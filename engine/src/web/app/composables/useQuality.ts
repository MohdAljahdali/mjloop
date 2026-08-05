/**
 * DOM-free derivations for the pinned quality policy — its ledger, its
 * ceilings, what the run has cost, and the mode comparison shown before a run
 * starts.
 *
 * Its own file rather than more of `useRun.ts`: every one of these is drawn by
 * the **Evidence** panel as well as the Run panel (and `QUALITY_BUDGET_FIELDS`
 * by the budget dialog), while that file's own header promises "derivations the
 * Run panel needs and nothing else does". A shared derivation living behind
 * that promise is how the next reader writes a second copy for Evidence instead
 * of reusing this one — the same reason the dialog state was carved out into
 * `useQualityDialogs.ts`.
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
