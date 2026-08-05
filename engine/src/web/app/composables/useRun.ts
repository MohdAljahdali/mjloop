/**
 * DOM-free derivations the Run panel needs and nothing else does — ported
 * from `panels/run.js`'s own module-level helpers, which is why each keeps
 * that file's comment.
 */
import type { Preflight } from '../types/protocol.js'

/**
 * `<run_id>--<story|adhoc>--<track>`, the same shape `ops/run.ts:runDirName`
 * builds. Derived here rather than sent, because every part of it is already
 * on the summary.
 */
export function runDirName(state: { run_id: string | null; story: string | null; track: string | null }): string {
  return `${state.run_id ?? ''}--${state.story ?? 'adhoc'}--${state.track ?? ''}`
}

/**
 * `3 (2–5)`, or the bare number when every comparable run agreed.
 *
 * Through `<Bdi>` like every other digit in a dense row: a median of 2.5
 * cycles is a true statement about two runs and rounding it would invent a
 * run neither of them was, so it is printed as the engine computed it.
 */
export function spread(range: { median: number; min: number; max: number }): string {
  return range.min === range.max ? String(range.median) : `${range.median} (${range.min}–${range.max})`
}

export interface Fact {
  key: string
  value: string
}

/**
 * What this track can cost at most: the `dl.facts` rows above the "no
 * basis"/comparable split. The four roster sets that are often empty are
 * included only when they are not — a row reading "—" four times over is how
 * a reader learns to skip the block.
 */
export function preflightFacts(estimate: Preflight): Fact[] {
  const facts: Fact[] = [
    { key: 'preflight.maxCycles', value: String(estimate.max_cycles) },
    { key: 'preflight.perCycle', value: String(estimate.dispatches_per_cycle) },
    { key: 'preflight.ceiling', value: String(estimate.ceiling.dispatches) },
    { key: 'preflight.required', value: estimate.roster.required.join(', ') },
  ]
  const optional: readonly [string, readonly string[]][] = [
    ['preflight.available', estimate.roster.available],
    ['preflight.forced', estimate.roster.forced],
    ['preflight.forbidden', estimate.roster.forbidden],
    ['preflight.closing', estimate.roster.closing],
  ]
  for (const [key, agents] of optional) {
    if (agents.length > 0) facts.push({ key, value: agents.join(', ') })
  }
  return facts
}

/** What comparable runs actually took — the `dl.facts` rows below the basis line. */
export function preflightPast(comparable: NonNullable<Preflight['comparable']>): Fact[] {
  const past: Fact[] = [
    { key: 'preflight.pastCycles', value: spread(comparable.cycles) },
    { key: 'preflight.pastDispatches', value: spread(comparable.dispatches) },
  ]
  // Absent until a run has been timed: nothing archives a finished run's clock,
  // so only the run `state.json` still describes carries one.
  if (comparable.minutes !== null) past.push({ key: 'preflight.pastMinutes', value: spread(comparable.minutes) })
  return past
}
