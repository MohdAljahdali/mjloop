import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  findTrack,
  type Config,
  type QualityConfigSource,
  type QualityMode,
  type Track,
} from '../schemas/config.js'
import {
  QualityLedgerSchema,
  QualityPolicySchema,
  type MeasurementKind,
  type QualityDimension,
  type QualityDispatch,
  type QualityLedger,
  type QualityPolicy,
  type Supervision,
} from '../schemas/quality.js'
import type { State } from '../schemas/state.js'
import { loadConfigRecord } from '../store/config-store.js'
import { readFeatureBrief } from '../store/feature-store.js'
import { worktreeDigest } from '../store/git.js'
import { readStory } from '../store/plan-store.js'
import { readAcceptedProfile } from '../store/project-profile-store.js'
import {
  qualityFiles,
  readLedger,
  readPolicy,
  writeLedger,
  writePolicyOnce,
} from '../store/quality-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import {
  compareQualityCandidates,
  deriveQualityBudget,
  measureTokens,
  type TokenMeasurement,
} from './quality-budget.js'
import type { PreflightInput } from './preflight.js'
import { analyzeQualityRisk, type QualityRiskInput } from './quality-risk.js'
import { NoActiveRunError } from './run.js'

export interface QualityPolicyInput extends Omit<QualityRiskInput, 'track'> {
  config: Config
  qualitySource: QualityConfigSource
  supervision: Supervision
  track: Track
}

export interface QualityPolicyPreview {
  policy: QualityPolicy
  forecast: {
    inputTokens: TokenMeasurement
    outputTokens: TokenMeasurement
    cost: { kind: MeasurementKind; currency: string | null; value: number | null }
    elapsed: { kind: MeasurementKind; valueMs: number | null }
  }
}

interface ProjectPolicyInput {
  config: Config
  qualitySource: QualityConfigSource
  track: Track
  goal: string
  story?: string | null | undefined
  feature?: string | null | undefined
  supervision: Supervision
  allowMissingStory?: boolean
  includeWorktreeDigest?: boolean
}

type RecordIntegrity = 'missing' | 'valid' | 'invalid'

const DIMENSIONS: readonly QualityDimension[] = ['correctness', 'security', 'alignment', 'regression', 'ui']

const REQUIRED_EVIDENCE: Record<QualityDimension, Array<'command' | 'file' | 'test'>> = {
  correctness: ['test'],
  security: ['command'],
  alignment: ['file'],
  regression: ['test'],
  ui: ['file'],
}

export class QualityPolicyIntegrityError extends Error {
  constructor(detail: string) {
    super(`quality policy integrity failure: ${detail}`)
    this.name = 'QualityPolicyIntegrityError'
  }
}

/** Build one immutable policy from already-resolved, deterministic inputs. */
export async function buildQualityPolicy(input: QualityPolicyInput, now: Clock): Promise<QualityPolicy> {
  const analysis = analyzeQualityRisk(riskInput(input))
  const dispatches = qualityDispatchCandidates(input, analysis.applicability, analysis.level)
  const repairAttempts = input.config.orchestration.execution.repair_attempts
  const targetedRepairs = Array.from({ length: repairAttempts }, (_, index): QualityDispatch => ({
    agent: dispatches[0]!.agent,
    instance: `repair-${index + 1}`,
    dimensions: dispatches[0]!.dimensions,
    reason: `Targeted repair attempt ${index + 1} for the pinned quality plan.`,
  }))
  const budget = deriveQualityBudget({
    mode: input.config.orchestration.quality.mode,
    track: input.track,
    repairAttempts,
    dispatches,
    targetedRepairs,
  })
  const explicit = input.qualitySource === 'explicit'

  return QualityPolicySchema.parse({
    version: 1,
    pinned_at: now().toISOString(),
    mode: input.config.orchestration.quality.mode,
    supervision: input.supervision,
    source: explicit ? 'explicit' : 'legacy',
    enforcement: explicit ? 'active' : 'shadow',
    risk: { level: analysis.level, signals: analysis.signals },
    budget,
    initial_quality_plan: analysis.applicability,
    dispatches,
  })
}

/**
 * Preview every mode from the same project evidence without opening a run or
 * writing any policy/ledger record.
 */
export async function previewQualityPolicies(
  projectDir: string,
  input: PreflightInput,
): Promise<Record<QualityMode, QualityPolicyPreview>> {
  const { config, qualitySource } = await loadConfigRecord(projectDir)
  const track = findTrack(config, input.track)
  if (track === undefined) throw new Error(`cannot preview unknown track "${input.track}"`)
  const evidence = await projectRiskInput(projectDir, {
    config,
    qualitySource,
    track,
    goal: input.goal ?? `Preview ${input.track} quality policy`,
    story: input.story,
    feature: input.feature,
    supervision: input.supervision ?? 'supervised',
    allowMissingStory: true,
    includeWorktreeDigest: true,
  })

  const candidates: Array<{
    mode: QualityMode
    preview: QualityPolicyPreview
    candidate: Parameters<typeof compareQualityCandidates>[0]
  }> = []
  for (const mode of ['economy', 'adaptive', 'strict'] as const) {
    const modeConfig: Config = {
      ...config,
      orchestration: {
        ...config.orchestration,
        quality: { mode },
      },
    }
    const policy = await buildQualityPolicy({ ...evidence, config: modeConfig, track }, () => new Date(0))
    const inputTokens = measureTokens(JSON.stringify({
      goal: evidence.goal,
      acceptance: evidence.acceptance,
      intendedFiles: evidence.intendedFiles,
      componentKinds: evidence.componentKinds,
      dispatches: policy.dispatches,
    }))
    const preview: QualityPolicyPreview = {
      policy,
      forecast: {
        inputTokens,
        outputTokens: { kind: 'unavailable', value: null },
        cost: { kind: 'unavailable', currency: null, value: null },
        elapsed: { kind: 'unavailable', valueMs: null },
      },
    }
    candidates.push({
      mode,
      preview,
      candidate: {
        id: mode,
        requiredDimensions: DIMENSIONS.filter(
          (dimension) => policy.initial_quality_plan[dimension].value === 'required',
        ),
        inputTokens,
        monetaryCost: { kind: 'unavailable', value: null },
        elapsedMs: { kind: 'unavailable', value: null },
        costProxy: { kind: 'dispatch_count', value: policy.dispatches.length },
        timeProxy: { kind: 'sequential_wave_count', value: policy.dispatches.length },
      },
    })
  }
  candidates.sort((left, right) => compareQualityCandidates(left.candidate, right.candidate))
  const previews = Object.fromEntries(candidates.map(({ mode, preview }) => [mode, preview])) as Record<
    QualityMode,
    QualityPolicyPreview
  >
  return previews
}

/**
 * Validate or bootstrap the policy belonging to the active state under the
 * same state lock that publishes its marker. A pre-policy run is always
 * shadow, even if the live config is explicit: the run itself predates the
 * opt-in pin and an upgrade may not silently change its behaviour.
 */
export async function ensureRunQualityPolicy(projectDir: string, now: Clock = () => new Date()): Promise<QualityPolicy> {
  let result: QualityPolicy | null = null
  let integrityError: QualityPolicyIntegrityError | null = null

  await new StateStore(projectDir, now).update(async (draft) => {
    if (draft.run_id === null || draft.track === null || draft.status === 'idle') throw new NoActiveRunError()
    const files = qualityFiles(projectDir, draft)
    const [policyStatus, ledgerStatus] = await Promise.all([
      inspectRecord(files.policy, QualityPolicySchema, false),
      inspectRecord(files.ledger, QualityLedgerSchema, true),
    ])
    const classification = classifyPolicyIntegrity({
      marker: draft.quality_policy_version,
      policy: policyStatus,
      ledger: ledgerStatus,
    })

    if (classification === 'halt') {
      integrityError = new QualityPolicyIntegrityError(
        `marker=${String(draft.quality_policy_version)}, policy=${policyStatus}, ledger=${ledgerStatus}`,
      )
      haltDraft(draft, integrityError.message)
      return
    }
    if (classification === 'ready' || classification === 'recover-marker') {
      result = await readPolicy(projectDir, draft)
      await readLedger(projectDir, draft)
      draft.quality_policy_version = 1
      return
    }

    try {
      const { config } = await loadConfigRecord(projectDir)
      const track = findTrack(config, draft.track)
      if (track === undefined) throw new Error(`active run track "${draft.track}" is no longer configured`)
      result = await buildProjectQualityPolicy(projectDir, {
        config,
        qualitySource: 'legacy',
        track,
        goal: draft.goal ?? 'Legacy run',
        story: draft.current.story,
        supervision: 'supervised',
      }, now)
      await writePolicyOnce(projectDir, draft, result)
      await writeLedger(projectDir, draft, createInitialQualityLedger(result, now))
      draft.quality_policy_version = 1
    } catch (error) {
      integrityError = new QualityPolicyIntegrityError(`legacy bootstrap could not write both records: ${messageOf(error)}`)
      haltDraft(draft, integrityError.message)
    }
  })

  if (integrityError !== null) throw integrityError
  if (result === null) throw new QualityPolicyIntegrityError('policy bootstrap completed without a readable policy')
  return result
}

export function createInitialQualityLedger(policy: QualityPolicy, now: Clock): QualityLedger {
  const stampedAt = now().toISOString()
  const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const applicability = policy.initial_quality_plan[dimension]
    return [dimension, {
      applicability: applicability.value,
      status: applicability.value === 'required' ? 'pending' : 'not_applicable',
      required_evidence: applicability.value === 'required' ? REQUIRED_EVIDENCE[dimension] : [],
      evidence_refs: [],
      reason: applicability.reason,
      inputs_fingerprint: sha256(canonicalJson({
        version: policy.version,
        pinned_at: policy.pinned_at,
        initialized_at: stampedAt,
        dimension,
        applicability,
      })),
      checked_at: null,
      invalidated_at: null,
    }]
  }))
  return QualityLedgerSchema.parse({ version: 1, dimensions })
}

/** The complete marker/policy/ledger truth table, kept pure for mutation tests. */
export function classifyPolicyIntegrity(input: {
  marker: 1 | null
  policy: RecordIntegrity
  ledger: RecordIntegrity
}): 'legacy-bootstrap' | 'recover-marker' | 'ready' | 'halt' {
  if (input.marker === 1) {
    return input.policy === 'valid' && input.ledger === 'valid' ? 'ready' : 'halt'
  }
  if (input.policy === 'missing' && input.ledger === 'missing') return 'legacy-bootstrap'
  if (input.policy === 'valid' && input.ledger === 'valid') return 'recover-marker'
  return 'halt'
}

/** Shared run-start seam: resolve current story, feature, profile and tree evidence once. */
export async function buildProjectQualityPolicy(
  projectDir: string,
  input: ProjectPolicyInput,
  now: Clock,
): Promise<QualityPolicy> {
  return buildQualityPolicy(await projectRiskInput(projectDir, input), now)
}

async function projectRiskInput(projectDir: string, input: ProjectPolicyInput): Promise<QualityPolicyInput> {
  const [story, feature, profile, digest] = await Promise.all([
    input.story === undefined || input.story === null
      ? null
      : input.allowMissingStory === true
        ? readStory(projectDir, input.story).catch(() => null)
        : readStory(projectDir, input.story),
    input.feature === undefined || input.feature === null ? null : readFeatureBrief(projectDir, input.feature),
    readAcceptedProfile(projectDir),
    input.includeWorktreeDigest === true ? worktreeDigest(projectDir) : Promise.resolve(null),
  ])
  const componentById = new Map((profile?.components ?? []).map((component) => [component.id, component]))
  const affected = feature?.brief.affectedComponents
    .map((id) => componentById.get(id))
    .filter((component) => component !== undefined) ?? []
  const componentKinds: string[] = affected.map((component) => component.technology)
  if (story?.frontmatter.ui === true) componentKinds.push('ui')

  return {
    ...input,
    acceptance: distinct([...(story?.frontmatter.acceptance ?? []), ...(feature?.brief.acceptance ?? [])]),
    intendedFiles: distinct([
      ...affected.map((component) => component.root),
      ...(story === null ? [] : [path.relative(projectDir, story.file)]),
    ]),
    // A digest is deliberately not decoded into invented paths. Carrying it as
    // a non-matching provenance token lets the deterministic input change when
    // the tree changes without claiming the engine knows which path caused it.
    changedFiles: digest === null ? [] : [`worktree-digest:${digest}`],
    componentKinds: distinct(componentKinds),
    priorFailures: [],
  }
}

function qualityDispatchCandidates(
  input: QualityPolicyInput,
  applicability: Record<QualityDimension, { value: 'required' | 'not_applicable'; reason: string }>,
  risk: 'low' | 'medium' | 'high',
): QualityDispatch[] {
  const required = DIMENSIONS.filter((dimension) => applicability[dimension].value === 'required')
  const permitted = [...input.track.required, ...input.track.available]
  const agent = permitted.includes('verifier') ? 'verifier' : permitted[0]
  if (agent === undefined) throw new Error('quality policy needs at least one track agent')
  const base: QualityDispatch = {
    agent,
    instance: null,
    dimensions: required,
    reason: 'Collect the deterministic evidence required by the pinned quality plan.',
  }
  if (input.config.orchestration.quality.mode === 'economy') return [base]
  if (input.config.orchestration.quality.mode === 'adaptive' && risk === 'low') return [base]
  return [base, {
    agent,
    instance: 'independent',
    dimensions: required,
    reason: 'Independently review the evidence required by the pinned quality plan.',
  }]
}

async function inspectRecord<T>(file: string, schema: z.ZodType<T>, allowBackup: boolean): Promise<RecordIntegrity> {
  const primary = await parseRecord(file, schema)
  if (primary === 'valid' || primary === 'missing' && !allowBackup) return primary
  if (!allowBackup) return 'invalid'
  const backup = await parseRecord(`${file}.bak`, schema)
  if (backup === 'valid') return 'valid'
  return primary === 'missing' && backup === 'missing' ? 'missing' : 'invalid'
}

async function parseRecord<T>(file: string, schema: z.ZodType<T>): Promise<RecordIntegrity> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    return schema.safeParse(value).success ? 'valid' : 'invalid'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'
  }
}

function haltDraft(draft: State, reason: string): void {
  draft.status = 'halted'
  draft.current.stage = 'halted'
  draft.halt_reason = reason
}

function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort()
}

function riskInput(input: QualityPolicyInput): QualityRiskInput {
  return {
    track: input.track.required.join(','),
    goal: input.goal,
    acceptance: input.acceptance,
    intendedFiles: input.intendedFiles,
    changedFiles: input.changedFiles,
    componentKinds: input.componentKinds,
    priorFailures: input.priorFailures,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
