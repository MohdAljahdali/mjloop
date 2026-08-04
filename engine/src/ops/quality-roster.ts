import crypto from 'node:crypto'
import { dispatchWaves, forbiddenSpecialists, permittedAgents, type Config, type Track } from '../schemas/config.js'
import type { QualityDimension, QualityDispatch, QualityPolicy } from '../schemas/quality.js'
import { contextCeiling, fitContextPacket, type ContextEvidenceDigest, type ContextPacketResult } from './quality-budget.js'
import type { RosterViolation } from './roster.js'

/**
 * A pinned policy names *what* evidence a dimension needs; this is the
 * translation into *who* runs — an existing track role, never a new one, and
 * a bounded context packet rather than the run's own transcript.
 *
 * Pure planning logic, deliberately: every input arrives already resolved
 * (`roster.ts` is the caller that reads config, track and the pinned policy
 * off disk), so the same plan is reproducible from the same four values with
 * no filesystem, network, or clock in reach.
 */
export interface QualityRosterInput {
  trackName: string
  track: Track
  config: Config
  policy: QualityPolicy
  goal: string
}

/** One planned dispatch: the policy's own shape, plus the context it would carry and a fingerprint of both. */
export interface PlannedQualityDispatch extends QualityDispatch {
  inputFingerprint: string
  context: ContextPacketResult
}

/**
 * Which existing track role can stand in for a dimension's specialist review,
 * tried in this order. `correctness` and `regression` have none — the base
 * and independent verifier dispatches already cover them — so both map to an
 * empty list, meaning strict mode adds nothing further for them.
 */
const SPECIALIST_ROLES: Record<QualityDimension, readonly string[]> = {
  correctness: [],
  security: ['security'],
  alignment: ['critic', 'plan-critic', 'story-critic'],
  regression: [],
  ui: ['ui-critic'],
}

/** What every dispatch's context packet closes with — fixed, since the shape every agent must return does not vary by dimension or mode. */
const OUTPUT_CONTRACT =
  'Return the standard AgentResult shape: status, summary, evidence, findings, files_touched, next_hint.'

/**
 * The dispatches a mode-aware roster would plan for this cycle: the policy's
 * own base (and, past economy, its independent-review duplicate) verbatim,
 * plus — in strict mode only — one further dispatch per dimension the policy
 * marks required, routed to a permitted specialist where the track has one
 * and to a named `verifier` instance where it does not.
 *
 * Never invents an agent role: every dispatch here resolves to a name
 * `permittedAgents` already grants the track, or to `verifier` under a
 * dimension-named instance — the same mechanism `runLog` already supports
 * for `--independent`.
 */
export function planQualityDispatches(input: QualityRosterInput): PlannedQualityDispatch[] {
  const dispatches: QualityDispatch[] = [...input.policy.dispatches]

  if (input.policy.mode === 'strict') {
    const permitted = permittedAgents(input.config, input.track)
    const forbidden = new Set(forbiddenSpecialists(input.config))
    for (const dimension of requiredDimensions(input.policy)) {
      dispatches.push(specialistDispatch(dimension, permitted, forbidden))
    }
  }

  const wave = waveIndex(input.track, dispatches.map((dispatch) => dispatch.agent))
  const ordered = [...dispatches].sort((left, right) =>
    (wave.get(left.agent) ?? Number.MAX_SAFE_INTEGER) - (wave.get(right.agent) ?? Number.MAX_SAFE_INTEGER) ||
    compareCodeUnits(left.agent, right.agent) ||
    compareCodeUnits(left.instance ?? '', right.instance ?? ''),
  )

  const ceiling = contextCeiling(input.policy.mode)
  return ordered.map((dispatch) => {
    const context = buildContext(input, dispatch, ceiling)
    return { ...dispatch, inputFingerprint: fingerprint(dispatch, context), context }
  })
}

/**
 * `roster.quality`: the selected base-agent set omits an agent a planned
 * quality dispatch needs. One violation per missing agent, sorted for a
 * deterministic report — the same shape `rosterViolations` returns for every
 * other rule a candidate composition can break.
 */
export function qualityRosterViolations(
  dispatches: readonly PlannedQualityDispatch[],
  selected: readonly string[],
): RosterViolation[] {
  const selectedSet = new Set(selected)
  const missing = [...new Set(dispatches.filter((dispatch) => !selectedSet.has(dispatch.agent)).map((dispatch) => dispatch.agent))]
  return missing.sort(compareCodeUnits).map((agent) => ({ code: 'roster.quality' as const, params: { agent } }))
}

function requiredDimensions(policy: QualityPolicy): QualityDimension[] {
  return (Object.keys(policy.initial_quality_plan) as QualityDimension[])
    .filter((dimension) => policy.initial_quality_plan[dimension].value === 'required')
}

function specialistDispatch(dimension: QualityDimension, permitted: Set<string>, forbidden: Set<string>): QualityDispatch {
  const specialist = SPECIALIST_ROLES[dimension].find((role) => permitted.has(role) && !forbidden.has(role))
  if (specialist !== undefined) {
    return {
      agent: specialist,
      instance: null,
      dimensions: [dimension],
      reason: `Independent ${dimension} review by the track's ${specialist} specialist, required by the pinned strict quality plan.`,
    }
  }
  return {
    agent: 'verifier',
    instance: dimension,
    dimensions: [dimension],
    reason: `The track has no permitted ${dimension} specialist — verifier covers it under a "${dimension}" instance instead of a new role.`,
  }
}

function waveIndex(track: Track, agents: readonly string[]): Map<string, number> {
  const unique = [...new Set(agents)]
  const waves = dispatchWaves(track, unique)
  const index = new Map<string, number>()
  waves.forEach((wave, position) => { for (const agent of wave) index.set(agent, position) })
  return index
}

/**
 * The bounded packet one dispatch would actually carry: goal, role, the
 * dispatch's own reason and the fixed output contract as mandatory text, the
 * policy's own risk evidence and per-dimension applicability reasons as
 * optional text `fitContextPacket` may drop under the mode's ceiling.
 *
 * Deliberately built from `policy` and `goal` alone — never the conversation
 * transcript and never raw tool output, which do not appear anywhere in this
 * function's inputs to begin with.
 */
function buildContext(input: QualityRosterInput, dispatch: QualityDispatch, ceiling: number): ContextPacketResult {
  const mandatory = [
    `Goal: ${input.goal}`,
    `Role: act as the ${input.trackName} track's ${dispatch.agent} role; only that role's mandate applies to this dispatch.`,
    `Reason: ${dispatch.reason}`,
    `Output contract: ${OUTPUT_CONTRACT}`,
  ]

  const optional: ContextEvidenceDigest[] = [
    ...dispatch.dimensions.map((dimension, index) => ({
      text: `Criteria (${dimension}): ${input.policy.initial_quality_plan[dimension].reason}`,
      relevance: 100 - index,
    })),
    ...input.policy.risk.signals.flatMap((signal) =>
      signal.evidence.map((evidence) => ({
        text: `Evidence (${signal.code}, ${signal.level}): ${evidence}`,
        relevance: RISK_RELEVANCE[signal.level],
      }))),
  ]

  return fitContextPacket({ mandatory, optional, ceiling })
}

const RISK_RELEVANCE: Record<'low' | 'medium' | 'high', number> = { high: 60, medium: 40, low: 20 }

function fingerprint(dispatch: QualityDispatch, context: ContextPacketResult): string {
  return crypto.createHash('sha256').update(canonicalJson({ dispatch, text: context.text })).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
