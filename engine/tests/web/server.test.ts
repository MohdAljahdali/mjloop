import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { initLoop } from '../../src/ops/init.js'
import { startServer, tokenMatches, type RunningServer } from '../../src/web/server.js'
import { fakeSessions, type FakeSessions } from '../helpers/fake-session.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let server: RunningServer
let sessions: FakeSessions

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, () => new Date('2026-07-28T09:00:00.000Z'))
  sessions = fakeSessions()
  // Port 0 so parallel test files cannot collide on a fixed one.
  server = await startServer({ projectDir: project.dir, port: 0, spawn: sessions.factory, pollMs: 50 })
})

afterEach(async () => {
  await server.close()
  await project.cleanup()
})

const base = (): string => `http://127.0.0.1:${server.port}`

describe('tokenMatches', () => {
  it('rejects a null, a short value, and a wrong one', () => {
    expect(tokenMatches('abcd', null)).toBe(false)
    expect(tokenMatches('abcd', 'abc')).toBe(false)
    expect(tokenMatches('abcd', 'abce')).toBe(false)
  })

  it('accepts the exact token', () => {
    expect(tokenMatches('abcd', 'abcd')).toBe(true)
  })
})

describe('http', () => {
  it('refuses a request with no token', async () => {
    // Any page in any tab can reach localhost, and this server spawns
    // processes. Without the token the url is not a credential.
    const response = await fetch(`${base()}/`)
    expect(response.status).toBe(401)
  })

  it('refuses a request with the wrong token', async () => {
    const response = await fetch(`${base()}/?t=nope`)
    expect(response.status).toBe(401)
  })

  it('serves the page with the token', async () => {
    const response = await fetch(`${base()}/?t=${server.token}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('mjloop')
  })

  it('puts the read api behind the same token', async () => {
    expect((await fetch(`${base()}/api/state`)).status).toBe(401)
  })

  it('answers a conditional GET with an empty 304', async () => {
    const url = `${base()}/api/runs?t=${server.token}`
    const first = await fetch(url)
    expect(first.status).toBe(200)
    const tag = first.headers.get('etag') ?? ''
    expect(tag).not.toBe('')

    const second = await fetch(url, { headers: { 'if-none-match': tag } })
    expect(second.status).toBe(304)
    // The empty body is the point: an open Run tab issues one of these per
    // tick while a run is live.
    expect(await second.text()).toBe('')
  })

  it('serves the locale dictionaries', async () => {
    const response = await fetch(`${base()}/locales/ar.json?t=${server.token}`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as Record<string, string>)['queue.tab']).toBe('الطابور')
  })

  it('keeps the tokened page out of caches and referrers', async () => {
    const response = await fetch(`${base()}/?t=${server.token}`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('refuses to walk out of the public directory', async () => {
    // `fetch` normalises `..` away, so the traversal is sent pre-encoded — which
    // is how it would arrive from anything actually trying it.
    const response = await fetch(`${base()}/%2e%2e/%2e%2e/package.json?t=${server.token}`)
    expect([403, 404]).toContain(response.status)
  })
})

describe('websocket', () => {
  interface Client {
    socket: WebSocket
    messages: Array<Record<string, unknown>>
  }

  /**
   * The message listener is attached at construction, not after `open`. The
   * server sends its first snapshot the instant the socket connects, and a
   * listener attached a microtask later misses it.
   */
  async function open(url: string): Promise<Client> {
    const socket = new WebSocket(url)
    const messages: Array<Record<string, unknown>> = []
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return { socket, messages }
  }

  it('refuses an upgrade without the token', async () => {
    await expect(open(`ws://127.0.0.1:${server.port}/`)).rejects.toThrow()
  })

  it('drops a write frame the schemas refuse, with no reply at all', async () => {
    // No error channel: a malformed frame is either a bug in our own page or
    // something with no business here, and neither is worth telling a prober
    // what shape to send next. The id schemas are doing filesystem duty on the
    // wire, and every forbidden op is simply not a `kind`.
    const client = await open(`ws://127.0.0.1:${server.port}/?t=${server.token}`)
    const refused = [
      { kind: 'gate', plan: '../../etc', from: null, to: 'approved' },
      { kind: 'story.status', story: '../x', from: 'todo', to: 'done' },
      { kind: 'cycle.advance', result: 'pass' },
      { kind: 'run.log', agent: 'reproducer', result: {} },
      { kind: 'run.start', track: 'fix', goal: 'x' },
      { kind: 'roster.set', agents: ['fixer'] },
    ]
    for (const write of refused) {
      client.socket.send(JSON.stringify({ type: 'write', id: 'w1', write }))
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(client.messages.filter((message) => message['type'] === 'receipt')).toEqual([])
    client.socket.close()
  })

  it('sends a snapshot on connect', async () => {
    const client = await open(`ws://127.0.0.1:${server.port}/?t=${server.token}`)
    await expect.poll(() => client.messages.length).toBeGreaterThan(0)

    const [message] = client.messages
    expect(message?.type).toBe('snapshot')
    expect((message?.snapshot as { project: string }).project).toBe(project.dir)
    client.socket.close()
  })

  it('enqueues a command and spawns a session for it', async () => {
    const { socket } = await open(`ws://127.0.0.1:${server.port}/?t=${server.token}`)
    socket.send(JSON.stringify({ type: 'enqueue', command: '/mjloop:build P001-S01' }))

    await expect.poll(() => sessions.sessions.length).toBe(1)
    expect(sessions.last().options.command).toBe('/mjloop:build P001-S01')
    socket.close()
  })

  it('ignores a frame that is not a client message', async () => {
    const { socket } = await open(`ws://127.0.0.1:${server.port}/?t=${server.token}`)
    socket.send('not json')
    socket.send(JSON.stringify({ type: 'enqueue' }))
    socket.send(JSON.stringify({ type: 'sudo', command: 'rm -rf /' }))

    // Still answering, and nothing was spawned by any of it.
    socket.send(JSON.stringify({ type: 'enqueue', command: '/mjloop:status' }))
    await expect.poll(() => sessions.sessions.length).toBe(1)
    expect(sessions.last().options.command).toBe('/mjloop:status')
    socket.close()
  })
})
