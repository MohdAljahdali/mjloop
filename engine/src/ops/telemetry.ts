import { pinnedAgents, type QualityMode, type SpecialistMode } from '../schemas/config.js'
import type { MeasurementKind, QualityBudget } from '../schemas/quality.js'
import type { Result, Severity } from '../schemas/state.js'
import { loadConfig } from '../store/config-store.js'
import { readRunHistory, type CycleRecord } from './history.js'
import { measureTokens } from './quality-budget.js'

/**
 * What every specialist this project has ever drafted actually returned.
 *
 * A projection over `readRunHistory` and nothing else: no `fs` call lives in
 * this file, because a second walk would answer "what is a run?" differently
 * from the first one (see `history.ts`).
 *
 * **Telemetry is a report, not a rule.** Nothing in the engine drafts or skips
 * an agent because of anything here. A specialist with a zero hit rate on this
 * project may be the reason the project has no security findings, and that
 * judgement belongs to a person.
 */

/**
 * The wire ceiling. This repository ships 19 agents today; the cap is not for
 * this repository but for the one that adds a specialist a month for two years,
 * and `truncated` beside it is what keeps the ceiling visible instead of making
 * the table quietly wrong.
 */
export const TELEMETRY_MAX_ROWS = 40

/**
 * Drafted this many times with nothing high or medium to show for it, and the
 * one line `/mjloop:status` prints.
 *
 * Five is chosen so a specialist has had a run's worth of chances before it is
 * named: `build`'s cap is five cycles, so this is roughly "a whole run drafted
 * it every cycle and it never found anything".
 */
export const TELEMETRY_FLAG_DRAFTS = 5

export interface SpecialistRow {
  agent: string
  /** `config.specialists[agent]`, or `null` when the project has no rule about it. */
  mode: SpecialistMode | null
  /** Cycles whose roster selected it. */
  drafted: number
  /** Cycles whose roster left it out with a stated reason. */
  skipped: number
  /**
   * Cycles in which its result file exists. Counted in cycles, like `drafted`,
   * so the gap between the two is readable: a cycle the leader planned and the
   * agent never returned from is worth seeing.
   */
  landed: number
  /**
   * Counted per **file**, not per cycle, so two instances of one agent in one
   * cycle contribute two. That is the honest count of what it returned; the
   * cycle count is `landed`.
   */
  results: Record<Result, number>
  /** From its own result files only. `findings.json` is a cycle aggregate with no attribution. */
  findings: Record<Severity, number>
  /** Distinct runs that mentioned it at all — drafted, skipped or landed. */
  runs: number
  /** The `run_id` of the most recent such run. */
  last_seen: string | null
}

export interface Telemetry {
  runs: number
  /** Working cycles. The `closing/` pass is not a cycle. */
  cycles: number
  /** At most `TELEMETRY_MAX_ROWS`, ordered by `drafted` descending. */
  specialists: SpecialistRow[]
  /** How many rows the cap dropped, so the ceiling is visible. */
  truncated: number
  /**
   * Drafted `TELEMETRY_FLAG_DRAFTS`+ times with no high or medium finding.
   *
   * The only field `/mjloop:status` reads. The full table is a report you ask
   * for — `mjloop_report_get`, or the cockpit's Config tab — not one every
   * status call is handed, in a milestone whose purpose is cutting context.
   */
  flagged: string[]
}

/**
 * One human-wait interval, from the timestamps a record already carries.
 *
 * `decidedAt: null` is an interval nobody has closed yet. It stays open rather
 * than being ended at the reader's clock, which is the whole discipline of this
 * projection: the engine reports what was written down.
 */
export interface QualityWait {
  requestedAt: string
  decidedAt: string | null
}

export interface QualityTelemetryInput {
  mode: QualityMode
  /** The *effective* budget; its `cost_estimate` is the only price record this projection trusts. */
  budget: QualityBudget
  dispatches: { used: number; max: number }
  /** Token counts a host adapter actually reported. Absent everywhere until one does. */
  usage?: { inputTokens?: number | null; outputTokens?: number | null } | null
  /** The bounded input packet this run fitted, when one was recorded. Estimated from bytes, never measured. */
  inputPacket?: string | null
  /** `state.started_at` — the run's own opening, persisted by `runStart`. */
  startedAt: string | null
  /** `state.updated_at` — the last state transition anybody wrote. Never a UI clock. */
  lastTransitionAt: string | null
  /** Human waits, from the destructive-request record's own timestamps. */
  waits?: readonly QualityWait[]
}

/**
 * What one run has actually cost, in the units the engine can honestly produce.
 *
 * Every field carries the kind of claim it is, and `unavailable` is a real
 * answer rather than a gap to be filled: an invented price or an invented token
 * count is worse than a blank, because a person budgets against it.
 */
export interface QualityTelemetry {
  mode: QualityMode
  inputTokens: { kind: MeasurementKind; value: number | null }
  outputTokens: { kind: MeasurementKind; value: number | null }
  estimatedCost: { kind: MeasurementKind; currency: string | null; value: number | null }
  /** Time the run was working, waits excluded. */
  activeElapsed: { kind: MeasurementKind; valueMs: number | null }
  /** Time it was stopped waiting on a person. Separate, because one of them is the engine's fault and one is not. */
  waitingElapsed: { kind: MeasurementKind; valueMs: number | null }
  dispatches: { used: number; max: number }
}

const UNAVAILABLE_TOKENS = { kind: 'unavailable' as const, value: null }
const UNAVAILABLE_ELAPSED = { kind: 'unavailable' as const, valueMs: null }

/**
 * The run-scoped projection, computed from records and nothing else.
 *
 * Three refusals hold it together:
 *
 *  - **Cost** is `unavailable` unless `budget.cost_estimate` exists, and that
 *    record is only ever written when a versioned pricing table *and* measured
 *    usage on both sides were both present (`quality-budget.ts:costEstimate`).
 *    There is no path here that multiplies a guess by a price.
 *  - **Output tokens** are never estimated. Input can be estimated from the
 *    packet the engine itself composed, because that text is a thing the engine
 *    holds; what a model will say back is not.
 *  - **Elapsed** comes from persisted transitions. The active clock stops at an
 *    open decision rather than running to the reader's `Date.now()`, so a run
 *    that has been waiting on a person overnight does not report a night's work.
 */
export function qualityTelemetry(input: QualityTelemetryInput): QualityTelemetry {
  const priced = input.budget.cost_estimate
  const waits = input.waits ?? []
  const closed = waits.filter((wait) => wait.decidedAt !== null)
  const waitingMs = sumMs(closed.map((wait) => span(wait.requestedAt, wait.decidedAt)))
  const open = waits.find((wait) => wait.decidedAt === null)
  // The active clock ends at an open decision: everything after it is time
  // spent waiting, and its length is not yet a fact anybody has written down.
  const total = span(input.startedAt, open?.requestedAt ?? input.lastTransitionAt)
  const activeMs = total === null || waitingMs === null ? null : Math.max(total - waitingMs, 0)

  return {
    mode: input.mode,
    inputTokens: priced !== null
      ? { kind: 'measured', value: priced.input_tokens }
      : hostTokens(input.usage?.inputTokens) ?? estimatedTokens(input.inputPacket),
    outputTokens: priced !== null
      ? { kind: 'measured', value: priced.output_tokens }
      : hostTokens(input.usage?.outputTokens) ?? UNAVAILABLE_TOKENS,
    estimatedCost: priced === null
      ? { kind: 'unavailable', currency: null, value: null }
      : { kind: 'measured', currency: priced.currency, value: priced.total },
    activeElapsed: elapsed(activeMs),
    waitingElapsed: closed.length === 0 ? UNAVAILABLE_ELAPSED : elapsed(waitingMs),
    dispatches: input.dispatches,
  }
}

function hostTokens(value: number | null | undefined): { kind: MeasurementKind; value: number } | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? { kind: 'measured', value } : null
}

/** Task 6's documented byte estimate, labelled as one. */
function estimatedTokens(packet: string | null | undefined): { kind: MeasurementKind; value: number | null } {
  if (packet === null || packet === undefined) return UNAVAILABLE_TOKENS
  const measured = measureTokens(packet)
  return { kind: measured.kind, value: measured.value }
}

function elapsed(valueMs: number | null): { kind: MeasurementKind; valueMs: number | null } {
  return valueMs === null ? UNAVAILABLE_ELAPSED : { kind: 'measured', valueMs }
}

/** Milliseconds between two persisted timestamps, or `null` when either is missing or unusable. */
function span(from: string | null | undefined, to: string | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null
  const value = Date.parse(to) - Date.parse(from)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** `null` if any interval is unusable: a partial sum would understate the wait it claims to total. */
function sumMs(values: readonly (number | null)[]): number | null {
  let total = 0
  for (const value of values) {
    if (value === null) return null
    total += value
  }
  return total
}

export async function readTelemetry(projectDir: string, options: { limit?: number } = {}): Promise<Telemetry> {
  const history = await readRunHistory(projectDir, options)
  // A project with no config still has a history worth reporting: the config
  // supplies modes and closing sets, and their absence costs those two columns
  // rather than the whole table.
  const config = await loadConfig(projectDir).catch(() => null)
  const modes = new Map<string, SpecialistMode>(Object.entries(config?.specialists ?? {}))

  const rows = new Map<string, SpecialistRow>()
  const rowFor = (agent: string): SpecialistRow => {
    const existing = rows.get(agent)
    if (existing !== undefined) return existing
    const created: SpecialistRow = {
      agent,
      mode: modes.get(agent) ?? null,
      drafted: 0,
      skipped: 0,
      landed: 0,
      results: { pass: 0, fail: 0, blocked: 0 },
      findings: { high: 0, medium: 0, low: 0 },
      runs: 0,
      last_seen: null,
    }
    rows.set(agent, created)
    return created
  }

  let cycles = 0
  for (const run of history) {
    cycles += run.cycles.length
    // Every name this run mentioned, so `runs` counts runs and not cycles.
    const mentioned = new Set<string>()
    // The closing pass is walked beside the cycles: a closing agent appears in
    // no cycle roster, and leaving it out here would erase `docs` from this
    // report entirely the moment idea 9 moved it out of `available`.
    const passes: CycleRecord[] = run.closing === null ? run.cycles : [...run.cycles, run.closing]

    for (const cycle of passes) {
      for (const agent of new Set(cycle.selected)) {
        rowFor(agent).drafted += 1
        mentioned.add(agent)
      }
      for (const agent of Object.keys(cycle.skipped)) {
        rowFor(agent).skipped += 1
        mentioned.add(agent)
      }
      const landed = new Set<string>()
      for (const record of cycle.agents) {
        const row = rowFor(record.name)
        row.results[record.status] += 1
        for (const finding of record.findings) row.findings[finding.severity] += 1
        landed.add(record.name)
        mentioned.add(record.name)
      }
      for (const agent of landed) rowFor(agent).landed += 1
    }

    for (const agent of mentioned) {
      const row = rowFor(agent)
      row.runs += 1
      // The walk is newest first, so the first run to mention an agent is the
      // last one that did.
      row.last_seen ??= run.run_id
    }
  }

  // Names from the tracks' `closing` sets, on top of every name a roster
  // mentioned. A closing agent that has never been dispatched appears in no
  // roster anywhere, and a report that only knew rosters would answer "docs?
  // never heard of it" for an agent the config runs on every passing build.
  //
  // Gated on there being a history at all: a project that has never run has
  // nothing to report about any agent, and rows of zeroes would be a report
  // about the config rather than about what happened.
  if (config !== null && history.length > 0) {
    for (const track of Object.values(config.tracks)) for (const agent of track.closing) rowFor(agent)
  }

  // Flagged is computed over every row, before the cap: a specialist the cap
  // dropped is by definition one of the least-drafted, but the threshold is on
  // `drafted` and the ordering is too, so a future cap on a different key would
  // otherwise silently stop flagging the rows it dropped.
  //
  // **An agent a track pins is never flagged, however quiet it is.** The line
  // prescribes two remedies — `specialists.<agent>: never`, or trimming the
  // track's `available` — and for a pinned name both are wrong: `never` is
  // refused by `ConfigSchema` for every one of `pinnedAgents`' four categories,
  // so an operator who follows the advice writes a `config.yaml` that no
  // longer parses and every op fails until it is repaired by hand; and a pinned
  // name is generally not in `available` to trim (`docs` closes `build`;
  // `scout` drafts its map and could not be trimmed either, because a map
  // drafted by a name the leader cannot draft is refused too).
  //
  // These names still reach the report: `rosterSet` forces every `required`
  // name into `cycle.selected`, so `builder` and `verifier` accrue a draft
  // every cycle — and a builder that passes files no findings by design —
  // while `closingRosterSet` puts `docs` in the roster of every passing build.
  // Five green cycles is all it takes. The word the surfaces use is
  // "specialist", and that is exactly the *unpinned* set.
  const pinned = new Set<string>()
  if (config !== null) for (const track of Object.values(config.tracks)) for (const agent of pinnedAgents(track)) pinned.add(agent)

  const ordered = [...rows.values()].sort(byDraftedThenName)
  const flagged = ordered
    .filter(
      (row) =>
        !pinned.has(row.agent) &&
        row.drafted >= TELEMETRY_FLAG_DRAFTS &&
        row.findings.high === 0 &&
        row.findings.medium === 0,
    )
    .map((row) => row.agent)

  return {
    runs: history.length,
    cycles,
    specialists: ordered.slice(0, TELEMETRY_MAX_ROWS),
    truncated: Math.max(0, ordered.length - TELEMETRY_MAX_ROWS),
    flagged,
  }
}

/** Name breaks the tie, so two identical projects produce identical tables. */
function byDraftedThenName(a: SpecialistRow, b: SpecialistRow): number {
  return b.drafted - a.drafted || a.agent.localeCompare(b.agent)
}
