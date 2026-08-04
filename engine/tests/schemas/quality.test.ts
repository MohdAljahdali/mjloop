import { describe, expect, it } from 'vitest'
import {
  DestructiveRequestSchema,
  QualityAmendmentSchema,
  QualityLedgerSchema,
  QualityPolicySchema,
} from '../../src/schemas/quality.js'

const AT = '2026-08-04T10:36:00.000Z'

function policyFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    pinned_at: AT,
    mode: 'adaptive',
    supervision: 'supervised',
    enforcement: 'active',
    source: 'explicit',
    risk: { level: 'medium', signals: [] },
    budget: {
      max_cycles: 5,
      max_dispatches: 18,
      max_context_tokens_per_dispatch: 12_000,
      max_repair_attempts: 1,
      cost_estimate: null,
    },
    initial_quality_plan: {
      correctness: 'required',
      security: 'required',
      alignment: 'required',
      regression: 'required',
      ui: 'not_applicable',
    },
    dispatches: [{ agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'check the acceptance criteria' }],
    ...overrides,
  }
}

function ledgerFixture(overrides: Record<string, unknown> = {}) {
  const entry = {
    applicability: 'required',
    status: 'pending',
    required_evidence: ['test'],
    evidence_refs: [],
    reason: 'required by the pinned quality plan',
    inputs_fingerprint: 'a'.repeat(64),
    checked_at: null,
    invalidated_at: null,
  }

  return {
    version: 1,
    dimensions: {
      correctness: entry,
      security: entry,
      alignment: entry,
      regression: entry,
      ui: { ...entry, applicability: 'not_applicable', status: 'not_applicable', required_evidence: [] },
    },
    ...overrides,
  }
}

function amendment(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    run: '2026-08-04-001',
    field: 'max_dispatches',
    from: 18,
    to: 24,
    reason: 'one targeted repair',
    decided_at: AT,
    decided_by: 'operator',
    ...overrides,
  }
}

describe('QualityPolicySchema', () => {
  it('accepts a complete versioned policy', () => {
    expect(QualityPolicySchema.safeParse(policyFixture()).success).toBe(true)
  })

  it('rejects an unknown policy key', () => {
    expect(QualityPolicySchema.safeParse(policyFixture({ surprise: true })).success).toBe(false)
  })

  it('requires each dispatch to name at least one quality dimension', () => {
    expect(QualityPolicySchema.safeParse(policyFixture({ dispatches: [{ agent: 'verifier', instance: null, dimensions: [], reason: 'check' }] })).success).toBe(false)
  })
})

describe('QualityLedgerSchema', () => {
  it('requires exactly the five quality dimensions', () => {
    const { ui: _ui, ...withoutUi } = ledgerFixture().dimensions
    expect(QualityLedgerSchema.safeParse(ledgerFixture({ dimensions: withoutUi })).success).toBe(false)
  })

  it('rejects unknown ledger dimensions', () => {
    expect(QualityLedgerSchema.safeParse(ledgerFixture({ dimensions: { ...ledgerFixture().dimensions, performance: {} } })).success).toBe(false)
  })
})

describe('QualityAmendmentSchema', () => {
  it('accepts a one-way budget amendment and rejects a decrease', () => {
    expect(QualityAmendmentSchema.safeParse(amendment({ from: 18, to: 24 })).success).toBe(true)
    expect(QualityAmendmentSchema.safeParse(amendment({ from: 18, to: 12 })).success).toBe(false)
  })
})

describe('DestructiveRequestSchema', () => {
  it('accepts a bounded pending destructive request without raw capability material', () => {
    const request = {
      version: 1,
      run: '2026-08-04-001',
      operation_fingerprint: 'a'.repeat(64),
      kind: 'table_drop',
      targets: ['users'],
      operation: 'DROP TABLE users',
      reason: 'The replacement schema removes this table.',
      approval_impact: 'The table will be removed.',
      rejection_impact: 'The migration cannot continue.',
      rollback: null,
      completed_work: ['cycle-01/verify.json'],
      evidence_refs: ['cycle-01/verify.json'],
      requested_at: AT,
      capability_hash: 'b'.repeat(64),
      decision: null,
    }
    expect(DestructiveRequestSchema.safeParse(request).success).toBe(true)
  })

  it('rejects raw or malformed capability material', () => {
    const request = {
      version: 1, run: '2026-08-04-001', operation_fingerprint: 'a'.repeat(64), kind: 'table_drop', targets: ['users'],
      operation: 'DROP TABLE users', reason: 'needed', approval_impact: 'removes the table', rejection_impact: 'stops migration', rollback: null,
      completed_work: [], evidence_refs: [], requested_at: AT, capability_hash: 'raw-secret-token', decision: null,
    }
    expect(DestructiveRequestSchema.safeParse(request).success).toBe(false)
  })

  it('rejects an unknown request key', () => {
    expect(DestructiveRequestSchema.safeParse({ surprise: true }).success).toBe(false)
  })
})
