import { describe, expect, it } from 'vitest'
import { OrchestrationSchema, type Orchestration, type UncertainConcurrency } from '../../src/schemas/config.js'
import type { FeatureBrief } from '../../src/schemas/feature.js'
import type { ProjectComponent, ProjectProfile } from '../../src/schemas/project-profile.js'
import type { AcceptedProjectSkill } from '../../src/schemas/skill-selection.js'
import {
  BriefNotApprovedError,
  UnresolvedComponentError,
  analyseConcurrency,
  selectSkills,
} from '../../src/ops/skill-selection.js'

const DIGEST = 'a'.repeat(64)

/** A mixed profile: one component per technology, plus a shared "lint" tag on
 * every one of them — the trap that catches a join that forgets to check
 * `skill.components` and instead trusts a tag match against any component in
 * the profile. */
function mixedProfile(overrides: Partial<Record<'mobile' | 'admin' | 'api', Partial<ProjectComponent>>> = {}): ProjectProfile {
  const component = (id: string, technology: ProjectComponent['technology'], tag: string, extra: Partial<ProjectComponent> = {}): ProjectComponent => ({
    id,
    root: id,
    technology,
    verification: { test: null, lint: null, build: null },
    skillTags: [tag, 'lint'],
    ...extra,
  })
  return {
    schema: 1,
    revision: 1,
    generatedAt: '2026-07-30T09:00:00.000Z',
    acceptedAt: '2026-07-30T09:00:00.000Z',
    acceptedBy: 'mohd',
    supersedes: null,
    components: [
      component('mobile', 'flutter', 'flutter', overrides.mobile),
      component('admin', 'nextjs', 'nextjs', overrides.admin),
      component('api', 'python', 'python', overrides.api),
    ],
  }
}

function approvedBrief(overrides: Partial<FeatureBrief> = {}): FeatureBrief {
  return {
    schema: 1,
    id: 'F001',
    revision: 1,
    title: 'Passwordless sign-in',
    status: 'approved',
    problem: 'Members forget passwords and support carries the cost of every reset.',
    decisions: [],
    acceptance: ['A member with no password can sign in from a link'],
    affectedComponents: ['mobile'],
    tags: [],
    discovery: { mode: 'always', questionBudget: 8, completedAt: '2026-07-31T09:00:00.000Z' },
    approval: { by: 'mohd', at: '2026-07-31T09:30:00.000Z', note: null },
    supersedes: null,
    createdAt: '2026-07-31T09:00:00.000Z',
    ...overrides,
  }
}

function skill(overrides: Partial<AcceptedProjectSkill> = {}): AcceptedProjectSkill {
  return {
    skillId: 'generic-skill',
    packageDigest: DIGEST,
    components: ['mobile'],
    tags: ['flutter'],
    agents: ['builder'],
    guidance: 'Follow the shared conventions.',
    status: 'active',
    compatible: true,
    ...overrides,
  }
}

function orchestration(uncertainConcurrency: UncertainConcurrency): Orchestration {
  return OrchestrationSchema.parse({ execution: { uncertain_concurrency: uncertainConcurrency } })
}

describe('selectSkills', () => {
  const flutterSkill = skill({ skillId: 'flutter-widgets', components: ['mobile'], tags: ['flutter'] })
  const nextjsSkill = skill({ skillId: 'nextjs-app-router', components: ['admin'], tags: ['nextjs'] })
  const pythonSkill = skill({ skillId: 'python-fastapi', components: ['api'], tags: ['python'] })
  // The trap: shares the "lint" tag with every component's skillTags above,
  // but is only accepted for "admin". A join that selects on tag alone —
  // ignoring `skill.components` — would leak this into the mobile and api
  // selections too.
  const adminLintSkill = skill({ skillId: 'admin-lint-only', components: ['admin'], tags: ['lint'] })

  const profile = mixedProfile()
  const acceptedSkills = [flutterSkill, nextjsSkill, pythonSkill, adminLintSkill]

  it('selects only Flutter skills for a Flutter-affected component, in a mixed profile', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'] }),
      profile,
      acceptedSkills,
      agent: 'builder',
    })
    expect(selections).toHaveLength(1)
    expect(selections[0]?.skillIds).toEqual(['flutter-widgets'])
    expect(selections[0]?.reasons).toHaveLength(1)
  })

  it('selects only Next.js skills for a Next.js-affected component', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['admin'] }),
      profile,
      acceptedSkills,
      agent: 'builder',
    })
    expect(selections).toHaveLength(1)
    // Both admin-scoped skills legitimately apply — the shared "lint" tag is
    // a real match here, because "admin-lint-only" really is accepted for
    // "admin". Sorted by skill id.
    expect(selections[0]?.skillIds).toEqual(['admin-lint-only', 'nextjs-app-router'])
    expect(selections[0]?.skillIds).not.toContain('flutter-widgets')
    expect(selections[0]?.skillIds).not.toContain('python-fastapi')
  })

  it('selects only Python skills for a Python-affected component', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['api'] }),
      profile,
      acceptedSkills,
      agent: 'builder',
    })
    expect(selections).toHaveLength(1)
    expect(selections[0]?.skillIds).toEqual(['python-fastapi'])
  })

  it('adds an accepted security skill when the brief declares a security tag', () => {
    const securitySkill = skill({ skillId: 'security-auth-guard', components: ['mobile'], tags: ['security'] })
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'], tags: ['security'] }),
      profile,
      acceptedSkills: [flutterSkill, securitySkill],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual(['flutter-widgets', 'security-auth-guard'])
  })

  // The test that proves selection is not reading text: the word appears in
  // the prose and nowhere in `tags`, and the security skill must not appear.
  it('does not add the security skill when the tag is absent, even though the prose mentions authentication', () => {
    const securitySkill = skill({ skillId: 'security-auth-guard', components: ['mobile'], tags: ['security'] })
    const selections = selectSkills({
      brief: approvedBrief({
        affectedComponents: ['mobile'],
        tags: [],
        problem: 'Members cannot authenticate without a password, and every authentication reset costs support time.',
      }),
      profile,
      acceptedSkills: [flutterSkill, securitySkill],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual(['flutter-widgets'])
    expect(selections[0]?.skillIds).not.toContain('security-auth-guard')
  })

  it('rejects a skill this project has never accepted at all', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'] }),
      profile,
      acceptedSkills: [],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual([])
  })

  it('rejects a disabled skill', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'] }),
      profile,
      acceptedSkills: [skill({ skillId: 'disabled-skill', status: 'disabled' })],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual([])
  })

  it('rejects an incompatible skill', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'] }),
      profile,
      acceptedSkills: [skill({ skillId: 'incompatible-skill', compatible: false })],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual([])
  })

  it('rejects a skill enabled for a different component', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'] }),
      profile,
      acceptedSkills: [skill({ skillId: 'admin-only-skill', components: ['admin'], tags: ['flutter'] })],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual([])
  })

  it('rejects a skill whose agents list excludes this role', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile'] }),
      profile,
      acceptedSkills: [skill({ skillId: 'critic-only-skill', agents: ['critic'] })],
      agent: 'builder',
    })
    expect(selections[0]?.skillIds).toEqual([])
  })

  it('refuses to select for a brief that is not approved', () => {
    const draft = approvedBrief({ status: 'draft', approval: null })
    expect(() => selectSkills({ brief: draft, profile, acceptedSkills, agent: 'builder' })).toThrow(BriefNotApprovedError)
    expect(() => selectSkills({ brief: draft, profile, acceptedSkills, agent: 'builder' })).toThrow(/draft/)
  })

  it('treats a component id the accepted profile does not have as an error, not a silent skip', () => {
    const ghostly = approvedBrief({ affectedComponents: ['ghost'] })
    expect(() => selectSkills({ brief: ghostly, profile, acceptedSkills, agent: 'builder' })).toThrow(
      UnresolvedComponentError,
    )
    expect(() => selectSkills({ brief: ghostly, profile, acceptedSkills, agent: 'builder' })).toThrow(/ghost/)
  })

  it('still yields a selection with empty skillIds for a component with no matching skill', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['api'] }),
      profile,
      acceptedSkills: [flutterSkill],
      agent: 'builder',
    })
    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatchObject({ component: 'api', skillIds: [], reasons: [] })
  })

  it('sorts selections by component id regardless of the order affectedComponents was written in', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['api', 'mobile', 'admin'] }),
      profile,
      acceptedSkills,
      agent: 'builder',
    })
    expect(selections.map((s) => s.component)).toEqual(['admin', 'api', 'mobile'])
  })

  it('de-duplicates a component id named twice in affectedComponents', () => {
    const selections = selectSkills({
      brief: approvedBrief({ affectedComponents: ['mobile', 'mobile'] }),
      profile,
      acceptedSkills,
      agent: 'builder',
    })
    expect(selections).toHaveLength(1)
  })

  it('produces byte-identical output across two calls with identical inputs', () => {
    const input = {
      brief: approvedBrief({ affectedComponents: ['api', 'mobile', 'admin'], tags: ['security'] }),
      profile,
      acceptedSkills: [...acceptedSkills, skill({ skillId: 'security-auth-guard', components: ['mobile'], tags: ['security'] })],
      agent: 'builder',
    }
    const first = selectSkills(input)
    const second = selectSkills(input)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

describe('analyseConcurrency', () => {
  it('serialises a brief affecting fewer than two components', () => {
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile'] }),
      mixedProfile(),
      orchestration('sequential'),
    )
    expect(decision.mode).toBe('sequential')
    expect(decision.reason).toMatch(/fewer than two/)
  })

  /** Two components proof can actually separate: disjoint roots, no command in common. */
  function provablyIndependent(): ProjectProfile {
    return mixedProfile({
      mobile: { verification: { test: 'flutter test', lint: null, build: null } },
      admin: { verification: { test: 'npm test --scope admin', lint: null, build: null } },
    })
  }

  it('runs proven-independent components in parallel under the default sequential policy', () => {
    // The story's required "proven independent branches may be parallel", read
    // against `uncertain_concurrency`'s own committed contract in
    // `schemas/config.ts`: the setting governs work whose dependencies *cannot*
    // be proven independent. Proof is not uncertainty, so the policy never
    // reaches this case — and asserting it under the **default** is the whole
    // point, because a `parallel` mode only a non-default setting can reach is
    // a mode no default install can ever produce.
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      provablyIndependent(),
      orchestration('sequential'),
    )
    expect(decision.mode).toBe('parallel')
    expect(decision.reason).toMatch(/disjoint/)
    expect(decision.reason).not.toMatch(/uncertain_concurrency/)
  })

  it('runs proven-independent components in parallel without asking, even under "ask"', () => {
    // `ask` is what to do with uncertainty. There is none here to put to
    // anyone, so there is nothing to ask about.
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      provablyIndependent(),
      orchestration('ask'),
    )
    expect(decision.mode).toBe('parallel')
  })

  it('serialises when one component root is a path prefix of another, and says which policy decided', () => {
    const profile = mixedProfile({
      mobile: { root: 'apps' },
      admin: { root: 'apps/admin' },
    })
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      profile,
      orchestration('sequential'),
    )
    expect(decision.mode).toBe('sequential')
    expect(decision.reason).toMatch(/prefix/)
    // Both halves, because either alone is a reason an operator cannot act on:
    // the rule says what could not be proven, the policy says what the project
    // asked for when nothing could be.
    expect(decision.reason).toMatch(/uncertain_concurrency is "sequential"/)
  })

  it('serialises when the project root "." sits alongside another component', () => {
    const profile = mixedProfile({ mobile: { root: '.' } })
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      profile,
      orchestration('sequential'),
    )
    expect(decision.mode).toBe('sequential')
  })

  it('serialises when two components share a verify command string, and says which policy decided', () => {
    const profile = mixedProfile({
      mobile: { verification: { test: 'npm test', lint: null, build: null } },
      admin: { verification: { test: null, lint: null, build: 'npm test' } },
    })
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      profile,
      orchestration('sequential'),
    )
    expect(decision.mode).toBe('sequential')
    expect(decision.reason).toMatch(/share the verify command/)
    expect(decision.reason).toMatch(/uncertain_concurrency is "sequential"/)
  })

  it('names "ask" in the reason and serialises when independence could not be proven', () => {
    // `ask` cannot be honoured by a pure function, so it reports the safe
    // answer and names itself — that naming is the only thing that tells the
    // leader there is a choice to offer rather than a verdict to obey.
    const profile = mixedProfile({ mobile: { root: 'apps' }, admin: { root: 'apps/admin' } })
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      profile,
      orchestration('ask'),
    )
    expect(decision.mode).toBe('sequential')
    expect(decision.reason).toMatch(/"ask"/)
  })

  it('obeys a project that asked for parallel when independence could not be proven', () => {
    // The branch `uncertain_concurrency` was actually written for. A root
    // prefix does not prove *dependence* — `apps` and `apps/admin` may well be
    // independent — it only means this analyser cannot show independence, and
    // that is precisely the case the project's own policy is documented to
    // settle. Ignoring the setting here would leave it governing nothing.
    const profile = mixedProfile({ mobile: { root: 'apps' }, admin: { root: 'apps/admin' } })
    const decision = analyseConcurrency(
      approvedBrief({ affectedComponents: ['mobile', 'admin'] }),
      profile,
      orchestration('parallel'),
    )
    expect(decision.mode).toBe('parallel')
    expect(decision.reason).toMatch(/prefix/)
    expect(decision.reason).toMatch(/uncertain_concurrency is "parallel"/)
  })

  it('treats a component id the accepted profile does not have as an error, not a silent skip', () => {
    expect(() =>
      analyseConcurrency(
        approvedBrief({ affectedComponents: ['mobile', 'ghost'] }),
        mixedProfile(),
        orchestration('sequential'),
      ),
    ).toThrow(UnresolvedComponentError)
  })
})
