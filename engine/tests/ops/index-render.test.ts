import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planStatus, renderIndex } from '../../src/ops/index-render.js'
import { planCreate, storyAdd, storyUpdate } from '../../src/ops/plan.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:14:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

function entry(id: string, status: 'todo' | 'doing' | 'done' | 'blocked') {
  return { id, title: id, status, ui: false, depends_on: [], file: `stories/${id}.md` }
}

describe('planStatus', () => {
  it('is planned when nothing has started', () => {
    expect(planStatus([entry('P001-S01', 'todo'), entry('P001-S02', 'todo')])).toBe('planned')
  })

  it('is done when every story is done', () => {
    expect(planStatus([entry('P001-S01', 'done')])).toBe('done')
  })

  it('is in-progress when some work has started', () => {
    expect(planStatus([entry('P001-S01', 'done'), entry('P001-S02', 'todo')])).toBe('in-progress')
    expect(planStatus([entry('P001-S01', 'doing'), entry('P001-S02', 'todo')])).toBe('in-progress')
  })

  it('is blocked when nothing can proceed and something is blocked', () => {
    expect(planStatus([entry('P001-S01', 'blocked'), entry('P001-S02', 'done')])).toBe('blocked')
  })

  it('is planned for a plan with no stories', () => {
    expect(planStatus([])).toBe('planned')
  })
})

describe('renderIndex', () => {
  it('writes a header and a row per plan', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)

    const markdown = await renderIndex(project.dir, clock)
    expect(markdown).toContain('do not edit')
    expect(markdown).toContain('| P001 | User authentication | 2 | 1 | in-progress |')
    expect(markdown).toContain('| P002 | Billing | 0 | 0 | planned |')

    const onDisk = await fs.readFile(resolveLoopPaths(project.dir).index, 'utf8')
    expect(onDisk).toBe(markdown)
  })

  it('says so plainly when there are no plans', async () => {
    const markdown = await renderIndex(project.dir, clock)
    expect(markdown).toContain('No plans yet')
  })

  it('is byte-identical when regenerated from unchanged input', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    expect(await renderIndex(project.dir, clock)).toBe(await renderIndex(project.dir, clock))
  })
})
