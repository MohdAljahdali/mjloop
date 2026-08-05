import { describe, expect, it } from 'vitest'
import { planQualityDispatches, qualityRosterViolations, type QualityRosterInput } from '../../src/ops/quality-roster.js'
import { DEFAULT_TRACKS, defaultConfig, type QualityMode } from '../../src/schemas/config.js'
import { QualityPolicySchema, type QualityDimension, type QualityDispatch, type QualityPolicy, type RiskLevel } from '../../src/schemas/quality.js'

const DIMENSIONS: readonly QualityDimension[] = ['correctness', 'security', 'alignment', 'regression']

/**
 * The base (+ independent, past economy) dispatches `quality-policy.ts`'s own
 * candidate builder produces for a mode/risk pair. `baseAgent` mirrors that
 * builder's own `permitted.includes('verifier') ? 'verifier' : permitted[0]`
 * — a track without `verifier` (`plan`, say) pins a different agent.
 */
function policyDispatches(mode: QualityMode, risk: RiskLevel, baseAgent = 'verifier'): QualityDispatch[] {
  const base: QualityDispatch = {
    agent: baseAgent,
    instance: null,
    dimensions: [...DIMENSIONS],
    reason: 'Collect the deterministic evidence required by the pinned quality plan.',
  }
  if (mode === 'economy') return [base]
  if (mode === 'adaptive' && risk === 'low') return [base]
  return [base, {
    agent: baseAgent,
    instance: 'independent',
    dimensions: [...DIMENSIONS],
    reason: 'Independently review the evidence required by the pinned quality plan.',
  }]
}

function policy(mode: QualityMode, risk: RiskLevel, baseAgent = 'verifier'): QualityPolicy {
  return QualityPolicySchema.parse({
    version: 1,
    pinned_at: '2026-08-04T00:00:00.000Z',
    mode,
    supervision: 'supervised',
    source: 'explicit',
    enforcement: 'active',
    risk: {
      level: risk,
      signals: [{ code: 'security.authorization', level: risk, evidence: ['src/auth/policy.ts'] }],
    },
    budget: {
      max_cycles: 5,
      max_dispatches: 10,
      max_context_tokens_per_dispatch: 16_000,
      max_repair_attempts: 0,
      cost_estimate: null,
    },
    initial_quality_plan: {
      correctness: { value: 'required', reason: 'Every change requires correctness verification.' },
      security: { value: 'required', reason: 'Every change requires security review.' },
      alignment: { value: 'required', reason: 'Every change requires acceptance alignment.' },
      regression: { value: 'required', reason: 'Every change requires regression coverage.' },
      ui: { value: 'not_applicable', reason: 'No user-visible surface indicated.' },
    },
    dispatches: policyDispatches(mode, risk, baseAgent),
  })
}

/** The `build` track: it carries `security`, `ui-critic` and `critic`, so a strict plan can resolve every dimension to a real specialist. */
function input(overrides: { mode: QualityMode; risk?: RiskLevel }): QualityRosterInput {
  const risk = overrides.risk ?? 'high'
  return {
    trackName: 'build',
    track: DEFAULT_TRACKS['build']!,
    config: defaultConfig({ test: 'npm test', lint: null, build: null }),
    policy: policy(overrides.mode, risk),
    goal: 'Ship the checkout redesign',
    acceptance: ['Checkout responds under 200ms'],
    intendedFiles: ['src/checkout/api.ts'],
    componentKinds: ['api'],
  }
}

/** The `edit` track: it carries neither `security` nor a `critic`-family role, so strict mode has nowhere to route those dimensions but the policy's own base agent (`editor`). */
function editSecurityInput(): QualityRosterInput {
  return {
    trackName: 'edit',
    track: DEFAULT_TRACKS['edit']!,
    config: defaultConfig({ test: 'npm test', lint: null, build: null }),
    policy: policy('strict', 'high'),
    goal: 'Rename the submit label',
    acceptance: ['The button reads "Submit"'],
    intendedFiles: ['src/Button.tsx'],
    componentKinds: [],
  }
}

/** The `plan` track: no `verifier` at all, so the strict fallback for a specialist-less dimension must be the policy's own base agent (`planner`), not a hardcoded role the track doesn't define. */
function planTrackInput(): QualityRosterInput {
  return {
    trackName: 'plan',
    track: DEFAULT_TRACKS['plan']!,
    config: defaultConfig({ test: 'npm test', lint: null, build: null }),
    policy: policy('strict', 'high', 'planner'),
    goal: 'Plan the checkout redesign',
    acceptance: [],
    intendedFiles: [],
    componentKinds: [],
  }
}

describe('planQualityDispatches', () => {
  it('economy uses one verifier when deterministic evidence is sufficient', () => {
    expect(planQualityDispatches(input({ mode: 'economy', risk: 'low' })).filter((d) => d.agent === 'verifier')).toHaveLength(1)
  })

  it('adaptive at low risk plans the same single verifier dispatch as economy', () => {
    expect(planQualityDispatches(input({ mode: 'adaptive', risk: 'low' })).filter((d) => d.agent === 'verifier')).toHaveLength(1)
  })

  it('adaptive at high risk adds an independent verifier dispatch', () => {
    expect(planQualityDispatches(input({ mode: 'adaptive', risk: 'high' }))).toContainEqual(
      expect.objectContaining({ agent: 'verifier', instance: 'independent' }),
    )
  })

  it('strict adds an independent verifier instance without adding an agent role', () => {
    expect(planQualityDispatches(input({ mode: 'strict' }))).toContainEqual(
      expect.objectContaining({ agent: 'verifier', instance: 'independent' }),
    )
  })

  it('strict routes a required dimension to the track\'s own specialist role, not a new one', () => {
    const dispatches = planQualityDispatches(input({ mode: 'strict' }))
    expect(dispatches).toContainEqual(expect.objectContaining({ agent: 'security', instance: null, dimensions: ['security'] }))
    expect(dispatches).toContainEqual(expect.objectContaining({ agent: 'critic', instance: null, dimensions: ['alignment'] }))
  })

  it('falls back to a verifier instance when the track has no security role', () => {
    expect(planQualityDispatches(editSecurityInput())).toContainEqual(
      expect.objectContaining({ agent: 'verifier', instance: 'security', dimensions: ['security'] }),
    )
  })

  it('never invents an agent role outside what the track and verifier already permit', () => {
    const dispatches = planQualityDispatches(editSecurityInput())
    const editRoles = new Set([...DEFAULT_TRACKS['edit']!.required, ...DEFAULT_TRACKS['edit']!.available, 'verifier'])
    for (const dispatch of dispatches) expect(editRoles.has(dispatch.agent)).toBe(true)
  })

  it('falls back to the policy\'s own base agent, not a hardcoded "verifier", on a track that has no verifier role', () => {
    // The `plan` track never permits `verifier` at all — a hardcoded fallback
    // would plan a dispatch `rosterViolations` then refuses as `roster.unknown`,
    // an unsatisfiable roster once the gate opens (Review finding 2).
    const dispatches = planQualityDispatches(planTrackInput())
    const planRoles = new Set([...DEFAULT_TRACKS['plan']!.required, ...DEFAULT_TRACKS['plan']!.available])
    expect(planRoles.has('verifier')).toBe(false)
    for (const dispatch of dispatches) expect(planRoles.has(dispatch.agent)).toBe(true)
    expect(dispatches).toContainEqual(expect.objectContaining({ agent: 'planner', instance: 'security', dimensions: ['security'] }))
  })

  it('carries the acceptance criteria and the component/file map as optional context, ranked above risk evidence', () => {
    const [dispatch] = planQualityDispatches(input({ mode: 'strict' }))
    expect(dispatch!.context.text).toContain('Acceptance: Checkout responds under 200ms')
    expect(dispatch!.context.text).toContain('File: src/checkout/api.ts')
    expect(dispatch!.context.text).toContain('Component: api')
    const text = dispatch!.context.text
    expect(text.indexOf('Acceptance:')).toBeLessThan(text.indexOf('Evidence ('))
  })

  it('orders dispatches by the track\'s own waves, then agent, then instance', () => {
    const dispatches = planQualityDispatches(input({ mode: 'strict' }))
    const agentsAndInstances = dispatches.map((d) => `${d.agent}:${d.instance ?? ''}`)
    expect(agentsAndInstances).toEqual([...agentsAndInstances].sort())
  })

  it('stamps every dispatch with a bounded context packet and a fingerprint of it', () => {
    for (const dispatch of planQualityDispatches(input({ mode: 'strict' }))) {
      expect(dispatch.inputFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(dispatch.context.text.length).toBeGreaterThan(0)
      expect(dispatch.context.text).not.toContain('conversation transcript')
    }
  })

  it('never exceeds the mode\'s context ceiling', () => {
    for (const dispatch of planQualityDispatches(input({ mode: 'economy' }))) {
      expect(dispatch.context.tokens.value).not.toBeNull()
      expect(dispatch.context.tokens.value!).toBeLessThanOrEqual(8_000)
    }
  })
})

describe('qualityRosterViolations', () => {
  it('reports roster.quality for a planned dispatch the selected set omits', () => {
    const dispatches = planQualityDispatches(input({ mode: 'strict' }))
    const violations = qualityRosterViolations(dispatches, ['builder'])
    expect(violations).toContainEqual({ code: 'roster.quality', params: { agent: 'verifier' } })
    expect(violations).toContainEqual({ code: 'roster.quality', params: { agent: 'security' } })
  })

  it('reports nothing when every planned dispatch\'s agent was selected', () => {
    const dispatches = planQualityDispatches(input({ mode: 'economy', risk: 'low' }))
    expect(qualityRosterViolations(dispatches, dispatches.map((d) => d.agent))).toEqual([])
  })
})
