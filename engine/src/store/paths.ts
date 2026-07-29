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
export const PROTECTED_BASENAMES = ['state.json', 'manifest.json', 'verify-pinned.json'] as const
