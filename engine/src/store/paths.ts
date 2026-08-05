import path from 'node:path'

export interface LoopPaths {
  root: string
  config: string
  state: string
  index: string
  designSystem: string
  plans: string
  runs: string
  memory: string
  profile: string
  features: string
  skills: string
  webTranscripts: string
  webServer: string
  lock: string
  verifyLock: string
}

export function resolveLoopPaths(projectDir: string): LoopPaths {
  const root = path.join(projectDir, '.mjloop')
  return {
    root,
    config: path.join(root, 'config.yaml'),
    state: path.join(root, 'state.json'),
    index: path.join(root, 'INDEX.md'),
    designSystem: path.join(root, 'design-system.md'),
    plans: path.join(root, 'plans'),
    runs: path.join(root, 'runs'),
    memory: path.join(root, 'memory'),
    /**
     * The project's component map: a mutable `proposed.json` a scan overwrites,
     * and an `accepted/` directory of immutable numbered revisions.
     *
     * Only the directory is named here. What a revision file is called, and the
     * fact that the accepted profile is simply the highest-numbered one rather
     * than whatever a mutable pointer says, belong to
     * `project-profile-store.ts` — this map is the place every path in
     * `.mjloop/` is *rooted*, not the place any of them are interpreted.
     */
    profile: path.join(root, 'profile'),
    /**
     * The feature briefs: one directory per feature, `F001-<slug>/`, holding
     * immutable numbered revisions of what a discovery interview decided.
     *
     * Named here and interpreted in `feature-store.ts`, for the reason the
     * profile above is: this map is where every path in `.mjloop/` is *rooted*,
     * not where any of them is given meaning. Which revision is current, and
     * the fact that it is simply the highest-numbered one rather than whatever
     * a mutable pointer claims, belong to the store.
     */
    features: path.join(root, 'features'),
    /**
     * This project's acceptances of packages from the shared, user-local
     * skill library: one `<skillId>.json` per accepted skill, holding which
     * digest this project pinned and never a path into the library itself —
     * see `schemas/skill-acceptance.ts`. The library the digest resolves
     * against lives under `resolveLibraryRoot` (`library-paths.ts`), which is
     * deliberately *not* under `.mjloop/`: it is shared by every project on
     * this machine, where this directory is this one project's own decision.
     *
     * Added to `PROTECTED_DIRECTORIES` below now that `mjloop-cli skills
     * accept|disable|enable|remove` exists: that is the route back in the
     * denial below names, and the reason the `satisfies` check on
     * `PROTECTED_DIRECTORY_REASONS` in `cli/index.ts` was written to demand.
     */
    skills: path.join(root, 'skills'),
    /**
     * Durable job transcripts: `web/transcripts/<jobId>.log`, raw pty bytes,
     * append-only, written by `JobQueue` and read by `readTranscript`.
     *
     * Named here rather than left as a literal join in `queue.ts` and `read.ts`
     * for the reason every other entry in this map is: one place decides where
     * a `.mjloop/` path is rooted. It carries no key in `revision.ts` — job ids
     * are unique across restarts (`Job.id`'s own doc says why), so a tab that
     * wants one fetches it once, by id, rather than polling for a change.
     */
    webTranscripts: path.join(root, 'web', 'transcripts'),
    /**
     * What a running cockpit leaves behind so a second session can find it:
     * its port, its token and its pid. Written when the server starts
     * listening and removed when it stops, so a stale file means a crash and
     * is treated as one — the pid is probed before the file is believed.
     *
     * Under `web/` rather than at the root because it is the same kind of
     * thing as `web/transcripts/`: server runtime, not project state, stamped
     * by no revision key and read by no poller.
     */
    webServer: path.join(root, 'web', 'server.json'),
    lock: path.join(root, '.lock'),
    /**
     * Mutual exclusion for verify *execution*, and never the same directory as
     * `lock`.
     *
     * The two answer different questions and must not share a directory. The
     * state lock is held for a read-modify-write measured in milliseconds; this
     * one is held for as long as a test suite runs. A subprocess held inside
     * `.lock` would starve every other tool in the session, since `withLock`'s
     * default acquire timeout is 5 000 ms.
     *
     * Keyed on the project rather than the slot, because the contended resource
     * is the machine — a port, a fixture database, a build output directory —
     * and the engine cannot know which two commands share one. Two suites on
     * one port both go red, and a red digest arms the repeated-error guard, so
     * a run making progress can halt over a port nobody was fighting for.
     */
    verifyLock: path.join(root, '.verify-lock'),
  }
}

/**
 * Files only the engine may write. The PreToolUse hook denies edits to these.
 *
 * `verify-pinned.json` is the entire enforcement of the run's verify pin:
 * `evaluateStateGuard` matches by basename anywhere under `.mjloop/`, so one
 * word covers every run directory of every project with no change to the guard,
 * the hook or `hooks.json`. The residual is stated rather than argued away —
 * the guard matches `Write|Edit`, so `rm` through `Bash` can still delete a
 * pin, which is why `state.started_at` makes a missing pin an error rather than
 * a fallback to the live config.
 */
export const PROTECTED_BASENAMES = [
  'state.json',
  'manifest.json',
  'verify-pinned.json',
  'skill-selection.json',
  'quality-policy.json',
  'quality-ledger.json',
  'quality-amendments.jsonl',
  // What a run has spent against those ceilings. It belongs here for the same
  // reason the amendments journal does: an edit to either raises a budget
  // without the explicit, recorded decision that is the only way a suspended
  // run is meant to continue.
  'quality-usage.json',
] as const

/**
 * Directories under `.mjloop/` only the engine may write into, named here for
 * the same reason the basenames above are and denied by the same hook.
 *
 * `profile` is a *directory* rather than three more basenames because the names
 * inside it are a family rather than a list: `accepted/rev-001.json`,
 * `rev-002.json`, and every revision a project has not reached yet. A basename
 * list cannot express that, and a list that named only the ones written so far
 * would protect a project's history and leave its next revision open.
 *
 * Both records need it, for different reasons. An accepted revision's entire
 * contract is that it never changes — a run may have pinned it, and the
 * numbered-revision layout exists precisely so nothing can move under one.
 * `proposed.json` is disposable, but it is also `profile accept`'s only input:
 * a model that can rewrite the proposal can put any component map it likes in
 * front of the person accepting, and the acceptance that follows is genuine.
 *
 * `features` is here for the sharper form of that same argument. An approved
 * brief is the evidence every later plan is built on — the record that exists
 * precisely so planning does not rest on chat text a model can rewrite — and
 * approval is a decision a person made about a *particular* set of words. A
 * model that could edit a revision could approve work nobody agreed to, without
 * anything on disk showing that the words moved after the decision.
 *
 * `skills` is here for the same shape of reason again: an acceptance names the
 * exact digest, components and agents a project pinned, and it is a decision
 * a person made through `mjloop-cli skills accept` — a model that could edit
 * the record by hand could change what a run treats as accepted without that
 * decision ever having been made.
 */
export const PROTECTED_DIRECTORIES = ['profile', 'features', 'skills'] as const
