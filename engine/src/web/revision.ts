import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveLoopPaths } from '../store/paths.js'

/**
 * Cheap fingerprints of what is on disk, so the page can ask "has this changed"
 * without anything being pushed to it.
 *
 * The rule the whole transport rests on: **the poller pushes only facts it has
 * already parsed from files it already opens; everything with a body is
 * fetched.** These fingerprints are what a tab subscribes to. The open tab *is*
 * the subscription — there is no server-side watch table, so there is nothing
 * to leak when a socket dies, no resubscribe on reconnect, and no per-view tick
 * budget anyone has to tune.
 *
 * Two things here are deliberate and read as bugs if you do not know why.
 */
export interface Revisions {
  state: string
  config: string
  plans: string
  runs: string
  /**
   * **Always dirty while a run is live**, because it is the poller's own tick
   * counter and not a fingerprint.
   *
   * The open cycle directory is the one thing actively being written while
   * somebody watches it, and mtime granularity loses writes inside the same
   * second. The consequence is explicit and intended: an open Run or Evidence
   * tab issues its conditional GETs once per tick, and the `ETag` makes almost
   * all of them a 304 with an empty body over a loopback socket. That is the
   * price of never showing a stale cycle. Do not "fix" this into a fingerprint.
   */
  cycle: string
  memory: string
}

/**
 * `mtimeMs` and size, or `-` when the path is absent.
 *
 * Absent is a state worth fingerprinting: a plan directory that gains a
 * `REVIEW.md` has changed, and so has one whose `HALT.md` was deleted.
 */
async function stamp(file: string): Promise<string> {
  try {
    const stats = await fs.stat(file)
    return `${Math.trunc(stats.mtimeMs)}.${stats.size}`
  } catch {
    return '-'
  }
}

/**
 * A directory's own mtime, plus a stamp of each named document inside it.
 *
 * Overwriting `PLAN.md` in place moves no directory's mtime — `gateSet` does
 * exactly that on every approval — so a fingerprint built from directory mtimes
 * alone would sit there confidently showing the old decision.
 */
async function stampDir(dir: string, documents: readonly string[]): Promise<string> {
  const parts = [await stamp(dir)]
  for (const document of documents) parts.push(await stamp(path.join(dir, document)))
  return parts.join(':')
}

/** Sorted, always: `JSON.stringify` follows insertion order and an unstable body flaps the `ETag`. */
async function entries(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch {
    return []
  }
}

const PLAN_DOCUMENTS = ['PLAN.md', 'REVIEW.md', 'manifest.json'] as const

/**
 * @param tick The poller's tick counter, folded into `cycle`. See above.
 * @param running Whether a run is open. A finished run's cycle directory is
 *   inert, so outside a run `cycle` settles and the conditional GETs stop.
 */
export async function readRevisions(projectDir: string, tick: number, running: boolean): Promise<Revisions> {
  const paths = resolveLoopPaths(projectDir)

  const planIds = await entries(paths.plans)
  const plans: string[] = []
  for (const id of planIds) {
    plans.push(`${id}=${await stampDir(path.join(paths.plans, id), PLAN_DOCUMENTS)}`)
    // The stories directory is a directory of documents; its own mtime moves
    // when a story is added or removed, which is what `--next` reads.
    plans.push(await stamp(path.join(paths.plans, id, 'stories')))
  }

  const [state, config, memory, runs] = await Promise.all([
    stamp(paths.state),
    stamp(paths.config),
    (async () => (await entries(paths.memory)).join(',') + (await stamp(paths.memory)))(),
    (async () => (await entries(paths.runs)).join(',') + (await stamp(paths.runs)))(),
  ])

  return {
    state,
    config,
    plans: plans.join('|'),
    runs,
    cycle: running ? String(tick) : 'idle',
    memory,
  }
}
