import { createHash } from 'node:crypto'
import type {
  QualityDimension,
  QualityLedger,
  QualityPolicy,
  QualityVerdict,
} from '../schemas/quality.js'
import type { State } from '../schemas/state.js'
import { worktreeDigest } from '../store/git.js'
import { updateLedger } from '../store/quality-store.js'
import type { Clock } from '../store/state-store.js'
import { resolveQualityEvidenceReceipts } from './quality-evidence.js'

const DIMENSIONS: readonly QualityDimension[] = ['correctness', 'security', 'alignment', 'regression', 'ui']
const UI_SURFACE_PATH = /\.(vue|tsx|jsx|css|scss|dart|svelte|html|swift|kt)$/i
const SECURITY_SURFACE_PATH = /(^|\/)(auth|permissions?|polic(?:y|ies)|api|routes?|controllers?|migrations?|schema|database)(\/|\.|$)/i

export interface QualityEvidenceInput {
  dimension: QualityDimension
  verdict: Exclude<QualityVerdict, 'not_applicable'>
  evidenceRefs: string[]
  reason: string
  criteria: string[]
  changedFiles: string[]
  worktree: string | null
}

export interface QualityChange {
  files: string[]
  criteriaChanged: boolean
  goalChanged?: boolean
  commandsChanged?: boolean
}

export class QualityIncompleteError extends Error {
  constructor(readonly violations: string[]) {
    super(`quality evidence is incomplete: ${violations.join('; ')}`)
    this.name = 'QualityIncompleteError'
  }
}

/**
 * Records one engine-validated verdict. Agent supplied worktree identity is a
 * claim only: the engine samples git while holding the ledger transition and
 * refuses a claim it cannot match.
 */
export async function recordQualityEvidence(
  projectDir: string,
  state: State,
  input: QualityEvidenceInput,
  now: Clock = () => new Date(),
): Promise<QualityLedger> {
  rejectNonEvidenceVerdict(input)
  return updateLedger(projectDir, state, async (ledger) => {
    const entry = ledger.dimensions[input.dimension]
    if (entry.applicability !== 'required') {
      throw new Error(`${input.dimension} is not applicable; only the analyzer may raise its applicability`)
    }

    const digest = await worktreeDigest(projectDir)
    const fingerprint = evidenceFingerprint(state, input.dimension, input.criteria, input.changedFiles, input.evidenceRefs, digest)
    const stampedAt = now().toISOString()
    if (digest !== input.worktree) {
      setPending(entry, {
        reason: `Evidence is stale: submitted worktree digest does not match the current worktree for ${input.dimension}.`,
        fingerprint,
        invalidatedAt: stampedAt,
      })
      return
    }

    if (input.evidenceRefs.length === 0) {
      setPending(entry, {
        reason: `Evidence references are missing for ${input.dimension}.`,
        fingerprint,
        invalidatedAt: stampedAt,
      })
      return
    }

    const resolved = await resolveQualityEvidenceReceipts(projectDir, state, input.verdict, input.evidenceRefs)
    const missingKinds = entry.required_evidence.filter((kind) => !resolved.receipts.some((receipt) => receipt.kind === kind))
    if (input.verdict === 'pass' && missingKinds.length > 0) {
      setPending(entry, {
        reason: `Missing required evidence for ${input.dimension}: ${missingKinds.join(', ')}.`,
        fingerprint,
        invalidatedAt: stampedAt,
      })
      return
    }

    entry.status = input.verdict
    entry.evidence_refs = sorted(resolved.receipts.map((receipt) => receipt.ref))
    entry.reason = input.reason.trim()
    entry.inputs_fingerprint = fingerprint
    entry.worktree_digest = digest
    entry.recorded_cycle = state.cycle
    entry.checked_at = stampedAt
    entry.invalidated_at = null
  })
}

/**
 * Invalidates only dimensions touched by a concrete source/criteria/command
 * change. A UI path may raise UI applicability; this function never lowers it.
 */
export async function invalidateQualityEvidence(
  projectDir: string,
  state: State,
  change: QualityChange,
  now: Clock = () => new Date(),
): Promise<QualityLedger> {
  return updateLedger(projectDir, state, async (ledger) => {
    const digest = await worktreeDigest(projectDir)
    const stampedAt = now().toISOString()
    const files = sorted(change.files)
    const hasUiFile = files.some((file) => UI_SURFACE_PATH.test(file))
    const hasSecurityFile = files.some((file) => SECURITY_SURFACE_PATH.test(file))
    const requirementsChanged = change.criteriaChanged || change.goalChanged === true

    if (hasUiFile && ledger.dimensions.ui.applicability === 'not_applicable') {
      const ui = ledger.dimensions.ui
      ui.applicability = 'required'
      ui.required_evidence = ['agent']
      ui.reason = `User-visible files require UI evidence: ${files.filter((file) => UI_SURFACE_PATH.test(file)).join(', ')}.`
    }

    for (const dimension of DIMENSIONS) {
      const entry = ledger.dimensions[dimension]
      const affected = requirementsChanged
        || (change.commandsChanged === true && entry.required_evidence.some(isExecutableEvidence))
        || (files.length > 0 && ((dimension === 'correctness' || dimension === 'regression')
          || (dimension === 'security' && hasSecurityFile)
          || dimension === 'alignment'
          || (dimension === 'ui' && hasUiFile)))
      if (!affected || entry.applicability !== 'required') continue

      const causes = [
        requirementsChanged ? 'goal or acceptance criteria changed' : null,
        change.commandsChanged === true && entry.required_evidence.some(isExecutableEvidence) ? 'pinned commands changed' : null,
        files.length > 0 ? `affected files changed: ${files.join(', ')}` : null,
      ].filter((cause): cause is string => cause !== null)
      setPending(entry, {
        reason: `Evidence invalidated for ${dimension}: ${causes.join('; ')}.`,
        fingerprint: evidenceFingerprint(state, dimension, [], files, [], digest),
        invalidatedAt: stampedAt,
      })
    }
  })
}

/**
 * The cycle-advance seam for Task 10. It makes null-digest evidence explicitly
 * cycle scoped before any later close check can inspect the ledger.
 */
export async function advanceQualityLedgerCycle(
  projectDir: string,
  state: State,
  now: Clock = () => new Date(),
): Promise<QualityLedger> {
  return updateLedger(projectDir, state, (ledger) => {
    if (state.cycle < ledger.cycle) throw new Error(`quality ledger cannot move from cycle ${ledger.cycle} back to ${state.cycle}`)
    if (state.cycle === ledger.cycle) return
    ledger.cycle = state.cycle
    const stampedAt = now().toISOString()
    for (const dimension of DIMENSIONS) {
      const entry = ledger.dimensions[dimension]
      if (entry.applicability !== 'required' || entry.status !== 'pass' || entry.worktree_digest !== null || entry.recorded_cycle === state.cycle) continue
      setPending(entry, {
        reason: `Evidence is stale: no worktree digest binds ${dimension} across cycle ${state.cycle}.`,
        fingerprint: evidenceFingerprint(state, dimension, [], [], [], null),
        invalidatedAt: stampedAt,
      })
    }
  })
}

/** Pure closure predicate: it trusts only the persisted policy and ledger. */
export function closingViolations(policy: QualityPolicy, ledger: QualityLedger): string[] {
  const violations: string[] = []
  for (const dimension of DIMENSIONS) {
    const entry = ledger.dimensions[dimension]
    const policyRequires = policy.initial_quality_plan[dimension].value === 'required'
    const required = policyRequires || entry.applicability === 'required'
    if (!required) continue
    if (entry.applicability !== 'required') {
      violations.push(`${dimension}: required by the pinned policy but marked not applicable`)
      continue
    }
    if (entry.status !== 'pass') {
      const detail = entry.status === 'blocked' ? 'required tool is blocked' : entry.status === 'fail' ? 'evidence is contradicted' : 'evidence is missing or pending'
      violations.push(`${dimension}: ${detail}`)
      continue
    }
    if (entry.invalidated_at !== null) {
      violations.push(`${dimension}: evidence is stale`)
      continue
    }
    if (entry.worktree_digest === null && entry.recorded_cycle !== ledger.cycle) {
      violations.push(`${dimension}: null-worktree evidence is stale for ledger cycle ${ledger.cycle}`)
      continue
    }
    if (entry.required_evidence.length === 0 || entry.evidence_refs.length === 0) {
      violations.push(`${dimension}: required evidence is missing`)
    }
  }
  return violations
}

export function assertQualityCloseable(policy: QualityPolicy, ledger: QualityLedger): void {
  const violations = closingViolations(policy, ledger)
  if (violations.length > 0) throw new QualityIncompleteError(violations)
}

function rejectNonEvidenceVerdict(input: QualityEvidenceInput): void {
  if (input.verdict === ('not_applicable' as QualityEvidenceInput['verdict'])) {
    throw new Error('agents cannot set a quality dimension to not_applicable')
  }
}

function isExecutableEvidence(kind: 'command' | 'test' | 'agent' | 'human'): boolean {
  return kind === 'command' || kind === 'test'
}

function setPending(
  entry: QualityLedger['dimensions'][QualityDimension],
  value: { reason: string; fingerprint: string; invalidatedAt: string },
): void {
  entry.status = 'pending'
  entry.evidence_refs = []
  entry.reason = value.reason
  entry.inputs_fingerprint = value.fingerprint
  entry.worktree_digest = null
  entry.recorded_cycle = null
  entry.checked_at = null
  entry.invalidated_at = value.invalidatedAt
}

function evidenceFingerprint(
  state: State,
  dimension: QualityDimension,
  criteria: string[],
  changedFiles: string[],
  evidenceRefs: string[],
  digest: string | null,
): string {
  return sha256(canonicalJson({
    dimension,
    criteria: sorted(criteria),
    changed_files: sorted(changedFiles),
    evidence_refs: sorted(evidenceRefs),
    worktree: digest ?? { unavailable: true, run: state.run_id, cycle: state.cycle },
  }))
}

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
