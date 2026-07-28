import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { runStart } from '../../src/ops/run.js'
import { buildSnapshot } from '../../src/web/snapshot.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
})
afterEach(async () => {
  await project.cleanup()
})

/** An approved plan with two stories — the shape the page is built to show. */
async function seedPlan(): Promise<void> {
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form', ui: true }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Session cookie', depends_on: ['P001-S01'] }, clock)
}

describe('buildSnapshot', () => {
  it('reports an uninitialised project without inventing anything', async () => {
    const snapshot = await buildSnapshot(project.dir)
    expect(snapshot.state.initialised).toBe(false)
    expect(snapshot.plans).toEqual([])
    expect(snapshot.runs).toEqual([])
  })

  it('carries the state summary the rest of the engine already produces', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)

    const snapshot = await buildSnapshot(project.dir)
    expect(snapshot.state.status).toBe('running')
    expect(snapshot.state.track).toBe('edit')
    expect(snapshot.state.goal).toBe('Rename the submit label')
    expect(snapshot.project).toBe(project.dir)
  })

  it('reads plans, their approval, and their stories', async () => {
    await initLoop(project.dir, clock)
    await seedPlan()

    const snapshot = await buildSnapshot(project.dir)
    expect(snapshot.plans).toHaveLength(1)

    const [plan] = snapshot.plans
    expect(plan?.id).toBe('P001')
    expect(plan?.title).toBe('User authentication')
    expect(plan?.approval).toBe('approved')
    expect(plan?.stories.map((story) => story.id)).toEqual(['P001-S01', 'P001-S02'])
    expect(plan?.stories[0]?.ui).toBe(true)
    expect(plan?.stories[1]?.depends_on).toEqual(['P001-S01'])
  })

  it('never writes to the project it is reading', async () => {
    await initLoop(project.dir, clock)
    await seedPlan()

    const planFile = path.join(project.dir, '.mjloop', 'plans', 'P001-user-auth', 'PLAN.md')
    // Frontmatter an agent clobbered. `readPlan` would repair it by rewriting
    // the file — which is exactly why the snapshot does not use `readPlan`: a
    // poller running eight times a second must not write to a project.
    await fs.writeFile(planFile, 'no frontmatter here at all\n', 'utf8')
    const before = await fs.readFile(planFile, 'utf8')

    const snapshot = await buildSnapshot(project.dir)

    expect(await fs.readFile(planFile, 'utf8')).toBe(before)
    // The plan is still listed, titled from its own manifest.
    expect(snapshot.plans[0]?.title).toBe('User authentication')
    expect(snapshot.plans[0]?.approval).toBeNull()
  })

  it('lists run directories newest first', async () => {
    await initLoop(project.dir, clock)
    const runs = path.join(project.dir, '.mjloop', 'runs')
    await fs.mkdir(path.join(runs, '2026-07-28-001--adhoc--edit'), { recursive: true })
    await fs.mkdir(path.join(runs, '2026-07-28-002--P001-S01--build'), { recursive: true })

    const snapshot = await buildSnapshot(project.dir)
    expect(snapshot.runs).toEqual(['2026-07-28-002--P001-S01--build', '2026-07-28-001--adhoc--edit'])
  })
})
