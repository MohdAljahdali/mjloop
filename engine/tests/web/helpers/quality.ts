import type { QualityRunView } from '../../../src/web/protocol.js'
import type { QualityLedger, QualityVerdict } from '../../../src/schemas/quality.js'

/**
 * The `/api/runs/<id>/quality` body, as the two panels that draw it see it.
 *
 * Shared between `panel-run.test.ts` and `panel-evidence.test.ts` because both
 * render the same document — the Run panel with the operator's two doors beside
 * it, the Evidence panel read-only — and a second copy of a fixture this shape
 * is how the two views quietly stop testing the same record.
 */

const DIGEST = 'a'.repeat(64)

export function ledgerEntry(status: QualityVerdict, patch: Record<string, unknown> = {}): QualityLedger['dimensions']['ui'] {
  return {
    applicability: status === 'not_applicable' ? 'not_applicable' : 'required',
    status,
    required_evidence: ['test'],
    evidence_refs: ['cycle-02/verify/test.log'],
    reason: `recorded ${status}`,
    inputs_fingerprint: DIGEST,
    worktree_digest: null,
    recorded_cycle: 2,
    checked_at: '2026-07-28T10:00:00.000Z',
    invalidated_at: null,
    ...patch,
  } as QualityLedger['dimensions']['ui']
}

const BUDGET = {
  max_cycles: 5,
  max_dispatches: 20,
  max_context_tokens_per_dispatch: 16_000,
  max_repair_attempts: 2,
  cost_estimate: null,
}

/** A pinned, actively enforced strict run whose cost nothing has priced. */
export function qualityView(patch: Partial<QualityRunView> = {}): QualityRunView {
  return {
    policy: {
      version: 1,
      pinned_at: '2026-07-28T09:00:00.000Z',
      mode: 'strict',
      supervision: 'supervised',
      enforcement: 'active',
      source: 'explicit',
      risk: { level: 'medium', signals: [] },
      budget: BUDGET,
      initial_quality_plan: {
        correctness: { value: 'required', reason: 'always' },
        security: { value: 'required', reason: 'auth touched' },
        alignment: { value: 'required', reason: 'always' },
        regression: { value: 'required', reason: 'always' },
        ui: { value: 'not_applicable', reason: 'no surface' },
      },
      dispatches: [{ agent: 'security', instance: null, dimensions: ['security'], reason: 'the change touches authorisation' }],
    },
    ledger: {
      version: 1,
      cycle: 2,
      dimensions: {
        correctness: ledgerEntry('pass'),
        security: ledgerEntry('pass'),
        alignment: ledgerEntry('pending'),
        regression: ledgerEntry('fail'),
        ui: ledgerEntry('not_applicable'),
      },
    },
    amendments: [],
    effectiveBudget: BUDGET,
    pendingRequest: null,
    telemetry: {
      mode: 'strict',
      inputTokens: { kind: 'estimated', value: 4200 },
      outputTokens: { kind: 'unavailable', value: null },
      estimatedCost: { kind: 'unavailable', currency: null, value: null },
      activeElapsed: { kind: 'measured', valueMs: 192_000 },
      waitingElapsed: { kind: 'unavailable', valueMs: null },
      dispatches: { used: 7, max: 20 },
    },
    ...patch,
  } as QualityRunView
}

/** One operation waiting on a person, already applied to the worktree. */
export function pendingRequest(patch: Record<string, unknown> = {}): QualityRunView['pendingRequest'] {
  return {
    run: '2026-07-28-001',
    fingerprint: 'b'.repeat(64),
    candidate: {
      kind: 'table_drop',
      targets: ['db/migrations/003_drop_users.sql'],
      operation: 'DROP TABLE users',
      rollback: null,
    },
    status: 'pending',
    applied: true,
    requested_at: '2026-07-28T11:00:00.000Z',
    decided_at: null,
    decided_by: null,
    note: null,
    ...patch,
  } as NonNullable<QualityRunView['pendingRequest']>
}
