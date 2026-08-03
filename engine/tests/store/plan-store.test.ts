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
  usedStoryNumbers,
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
  frontmatter: { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: CREATED, approval: null },
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

  it('bounds the name whatever the title', () => {
    // NAME_MAX is 255 bytes: an unbounded title fails the write with a raw
    // errno instead of naming the field at fault.
    const named = storyFileName({ ...STORY.frontmatter, title: 'a'.repeat(200) })
    expect(named.length).toBeLessThanOrEqual(255)
    expect(named.startsWith('P001-S02-')).toBe(true)
  })
})

describe('writePlan and readPlan', () => {
  it('writes back to the directory it was given rather than one named after the slug', async () => {
    const dir = await writePlan(project.dir, PLAN)
    await writeStory(project.dir, STORY)

    // The slug and the directory can disagree — an agent edits one, a person
    // renames the other. Recomputing the path forks the plan and leaves every
    // story in the directory nothing reads any more.
    await writePlan(project.dir, { frontmatter: { ...PLAN.frontmatter, slug: 'auth' }, body: PLAN.body }, dir)

    expect(await fs.readdir(resolveLoopPaths(project.dir).plans)).toEqual(['P001-user-auth'])
    expect((await listStories(project.dir, 'P001')).map((story) => story.frontmatter.id)).toEqual(['P001-S02'])
  })

  it('round-trips a plan through disk', async () => {
    const dir = await writePlan(project.dir, PLAN)
    expect(dir).toBe(path.join(resolveLoopPaths(project.dir).plans, 'P001-user-auth'))

    const read = await readPlan(project.dir, 'P001')
    expect(read.frontmatter).toEqual({ ...PLAN.frontmatter, approval: null })
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

  it('ignores a file named like a plan directory', async () => {
    await writePlan(project.dir, PLAN)
    await fs.writeFile(path.join(resolveLoopPaths(project.dir).plans, 'P001-notes.md'), 'notes\n', 'utf8')

    // Counted, the stray file renders P001 twice in INDEX.md; found first by
    // findPlanDir, it fails every read of the plan.
    expect(await listPlanIds(project.dir)).toEqual(['P001'])
    expect(await findPlanDir(project.dir, 'P001')).toContain('P001-user-auth')
  })

  it('reports one id for two directories that claim it', async () => {
    await writePlan(project.dir, PLAN)
    await fs.mkdir(path.join(resolveLoopPaths(project.dir).plans, 'P001-old'), { recursive: true })

    expect(await listPlanIds(project.dir)).toEqual(['P001'])
  })
})

describe('readPlan', () => {
  it('writes a PLAN.md for a hand-made directory that never had one', async () => {
    await fs.mkdir(path.join(resolveLoopPaths(project.dir).plans, 'P002-billing', 'stories'), { recursive: true })

    const read = await readPlan(project.dir, 'P002')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P002')
    expect(read.frontmatter.slug).toBe('billing')
    expect((await readPlan(project.dir, 'P002')).repaired).toBe(false)
  })
})

describe('frontmatter repair', () => {
  beforeEach(async () => {
    await writePlan(project.dir, PLAN)
  })

  it('returns a sound plan untouched and does not rewrite it', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    const before = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(false)
    expect(await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')).toBe(before)
  })

  it('rebuilds id and slug from the directory name when the frontmatter is gone', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'Just prose, no frontmatter.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P001')
    expect(read.frontmatter.slug).toBe('user-auth')
    expect(read.body).toBe('Just prose, no frontmatter.')
  })

  it('rebuilds from an unparseable frontmatter block', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), '---\nid: [unclosed\n---\n\nThe body survives.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P001')
    expect(read.body).toBe('The body survives.')
  })

  it('rebuilds when a required field was dropped', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), '---\nid: P001\n---\n\nBody.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.slug).toBe('user-auth')
  })

  it('persists the repair so the next read is clean', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'No frontmatter.\n', 'utf8')

    await readPlan(project.dir, 'P001')
    expect((await readPlan(project.dir, 'P001')).repaired).toBe(false)
  })

  it('recovers the title from the manifest when one exists', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        plan: 'P001',
        slug: 'user-auth',
        title: 'User authentication',
        generated_at: '2026-07-27T09:14:00.000Z',
        stories: [],
      }),
      'utf8',
    )
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'No frontmatter.\n', 'utf8')

    expect((await readPlan(project.dir, 'P001')).frontmatter.title).toBe('User authentication')
  })

  it('falls back to the slug for a title when there is no manifest', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.rm(path.join(dir, 'manifest.json'), { force: true })
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'No frontmatter.\n', 'utf8')

    expect((await readPlan(project.dir, 'P001')).frontmatter.title).toBe('user-auth')
  })

  it('rebuilds a PLAN.md that is missing entirely', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.rm(path.join(dir, 'PLAN.md'))

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P001')
    expect(read.body).toBe('')
  })

  it('carries a recorded approval through a repair', async () => {
    const approval = { decision: 'approved' as const, by: 'mohd', at: '2026-07-27T11:20:00.000Z', note: 'Ship it.' }
    await writePlan(project.dir, { frontmatter: { ...PLAN.frontmatter, approval }, body: 'Body.' })
    const dir = await findPlanDir(project.dir, 'P001')
    const file = path.join(dir, 'PLAN.md')

    // One key the strict schema does not know is enough to fail the parse —
    // the approval block itself is byte-for-byte intact.
    const clobbered = (await fs.readFile(file, 'utf8')).replace('---\nid: P001', '---\nstatus: drafting\nid: P001')
    await fs.writeFile(file, clobbered, 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    // The one field nothing else on disk records: losing it deletes a decision
    // a person made, and no later read can put it back.
    expect(read.frontmatter.approval).toEqual(approval)
    expect(await fs.readFile(file, 'utf8')).toContain('decision: approved')
  })

  it('keeps a title and created_at that individually survived', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(
      path.join(dir, 'PLAN.md'),
      `---\ntitle: User authentication\ncreated_at: ${CREATED}\nstray: true\n---\n\nBody.\n`,
      'utf8',
    )

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.title).toBe('User authentication')
    expect(read.frontmatter.created_at).toBe(CREATED)
  })

  it('repairs a slug that disagrees with the directory name', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    const file = path.join(dir, 'PLAN.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('slug: user-auth', 'slug: auth'), 'utf8')

    // The directory is where the stories are, so it is authoritative. A slug
    // left disagreeing sends the next write to a directory of its own.
    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.slug).toBe('user-auth')
  })

  it('repairs rather than throws for a directory renamed out of the convention', async () => {
    const plans = resolveLoopPaths(project.dir).plans
    await fs.rename(path.join(plans, 'P001-user-auth'), path.join(plans, 'P001-user-auth.v2'))

    const read = await readPlan(project.dir, 'P001')
    expect(read.frontmatter.slug).toBe('user-auth-v2')
    // Converges: the repaired slug matches what the directory now yields.
    expect((await readPlan(project.dir, 'P001')).repaired).toBe(false)
  })

  it('repairs a directory whose slug is empty', async () => {
    await fs.mkdir(path.join(resolveLoopPaths(project.dir).plans, 'P002-'), { recursive: true })
    expect((await readPlan(project.dir, 'P002')).frontmatter.slug).toBe('P002')
  })

  it('ignores a manifest created_at that is not a timestamp', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    // A manifest is disposable, so a bad value in one must not brick the plan
    // — least of all the render that would replace the manifest.
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ title: 'Billing', generated_at: 'yesterday' }), 'utf8')
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'Clobbered.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.frontmatter.title).toBe('Billing')
    expect(() => new Date(read.frontmatter.created_at).toISOString()).not.toThrow()
  })

  it('keeps a body that opens with a thematic break', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    const raw = '---\n# User authentication\n\nWeeks of design notes.\n\n---\n\nThe rest.\n'
    await fs.writeFile(path.join(dir, 'PLAN.md'), raw, 'utf8')

    // That leading `---` is a thematic break, not frontmatter. Stripping to
    // the next one would delete the head of the document.
    const read = await readPlan(project.dir, 'P001')
    expect(read.body).toContain('Weeks of design notes.')
    expect(read.body).toContain('The rest.')
  })

  it('names the plan and the path when PLAN.md cannot be read at all', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.rm(path.join(dir, 'PLAN.md'))
    await fs.mkdir(path.join(dir, 'PLAN.md'))

    await expect(readPlan(project.dir, 'P001')).rejects.toThrow(/P001[\s\S]*EISDIR/)
  })

  it('preserves a recorded approval through an unrelated read', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    const approved = {
      ...PLAN.frontmatter,
      approval: { decision: 'approved' as const, by: 'mohd', at: '2026-07-27T11:20:00.000Z', note: null },
    }
    await writePlan(project.dir, { frontmatter: approved, body: 'Body.' })

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(false)
    expect(read.frontmatter.approval?.decision).toBe('approved')
  })
})

describe('usedStoryNumbers', () => {
  it('counts a story whose frontmatter no longer parses', async () => {
    await writePlan(project.dir, PLAN)
    const file = await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, id: 'P001-S01', depends_on: [] } })
    await fs.writeFile(file, '---\nid: P001-S01\nnonsense: true\n---\n', 'utf8')

    // listStories drops it, but the file still owns the id: handing S01 out
    // again would put two stories under one name.
    expect(await listStories(project.dir, 'P001')).toEqual([])
    expect(await usedStoryNumbers(project.dir, 'P001')).toEqual([1])
  })

  it('ignores a file belonging to another plan', async () => {
    await writePlan(project.dir, PLAN)
    const dir = path.join(await findPlanDir(project.dir, 'P001'), 'stories')
    await fs.writeFile(path.join(dir, 'P002-S07-stray.md'), 'stray\n', 'utf8')

    expect(await usedStoryNumbers(project.dir, 'P001')).toEqual([])
  })
})
