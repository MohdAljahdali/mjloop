import fs from 'node:fs/promises'
import path from 'node:path'
import { packagesDir } from '../store/library-paths.js'
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
  /**
   * One fingerprint per plan, keyed by id.
   *
   * A single joined string was one subscription for every plan at once, so
   * editing a story in `P003` re-fetched an open `P001` document — tolerable
   * while one panel read it, and multiplied by a Plans workspace, a Stories
   * workspace and every open story tab. The browser has no working 304 path to
   * absorb that: `lib/api.js`'s `get()` sends no `if-none-match` and the api
   * answers `cache-control: no-store`.
   *
   * Built from sorted ids for the reason `entries()` sorts: a key order that
   * flaps is a body that flaps, which is the failure this whole shape exists to
   * avoid. `snapshot.test.ts` compares the serialisation rather than the object,
   * because `toEqual` does not see key order.
   */
  plans: Record<string, string>
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
  /**
   * `.mjloop/profile/` — the accepted component map, and the proposal beside it.
   *
   * A key of its own rather than a rider on `config`. The Skills tab draws the
   * accepted map, and until this existed the only way to notice one had landed
   * was to watch `config` and `state` and hope: `orchestration.profile.auto_accept`
   * lives in one and init moves the other, so the two together *happened* to
   * move whenever a map could have. That is a coincidence, not a subscription,
   * and `mjloop-cli profile accept` run against a project nobody is initialising
   * moves neither.
   */
  profile: string
  /**
   * `.mjloop/features/` — every brief and every revision of one.
   *
   * Load-bearing for the one write the browser is allowed. `applyWrite`
   * broadcasts a snapshot *before* the receipt, so a page whose feed depends on
   * nothing that moved receives its own confirmation and goes on drawing the
   * draft it just approved. Approval writes a new revision file into this
   * directory, so this is the key that makes the confirmation true.
   */
  features: string
  /**
   * This project's acceptances, and the machine-wide library they name.
   *
   * Two halves because the record is in two places by design: an acceptance
   * lives in `.mjloop/skills/` and travels with the repository, while the
   * package it names by digest lives once per *machine* under the library root.
   * A key covering only the project half would sit still through the
   * `mjloop-cli skills import` that finally supplies a package this project
   * accepted months ago on another machine.
   */
  skills: string
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
 * A directory's entries and its own mtime, in one string.
 *
 * The shape `memory` and `runs` were already computing inline. Named here
 * because three more keys want it and a fourth copy of a fingerprint is a
 * fourth place it can drift.
 */
async function stampListing(dir: string): Promise<string> {
  return (await entries(dir)).join(',') + (await stamp(dir))
}

/**
 * The same, but reaching one level into every entry.
 *
 * `stampListing` alone is blind to the two writes these three directories
 * actually make, and both are the write that matters most:
 *
 *  - **A new revision inside an existing record.** Approving `F001` writes
 *    `features/F001-sign-in/rev-002.json`. The `features/` directory gains no
 *    entry and its own mtime does not move, because the file landed in a
 *    subdirectory that already existed. The identical case is `profile/accepted/`.
 *  - **A record overwritten in place.** `skills accept` on a skill this project
 *    already holds rewrites `skills/<id>.json`. Same entry list, same directory
 *    mtime.
 *
 * Both are exactly the "the page shows the state it had before your write"
 * failure these keys exist to prevent, so the walk descends: each entry
 * contributes its own stamp, and a directory entry contributes its listing.
 * One level is enough — none of these layouts nests deeper — and the bound
 * matters, because this runs on every poller tick.
 */
async function stampTree(dir: string): Promise<string> {
  const parts = [await stamp(dir)]
  for (const name of await entries(dir)) {
    const child = path.join(dir, name)
    // A file contributes its own stamp; a directory contributes the listing of
    // what is inside it. `stampListing` answers `-` for a path it cannot read,
    // which covers the file case without a `stat` to tell them apart first.
    parts.push(`${name}=${await stamp(child)}=${await stampListing(child)}`)
  }
  return parts.join('|')
}

/**
 * The library's `packages/` listing, or `-` when there is no library to read.
 *
 * `resolveLibraryRoot` **throws** — `LibraryRootCollisionError` when the
 * resolved root would land inside the project or inside any `.mjloop`
 * directory. Every other fingerprint in this file answers `-` for a path it
 * cannot read, and this one has to as well: `readRevisions` runs on every
 * poller tick, and an exception here does not blank the Skills tab, it takes
 * out the whole snapshot for every tab at once.
 */
async function stampLibrary(projectDir: string): Promise<string> {
  try {
    return await stampListing(packagesDir(projectDir))
  } catch {
    return '-'
  }
}

/**
 * @param tick The poller's tick counter, folded into `cycle`. See above.
 * @param running Whether a run is open. A finished run's cycle directory is
 *   inert, so outside a run `cycle` settles and the conditional GETs stop.
 */
export async function readRevisions(projectDir: string, tick: number, running: boolean): Promise<Revisions> {
  const paths = resolveLoopPaths(projectDir)

  const planDirs = await entries(paths.plans)
  /** Insertion order is `entries()`'s sort, so the serialisation is stable. */
  const plans: Record<string, string> = {}
  for (const dir of planDirs) {
    const documents = await stampDir(path.join(paths.plans, dir), PLAN_DOCUMENTS)
    // The stories directory is a directory of documents; its own mtime moves
    // when a story is added or removed, which is what `--next` reads.
    const stories = await stamp(path.join(paths.plans, dir, 'stories'))
    // Keyed by plan id, because the id is what a subscriber has: the page knows
    // `P001`, never `P001-user-auth`. A directory whose name does not carry one
    // keeps its own name as the key rather than being dropped — a fingerprint
    // that silently stops covering a directory is worse than an odd key — and
    // two directories claiming one id are folded rather than overwriting, so
    // neither becomes invisible.
    const key = /^P\d{3}(?=-|$)/.exec(dir)?.[0] ?? dir
    const stamped = `${documents}:${stories}`
    plans[key] = plans[key] === undefined ? stamped : `${plans[key]}|${stamped}`
  }

  const [state, config, memory, runs, profile, features, acceptances, library] = await Promise.all([
    stamp(paths.state),
    stamp(paths.config),
    stampListing(paths.memory),
    stampListing(paths.runs),
    // `proposed.json` by name for the reason `PLAN_DOCUMENTS` names its three:
    // init overwrites the proposal in place, and a fingerprint built from the
    // directory's mtime alone would sit there showing the previous scan. The
    // accepted revisions themselves live in `profile/accepted/`, which is why
    // this is a tree walk and not a listing.
    (async () => `${await stampDir(paths.profile, ['proposed.json'])}:${await stampTree(paths.profile)}`)(),
    stampTree(paths.features),
    stampTree(paths.skills),
    stampLibrary(projectDir),
  ])

  return {
    state,
    config,
    plans,
    runs,
    cycle: running ? String(tick) : 'idle',
    memory,
    profile,
    features,
    skills: `${acceptances}|${library}`,
  }
}
