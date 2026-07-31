import { describe, expect, it } from 'vitest'
import {
  AcceptedProjectSkillSchema,
  ConcurrencyDecisionSchema,
  SkillManifestSchema,
  SkillSelectionSchema,
} from '../../src/schemas/skill-selection.js'

const DIGEST = 'a'.repeat(64)
const GENERATED_AT = '2026-07-31T09:00:00.000Z'

function acceptedSkill(overrides: Record<string, unknown> = {}): unknown {
  return {
    skillId: 'flutter-widgets',
    packageDigest: DIGEST,
    components: ['mobile'],
    tags: ['flutter'],
    agents: ['builder'],
    guidance: 'Use the shared widget kit under lib/widgets.',
    status: 'active',
    compatible: true,
    ...overrides,
  }
}

function selection(overrides: Record<string, unknown> = {}): unknown {
  return {
    component: 'mobile',
    agent: 'builder',
    skillIds: ['flutter-widgets'],
    reasons: ['"flutter-widgets" matches component "mobile"\'s skillTag "flutter"'],
    sourceBrief: { id: 'F001', revision: 1 },
    ...overrides,
  }
}

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 1,
    generatedAt: GENERATED_AT,
    sourceBrief: { id: 'F001', revision: 1 },
    profileRevision: 1,
    selections: [selection()],
    guidance: { 'flutter-widgets': 'Use the shared widget kit under lib/widgets.' },
    concurrency: { mode: 'sequential', reason: 'fewer than two affected components' },
    ...overrides,
  }
}

describe('AcceptedProjectSkillSchema', () => {
  it('parses a well-formed project acceptance', () => {
    const parsed = AcceptedProjectSkillSchema.parse(acceptedSkill())
    expect(parsed.skillId).toBe('flutter-widgets')
    expect(parsed.compatible).toBe(true)
  })

  it('requires the digest to be a sha256 hex string', () => {
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ packageDigest: 'not-a-digest' })).success).toBe(false)
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ packageDigest: 'a'.repeat(63) })).success).toBe(false)
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ packageDigest: 'A'.repeat(64) })).success).toBe(false)
  })

  it('rejects an empty tag and an empty guidance string', () => {
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ tags: [''] })).success).toBe(false)
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ guidance: '' })).success).toBe(false)
  })

  it('bounds the guidance a receiving agent is handed', () => {
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ guidance: 'a'.repeat(4000) })).success).toBe(true)
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ guidance: 'a'.repeat(4001) })).success).toBe(false)
  })

  it('accepts only the two lifecycle statuses', () => {
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ status: 'disabled' })).success).toBe(true)
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ status: 'accepted' })).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(AcceptedProjectSkillSchema.safeParse(acceptedSkill({ source: 'github' })).success).toBe(false)
  })
})

describe('SkillSelectionSchema', () => {
  it('parses a selection with one reason per selected skill', () => {
    const parsed = SkillSelectionSchema.parse(selection())
    expect(parsed.skillIds).toEqual(['flutter-widgets'])
  })

  it('parses a selection with no matching skill, empty rather than absent', () => {
    // The absence of a match is itself evidence: dropping this row would make
    // "no skills applied" indistinguishable from "this component was never
    // considered at all".
    const parsed = SkillSelectionSchema.parse(selection({ skillIds: [], reasons: [] }))
    expect(parsed.skillIds).toEqual([])
  })

  it('refuses skillIds and reasons that have drifted apart in length', () => {
    expect(SkillSelectionSchema.safeParse(selection({ skillIds: ['a', 'b'], reasons: ['only one reason'] })).success).toBe(
      false,
    )
    expect(SkillSelectionSchema.safeParse(selection({ skillIds: [], reasons: ['a reason with nothing to explain'] })).success).toBe(
      false,
    )
  })

  it('constrains component and skill ids the way every filesystem-bound id is constrained', () => {
    expect(SkillSelectionSchema.safeParse(selection({ component: '../etc' })).success).toBe(false)
    expect(SkillSelectionSchema.safeParse(selection({ skillIds: ['../etc'], reasons: ['x'] })).success).toBe(false)
  })

  it('constrains the agent name the way the contract does', () => {
    expect(SkillSelectionSchema.safeParse(selection({ agent: 'builder--x' })).success).toBe(false)
    expect(SkillSelectionSchema.safeParse(selection({ agent: 'findings' })).success).toBe(false)
  })

  it('constrains sourceBrief.id to the feature id shape', () => {
    expect(SkillSelectionSchema.safeParse(selection({ sourceBrief: { id: 'not-a-feature', revision: 1 } })).success).toBe(
      false,
    )
  })

  it('rejects an unknown key', () => {
    expect(SkillSelectionSchema.safeParse(selection({ confidence: 0.9 })).success).toBe(false)
  })
})

describe('ConcurrencyDecisionSchema', () => {
  it('parses either mode with a stated reason', () => {
    expect(ConcurrencyDecisionSchema.parse({ mode: 'sequential', reason: 'shared verify command' }).mode).toBe(
      'sequential',
    )
    expect(ConcurrencyDecisionSchema.parse({ mode: 'parallel', reason: 'roots are disjoint' }).mode).toBe('parallel')
  })

  it('refuses a mode with no stated reason', () => {
    expect(ConcurrencyDecisionSchema.safeParse({ mode: 'sequential', reason: '' }).success).toBe(false)
  })
})

describe('SkillManifestSchema', () => {
  it('parses a manifest with no selections, the shape a run with no approved brief never pins', () => {
    const parsed = SkillManifestSchema.parse(manifest({ selections: [] }))
    expect(parsed.selections).toEqual([])
  })

  it('parses a manifest carrying selections and a concurrency decision', () => {
    const parsed = SkillManifestSchema.parse(manifest())
    expect(parsed.selections).toHaveLength(1)
    expect(parsed.concurrency.mode).toBe('sequential')
  })

  it('carries the guidance text for every skill it selected', () => {
    // A selection names an id, and an id is not something an agent can follow.
    // The guidance the story requires be "added to the agent brief" has to
    // reach the file the brief points at, or the whole dispatch half of skill
    // selection hands a role a name and no instruction.
    expect(SkillManifestSchema.parse(manifest()).guidance['flutter-widgets']).toBe(
      'Use the shared widget kit under lib/widgets.',
    )
  })

  it('refuses a manifest naming a skill it carries no guidance for', () => {
    // The drift this catches is the same class as `skillIds`/`reasons` above:
    // an agent told to follow "exactly the guidance it carries" would find
    // nothing under the id and be left to decide for itself what the skill
    // meant, which is the free-form claim the manifest exists to replace.
    expect(SkillManifestSchema.safeParse(manifest({ guidance: {} })).success).toBe(false)
  })

  it('defaults the guidance map to empty, the shape every manifest today pins', () => {
    // No skill library exists yet, so every selection is empty and there is
    // nothing to render guidance for. An empty map is the honest record of
    // that, not a missing field.
    const { guidance, ...withoutGuidance } = manifest({ selections: [] }) as Record<string, unknown>
    expect(SkillManifestSchema.parse(withoutGuidance).guidance).toEqual({})
  })

  it('bounds a rendered guidance string exactly as the acceptance record bounds it', () => {
    expect(SkillManifestSchema.safeParse(manifest({ guidance: { 'flutter-widgets': 'a'.repeat(4000) } })).success).toBe(
      true,
    )
    expect(SkillManifestSchema.safeParse(manifest({ guidance: { 'flutter-widgets': 'a'.repeat(4001) } })).success).toBe(
      false,
    )
  })

  it('rejects a schema version other than 1', () => {
    expect(SkillManifestSchema.safeParse(manifest({ schema: 2 })).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(SkillManifestSchema.safeParse(manifest({ extra: true })).success).toBe(false)
  })
})
