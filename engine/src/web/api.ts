import crypto from 'node:crypto'
import type http from 'node:http'
import type { WebCode } from './codes.js'
import { PlanIdSchema, StoryIdSchema } from '../schemas/plan.js'
import {
  NotFoundError,
  readConfigView,
  readCycleDetail,
  readMemories,
  readMemoryEntry,
  readPlanDetail,
  readRunDetail,
  readRuns,
  readState,
  readStoryDetail,
} from './read.js'

/**
 * The read side: everything with a body.
 *
 * The poller pushes keys; this serves documents. Each tab declares which
 * revision it depends on and re-fetches when that moves, so the open tab *is*
 * the subscription — no watch table, nothing to leak when a socket dies, no
 * resubscribe on reconnect.
 *
 * Three things are load-bearing here:
 *
 *  - It is matched **after** the token check and **before** the static
 *    resolver, so no `/api` path can reach a file.
 *  - Ids are validated by the engine's own `PlanIdSchema` / `StoryIdSchema`
 *    rather than retyped. `schemas/plan.ts:6-10` records that these were
 *    constrained after a review found a story id could steer a write outside
 *    `.mjloop`; reusing them means the wire validation *is* that defence. The
 *    id shape is itself the traversal guard — `.` is outside `[\w-]`, so `..`
 *    cannot match.
 *  - Errors carry no prose. `{ error: { code } }` with **no `params` at all**,
 *    because a `params` hole is exactly how a sentence gets smuggled past the
 *    no-prose rule. A diagnosis goes to the terminal the server was launched
 *    from; `error.message` never crosses the wire.
 */

/** `<run_id>--<story|adhoc>--<track>`, all three of which are already id-shaped. */
const RUN_ID = /^[\w-]+$/
const MEMORY_ID = /^M\d{3}$/

export interface ApiResult {
  status: number
  body: unknown
}

const ok = (body: unknown): ApiResult => ({ status: 200, body })
const fail = (status: number, code: WebCode): ApiResult => ({ status, body: { error: { code } } })

/**
 * Answer an `/api/...` GET, or return null when the path is not ours.
 *
 * @param method so a `POST` is a 405 rather than being served as a read.
 */
export async function handleApi(projectDir: string, method: string, pathname: string): Promise<ApiResult | null> {
  if (!pathname.startsWith('/api/') && pathname !== '/api') return null
  if (method !== 'GET') return fail(405, 'error.badRequest')

  const segments = pathname.split('/').filter((part) => part.length > 0).slice(1)

  try {
    return await route(projectDir, segments)
  } catch (error) {
    if (error instanceof NotFoundError) return fail(404, 'error.notFound')
    // Everything else is a project on disk in a shape we could not read. The
    // page gets a code; the developer gets the stack on the server's own
    // stderr, which is where a diagnosis belongs.
    process.stderr.write(`mjloop web: ${String(error)}\n`)
    return fail(500, 'error.unreadable')
  }
}

async function route(projectDir: string, segments: readonly string[]): Promise<ApiResult> {
  const [head, first, second] = segments

  switch (head) {
    case 'state':
      if (segments.length !== 1) break
      return ok(await readState(projectDir))

    case 'config':
      if (segments.length !== 1) break
      return ok(await readConfigView(projectDir))

    case 'plans':
      if (segments.length !== 2 || first === undefined) break
      if (!PlanIdSchema.safeParse(first).success) return fail(400, 'error.badRequest')
      return ok(await readPlanDetail(projectDir, first))

    case 'stories':
      if (segments.length !== 2 || first === undefined) break
      if (!StoryIdSchema.safeParse(first).success) return fail(400, 'error.badRequest')
      return ok(await readStoryDetail(projectDir, first))

    case 'runs':
      if (segments.length === 1) return ok(await readRuns(projectDir))
      if (first === undefined || !RUN_ID.test(first)) return fail(400, 'error.badRequest')
      if (segments.length === 2) return ok(await readRunDetail(projectDir, first))
      if (segments.length === 3) {
        const cycle = Number(second)
        if (!Number.isInteger(cycle) || cycle < 1 || cycle > 999) return fail(400, 'error.badRequest')
        return ok(await readCycleDetail(projectDir, first, cycle))
      }
      break

    case 'memory':
      if (segments.length === 1) return ok(await readMemories(projectDir))
      if (segments.length !== 2 || first === undefined) break
      if (!MEMORY_ID.test(first)) return fail(400, 'error.badRequest')
      return ok(await readMemoryEntry(projectDir, first))
  }

  return fail(404, 'error.notFound')
}

/**
 * Weak `ETag` over the serialised body.
 *
 * `revisions.cycle` is the poller's tick counter while a run is live, so an
 * open Run or Evidence tab issues a conditional GET roughly once a second. This
 * is what makes almost all of them a 304 with an empty body over a loopback
 * socket, which is the whole reason that design is affordable.
 */
export function etag(body: string): string {
  return `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`
}

export function sendApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  result: ApiResult,
): void {
  const body = JSON.stringify(result.body)
  const tag = etag(body)

  if (request.headers['if-none-match'] === tag) {
    response.writeHead(304, { etag: tag, 'cache-control': 'no-store' }).end()
    return
  }

  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    etag: tag,
    // The page carries a token in its url. Keeping it out of caches and
    // referrers is most of what stops it leaking.
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}
