import { findTrack, forbiddenSpecialists, forcedSpecialists } from '../schemas/config.js'
import { loadConfig } from '../store/config-store.js'
import { readRunHistory, type RunRecord } from './history.js'
import { UnknownTrackError } from './run.js'

/**
 * The shape of a run before it starts, in the units the engine can actually
 * observe: agents per cycle, the cycle cap, and what comparable runs did.
 *
 * **It names no currency figure, and that is the design, not an omission.**
 * The engine cannot see what an agent runs on: that is frontmatter under the
 * plugin's `agents/` directory, which the engine has never read and cannot
 * reliably locate from `projectDir`, and a project-local agent may shadow a
 * plugin one without the engine knowing. A figure built on that would be a
 * guess wearing an estimate's clothes, and it would be wrong within a quarter
 * as published rates move. `tests/ops/preflight.test.ts` asserts at the source
 * level that this file names none.
 *
 * A second projection over `readRunHistory`, alongside `readTelemetry`. It
 * walks nothing itself.
 *
 * Pure read, and it must work before any run exists: it takes a track name
 * rather than a state, because `status === 'idle'` is exactly when it is asked.
 */

export interface Range {
  median: number
  min: number
  max: number
}

export interface Comparable {
  /** How many past runs the numbers rest on. */
  runs: number
  cycles: Range
  dispatches: Range
  /** `null` until a comparable run has been timed. See `RunRecord.started_at`. */
  minutes: Range | null
}

export interface Preflight {
  track: string
  max_cycles: number
  roster: {
    required: string[]
    available: string[]
    /** Specialists configured `always`, which no roster may drop. */
    forced: string[]
    /** Specialists configured `never` that this track would otherwise draft. */
    forbidden: string[]
    /** Agents that run once after the run passes, never inside a cycle. */
    closing: string[]
  }
  /** required + available + forced, minus forbidden and minus closing — the widest cycle possible. */
  dispatches_per_cycle: number
  ceiling: { cycles: number; dispatches: number }
  /** `null` when the project has no comparable run: *no basis* is an answer, and an invented one is not. */
  comparable: Comparable | null
}

export interface PreflightInput {
  track: string
  /**
   * The story this run is bound to, if any. It selects which past runs are
   * comparable rather than appearing in the answer: a story is a bounded unit
   * and a goal typed at a prompt is not, and averaging the two together
   * produces a range wide enough to be useless.
   */
  story?: string | null
}

export async function preflightEstimate(projectDir: string, input: PreflightInput): Promise<Preflight> {
  const config = await loadConfig(projectDir)
  const track = findTrack(config, input.track)
  if (track === undefined) throw new UnknownTrackError(input.track, Object.keys(config.tracks))

  const forced = forcedSpecialists(config)
  const forbidden = new Set(forbiddenSpecialists(config))
  const closing = new Set(track.closing)

  const perCycle = new Set([...track.required, ...track.available, ...forced])
  for (const agent of forbidden) perCycle.delete(agent)
  // A closing agent runs once, after the run has passed, and `rosterSet`
  // refuses it inside a working cycle. Without this line a project that also
  // marked one `always` would have it counted once per cycle in a number whose
  // whole claim is that it is the widest *cycle* the track allows.
  for (const agent of closing) perCycle.delete(agent)

  const dispatchesPerCycle = perCycle.size

  return {
    track: input.track,
    max_cycles: track.max_cycles,
    roster: {
      required: [...track.required],
      available: [...track.available],
      forced,
      // Only the names this track would otherwise draft. A `never` on an agent
      // this track never runs is a fact about another track.
      forbidden: [...track.required, ...track.available, ...track.closing].filter((agent) => forbidden.has(agent)),
      closing: [...track.closing],
    },
    dispatches_per_cycle: dispatchesPerCycle,
    ceiling: {
      cycles: track.max_cycles,
      // The closing set is added once rather than per cycle, and it is added:
      // a closing agent is a real dispatch the run makes, and leaving it out
      // would understate the widest run by exactly the agent idea 9 introduced.
      dispatches: track.max_cycles * dispatchesPerCycle + closing.size,
    },
    comparable: await readComparable(projectDir, input),
  }
}

/**
 * Comparable means: same track, same *kind* of run, and a run that finished.
 *
 * A halted run is left out because its cycle count measures where a guard
 * fired, not what the work took, and a run still in flight is left out for the
 * same reason with the ending still ahead of it. A run with no cycle directory
 * at all was started and abandoned before it composed anything.
 */
async function readComparable(projectDir: string, input: PreflightInput): Promise<Comparable | null> {
  const storyBound = (input.story ?? null) !== null
  const history = await readRunHistory(projectDir, { track: input.track })
  const comparable = history.filter(
    (run) => !run.halted && !run.running && run.cycles.length > 0 && (run.story !== null) === storyBound,
  )
  if (comparable.length === 0) return null

  const timed = comparable.map(minutesOf).filter((value): value is number => value !== null)

  return {
    runs: comparable.length,
    cycles: rangeOf(comparable.map((run) => run.cycles.length)),
    dispatches: rangeOf(comparable.map(dispatchesIn)),
    // An existing project sees cycles and dispatches immediately and durations
    // from its next run: nothing archives a finished run's clock, so only the
    // run `state.json` still describes can be timed.
    minutes: timed.length === 0 ? null : rangeOf(timed, 1),
  }
}

/**
 * Every agent the run dispatched, cycle by cycle plus the closing pass.
 *
 * The union of the roster's `selected` and the results that landed, rather than
 * either alone: a cycle whose roster is unreadable still shows what returned,
 * and an agent that returned without being drafted is still a dispatch that
 * happened.
 */
function dispatchesIn(run: RunRecord): number {
  const passes = run.closing === null ? run.cycles : [...run.cycles, run.closing]
  let total = 0
  for (const cycle of passes) {
    total += new Set([...cycle.selected, ...cycle.agents.map((agent) => agent.name)]).size
  }
  return total
}

/** Wall-clock minutes from the run opening to its last cycle closing, when both are known. */
function minutesOf(run: RunRecord): number | null {
  const last = run.cycles.at(-1)
  if (run.started_at === null || last === undefined || last.at === null) return null
  const elapsed = Date.parse(last.at) - Date.parse(run.started_at)
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  return elapsed / 60_000
}

/**
 * `decimals` is supplied for minutes and withheld for counts, deliberately in
 * that direction. A median of 2.5 cycles across two runs is a true statement
 * and rounding it to 3 would invent a run neither of them was; a duration
 * carried to fifteen decimal places would claim a precision the clock does not
 * have.
 */
function rangeOf(values: number[], decimals?: number): Range {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return {
    median: round(median, decimals),
    min: round(sorted[0] ?? 0, decimals),
    max: round(sorted.at(-1) ?? 0, decimals),
  }
}

function round(value: number, decimals?: number): number {
  if (decimals === undefined) return value
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}
