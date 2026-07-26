import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PlanNotFoundError,
  StoryNotFoundError,
  findPlanDir,
  listPlanIds,
  listStories,
  readPlan,
  readStory,
  storyFileName,
  writePlan,
  writeStory,
} from '../../src/store/plan-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const CREATED = '2026-07-27T09:00:00.000Z'

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

const PLAN = {
  frontmatter: { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: CREATED },
  body: 'The problem and the approach.',
  dir: '',
}

const STORY = {
  frontmatter: {
    id: 'P001-S02',
    plan: 'P001',
    title: 'Session token issuance',
    status: 'todo' as const,
    ui: false,
    depends_on: ['P001-S01'],
    acceptance: ['Tokens expire after 24h'],
    evidence: null,
  },
  body: 'Context for the story.',
  file: '',
}

describe('storyFileName', () => {
  it('names the file after the id and a slugified title', () => {
    expect(storyFileName(STORY.frontmatter)).toBe('P001-S02-session-token-issuance.md')
  })

  it('strips characters that do not belong in a filename', () => {
    const named = storyFileName({ ...STORY.frontmatter, title: 'Refresh / rotate  the token!' })
    expect(named).toBe('P001-S02-refresh-rotate-the-token.md')
  })
})

describe('writePlan and readPlan', () => {
  it('round-trips a plan through disk', async () => {
    const dir = await writePlan(project.dir, PLAN)
    expect(dir).toBe(path.join(resolveLoopPaths(project.dir).plans, 'P001-user-auth'))

    const read = await readPlan(project.dir, 'P001')
    expect(read.frontmatter).toEqual(PLAN.frontmatter)
    expect(read.body).toBe(PLAN.body)
    expect(read.dir).toBe(dir)
  })

  it('throws PlanNotFoundError for an id with no directory', async () => {
    await expect(readPlan(project.dir, 'P404')).rejects.toBeInstanceOf(PlanNotFoundError)
  })

  it('finds the directory by id regardless of the slug', async () => {
    await writePlan(project.dir, PLAN)
    expect(await findPlanDir(project.dir, 'P001')).toContain('P001-user-auth')
  })
})

describe('writeStory and readStory', () => {
  it('round-trips a story through disk', async () => {
    await writePlan(project.dir, PLAN)
    const file = await writeStory(project.dir, STORY)
    expect(path.basename(file)).toBe('P001-S02-session-token-issuance.md')

    const read = await readStory(project.dir, 'P001-S02')
    expect(read.frontmatter).toEqual(STORY.frontmatter)
    expect(read.body).toBe(STORY.body)
    expect(read.file).toBe(file)
  })

  it('throws StoryNotFoundError for an id with no file', async () => {
    await writePlan(project.dir, PLAN)
    await expect(readStory(project.dir, 'P001-S99')).rejects.toBeInstanceOf(StoryNotFoundError)
  })

  it('finds a story by id even when its title changed the filename', async () => {
    await writePlan(project.dir, PLAN)
    await writeStory(project.dir, STORY)
    await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, title: 'Renamed' } })

    // Both files exist; reading by id must resolve, not collide.
    const read = await readStory(project.dir, 'P001-S02')
    expect(read.frontmatter.id).toBe('P001-S02')
  })
})

describe('listStories', () => {
  it('returns stories sorted by id', async () => {
    await writePlan(project.dir, PLAN)
    await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, id: 'P001-S03', title: 'Third' } })
    await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, id: 'P001-S01', title: 'First', depends_on: [] } })
    await writeStory(project.dir, STORY)

    const ids = (await listStories(project.dir, 'P001')).map((story) => story.frontmatter.id)
    expect(ids).toEqual(['P001-S01', 'P001-S02', 'P001-S03'])
  })

  it('returns an empty list for a plan with no stories', async () => {
    await writePlan(project.dir, PLAN)
    expect(await listStories(project.dir, 'P001')).toEqual([])
  })

  it('skips a file that is not a valid story rather than failing whole', async () => {
    await writePlan(project.dir, PLAN)
    await writeStory(project.dir, STORY)
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'stories', 'notes.md'), '# just notes\n', 'utf8')

    const stories = await listStories(project.dir, 'P001')
    expect(stories.map((story) => story.frontmatter.id)).toEqual(['P001-S02'])
  })
})

describe('listPlanIds', () => {
  it('returns plan ids sorted, ignoring stray entries', async () => {
    await writePlan(project.dir, PLAN)
    await writePlan(project.dir, {
      ...PLAN,
      frontmatter: { ...PLAN.frontmatter, id: 'P002', slug: 'billing', title: 'Billing' },
    })
    await fs.mkdir(path.join(resolveLoopPaths(project.dir).plans, 'scratch'), { recursive: true })

    expect(await listPlanIds(project.dir)).toEqual(['P001', 'P002'])
  })

  it('returns an empty list when nothing is provisioned', async () => {
    expect(await listPlanIds(project.dir)).toEqual([])
  })
})
