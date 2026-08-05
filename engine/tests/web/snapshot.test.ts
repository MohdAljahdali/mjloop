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
    //
    // Compared as JSON rather than with `toEqual`, because `plans` is an object
    // now and deep equality does not see key order — the exact property
    // `readRevisions` sorts to guarantee. With `toEqual` this assertion stayed
    // green while the key order was flapped on every call.
    expect(JSON.stringify({ ...second.revisions, cycle: '-' })).toBe(
      JSON.stringify({ ...first.revisions, cycle: '-' }),
    )
    expect(first.revisions.cycle).toBe('idle')
  })

  it('move on an approval, which overwrites PLAN.md in place', async () => {
    await initLoop(project.dir, clock)
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)

    const before = (await buildSnapshot(project.dir)).revisions.plans['P001']
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, () => new Date('2026-07-28T10:00:00.000Z'))
    // No directory's mtime moves for an in-place overwrite, which is why the
    // fingerprint stats each document by name.
    expect((await buildSnapshot(project.dir)).revisions.plans['P001']).not.toBe(before)
  })

  it('are per plan, so editing one does not re-fetch the others', async () => {
    // The reason the key is an object. A page with a plan open, a story list
    // beside it and N story tabs subscribes to this once per surface; a single
    // joined string made every one of them follow every plan in the project.
    await initLoop(project.dir, clock)
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)

    const before = (await buildSnapshot(project.dir)).revisions.plans
    expect(Object.keys(before)).toEqual(['P001', 'P002'])

    await gateSet(project.dir, { plan: 'P002', decision: 'approved', by: 'Mohd' }, () => new Date('2026-07-28T10:00:00.000Z'))
    const after = (await buildSnapshot(project.dir)).revisions.plans
    expect(after['P002']).not.toBe(before['P002'])
    expect(after['P001']).toBe(before['P001'])
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

  it('move when a quality record does, and are blind to everything else in the run', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    const runDir = path.join(project.dir, '.mjloop', 'runs', (await buildSnapshot(project.dir)).runs[0] ?? '')

    const before = (await buildSnapshot(project.dir)).revisions.quality
    // A cycle's own files land in the same run directory once a second while a
    // run is live. This key is built from three named documents, so none of
    // that moves it — `revisions.cycle` is what the Evidence tab watches.
    await fs.mkdir(path.join(runDir, 'cycle-01'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'cycle-01', 'editor.json'), '{}')
    expect((await buildSnapshot(project.dir)).revisions.quality).toBe(before)

    // …and an amendment appended beside the pin does, which is what makes a
    // raised ceiling visible to the page that raised it.
    await fs.appendFile(path.join(runDir, 'quality-amendments.jsonl'), '{"version":1}\n')
    expect((await buildSnapshot(project.dir)).revisions.quality).not.toBe(before)
  })

  it('move when a feature brief does, which is what makes an approval visible', async () => {
    await initLoop(project.dir, clock)

    // The directory has to exist *first*, which is the whole point. Creating it
    // moves `features/`'s own mtime and would make a shallow fingerprint look
    // like it worked; approving F001 writes `rev-002.json` **into a directory
    // that is already there**, and moves nothing a listing of `features/` can
    // see. That is the case this key exists for.
    const dir = path.join(project.dir, '.mjloop', 'features', 'F001-sign-in')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'rev-001.json'), '{}')

    const before = (await buildSnapshot(project.dir)).revisions.features
    await fs.writeFile(path.join(dir, 'rev-002.json'), '{}')

    // The snapshot broadcast goes out *before* the receipt, so without this an
    // approving page receives its own confirmation, re-fetches nothing, and
    // goes on drawing the draft it just approved.
    expect((await buildSnapshot(project.dir)).revisions.features).not.toBe(before)
  })

  it('move when a component map is accepted, without watching config and state for it', async () => {
    await initLoop(project.dir, clock)

    // `profile/accepted/`, not `profile/` — a second acceptance lands beside the
    // first inside a directory that already exists.
    const accepted = path.join(project.dir, '.mjloop', 'profile', 'accepted')
    await fs.mkdir(accepted, { recursive: true })
    await fs.writeFile(path.join(accepted, 'rev-001.json'), '{}')

    const before = (await buildSnapshot(project.dir)).revisions.profile
    await fs.writeFile(path.join(accepted, 'rev-002.json'), '{}')

    expect((await buildSnapshot(project.dir)).revisions.profile).not.toBe(before)
  })

  it('move when this project accepts a skill', async () => {
    await initLoop(project.dir, clock)

    const file = path.join(project.dir, '.mjloop', 'skills', 'flutter-forms.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"status":"active"}')

    const before = (await buildSnapshot(project.dir)).revisions.skills
    // `skills disable` rewrites the record in place. Same entry list, same
    // directory mtime, different answer from `/api/skills`.
    await fs.writeFile(file, '{"status":"disabled"}')

    expect((await buildSnapshot(project.dir)).revisions.skills).not.toBe(before)
  })

  it('move when a SKILL.md already on disk is edited in place', async () => {
    await initLoop(project.dir, clock)

    // Two levels down from `.claude/skills/`: `stampTree` reaches one level,
    // which sees this directory's own mtime and its listing — neither of
    // which moves for an edit to the file inside it.
    const dir = path.join(project.dir, '.claude', 'skills', 'brief-writer')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'SKILL.md')
    await fs.writeFile(file, '---\nname: brief-writer\ndescription: Use when a request needs a brief.\n---\nBody.\n')

    const before = (await buildSnapshot(project.dir)).revisions.skills
    // An in-place edit that also changes the file's size, so the fingerprint
    // cannot pass by coincidence on a filesystem whose mtime granularity is
    // coarser than the time this test takes to run.
    await fs.writeFile(
      file,
      '---\nname: brief-writer\ndescription: Use when a request needs a brief, edited.\n---\nBody.\n',
    )

    expect((await buildSnapshot(project.dir)).revisions.skills).not.toBe(before)
  })

  it('survive a library root that cannot be resolved at all', async () => {
    await initLoop(project.dir, clock)

    // `resolveLibraryRoot` *throws* when the resolved root would land inside the
    // project — `LibraryRootCollisionError`, which exists to stop a machine-wide
    // library ending up committed inside one checkout. This runs on every poller
    // tick, and a throw here does not blank the Skills tab: it takes out the
    // whole snapshot, for every tab at once.
    const held = process.env['MJLOOP_DATA_HOME']
    process.env['MJLOOP_DATA_HOME'] = path.join(project.dir, 'library')
    try {
      const snapshot = await buildSnapshot(project.dir)
      expect(snapshot.revisions.skills).toContain('-')
      expect(snapshot.state.status).toBe('idle')
    } finally {
      if (held === undefined) delete process.env['MJLOOP_DATA_HOME']
      else process.env['MJLOOP_DATA_HOME'] = held
    }
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

  it('moves the agents revision when an agent file is edited in place', async () => {
    await fs.mkdir(path.join(project.dir, '.claude', 'agents'), { recursive: true })
    const file = path.join(project.dir, '.claude', 'agents', 'scribe.md')
    await fs.writeFile(file, '---\nname: scribe\ndescription: a\n---\n\nbody\n', 'utf8')
    const before = (await buildSnapshot(project.dir)).revisions.agents
    await fs.writeFile(file, '---\nname: scribe\ndescription: b\n---\n\nbody\n', 'utf8')
    // `revision.ts`'s own `stamp()` is `Math.trunc(mtimeMs).size` — mtime
    // truncated to the millisecond, plus byte size — and `description: a` to
    // `description: b` is the same length, so `size` cannot tell the two
    // writes apart. Nothing forces the two `writeFile`s above to land in
    // different truncated milliseconds; on a fast enough run they do not,
    // which is exactly the fingerprint's own documented hazard (`cycle`'s
    // own comment above: "mtime granularity loses writes inside the same
    // second"). Advancing the second write's mtime by hand is what makes
    // this test assert the thing `stamp()` actually promises — "a file whose
    // mtime moved gets a new revision" — rather than racing the clock to
    // prove it by accident. Do not fix this by making the second write a
    // different byte length instead: that would stop exercising `stamp()`'s
    // mtime half at all, and would go green even if that half broke.
    const stats = await fs.stat(file)
    await fs.utimes(file, stats.atime, new Date(stats.mtimeMs + 2))
    const after = (await buildSnapshot(project.dir)).revisions.agents
    expect(after).not.toBe(before)
  })
})
