/**
 * DOM-free derivations the Run panel needs and nothing else does — ported
 * from `panels/run.js`'s own module-level helpers, which is why each keeps
 * that file's comment.
 */
import { elapsed } from '../lib/fmt.js'
import type {
  MeasurementKind,
  Preflight,
  QualityBudget,
  QualityBudgetField,
  QualityDimension,
  QualityLedger,
  QualityRunView,
  QualityTelemetry,
} from '../types/protocol.js'

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

/* ── the pinned quality policy ────────────────────────────────────────────── */

/** `QualityLedgerSchema`'s own order — the order the policy plans them in. */
export const QUALITY_DIMENSIONS: readonly QualityDimension[] = ['correctness', 'security', 'alignment', 'regression', 'ui']

/** `QualityBudgetFieldSchema`'s own order — the only four ceilings an amendment may name. */
export const QUALITY_BUDGET_FIELDS: readonly QualityBudgetField[] = [
  'max_cycles',
  'max_dispatches',
  'max_context_tokens_per_dispatch',
  'max_repair_attempts',
]

export interface LedgerRow {
  dimension: QualityDimension
  entry: QualityLedger['dimensions'][QualityDimension]
}

/** The five dimensions in a fixed order, so two runs' ledgers read the same way. */
export function qualityLedgerRows(ledger: QualityLedger): LedgerRow[] {
  return QUALITY_DIMENSIONS.map((dimension) => ({ dimension, entry: ledger.dimensions[dimension] }))
}

/**
 * One measurement, ready to draw.
 *
 * `value === null` is the whole of what `unavailable` means here, and the row
 * carries the sentence to print instead rather than a formatted zero: an
 * invented token count or price is worse than a blank, because a person budgets
 * against it. `kind` rides along so an *estimate* is never drawn as a
 * measurement — the template says so in words, not in styling.
 */
export interface TelemetryRow {
  key: 'inputTokens' | 'outputTokens' | 'cost' | 'activeTime' | 'waitingTime' | 'dispatches'
  /** The row's label key. */
  label: string
  kind: MeasurementKind
  /** The formatted value, or null when the engine could not measure it. */
  value: string | null
  /** The sentence to print in place of a value there is none of. */
  unavailable: string
}

/**
 * What this run has cost, in priority order: what it consumed, what it was
 * priced at, how long it worked, how long it waited on a person.
 *
 * Nothing here computes a measurement the engine did not make. A `null` value
 * on an `unavailable` field stays null all the way to the screen.
 */
export function qualityTelemetryRows(telemetry: QualityTelemetry): TelemetryRow[] {
  return [
    {
      key: 'inputTokens',
      label: 'quality.inputTokens',
      kind: telemetry.inputTokens.kind,
      value: telemetry.inputTokens.value === null ? null : String(telemetry.inputTokens.value),
      unavailable: 'quality.tokensUnavailable',
    },
    {
      key: 'outputTokens',
      label: 'quality.outputTokens',
      kind: telemetry.outputTokens.kind,
      value: telemetry.outputTokens.value === null ? null : String(telemetry.outputTokens.value),
      unavailable: 'quality.tokensUnavailable',
    },
    {
      key: 'cost',
      label: 'quality.cost',
      kind: telemetry.estimatedCost.kind,
      // The currency is the record's own, beside the number rather than
      // formatted into it: `Intl.NumberFormat` would render the amount in the
      // reader's digits, and this is a price a person reconciles against a bill.
      value:
        telemetry.estimatedCost.value === null
          ? null
          : `${telemetry.estimatedCost.value} ${telemetry.estimatedCost.currency ?? ''}`.trim(),
      unavailable: 'quality.costUnavailable',
    },
    {
      key: 'activeTime',
      label: 'quality.activeTime',
      kind: telemetry.activeElapsed.kind,
      value: telemetry.activeElapsed.valueMs === null ? null : elapsed(telemetry.activeElapsed.valueMs),
      unavailable: 'quality.timeUnavailable',
    },
    {
      key: 'waitingTime',
      label: 'quality.waitingTime',
      kind: telemetry.waitingElapsed.kind,
      value: telemetry.waitingElapsed.valueMs === null ? null : elapsed(telemetry.waitingElapsed.valueMs),
      unavailable: 'quality.timeUnavailable',
    },
    {
      // Two identifiers side by side, like the strike counter: `7/20` must
      // never become `٧/٢٠`. Always measured — it is a count of records.
      key: 'dispatches',
      label: 'quality.dispatches',
      kind: 'measured',
      value: `${telemetry.dispatches.used}/${telemetry.dispatches.max}`,
      unavailable: 'quality.unavailable',
    },
  ]
}

/** The four ceilings the run is actually working against. */
export function qualityBudgetRows(budget: QualityBudget): { field: QualityBudgetField; value: string }[] {
  return QUALITY_BUDGET_FIELDS.map((field) => ({ field, value: String(budget[field]) }))
}

export interface ModeComparison {
  mode: 'economy' | 'adaptive' | 'strict'
  selected: boolean
  dispatches: string
  cycles: string
  cost: TelemetryRow
}

/**
 * What each mode would cost for the run nobody has started yet.
 *
 * Drawn from the preflight's own previews, in `QualityModeSchema`'s order —
 * least review first — with the project's own mode marked rather than moved:
 * three peers a reader compares, not a recommendation and two alternatives.
 */
export function qualityComparisons(quality: Preflight['quality']): ModeComparison[] {
  return (['economy', 'adaptive', 'strict'] as const).map((mode) => {
    const preview = quality.comparisons[mode]
    const cost = preview.forecast.cost
    return {
      mode,
      selected: quality.selected.policy.mode === mode,
      dispatches: String(preview.policy.budget.max_dispatches),
      cycles: String(preview.policy.budget.max_cycles),
      cost: {
        key: 'cost',
        label: 'quality.cost',
        kind: cost.kind,
        value: cost.value === null ? null : `${cost.value} ${cost.currency ?? ''}`.trim(),
        unavailable: 'quality.costUnavailable',
      },
    }
  })
}

/**
 * The quality view to draw, or null.
 *
 * `lib/api.ts`'s `feed()` keeps the last good body when a fetch fails, which is
 * the right call for a transient one — a blip must not blank a policy the
 * reader is mid-decision on. A **404** is not transient: it says this run has no
 * quality record, and the body still held is some *other* run's. Drawing that
 * under this run's heading would attribute one run's evidence to another, so
 * this is the one failure the panels drop the held view for.
 */
export function qualityViewFor(view: QualityRunView | null, error: string | null): QualityRunView | null {
  return error === 'error.notFound' ? null : view
}

/**
 * Which of the two operator doors this run is stopped at, if either.
 *
 * Read off the state summary rather than off the quality document: a suspension
 * is a *status*, and the document says what is being decided, not whether the
 * run is still waiting for it.
 */
export function qualityDoors(
  state: { status: string } | null,
  view: QualityRunView | null,
): { decision: boolean; budget: boolean } {
  return {
    decision: state?.status === 'waiting_for_user' && view?.pendingRequest != null,
    budget: state?.status === 'budget_exhausted' && view !== null,
  }
}
