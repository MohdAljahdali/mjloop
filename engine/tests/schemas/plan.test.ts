import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  ApprovalSchema,
  ManifestSchema,
  PlanFrontmatterSchema,
  PlanIdSchema,
  StoryFrontmatterSchema,
  StoryIdSchema,
} from '../../src/schemas/plan.js'

const STORY = {
  id: 'P001-S02',
  plan: 'P001',
  title: 'Session token issuance',
  status: 'todo',
  ui: false,
  depends_on: ['P001-S01'],
  acceptance: ['Tokens expire after 24h'],
  evidence: null,
}

describe('id patterns', () => {
  it('accepts a well-formed plan id', () => {
    expect(PlanIdSchema.safeParse('P001').success).toBe(true)
  })

  it('rejects a plan id that is not three digits', () => {
    expect(PlanIdSchema.safeParse('P1').success).toBe(false)
    expect(PlanIdSchema.safeParse('P0001').success).toBe(false)
  })

  it('accepts a well-formed story id', () => {
    expect(StoryIdSchema.safeParse('P001-S02').success).toBe(true)
  })

  it('rejects a story id that could steer a path', () => {
    expect(StoryIdSchema.safeParse('../../etc').success).toBe(false)
    expect(StoryIdSchema.safeParse('P001-S02/x').success).toBe(false)
  })
})

describe('StoryFrontmatterSchema', () => {
  it('accepts a complete story', () => {
    expect(StoryFrontmatterSchema.parse(STORY)).toEqual(STORY)
  })

  it('defaults the optional fields', () => {
    const minimal = { id: 'P001-S01', plan: 'P001', title: 'Login form', status: 'todo' }
    const parsed = StoryFrontmatterSchema.parse(minimal)
    expect(parsed.ui).toBe(false)
    expect(parsed.depends_on).toEqual([])
    expect(parsed.acceptance).toEqual([])
    expect(parsed.evidence).toBeNull()
  })

  it('rejects a status outside the four values', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, status: 'in-progress' }).success).toBe(false)
  })

  it('rejects an unknown frontmatter key', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, priority: 'high' }).success).toBe(false)
  })

  it('rejects a dependency that is not a story id', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, depends_on: ['../x'] }).success).toBe(false)
  })

  it('rejects an id that does not begin with its plan id', () => {
    // readStory locates the file from the id and writeStory from the plan, so
    // a story whose two fields disagree is read from one plan and written to
    // another.
    const parsed = StoryFrontmatterSchema.safeParse({ ...STORY, plan: 'P002' })
    expect(parsed.success).toBe(false)
    expect(z.prettifyError(parsed.error!)).toContain('a story id must begin with its plan id')
  })

  it('rejects a title too long to name a file', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, title: 'a'.repeat(201) }).success).toBe(false)
  })
})

describe('PlanFrontmatterSchema', () => {
  it('accepts a complete plan', () => {
    const plan = { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: '2026-07-27T09:00:00.000Z' }
    expect(PlanFrontmatterSchema.parse(plan)).toEqual({ ...plan, approval: null })
  })

  it('rejects a slug that could steer a path', () => {
    const bad = { id: 'P001', slug: '../escape', title: 'x', created_at: '2026-07-27T09:00:00.000Z' }
    expect(PlanFrontmatterSchema.safeParse(bad).success).toBe(false)
  })

  it('defaults approval to null on a plan written before the field existed', () => {
    const plan = { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: '2026-07-27T09:00:00.000Z' }
    expect(PlanFrontmatterSchema.parse(plan).approval).toBeNull()
  })

  it('accepts a recorded approval', () => {
    const plan = {
      id: 'P001',
      slug: 'user-auth',
      title: 'User authentication',
      created_at: '2026-07-27T09:00:00.000Z',
      approval: {
        decision: 'approved',
        by: 'mohd',
        at: '2026-07-27T11:20:00.000Z',
        note: 'Ship it, but keep the token TTL configurable.',
      },
    }
    expect(PlanFrontmatterSchema.safeParse(plan).success).toBe(true)
  })

  it('accepts an approval with no note', () => {
    const approval = { decision: 'rejected', by: 'mohd', at: '2026-07-27T11:20:00.000Z' }
    expect(ApprovalSchema.parse(approval).note).toBeNull()
  })

  it('rejects a decision outside the three values', () => {
    const approval = { decision: 'maybe', by: 'mohd', at: '2026-07-27T11:20:00.000Z' }
    expect(ApprovalSchema.safeParse(approval).success).toBe(false)
  })

  it('rejects an approval with no approver', () => {
    const approval = { decision: 'approved', by: '', at: '2026-07-27T11:20:00.000Z' }
    expect(ApprovalSchema.safeParse(approval).success).toBe(false)
  })
})

describe('ManifestSchema', () => {
  it('accepts a generated manifest', () => {
    const manifest = {
      schema: 1,
      plan: 'P001',
      slug: 'user-auth',
      title: 'User authentication',
      generated_at: '2026-07-27T09:14:00.000Z',
      stories: [
        {
          id: 'P001-S01',
          title: 'Login form',
          status: 'done',
          ui: true,
          depends_on: [],
          file: 'stories/P001-S01-login-form.md',
        },
      ],
    }
    expect(ManifestSchema.parse(manifest)).toEqual(manifest)
  })

  it('rejects a schema version other than 1', () => {
    const bad = { schema: 2, plan: 'P001', slug: 's', title: 't', generated_at: '2026-07-27T09:14:00.000Z', stories: [] }
    expect(ManifestSchema.safeParse(bad).success).toBe(false)
  })
})
