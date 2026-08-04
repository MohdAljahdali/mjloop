import type { QualityMode } from '../schemas/config.js'
import type {
  MeasurementKind,
  QualityAmendment,
  QualityBudget,
  QualityDimension,
  QualityDispatch,
  QualityPolicy,
} from '../schemas/quality.js'

export interface TokenMeasurement {
  value: number | null
  kind: MeasurementKind
}

export interface Tokenizer {
  count(text: string): number
}

export interface ContextEvidenceDigest {
  text: string
  relevance: number
}

export interface ContextPacketInput {
  mandatory: readonly string[]
  optional: readonly ContextEvidenceDigest[]
  ceiling: number
  tokenizer?: Tokenizer
}

export interface ContextPacketResult {
  status: 'fit' | 'budget_exhausted'
  text: string
  mandatory: string[]
  optional: ContextEvidenceDigest[]
  dropped: ContextEvidenceDigest[]
  tokens: TokenMeasurement
}

export interface CostInput {
  modelId?: string
  inputTokens?: TokenMeasurement
  outputTokens?: TokenMeasurement
  currency?: string
  inputUnitPrice?: number
  outputUnitPrice?: number
  pricingTableVersion?: string
}

export interface BudgetInput {
  mode: QualityMode
  track: { max_cycles: number; closing?: readonly string[] }
  repairAttempts: number
  dispatches: readonly QualityDispatch[]
  targetedRepairs: readonly QualityDispatch[]
  hostSafeInput?: number
  cost?: CostInput
}

export type QualityProxy =
  | { kind: 'dispatch_count'; value: number }
  | { kind: 'sequential_wave_count'; value: number }

export interface QualityCandidate {
  id: string
  requiredDimensions: readonly QualityDimension[]
  inputTokens: TokenMeasurement
  monetaryCost: TokenMeasurement
  elapsedMs: TokenMeasurement
  costProxy?: QualityProxy
  timeProxy?: QualityProxy
}

const CONTEXT_CEILINGS: Record<QualityMode, number> = {
  economy: 8_000,
  adaptive: 12_000,
  strict: 16_000,
}

/**
 * The instance `buildQualityPolicy` gives a targeted repair (`repair-1`,
 * `repair-2`, …). The budget counts repair attempts by exactly that spelling,
 * so the pin and the ceiling that limits it agree on one name rather than two.
 */
const REPAIR_INSTANCE = /^repair-\d+$/

export function isRepairInstance(instance: string | null): boolean {
  return instance !== null && REPAIR_INSTANCE.test(instance)
}

export function measureTokens(text: string, tokenizer?: Tokenizer): TokenMeasurement {
  if (tokenizer !== undefined) {
    const value = tokenizer.count(text)
    assertNonNegativeInteger(value, 'tokenizer count')
    return { value, kind: 'measured' }
  }
  return { value: Math.ceil(Buffer.byteLength(text, 'utf8') / 2), kind: 'estimated' }
}

export function contextCeiling(mode: QualityMode, hostSafeInput?: number): number {
  const profile = CONTEXT_CEILINGS[mode]
  if (hostSafeInput !== undefined) assertPositiveInteger(hostSafeInput, 'host-safe input ceiling')
  return hostSafeInput === undefined ? profile : Math.min(profile, hostSafeInput)
}

export function deriveQualityBudget(input: BudgetInput): QualityBudget {
  assertPositiveInteger(input.track.max_cycles, 'track max cycles')
  assertNonNegativeInteger(input.repairAttempts, 'repair attempts')
  const closingAgents = new Set(input.track.closing ?? [])
  const targetedRepairs = input.targetedRepairs.slice(0, input.repairAttempts)
  const maxDispatches =
    input.dispatches.length + strictSpecialists(input) + targetedRepairs.length + closingAgents.size
  assertPositiveInteger(maxDispatches, 'maximum dispatches')

  return {
    max_cycles: input.track.max_cycles,
    max_dispatches: maxDispatches,
    max_context_tokens_per_dispatch: contextCeiling(input.mode, input.hostSafeInput),
    max_repair_attempts: input.repairAttempts,
    cost_estimate: costEstimate(input.cost),
  }
}

/**
 * The further dispatches strict mode's roster adds on top of the policy's own:
 * one per dimension the pinned plan marks required (`planQualityDispatches`).
 *
 * Counted here because a ceiling that did not cover the roster its own mode
 * plans would suspend every strict run on its first cycle. The policy's base
 * dispatch carries exactly the required dimensions, so the count is available
 * without the track and config `planQualityDispatches` needs to decide *who*
 * runs — which is the part this budget does not care about.
 */
function strictSpecialists(input: BudgetInput): number {
  return input.mode === 'strict' ? (input.dispatches[0]?.dimensions.length ?? 0) : 0
}

export function fitContextPacket(input: ContextPacketInput): ContextPacketResult {
  assertPositiveInteger(input.ceiling, 'context packet ceiling')
  const mandatory = [...input.mandatory]
  const remaining = input.optional.map((digest, index) => ({ digest, index }))
  const dropped: ContextEvidenceDigest[] = []

  while (true) {
    const optional = remaining.map((entry) => entry.digest)
    const text = packetText(mandatory, optional)
    const tokens = measureTokens(text, input.tokenizer)
    if (tokens.value !== null && tokens.value <= input.ceiling) {
      return { status: 'fit', text, mandatory, optional, dropped, tokens }
    }
    if (remaining.length === 0) {
      return { status: 'budget_exhausted', text, mandatory, optional, dropped, tokens }
    }

    const lowest = remaining
      .slice()
      .sort((left, right) => left.digest.relevance - right.digest.relevance || left.index - right.index)[0]
    if (lowest === undefined) throw new Error('optional context selection unexpectedly empty')
    remaining.splice(remaining.indexOf(lowest), 1)
    dropped.push(lowest.digest)
  }
}

export function effectiveBudget(policy: QualityPolicy, amendments: QualityAmendment[]): QualityBudget {
  const budget: QualityBudget = {
    ...policy.budget,
    cost_estimate: policy.budget.cost_estimate === null ? null : { ...policy.budget.cost_estimate },
  }

  for (const amendment of amendments) {
    switch (amendment.field) {
      case 'max_cycles': budget.max_cycles = amendment.to; break
      case 'max_dispatches': budget.max_dispatches = amendment.to; break
      case 'max_context_tokens_per_dispatch': budget.max_context_tokens_per_dispatch = amendment.to; break
      case 'max_repair_attempts': budget.max_repair_attempts = amendment.to; break
    }
  }
  return budget
}

export function compareQualityCandidates(a: QualityCandidate, b: QualityCandidate): number {
  assertSameRequiredDimensions(a, b)

  const tokens = compareMeasurement(a.inputTokens, b.inputTokens)
  if (tokens !== 0) return tokens

  const cost = compareMeasurement(a.monetaryCost, b.monetaryCost)
  if (cost !== 0) return cost
  if (isUnavailable(a.monetaryCost) && isUnavailable(b.monetaryCost)) {
    const proxy = compareProxy(a.costProxy, b.costProxy)
    if (proxy !== 0) return proxy
  }

  const elapsed = compareMeasurement(a.elapsedMs, b.elapsedMs)
  if (elapsed !== 0) return elapsed
  if (isUnavailable(a.elapsedMs) && isUnavailable(b.elapsedMs)) {
    const proxy = compareProxy(a.timeProxy, b.timeProxy)
    if (proxy !== 0) return proxy
  }

  return compareCodeUnits(a.id, b.id)
}

function packetText(mandatory: readonly string[], optional: readonly ContextEvidenceDigest[]): string {
  return mandatory.concat(optional.map((digest) => digest.text)).join('\n')
}

function costEstimate(cost: CostInput | undefined): QualityBudget['cost_estimate'] {
  if (
    cost?.modelId === undefined || cost.modelId.length === 0 ||
    !isMeasuredTokenCount(cost.inputTokens) || !isMeasuredTokenCount(cost.outputTokens) ||
    cost.currency === undefined || cost.currency.length !== 3 ||
    !isFiniteNonNegative(cost.inputUnitPrice) || !isFiniteNonNegative(cost.outputUnitPrice) ||
    cost.pricingTableVersion === undefined || cost.pricingTableVersion.length === 0
  ) return null

  const total = cost.inputTokens.value * cost.inputUnitPrice + cost.outputTokens.value * cost.outputUnitPrice
  if (!isFiniteNonNegative(total)) return null

  return {
    model_id: cost.modelId,
    input_tokens: cost.inputTokens.value,
    output_tokens: cost.outputTokens.value,
    currency: cost.currency,
    input_unit_price: cost.inputUnitPrice,
    output_unit_price: cost.outputUnitPrice,
    pricing_table_version: cost.pricingTableVersion,
    total,
  }
}

function assertSameRequiredDimensions(a: QualityCandidate, b: QualityCandidate): void {
  const aDimensions = [...new Set(a.requiredDimensions)].sort(compareCodeUnits)
  const bDimensions = [...new Set(b.requiredDimensions)].sort(compareCodeUnits)
  if (aDimensions.length !== bDimensions.length || aDimensions.some((dimension, index) => dimension !== bDimensions[index])) {
    throw new Error('quality candidates must cover the same required dimensions')
  }
}

function compareMeasurement(a: TokenMeasurement, b: TokenMeasurement): number {
  const aAvailable = !isUnavailable(a)
  const bAvailable = !isUnavailable(b)
  if (!aAvailable) return bAvailable ? 1 : 0
  if (!bAvailable) return -1
  return a.value! - b.value!
}

function isUnavailable(measurement: TokenMeasurement): boolean {
  return measurement.kind === 'unavailable' || measurement.value === null
}

function isMeasuredTokenCount(measurement: TokenMeasurement | undefined): measurement is TokenMeasurement & { value: number } {
  return measurement?.kind === 'measured' && isNonNegativeInteger(measurement.value)
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!isNonNegativeInteger(value)) throw new RangeError(`${name} must be a finite nonnegative integer`)
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a finite positive integer`)
  }
}

function compareProxy(a: QualityProxy | undefined, b: QualityProxy | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return a.value - b.value || compareCodeUnits(a.kind, b.kind)
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
