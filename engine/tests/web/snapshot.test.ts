import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { runStart } from '../../src/ops/run.js'
import { rosterSet } from '../../src/ops/roster.js'
import { runLog } from '../../src/ops/log.js'
import { buildSnapshot, emptyCache } from '../../src/web/snapshot.js'
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


/**
 * `revisions` is what every tab subscribes to, so two properties matter more
 * than any field it carries: it must not move when nothing has, and it must
 * move when something has that no directory mtime would catch.
 */
describe('revisions', () => {
  it('are byte-identical across two calls with nothing touched', async () => {
    await initLoop(project.dir, clock)
    await seedPlan()

    const cache = emptyCache()
    const first = await buildSnapshot(project.dir, cache)
    const second = await buildSnapshot(project.dir, cache)
    // A flapping revision silently turns the poller into a 1.25 Hz broadcaster
    // and every open tab into a 1.25 Hz fetcher.
    expect(second.revisions).toEqual({ ...first.revisions, cycle: second.revisions.cycle })
    expect(first.revisions.cycle).toBe('idle')
  })

  it('move on an approval, which overwrites PLAN.md in place', async () => {
    await initLoop(project.dir, clock)
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)

    const before = (await buildSnapshot(project.dir)).revisions.plans
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, () => new Date('2026-07-28T10:00:00.000Z'))
    // No directory's mtime moves for an in-place overwrite, which is why the
    // fingerprint stats each document by name.
    expect((await buildSnapshot(project.dir)).revisions.plans).not.toBe(before)
  })

  it('cover the clean-pass hole', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })

    // One cache, as the server has: `revisions.cycle` is that poller's own
    // tick counter, so it only means anything across calls that share one.
    const cache = emptyCache()
    const before = await buildSnapshot(project.dir, cache)
    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: { status: 'pass', summary: 'Renamed it.', evidence: [], findings: [], files_touched: [] },
      },
      clock,
    )
    const after = await buildSnapshot(project.dir, cache)

    // `ops/log.ts:175` only calls `store.update` when a result carries
    // findings, a gate proof or error signatures. A clean pass writes
    // `cycle-NN/<agent>.json` and touches nothing else — so without a cycle
    // revision the Evidence tab would sit there confidently showing nothing.
    expect(after.state.status).toBe('running')
    expect(before.revisions.cycle).not.toBe(after.revisions.cycle)
  })

  it('report which drafted agents have landed while a run is open', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: { status: 'pass', summary: 'Renamed it.', evidence: [], findings: [], files_touched: [] },
      },
      clock,
    )

    const snapshot = await buildSnapshot(project.dir)
    expect(snapshot.roster).toEqual({ cycle: 1, selected: ['editor', 'verifier'], landed: ['editor'] })
    expect(snapshot.guards).toMatchObject({ strikes: 0, strikesAllowed: 2 })
  })
})
