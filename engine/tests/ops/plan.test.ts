import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planCreate, storyAdd } from '../../src/ops/plan.js'
import { PlanNotFoundError, listPlanIds, readStory } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('planCreate', () => {
  it('allocates P001 for the first plan', async () => {
    const created = await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    expect(created.id).toBe('P001')
    expect(created.dir).toContain('P001-user-auth')
    expect(created.manifest.stories).toEqual([])
  })

  it('allocates the next id for the second plan', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    const second = await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    expect(second.id).toBe('P002')
  })

  it('does not renumber into a gap', async () => {
    await planCreate(project.dir, { slug: 'a', title: 'A' }, clock)
    await planCreate(project.dir, { slug: 'b', title: 'B' }, clock)
    await planCreate(project.dir, { slug: 'c', title: 'C' }, clock)
    expect(await listPlanIds(project.dir)).toEqual(['P001', 'P002', 'P003'])
  })

  it('does not collide when two creates overlap', async () => {
    const [first, second] = await Promise.all([
      planCreate(project.dir, { slug: 'a', title: 'A' }, clock),
      planCreate(project.dir, { slug: 'b', title: 'B' }, clock),
    ])
    expect(new Set([first.id, second.id]).size).toBe(2)
  })

  it('rejects a slug that could steer a path', async () => {
    await expect(planCreate(project.dir, { slug: '../escape', title: 'Escape' }, clock)).rejects.toThrow()
  })

  it('allows two plans to share a slug, distinguished by id', async () => {
    const first = await planCreate(project.dir, { slug: 'auth', title: 'Auth one' }, clock)
    const second = await planCreate(project.dir, { slug: 'auth', title: 'Auth two' }, clock)
    expect(first.id).not.toBe(second.id)
  })
})

describe('storyAdd', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  })

  it('allocates S01 for the first story', async () => {
    const added = await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    expect(added.id).toBe('P001-S01')
    expect(added.file).toContain('P001-S01-login-form.md')
  })

  it('allocates the next story id within the plan', async () => {
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    const second = await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    expect(second.id).toBe('P001-S02')
  })

  it('numbers stories per plan, not globally', async () => {
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    const other = await storyAdd(project.dir, { plan: 'P002', title: 'Invoices' }, clock)
    expect(other.id).toBe('P002-S01')
  })

  it('writes the acceptance criteria and defaults the rest', async () => {
    const added = await storyAdd(
      project.dir,
      { plan: 'P001', title: 'Session token', acceptance: ['Tokens expire after 24h'], ui: true },
      clock,
    )
    const story = await readStory(project.dir, added.id)
    expect(story.frontmatter.acceptance).toEqual(['Tokens expire after 24h'])
    expect(story.frontmatter.ui).toBe(true)
    expect(story.frontmatter.status).toBe('todo')
    expect(story.frontmatter.evidence).toBeNull()
    expect(story.frontmatter.depends_on).toEqual([])
  })

  it('regenerates the manifest so it lists the new story', async () => {
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    const added = await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    expect(added.manifest.stories.map((entry) => entry.id)).toEqual(['P001-S01', 'P001-S02'])
  })

  it('throws PlanNotFoundError for a plan that does not exist', async () => {
    await expect(storyAdd(project.dir, { plan: 'P404', title: 'Ghost' }, clock)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    )
  })

  it('does not collide when two adds overlap', async () => {
    const [first, second] = await Promise.all([
      storyAdd(project.dir, { plan: 'P001', title: 'One' }, clock),
      storyAdd(project.dir, { plan: 'P001', title: 'Two' }, clock),
    ])
    expect(new Set([first.id, second.id]).size).toBe(2)
  })
})
