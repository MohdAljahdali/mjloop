import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DependencyError,
  InvalidPlanInputError,
  planCreate,
  storyAdd,
  storyGet,
  storyNext,
  storyUpdate,
} from '../../src/ops/plan.js'
import {
  PlanNotFoundError,
  StoryNotFoundError,
  findPlanDir,
  listPlanIds,
  listStories,
  readStory,
} from '../../src/store/plan-store.js'
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

  it('does not reuse the id of a story whose frontmatter stopped parsing', async () => {
    const first = await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    const raw = await fs.readFile(first.file, 'utf8')
    await fs.writeFile(first.file, raw.replace('status: todo', 'status: todo\nnotes: remember'), 'utf8')

    // listStories skips the file, but its id is spoken for: reusing it puts
    // two stories under one name, and marking one done leaves the other open.
    const second = await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    expect(second.id).toBe('P001-S02')
  })

  it('says the plan is full rather than rejecting an id the caller never supplied', async () => {
    const dir = path.join(await findPlanDir(project.dir, 'P001'), 'stories')
    await fs.writeFile(path.join(dir, 'P001-S99-last.md'), 'placeholder\n', 'utf8')

    await expect(storyAdd(project.dir, { plan: 'P001', title: 'One too many' }, clock)).rejects.toThrow(/full/)
  })

  it('rejects a title too long to name a file, naming the field', async () => {
    const failure = await storyAdd(project.dir, { plan: 'P001', title: 'a'.repeat(244) }, clock).catch(
      (error: Error) => error,
    )
    expect(failure).toBeInstanceOf(InvalidPlanInputError)
    expect((failure as Error).message).toContain('title')
  })
})

describe('storyUpdate', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] }, clock)
  })

  it('changes the status and regenerates the manifest', async () => {
    const updated = await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    expect(updated.manifest.stories[0]?.status).toBe('done')
    expect((await readStory(project.dir, 'P001-S01')).frontmatter.status).toBe('done')
  })

  it('records an evidence path', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'done', evidence: '.loop/runs/2026-07-27-001--P001-S01--build' }, clock)
    expect((await readStory(project.dir, 'P001-S01')).frontmatter.evidence).toBe(
      '.loop/runs/2026-07-27-001--P001-S01--build',
    )
  })

  it('leaves untouched fields alone', async () => {
    await storyUpdate(project.dir, 'P001-S02', { status: 'doing' }, clock)
    const story = await readStory(project.dir, 'P001-S02')
    expect(story.frontmatter.depends_on).toEqual(['P001-S01'])
    expect(story.frontmatter.title).toBe('Session token')
  })

  it('throws StoryNotFoundError for a story that does not exist', async () => {
    await expect(storyUpdate(project.dir, 'P001-S99', { status: 'done' }, clock)).rejects.toBeInstanceOf(
      StoryNotFoundError,
    )
  })

  it('renames the file when the title changes, leaving one file for the story', async () => {
    await storyUpdate(project.dir, 'P001-S01', { title: 'Login screen' }, clock)
    const story = await readStory(project.dir, 'P001-S01')
    expect(story.file).toContain('P001-S01-login-screen.md')

    const manifest = (await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)).manifest
    expect(manifest.stories.filter((entry) => entry.id === 'P001-S01')).toHaveLength(1)
  })

  it('renames rather than writing a second file, so an interruption cannot orphan one', async () => {
    const before = await readStory(project.dir, 'P001-S01')
    // rename replaces the write-then-delete pair: a delete that never happens
    // leaves two files claiming one id, and nothing afterwards removes either.
    await storyUpdate(project.dir, 'P001-S01', { title: 'Login screen' }, clock)

    const files = await fs.readdir(path.dirname(before.file))
    expect(files.filter((name) => name.startsWith('P001-S01'))).toEqual(['P001-S01-login-screen.md'])
  })

  it('records a status when a dependency file was deleted by hand', async () => {
    const s01 = await readStory(project.dir, 'P001-S01')
    await fs.rm(s01.file)

    // The patch does not touch depends_on, so a dangling edge it did not
    // introduce must not make the story permanently un-updatable.
    const updated = await storyUpdate(project.dir, 'P001-S02', { status: 'done', evidence: '.loop/runs/x' }, clock)
    expect(updated.manifest.stories[0]?.status).toBe('done')
  })

  it('still rejects a dangling edge the patch introduces', async () => {
    await expect(
      storyUpdate(project.dir, 'P001-S01', { depends_on: ['P001-S99'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })

  it('leaves a story whose plan and id disagree where it is', async () => {
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    const dir = path.join(await findPlanDir(project.dir, 'P001'), 'stories')
    await fs.writeFile(
      path.join(dir, 'P001-S07-hand.md'),
      '---\nid: P001-S07\nplan: P002\ntitle: Hand written\nstatus: todo\nui: false\ndepends_on: []\nacceptance: []\nevidence: null\n---\n\nbody\n',
      'utf8',
    )

    // Read from P001 and written from `plan`, the story would otherwise land
    // in P002 and disappear from both manifests.
    await expect(storyUpdate(project.dir, 'P001-S07', { status: 'doing' }, clock)).rejects.toBeInstanceOf(
      StoryNotFoundError,
    )
    expect((await listStories(project.dir, 'P002')).length).toBe(0)
    expect(await fs.readdir(dir)).toContain('P001-S07-hand.md')
  })
})

describe('dependency validation', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Logout' }, clock)
  })

  it('rejects a dependency on a story that does not exist', async () => {
    await expect(
      storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S99'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })

  it('rejects a dependency on itself', async () => {
    await expect(
      storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S02'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })

  it('rejects a two-story cycle', async () => {
    await storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S01'] }, clock)
    await expect(
      storyUpdate(project.dir, 'P001-S01', { depends_on: ['P001-S02'] }, clock),
    ).rejects.toThrow(/cycle/i)
  })

  it('rejects a three-story cycle', async () => {
    await storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S01'] }, clock)
    await storyUpdate(project.dir, 'P001-S03', { depends_on: ['P001-S02'] }, clock)
    await expect(
      storyUpdate(project.dir, 'P001-S01', { depends_on: ['P001-S03'] }, clock),
    ).rejects.toThrow(/cycle/i)
  })

  it('accepts a diamond', async () => {
    await storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S01'] }, clock)
    await storyUpdate(project.dir, 'P001-S03', { depends_on: ['P001-S01', 'P001-S02'] }, clock)
    expect((await readStory(project.dir, 'P001-S03')).frontmatter.depends_on).toEqual(['P001-S01', 'P001-S02'])
  })

  it('rejects a dangling dependency at add time too', async () => {
    await expect(
      storyAdd(project.dir, { plan: 'P001', title: 'Fourth', depends_on: ['P001-S99'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })
})

describe('storyNext', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Logout', depends_on: ['P001-S02'] }, clock)
  })

  it('picks the lowest-id todo story with no unmet dependencies', async () => {
    const next = await storyNext(project.dir)
    expect(next.story?.frontmatter.id).toBe('P001-S01')
  })

  it('skips a story whose dependency is not done', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)
    const next = await storyNext(project.dir)
    expect(next.story).toBeNull()
    expect(next.reason).toContain('P001-S02')
  })

  it('advances once the dependency is done', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    expect((await storyNext(project.dir)).story?.frontmatter.id).toBe('P001-S02')
  })

  it('returns nothing with a reason when every story is done', async () => {
    for (const id of ['P001-S01', 'P001-S02', 'P001-S03']) {
      await storyUpdate(project.dir, id, { status: 'done' }, clock)
    }
    const next = await storyNext(project.dir)
    expect(next.story).toBeNull()
    expect(next.reason).toContain('done')
  })

  it('ignores stories that are doing or blocked', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'blocked' }, clock)
    const next = await storyNext(project.dir)
    expect(next.story).toBeNull()
    expect(next.reason).toMatch(/blocked|waiting/i)
  })

  it('searches every plan when none is named', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    await storyUpdate(project.dir, 'P001-S02', { status: 'done' }, clock)
    await storyUpdate(project.dir, 'P001-S03', { status: 'done' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    await storyAdd(project.dir, { plan: 'P002', title: 'Invoices' }, clock)

    expect((await storyNext(project.dir)).story?.frontmatter.id).toBe('P002-S01')
  })

  it('restricts the search to one plan when asked', async () => {
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    await storyAdd(project.dir, { plan: 'P002', title: 'Invoices' }, clock)

    expect((await storyNext(project.dir, 'P002')).story?.frontmatter.id).toBe('P002-S01')
  })

  it('returns nothing for a project with no plans', async () => {
    const empty = await makeTmpProject()
    try {
      const next = await storyNext(empty.dir)
      expect(next.story).toBeNull()
      expect(next.reason).toContain('no plans')
    } finally {
      await empty.cleanup()
    }
  })
})

describe('storyGet', () => {
  it('reads a story by id', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form', acceptance: ['Shows an error on bad input'] }, clock)

    const story = await storyGet(project.dir, 'P001-S01')
    expect(story.frontmatter.acceptance).toEqual(['Shows an error on bad input'])
  })

  it('throws StoryNotFoundError for an unknown id', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await expect(storyGet(project.dir, 'P001-S99')).rejects.toBeInstanceOf(StoryNotFoundError)
  })
})
