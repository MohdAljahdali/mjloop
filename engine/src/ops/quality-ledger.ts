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
import { QualityEvidenceReceiptError, resolveQualityEvidenceReceipts } from './quality-evidence.js'

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

/** One dimension the engine refused to record, and the receipt refusal that says why. */
export interface QualityEvidenceRejection {
  dimension: QualityDimension
  error: QualityEvidenceReceiptError
}

/**
 * Records one engine-validated verdict. Agent supplied worktree identity is a
 * claim only: the engine samples git while holding the ledger transition and
 * refuses a claim it cannot match.
 *
 * One dimension, and a rejected receipt throws — the contract every caller
 * before batching was written against. It is now a batch of one, so the two
 * cannot drift.
 */
export async function recordQualityEvidence(
  projectDir: string,
  state: State,
  input: QualityEvidenceInput,
  now: Clock = () => new Date(),
): Promise<QualityLedger> {
  const { ledger, rejected } = await recordQualityEvidenceBatch(projectDir, state, [input], now)
  const failure = rejected[0]
  if (failure !== undefined) throw failure.error
  return ledger
}

/**
 * Records every verdict one dispatch produced in a single ledger transition.
 *
 * **One transition, one sample.** The worktree digest is taken once, inside the
 * lock, and every dimension in the batch is stamped against that same tree.
 * Recording a dispatch's four dimensions through four separate transitions
 * sampled git four times — four subprocesses per logged agent result, and four
 * chances for the tree to move between two dimensions of the *same* answer, so
 * one could be stamped fresh and the next marked stale for no reason a reader
 * could reconstruct.
 *
 * **Rejections are per dimension, refusals are not.** A receipt the engine will
 * not stand behind concerns exactly the dimension that cited it, so it is
 * returned in `rejected` with that dimension left untouched while the rest of
 * the batch lands. Everything else — a verdict an agent may not set, a
 * dimension the pinned plan marked not applicable — is a refusal of the whole
 * call and aborts the transaction, exactly as before.
 */
export async function recordQualityEvidenceBatch(
  projectDir: string,
  state: State,
  inputs: readonly QualityEvidenceInput[],
  now: Clock = () => new Date(),
): Promise<{ ledger: QualityLedger; rejected: QualityEvidenceRejection[] }> {
  for (const input of inputs) rejectNonEvidenceVerdict(input)

  const rejected: QualityEvidenceRejection[] = []
  const ledger = await updateLedger(projectDir, state, async (draft) => {
    // Cleared on every attempt: `updateLedger` may run its mutator more than
    // once across a retry, and a rejection list that accumulated would report
    // the same refusal twice.
    rejected.length = 0
    const digest = await worktreeDigest(projectDir)
    const stampedAt = now().toISOString()
    for (const input of inputs) {
      try {
        await applyEvidence(projectDir, state, draft, input, digest, stampedAt)
      } catch (error) {
        if (!(error instanceof QualityEvidenceReceiptError)) throw error
        rejected.push({ dimension: input.dimension, error })
      }
    }
  })
  return { ledger, rejected }
}

/** One dimension's transition, against a digest and a timestamp the whole batch shares. */
async function applyEvidence(
  projectDir: string,
  state: State,
  ledger: QualityLedger,
  input: QualityEvidenceInput,
  digest: string | null,
  stampedAt: string,
): Promise<void> {
  const entry = ledger.dimensions[input.dimension]
  if (entry.applicability !== 'required') {
    throw new Error(`${input.dimension} is not applicable; only the analyzer may raise its applicability`)
  }

  const fingerprint = evidenceFingerprint(state, input.dimension, input.criteria, input.changedFiles, input.evidenceRefs, digest)
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

  const resolved = await resolveQualityEvidenceReceipts(projectDir, state, input.verdict, input.evidenceRefs, digest)
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
  entry.recorded_cycle = resolved.recordedCycle
  ledger.cycle = state.cycle
  entry.checked_at = stampedAt
  entry.invalidated_at = null
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

/** Pure closure predicate: it trusts only the persisted policy and ledger. */
export function closingViolations(policy: QualityPolicy, ledger: QualityLedger, currentCycle: number): string[] {
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
    if (entry.worktree_digest === null && entry.recorded_cycle !== currentCycle) {
      violations.push(`${dimension}: null-worktree evidence is stale for current cycle ${currentCycle}`)
      continue
    }
    if (entry.required_evidence.length === 0 || entry.evidence_refs.length === 0) {
      violations.push(`${dimension}: required evidence is missing`)
    }
  }
  return violations
}

export function assertQualityCloseable(policy: QualityPolicy, ledger: QualityLedger, currentCycle: number): void {
  const violations = closingViolations(policy, ledger, currentCycle)
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
