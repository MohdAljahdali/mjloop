import crypto from 'node:crypto'
import type http from 'node:http'
import type { WebCode } from './codes.js'
import { FeatureIdSchema } from '../schemas/feature.js'
import { PlanIdSchema, StoryIdSchema } from '../schemas/plan.js'
import { IdSchema } from '../schemas/state.js'
import {
  NotFoundError,
  readConfigView,
  readCycleDetail,
  readFeatureDetail,
  readFeatures,
  readMemories,
  readMemoryEntry,
  readPlanDetail,
  readPreflightEstimate,
  readProfileView,
  readRunDetail,
  readRuns,
  readSkillManifest,
  readSkillsView,
  readState,
  readStoryDetail,
  readTelemetryReport,
  readTranscript,
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
 *  - Every route is a read and none of them can be made into anything else.
 *    The two reports added for the token-economy milestone are projections over
 *    run directories that already exist; the preflight estimate in particular
 *    describes a run *before* it starts and cannot start one, because `runStart`
 *    is forbidden from this process entirely (`web/writes.ts`, and the
 *    `FORBIDDEN` list in `tests/web/boundary.test.ts`).
 *  - Errors carry no prose. `{ error: { code } }` with **no `params` at all**,
 *    because a `params` hole is exactly how a sentence gets smuggled past the
 *    no-prose rule. A diagnosis goes to the terminal the server was launched
 *    from; `error.message` never crosses the wire.
 */

/** `<run_id>--<story|adhoc>--<track>`, all three of which are already id-shaped. */
const RUN_ID = /^[\w-]+$/
const MEMORY_ID = /^M\d{3}$/
/**
 * `<server start, compact ISO>-<counter>` — `Job.id`'s own shape, restated
 * here for the same reason `PlanIdSchema` is reused rather than retyped
 * elsewhere in this file: the id shape *is* the traversal guard. Digits, `T`
 * and `-` only, so `.` and `/` are both outside the class and `..` cannot match.
 */
const JOB_ID = /^\d{8}T\d{6}-\d+$/

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
      // The pinned skill manifest, read-only: the page reports the routing
      // decision a run started with and offers no way to set one — a route
      // that took anything beyond the run id would be the first half of one
      // that let the browser select a skill for it.
      if (segments.length === 3 && second === 'skills') return ok(await readSkillManifest(projectDir, first))
      if (segments.length === 3) {
        const cycle = Number(second)
        if (!Number.isInteger(cycle) || cycle < 1 || cycle > 999) return fail(400, 'error.badRequest')
        return ok(await readCycleDetail(projectDir, first, cycle))
      }
      break

    case 'telemetry':
      // No parameter, and deliberately none: the row cap and the walk's bound
      // are the engine's to state, not a query string's to widen.
      if (segments.length !== 1) break
      return ok(await readTelemetryReport(projectDir))

    case 'preflight':
      if (segments.length !== 2 || first === undefined) break
      // A track name is an `IdSchema` id everywhere else in the engine —
      // `config.tracks` is keyed on it — so it is validated with that schema
      // rather than a regex retyped on the wire, for the same reason plan and
      // story ids are. The id shape is the traversal guard: `.` is outside
      // `[A-Za-z0-9_-]`, so `..` cannot match.
      if (!IdSchema.safeParse(first).success) return fail(400, 'error.badRequest')
      return ok(await readPreflightEstimate(projectDir, first))

    case 'profile':
      // No parameter, and none a later story should add: the accepted profile
      // is whichever revision file is highest and every revision is immutable,
      // so there is nothing here to select between. It is also the one document
      // on this wire whose *write* the browser is permanently denied —
      // accepting a component map activates routing for every later run — and a
      // route that took a revision would be the first half of one that set it.
      if (segments.length !== 1) break
      return ok(await readProfileView(projectDir))

    case 'features':
      if (segments.length === 1) return ok(await readFeatures(projectDir))
      if (segments.length !== 2 || first === undefined) break
      // `FeatureIdSchema` rather than a retyped `^F\d{3}$`, for the reason this
      // file's header gives about plan and story ids: the id shape *is* the
      // traversal guard, and a copy of it here is a copy that can be relaxed
      // without the schema noticing. `.` is outside the class, so `..` cannot
      // match.
      if (!FeatureIdSchema.safeParse(first).success) return fail(400, 'error.badRequest')
      // No revision segment, and none a later story should add. This serves the
      // latest revision and the history beside it; a route that selected a
      // revision would be the first half of one that *set* the selected
      // revision, and reselection is precisely how a brief is rolled back.
      return ok(await readFeatureDetail(projectDir, first))

    case 'memory':
      if (segments.length === 1) return ok(await readMemories(projectDir))
      if (segments.length !== 2 || first === undefined) break
      if (!MEMORY_ID.test(first)) return fail(400, 'error.badRequest')
      return ok(await readMemoryEntry(projectDir, first))

    case 'transcripts':
      // No listing at `/api/transcripts`, unlike `runs` and `memory` above:
      // there is no panel that browses every job that ever ran, only ever one
      // that already knows the id it wants.
      if (segments.length !== 2 || first === undefined) break
      if (!JOB_ID.test(first)) return fail(400, 'error.badRequest')
      return ok(await readTranscript(projectDir, first))

    case 'skills':
      // No parameter, and none a later story should add: activation is a
      // decision that changes what every later run is told, and this route
      // exists precisely so the cockpit can report the library and this
      // project's acceptances without offering a way to set either — the
      // class of write `web/writes.ts`'s header permanently denies the
      // browser. `mjloop-cli skills accept|disable|enable|remove` is where
      // that decision is made.
      if (segments.length !== 1) break
      return ok(await readSkillsView(projectDir))
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
