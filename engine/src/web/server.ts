import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { handleApi, sendApi } from './api.js'
import { JobQueue } from './queue.js'
import { clearServerMarker, writeServerMarker } from './marker.js'
import { ClientMessageSchema, type Message, type ServerMessage, type Snapshot } from './protocol.js'
import { spawnPtySession, type SessionFactory } from './session.js'
import { buildSnapshot, emptyCache } from './snapshot.js'
import { applyWrite } from './writes.js'

/** How often `.mjloop/` is re-read. Cheap next to what a loop cycle costs. */
export const POLL_MS = 800

export interface ServerOptions {
  projectDir: string
  port: number
  /** Injected by the tests. Production spawns a real pty. */
  spawn?: SessionFactory
  /** Injected by the tests so they need not wait out a real poll. */
  pollMs?: number
}

export interface RunningServer {
  url: string
  token: string
  port: number
  close: () => Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))

/** What a receipt says on success. One code per kind, and no parameters. */
const OK_CODES = {
  gate: 'write.ok.gate',
  'story.status': 'write.ok.story',
  halt: 'write.ok.halt',
  'config.patch': 'write.ok.config',
  'feature.approve': 'write.ok.feature',
  'agent.create': 'write.ok.agent',
  'agent.update': 'write.ok.agent',
  'agent.delete': 'write.ok.agent',
  'skill.agents': 'write.ok.skill',
  'quality.decision': 'write.ok.qualityDecision',
  'quality.budget': 'write.ok.qualityBudget',
} as const

/**
 * Constant-time so the token cannot be recovered a byte at a time. Length is
 * compared first because `timingSafeEqual` throws on a mismatch — that check
 * leaks only the length, which the URL format publishes anyway.
 */
export function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null || given.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))
}

export const COOKIE = 'mjloop_token'

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/**
 * The token from the url, or from the cookie the url's first request set.
 *
 * The page's own subresources — its stylesheet, its scripts, xterm's bundles —
 * are requested by the browser with no query string of ours attached, so the
 * url alone authenticates exactly one request and nothing it pulls in. The
 * cookie carries it the rest of the way.
 *
 * `SameSite=Strict` is what makes that safe: a page on another origin cannot
 * cause the cookie to be sent, so this is still a door only the url opens.
 */
export function suppliedToken(url: URL, cookieHeader: string | undefined): string | null {
  return url.searchParams.get('t') ?? readCookie(cookieHeader, COOKIE)
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { projectDir } = options
  const token = crypto.randomBytes(32).toString('hex')
  const sockets = new Set<WebSocket>()

  const broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message)
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload)
    }
  }

  const notice = (message: Message): void => broadcast({ type: 'notice', message })

  let pushSnapshot = (): void => {}

  const queue = new JobQueue({
    cwd: projectDir,
    spawn: options.spawn ?? spawnPtySession,
    onOutput: (jobId, data) => broadcast({ type: 'output', jobId, data }),
    onChange: () => pushSnapshot(),
    onNotice: notice,
  })

  let lastSent = ''
  let latest: Snapshot | null = null

  /** Sent only when it differs: the poller runs whether or not anything moved. */
  const emit = (): void => {
    if (latest === null) return
    const payload = JSON.stringify({ type: 'snapshot', snapshot: latest })
    if (payload === lastSent) return
    lastSent = payload
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload)
    }
  }

  // Carried across ticks so an idle project costs about eight stats and a
  // readdir rather than a full re-read of every plan.
  const cache = emptyCache()

  const refresh = async (): Promise<void> => {
    const base = await buildSnapshot(projectDir, cache)
    // Fed the summary the poller already read rather than reading it again:
    // one read per tick means the queue can never decide on a different state
    // from the one the page is about to be shown.
    queue.observe(base.state)
    latest = { ...base, queue: queue.jobs(), session: queue.session() }
    emit()
  }

  // The queue changes between polls too — a job enqueued, a session closed. Its
  // half of the snapshot is refreshed without re-reading the disk.
  pushSnapshot = (): void => {
    if (latest === null) return
    latest = { ...latest, queue: queue.jobs(), session: queue.session() }
    emit()
  }

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, token, projectDir)
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!tokenMatches(token, suppliedToken(url, request.headers.cookie))) {
      // A bare 401 rather than an upgrade: this socket would otherwise be able
      // to spawn processes on the user's machine, and any page in any tab can
      // open a WebSocket to localhost.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (socket: WebSocket) => {
    sockets.add(socket)
    if (latest !== null) socket.send(JSON.stringify({ type: 'snapshot', snapshot: latest }))
    const active = queue.session().jobId
    if (active !== null) {
      socket.send(JSON.stringify({ type: 'transcript', jobId: active, data: queue.transcript(active) }))
    }

    socket.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw)) as unknown
      } catch {
        return
      }
      const message = ClientMessageSchema.safeParse(parsed)
      // Silently dropped rather than answered. A malformed frame is either a
      // bug in our own page or something that has no business here; neither is
      // worth an error channel that tells a prober what shape to send next.
      if (!message.success) return

      switch (message.data.type) {
        case 'input':
          queue.write(message.data.data)
          break
        case 'resize':
          queue.resize(message.data.cols, message.data.rows)
          break
        case 'enqueue':
          queue.enqueue(message.data.command, message.data.story)
          break
        case 'cancel':
          queue.cancel(message.data.jobId)
          break
        case 'stop':
          queue.stop()
          break
        case 'resume':
          queue.resume()
          break
        case 'clear':
          queue.clear()
          break
        case 'attach':
          socket.send(
            JSON.stringify({
              type: 'transcript',
              jobId: message.data.jobId,
              data: queue.transcript(message.data.jobId),
            }),
          )
          break
        case 'nudge':
          queue.nudge()
          break
        case 'write': {
          const frame = message.data
          void applyWrite(projectDir, frame.write).then(async (result) => {
            // The snapshot goes out *before* the receipt, so by the time the
            // page is told the write landed it is already looking at the
            // result. That is what removes the optimistic render and its
            // rollback from the page entirely.
            if (result.ok) {
              await refresh().catch(() => {})
              // A halt is authoritative on state and best-effort on the
              // session: only once `HALT.md` exists does the pty get told.
              if (frame.write.kind === 'halt') queue.stop()
            }
            // Guarded, unlike the sends above it: this one happens after an
            // await, so the tab may well have gone. `ws` treats a send on a
            // closed socket as an error event, and an unhandled one on a
            // socket with no error listener takes the server down with it.
            if (socket.readyState !== socket.OPEN) return
            socket.send(
              JSON.stringify({
                type: 'receipt',
                id: frame.id,
                ok: result.ok,
                code: result.ok ? OK_CODES[frame.write.kind] : result.code,
              }),
            )
          }).catch(() => {
            // `applyWrite` reports its own failures as codes and never
            // rejects; this catches a send that raced a closing socket.
          })
          break
        }
      }
    })

    // A socket that errors with no listener is an uncaught exception in `ws`,
    // and this process is a server the user leaves running. A dropped
    // connection is not something to recover from — it is something not to
    // crash on; `close` follows and removes it.
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1, never 0.0.0.0: this process spawns `claude` with the user's
    // credentials, so the page is a local tool and must not be reachable from
    // the network the machine happens to be on.
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  await refresh()
  const timer = setInterval(() => {
    void refresh().catch(() => {
      // A failed read is transient — `.mjloop` mid-write, a directory being
      // replaced. The next tick is 800ms away and the page keeps the last
      // snapshot until then.
    })
  }, options.pollMs ?? POLL_MS)
  // The poller must not be what keeps the process alive: without this a server
  // whose sockets have all closed still holds the event loop open forever.
  timer.unref()

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  // The one thing a second session needs to find this one instead of racing it
  // for the port. Best effort in both directions: a project whose `.mjloop`
  // cannot be written still gets a working dashboard, it just cannot be found
  // by the `SessionStart` hook.
  await writeServerMarker(options.projectDir, { port, token, pid: process.pid })

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    token,
    port,
    close: async () => {
      clearInterval(timer)
      queue.dispose()
      for (const socket of sockets) socket.terminate()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await clearServerMarker(options.projectDir)
    },
  }
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  token: string,
  projectDir: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (!tokenMatches(token, suppliedToken(url, request.headers.cookie))) {
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('unauthorized')
    return
  }

  // Matched after the token check and before the static resolver, so no `/api`
  // path can ever reach a file on disk. `url.pathname + url.search` rather
  // than `url.pathname` alone: the roster validity route reads its candidate
  // composition from a `?roster=` query parameter, and `handleApi` splits that
  // back off itself (`api.ts`'s own header explains why it is a plain
  // `indexOf('?')` there rather than a second `new URL`). Every other route
  // ignores a query string entirely, so this changes nothing for them.
  const api = await handleApi(projectDir, request.method ?? 'GET', url.pathname + url.search)
  if (api !== null) {
    sendApi(request, response, api)
    return
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname
  // Resolved and then re-checked against the root: `..` in a path is how a
  // static handler serves the user's private keys.
  const file = path.resolve(PUBLIC_DIR, `.${requested}`)
  if (!file.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end()
    return
  }

  try {
    const body = await fs.readFile(file)
    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // The page carries a token in its URL. Keeping it out of caches and
      // referrers is most of what stops it leaking.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      // Host-only, script-unreadable, and never sent from another origin. The
      // browser needs it to fetch this page's own assets; nothing else does.
      'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
    })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
}
