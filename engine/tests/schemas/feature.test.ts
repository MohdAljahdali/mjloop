import { describe, expect, it } from 'vitest'
import { DecisionSchema, FeatureBriefSchema, FeatureIdSchema } from '../../src/schemas/feature.js'

const CREATED = '2026-07-31T09:00:00.000Z'
const ASKED = '2026-07-31T09:10:00.000Z'
const APPROVED = '2026-07-31T09:30:00.000Z'

function brief(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 1,
    id: 'F001',
    revision: 1,
    title: 'Passwordless sign-in',
    status: 'draft',
    problem: 'Members forget passwords and support carries the cost of every reset.',
    decisions: [],
    acceptance: [],
    affectedComponents: [],
    discovery: { mode: 'always', questionBudget: 8, completedAt: null },
    approval: null,
    supersedes: null,
    createdAt: CREATED,
    ...overrides,
  }
}

function approved(overrides: Record<string, unknown> = {}): unknown {
  return brief({
    status: 'approved',
    acceptance: ['A member with no password can sign in from a link'],
    approval: { by: 'mohd', at: APPROVED, note: null },
    ...overrides,
  })
}

describe('FeatureIdSchema', () => {
  it('accepts the shape every feature directory is named after', () => {
    expect(FeatureIdSchema.parse('F001')).toBe('F001')
    expect(FeatureIdSchema.parse('F042')).toBe('F042')
  })

  it('rejects an id that would steer a write out of .mjloop/features', () => {
    // The id *is* a directory name, so this schema is the only thing standing
    // between a model-supplied string and a path join.
    for (const id of ['../F001', 'F001/../..', '/etc/passwd', 'F001/rev-001.json']) {
      expect(FeatureIdSchema.safeParse(id).success).toBe(false)
    }
  })

  it('rejects a lookalike that is not the ascii shape', () => {
    // A fullwidth "Ｆ", a fullwidth digit and an Arabic-Indic digit all read as
    // "F001" to a person and name a different directory to a filesystem.
    for (const id of ['Ｆ001', 'F00１', 'F٠٠١', 'f001', 'F1', 'F0001', 'F001 ']) {
      expect(FeatureIdSchema.safeParse(id).success).toBe(false)
    }
  })
})

describe('DecisionSchema', () => {
  it('parses a question that was answered', () => {
    const parsed = DecisionSchema.parse({
      question: 'Does a magic link expire?',
      recommendation: 'Fifteen minutes, matching the session refresh window.',
      answer: 'Fifteen minutes.',
      at: ASKED,
    })
    expect(parsed.answer).toBe('Fifteen minutes.')
  })

  it('parses an unresolved decision, which is an output and not a gap', () => {
    // The interview emits these when its question budget runs out: the
    // question was worth asking and nobody answered it. Dropping them would
    // hand planning a brief that looks more settled than it is.
    const parsed = DecisionSchema.parse({ question: 'Which providers?', recommendation: null, answer: null, at: ASKED })
    expect(parsed.recommendation).toBeNull()
    expect(parsed.answer).toBeNull()
  })

  it('rejects an empty question and an empty answer string', () => {
    expect(DecisionSchema.safeParse({ question: '', recommendation: null, answer: null, at: ASKED }).success).toBe(false)
    expect(
      DecisionSchema.safeParse({ question: 'Which providers?', recommendation: null, answer: '', at: ASKED }).success,
    ).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(
      DecisionSchema.safeParse({ question: 'Which providers?', recommendation: null, answer: null, at: ASKED, by: 'mohd' })
        .success,
    ).toBe(false)
  })
})

describe('FeatureBriefSchema', () => {
  it('parses a draft that has not earned its acceptance criteria yet', () => {
    // A draft is built up one answer at a time, so it cannot carry acceptance
    // criteria from its first call. The rule the story wants — an approved
    // brief always has them — is enforced on approval instead.
    const parsed = FeatureBriefSchema.parse(brief())
    expect(parsed.acceptance).toEqual([])
    expect(parsed.status).toBe('draft')
  })

  it('parses an approved revision', () => {
    const parsed = FeatureBriefSchema.parse(approved())
    expect(parsed.approval?.by).toBe('mohd')
    expect(parsed.approval?.at).toBe(APPROVED)
  })

  it('refuses to store "superseded"', () => {
    // Superseding is what *creates* a successor; writing the word into the
    // record it describes would be mutating the one thing that must never
    // change. It is derived on read instead.
    const parsed = FeatureBriefSchema.safeParse(brief({ status: 'superseded' }))
    expect(parsed.success).toBe(false)
  })

  it('refuses an approved revision with no acceptance criteria', () => {
    expect(FeatureBriefSchema.safeParse(approved({ acceptance: [] })).success).toBe(false)
  })

  it('refuses an approval that does not match the status', () => {
    // An approved record with no approval block is an approval nobody signed;
    // a draft carrying one is an approval the status hides.
    expect(FeatureBriefSchema.safeParse(approved({ approval: null })).success).toBe(false)
    expect(
      FeatureBriefSchema.safeParse(brief({ approval: { by: 'mohd', at: APPROVED, note: null } })).success,
    ).toBe(false)
  })

  it('requires a successor to point at its predecessor', () => {
    const successor = (supersedes: unknown): unknown => brief({ revision: 2, supersedes })
    expect(FeatureBriefSchema.safeParse(successor({ id: 'F001', revision: 1 })).success).toBe(true)
    expect(FeatureBriefSchema.safeParse(successor(null)).success).toBe(false)
    // Another feature's revision is not this revision's predecessor.
    expect(FeatureBriefSchema.safeParse(successor({ id: 'F002', revision: 1 })).success).toBe(false)
    // Nor is one that does not come before it.
    expect(FeatureBriefSchema.safeParse(successor({ id: 'F001', revision: 2 })).success).toBe(false)
    expect(FeatureBriefSchema.safeParse(successor({ id: 'F001', revision: 3 })).success).toBe(false)
  })

  it('refuses a first revision that claims to supersede something', () => {
    expect(FeatureBriefSchema.safeParse(brief({ supersedes: { id: 'F001', revision: 1 } })).success).toBe(false)
  })

  it('refuses a revision number no file could be named after', () => {
    for (const revision of [0, -1, 1.5, Number.NaN]) {
      expect(FeatureBriefSchema.safeParse(brief({ revision })).success).toBe(false)
    }
  })

  it('constrains every affected component id the way every filesystem-bound id is constrained', () => {
    expect(FeatureBriefSchema.parse(brief({ affectedComponents: ['mobile', 'admin'] })).affectedComponents).toEqual([
      'mobile',
      'admin',
    ])
    for (const id of ['../etc', 'apps/mobile', '/mobile', '']) {
      expect(FeatureBriefSchema.safeParse(brief({ affectedComponents: [id] })).success).toBe(false)
    }
  })

  it('bounds the question budget the way the project policy does', () => {
    const withBudget = (questionBudget: unknown): unknown =>
      brief({ discovery: { mode: 'ask', questionBudget, completedAt: null } })
    expect(FeatureBriefSchema.safeParse(withBudget(1)).success).toBe(true)
    expect(FeatureBriefSchema.safeParse(withBudget(20)).success).toBe(true)
    expect(FeatureBriefSchema.safeParse(withBudget(0)).success).toBe(false)
    expect(FeatureBriefSchema.safeParse(withBudget(21)).success).toBe(false)
  })

  it('records the discovery mode a per-feature override chose', () => {
    for (const mode of ['always', 'ask', 'off']) {
      const parsed = FeatureBriefSchema.safeParse(brief({ discovery: { mode, questionBudget: 8, completedAt: null } }))
      expect(parsed.success).toBe(true)
    }
    expect(
      FeatureBriefSchema.safeParse(brief({ discovery: { mode: 'sometimes', questionBudget: 8, completedAt: null } }))
        .success,
    ).toBe(false)
  })

  it('bounds the free text a model writes into it', () => {
    expect(FeatureBriefSchema.safeParse(brief({ title: '' })).success).toBe(false)
    expect(FeatureBriefSchema.safeParse(brief({ title: 'a'.repeat(201) })).success).toBe(false)
    expect(FeatureBriefSchema.safeParse(brief({ problem: '' })).success).toBe(false)
    expect(FeatureBriefSchema.safeParse(brief({ problem: 'a'.repeat(20_001) })).success).toBe(false)
    expect(FeatureBriefSchema.safeParse(brief({ acceptance: [''] })).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(FeatureBriefSchema.safeParse(brief({ owner: 'mohd' })).success).toBe(false)
  })

  it('rejects a record written by a schema version this engine does not know', () => {
    expect(FeatureBriefSchema.safeParse(brief({ schema: 2 })).success).toBe(false)
  })
})
