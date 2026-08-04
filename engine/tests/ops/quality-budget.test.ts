import { describe, expect, it } from 'vitest'
import type { QualityPolicy } from '../../src/schemas/quality.js'
import {
  compareQualityCandidates,
  contextCeiling,
  deriveQualityBudget,
  effectiveBudget,
  fitContextPacket,
  measureTokens,
  type BudgetInput,
  type ContextPacketInput,
  type QualityCandidate,
} from '../../src/ops/quality-budget.js'

const AT = '2026-08-04T10:36:00.000Z'

function packet(overrides: Partial<ContextPacketInput> = {}): ContextPacketInput {
  return {
    mandatory: ['goal'],
    optional: [],
    ceiling: 100,
    tokenizer: { count: (text) => text.length },
    ...overrides,
  }
}

function candidate(overrides: Partial<QualityCandidate> = {}): QualityCandidate {
  return {
    id: 'candidate',
    requiredDimensions: ['correctness', 'security'],
    inputTokens: { value: 100, kind: 'estimated' },
    monetaryCost: { value: 5, kind: 'measured' },
    elapsedMs: { value: 1_000, kind: 'measured' },
    ...overrides,
  }
}

function policyFixture(): QualityPolicy {
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
      max_dispatches: 3,
      max_context_tokens_per_dispatch: 12_000,
      max_repair_attempts: 1,
      cost_estimate: null,
    },
    initial_quality_plan: {
      correctness: { value: 'required', reason: 'Required for every change.' },
      security: { value: 'required', reason: 'Required for every change.' },
      alignment: { value: 'required', reason: 'Required for every change.' },
      regression: { value: 'required', reason: 'Required for every change.' },
      ui: { value: 'not_applicable', reason: 'No user-visible surface.' },
    },
    dispatches: [{ agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'Verify correctness.' }],
  }
}

describe('quality budgets', () => {
  it.each([
    ['economy', 8_000], ['adaptive', 12_000], ['strict', 16_000],
  ] as const)('pins %s context to %d tokens', (mode, expected) => {
    expect(contextCeiling(mode)).toBe(expected)
  })

  it('honors a smaller host-safe context ceiling', () => {
    expect(contextCeiling('strict', 10_000)).toBe(10_000)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid host-safe context ceiling of %s',
    (hostSafeInput) => {
      expect(() => contextCeiling('strict', hostSafeInput)).toThrow(RangeError)
    },
  )

  it('rejects a dispatch plan that cannot satisfy the positive dispatch budget schema', () => {
    expect(() => deriveQualityBudget({
      mode: 'economy',
      track: { max_cycles: 1, closing: [] },
      repairAttempts: 0,
      dispatches: [],
      targetedRepairs: [],
    })).toThrow(RangeError)
  })

  it('uses the documented conservative fallback when no tokenizer exists', () => {
    const text = 'واجهة عربية'
    expect(measureTokens(text)).toEqual({ value: Math.ceil(Buffer.byteLength(text, 'utf8') / 2), kind: 'estimated' })
  })

  it('labels a host tokenizer measurement as measured', () => {
    expect(measureTokens('any text', { count: () => 17 })).toEqual({ value: 17, kind: 'measured' })
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid tokenizer count of %s',
    (count) => {
      expect(() => measureTokens('any text', { count: () => count })).toThrow(RangeError)
    },
  )

  it('never drops mandatory context to fit a ceiling', () => {
    expect(fitContextPacket(packet({ mandatory: ['x'.repeat(40)], ceiling: 10 })).status).toBe('budget_exhausted')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid context packet ceiling of %s',
    (ceiling) => {
      expect(() => fitContextPacket(packet({ ceiling }))).toThrow(RangeError)
    },
  )

  it('removes lowest-relevance optional evidence first while retaining stable ties', () => {
    const result = fitContextPacket(packet({
      mandatory: ['goal'],
      optional: [
        { text: 'first tie', relevance: 1 },
        { text: 'keep', relevance: 3 },
        { text: 'second tie', relevance: 1 },
      ],
      ceiling: 15,
    }))

    expect(result).toMatchObject({
      status: 'fit',
      mandatory: ['goal'],
      optional: [{ text: 'keep', relevance: 3 }],
      dropped: [
        { text: 'first tie', relevance: 1 },
        { text: 'second tie', relevance: 1 },
      ],
    })
  })

  it('derives dispatches from initial, bounded targeted repairs, and closing agents once', () => {
    const budget = deriveQualityBudget({
      mode: 'adaptive',
      track: { max_cycles: 5, closing: ['docs', 'docs', 'verifier'] },
      repairAttempts: 1,
      dispatches: [
        { agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'Initial correctness.' },
        { agent: 'critic', instance: null, dimensions: ['alignment'], reason: 'Initial alignment.' },
      ],
      targetedRepairs: [
        { agent: 'verifier', instance: 'repair-one', dimensions: ['correctness'], reason: 'Repair one.' },
        { agent: 'verifier', instance: 'repair-two', dimensions: ['correctness'], reason: 'Repair two.' },
      ],
    })

    expect(budget).toMatchObject({
      max_cycles: 5,
      max_dispatches: 5,
      max_context_tokens_per_dispatch: 12_000,
      max_repair_attempts: 1,
      cost_estimate: null,
    })
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid repair-attempt count of %s before deriving a budget',
    (repairAttempts) => {
      expect(() => deriveQualityBudget({
        mode: 'adaptive',
        track: { max_cycles: 5, closing: [] },
        repairAttempts,
        dispatches: [],
        targetedRepairs: [],
      })).toThrow(RangeError)
    },
  )

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid track cycle count of %s before deriving a budget',
    (max_cycles) => {
      expect(() => deriveQualityBudget({
        mode: 'adaptive',
        track: { max_cycles, closing: [] },
        repairAttempts: 0,
        dispatches: [],
        targetedRepairs: [],
      })).toThrow(RangeError)
    },
  )

  it('returns a cost only when every measured and versioned pricing input is supplied', () => {
    const base: BudgetInput = {
      mode: 'economy' as const,
      track: { max_cycles: 1, closing: [] },
      repairAttempts: 0,
      dispatches: [{ agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'Initial correctness.' }],
      targetedRepairs: [],
    }

    expect(deriveQualityBudget(base).cost_estimate).toBeNull()
    expect(deriveQualityBudget({
      ...base,
      cost: {
        modelId: 'host/model',
        inputTokens: { value: 100, kind: 'measured' },
        outputTokens: { value: 20, kind: 'measured' },
        currency: 'USD',
        inputUnitPrice: 0.01,
        outputUnitPrice: 0.02,
        pricingTableVersion: '2026-08',
      },
    }).cost_estimate).toEqual({
      model_id: 'host/model', input_tokens: 100, output_tokens: 20, currency: 'USD',
      input_unit_price: 0.01, output_unit_price: 0.02, pricing_table_version: '2026-08', total: 1.4,
    })
  })

  it.each([
    { inputTokens: { value: -1, kind: 'measured' as const } },
    { inputTokens: { value: 1.5, kind: 'measured' as const } },
    { inputTokens: { value: Number.NaN, kind: 'measured' as const } },
    { outputTokens: { value: -1, kind: 'measured' as const } },
    { outputTokens: { value: Number.POSITIVE_INFINITY, kind: 'measured' as const } },
    { inputUnitPrice: -0.01 },
    { inputUnitPrice: Number.NaN },
    { outputUnitPrice: -0.01 },
    { outputUnitPrice: Number.POSITIVE_INFINITY },
  ])('returns null for invalid cost metadata %#', (invalid) => {
    const budget = deriveQualityBudget({
      mode: 'economy',
      track: { max_cycles: 1, closing: [] },
      repairAttempts: 0,
      dispatches: [{ agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'Initial correctness.' }],
      targetedRepairs: [],
      cost: {
        modelId: 'host/model',
        inputTokens: { value: 100, kind: 'measured' },
        outputTokens: { value: 20, kind: 'measured' },
        currency: 'USD',
        inputUnitPrice: 0.01,
        outputUnitPrice: 0.02,
        pricingTableVersion: '2026-08',
        ...invalid,
      },
    })

    expect(budget.cost_estimate).toBeNull()
  })

  it('preserves a valid zero measured usage cost', () => {
    const budget = deriveQualityBudget({
      mode: 'economy',
      track: { max_cycles: 1, closing: [] },
      repairAttempts: 0,
      dispatches: [{ agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'Initial correctness.' }],
      targetedRepairs: [],
      cost: {
        modelId: 'host/model',
        inputTokens: { value: 0, kind: 'measured' },
        outputTokens: { value: 0, kind: 'measured' },
        currency: 'USD',
        inputUnitPrice: 0.01,
        outputUnitPrice: 0.02,
        pricingTableVersion: '2026-08',
      },
    })

    expect(budget.cost_estimate?.total).toBe(0)
  })

  it('applies ordered amendments without mutating the pinned policy budget', () => {
    const policy = policyFixture()
    const result = effectiveBudget(policy, [
      { version: 1, run: '2026-08-04-001', field: 'max_dispatches', from: 3, to: 4, reason: 'One repair.', decided_at: AT, decided_by: 'operator' },
      { version: 1, run: '2026-08-04-001', field: 'max_dispatches', from: 4, to: 6, reason: 'Another repair.', decided_at: AT, decided_by: 'operator' },
    ])

    expect(result.max_dispatches).toBe(6)
    expect(policy.budget.max_dispatches).toBe(3)
  })

  it('orders valid candidates by tokens, then cost, then time', () => {
    const candidates = [
      candidate({ id: 'slower-cheap', elapsedMs: { value: 3_000, kind: 'measured' } }),
      candidate({ id: 'fast-expensive', monetaryCost: { value: 8, kind: 'measured' }, elapsedMs: { value: 100, kind: 'measured' } }),
      candidate({ id: 'lowest-token', inputTokens: { value: 50, kind: 'estimated' }, monetaryCost: { value: 99, kind: 'measured' } }),
    ]

    expect(candidates.sort(compareQualityCandidates).map((entry) => entry.id)).toEqual([
      'lowest-token', 'slower-cheap', 'fast-expensive',
    ])
  })

  it('uses stated proxies only when the corresponding measurement is unavailable', () => {
    const candidates = [
      candidate({ id: 'alpha-two-dispatches', monetaryCost: { value: 0, kind: 'unavailable' }, costProxy: { kind: 'dispatch_count', value: 2 } }),
      candidate({ id: 'zeta-one-dispatch', monetaryCost: { value: 0, kind: 'unavailable' }, costProxy: { kind: 'dispatch_count', value: 1 } }),
    ]

    expect(candidates.sort(compareQualityCandidates).map((entry) => entry.id)).toEqual(['zeta-one-dispatch', 'alpha-two-dispatches'])
  })

  it('uses a stable id tie-break instead of treating unavailable cost or time as zero', () => {
    const candidates = [
      candidate({ id: 'zeta', monetaryCost: { value: null, kind: 'unavailable' }, elapsedMs: { value: null, kind: 'unavailable' } }),
      candidate({ id: 'alpha', monetaryCost: { value: null, kind: 'unavailable' }, elapsedMs: { value: null, kind: 'unavailable' } }),
    ]

    expect(candidates.sort(compareQualityCandidates).map((entry) => entry.id)).toEqual(['alpha', 'zeta'])
  })

  it('does not treat an unavailable zero-valued host measurement as free', () => {
    const candidates = [
      candidate({ id: 'unavailable', monetaryCost: { value: 0, kind: 'unavailable' } }),
      candidate({ id: 'measured', monetaryCost: { value: 1, kind: 'measured' } }),
    ]

    expect(candidates.sort(compareQualityCandidates).map((entry) => entry.id)).toEqual(['measured', 'unavailable'])
  })
})
