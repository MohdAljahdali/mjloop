import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { memoryAdd } from '../../src/ops/memory.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { runLog } from '../../src/ops/log.js'
import { runStart } from '../../src/ops/run.js'
import { LedgerEntrySchema, type LedgerEntry } from '../../src/schemas/verify.js'
import {
  CYCLE_HANDOFF_MAX,
  CYCLE_VERIFY_MAX,
  NotFoundError,
  readConfigView,
  readCycleDetail,
  readMemories,
  readMemoryEntry,
  readPlanDetail,
  readPreflightEstimate,
  readRosterProgress,
  readRunDetail,
  readRuns,
  readState,
  readStoryDetail,
  readTelemetryReport,
} from '../../src/web/read.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The read api serves a browser that polls. Its one non-negotiable property is
 * that it never writes — which is why `readPlan`, the repairing reader, is not
 * used anywhere under `src/web/`.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
})
afterEach(async () => {
  await project.cleanup()
})

/** Every file under `.mjloop/`, hashed. */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.set(full, crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex'))
    }
  }
  await walk(path.join(dir, '.mjloop'))
  return out
}

/**
 * A ledger row, built through the schema the executor writes through rather
 * than typed out as a literal. `ops/verify.ts` cannot be called from here — it
 * spawns the project's own commands — so the schema is what keeps this fixture
 * and the real file the same shape: a field added to `LedgerEntrySchema` that
 * these rows cannot satisfy fails here rather than in a browser.
 */
function ledgerRow(patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return LedgerEntrySchema.parse({
    slot: 'test',
    command: 'cd engine && npm test',
    source: 'pinned',
    log: 'test.log',
    phase: 'complete',
    exit_code: 0,
    at: NOW.toISOString(),
    ...patch,
  })
}

async function writeLedger(runId: string, cycle: number, entries: LedgerEntry[]): Promise<void> {
  const dir = path.join(project.dir, '.mjloop', 'runs', runId, `cycle-${String(cycle).padStart(2, '0')}`, 'verify')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

async function seed(): Promise<void> {
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd', note: 'ship it' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form', ui: true, acceptance: ['it logs in'] }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Session cookie', depends_on: ['P001-S01'] }, clock)
  await memoryAdd(project.dir, { kind: 'decision', title: 'Cookies over tokens', body: 'Because of SSR.' }, clock)
}

describe('read', () => {
  it('writes nothing, including against a clobbered PLAN.md', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    const runId = (await readRuns(project.dir))[0]?.id ?? ''

    // `readPlan` would repair this by rewriting the file. Nothing here may.
    const planFile = path.join(project.dir, '.mjloop', 'plans', 'P001-user-auth', 'PLAN.md')
    await fs.writeFile(planFile, '---\nnot: frontmatter\n---\n\nstill a body\n', 'utf8')

    const before = await hashTree(project.dir)
    await Promise.all([
      readState(project.dir),
      readConfigView(project.dir),
      readPlanDetail(project.dir, 'P001'),
      readStoryDetail(project.dir, 'P001-S01'),
      readRuns(project.dir),
      readCycleDetail(project.dir, runId, 1),
      readMemories(project.dir),
      readMemoryEntry(project.dir, 'M001'),
      // Both cross-run reports walk every run directory in the project. A walk
      // is still a read, and the property this test defends is the whole reason
      // they are projections over `readRunHistory` rather than anything that
      // could repair what it opens.
      readTelemetryReport(project.dir),
      readPreflightEstimate(project.dir, 'edit'),
    ])
    expect(await hashTree(project.dir)).toEqual(before)
  })

  it('carries the whole approval record, not just the decision', async () => {
    await seed()
    const detail = await readPlanDetail(project.dir, 'P001')
    expect(detail.approval).toMatchObject({ decision: 'approved', by: 'Mohd', note: 'ship it' })
    expect(detail.approval?.at).toBe(NOW.toISOString())
  })

  it('reads acceptance and evidence, which the manifest does not carry', async () => {
    await seed()
    const story = await readStoryDetail(project.dir, 'P001-S01')
    expect(story.acceptance).toEqual(['it logs in'])
    expect(story.evidence).toBe(null)
    expect(story.depends_on).toEqual([])
  })

  it('reports the review the engine itself never reads', async () => {
    await seed()
    const file = path.join(project.dir, '.mjloop', 'plans', 'P001-user-auth', 'REVIEW.md')
    await fs.writeFile(file, '# Review\n\nToo big.\n', 'utf8')
    expect((await readPlanDetail(project.dir, 'P001')).review).toContain('Too big.')
  })

  it('says what a run was and how it ended', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label', story: 'P001-S01' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })

    const runs = await readRuns(project.dir)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ story: 'P001-S01', track: 'edit', cycles: 1, halted: false })

    const detail = await readRunDetail(project.dir, runs[0]?.id ?? '')
    expect(detail.cycles).toEqual([1])
    expect(detail.halt).toBe(null)
  })

  it('keeps the agents the leader skipped, and its reason for each', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { critic: 'a one-line label change' },
    })

    const runId = (await readRuns(project.dir))[0]?.id ?? ''
    const cycle = await readCycleDetail(project.dir, runId, 1)
    // Recoverable from nowhere else: why an agent did *not* run is only ever
    // written here.
    expect(cycle.roster?.skipped).toEqual([{ agent: 'critic', reason: 'a one-line label change' }])
    expect(cycle.roster?.selected).toEqual(['editor', 'verifier'])
  })

  it('reports which drafted agents have landed', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    await runLog(
      project.dir,
      { agent: 'editor', result: { status: 'pass', summary: 'Renamed it.', evidence: [], findings: [], files_touched: [] } },
      clock,
    )

    const runId = (await readRuns(project.dir))[0]?.id ?? ''
    const progress = await readRosterProgress(project.dir, runId, 1)
    // The only real intra-cycle progress signal there is: `StateSchema` permits
    // stage `execute` and `judge`, and nothing in the engine ever sets them.
    expect(progress).toEqual({ cycle: 1, selected: ['editor', 'verifier'], landed: ['editor'] })
  })

  it('skips an agent result that no longer parses rather than blanking the cycle', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    await runLog(
      project.dir,
      { agent: 'editor', result: { status: 'pass', summary: 'Renamed it.', evidence: [], findings: [], files_touched: [] } },
      clock,
    )

    const runId = (await readRuns(project.dir))[0]?.id ?? ''
    const dir = path.join(project.dir, '.mjloop', 'runs', runId, 'cycle-01')
    await fs.writeFile(path.join(dir, 'verifier.json'), '{"nonsense":true}', 'utf8')

    const cycle = await readCycleDetail(project.dir, runId, 1)
    expect(cycle.agents.map((entry) => entry.agent)).toEqual(['editor'])
  })

  it('carries the cycle ledger, drift and queued rows included', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    const runId = (await readRuns(project.dir))[0]?.id ?? ''

    await writeLedger(runId, 1, [
      // The pin ran one command while `config.yaml` now holds another. This is
      // the whole reason drift was put on the ledger entry: it reaches the
      // Evidence tab through the reader the tab already has, with no second
      // channel and nothing here reading the pin.
      ledgerRow({ live_command: 'cd engine && npm run test:fast' }),
      // Nothing ran: another verify command in the project held the lock. It
      // must read as queued rather than as nothing.
      ledgerRow({ slot: 'lint', command: 'cd engine && npm run typecheck', log: 'lint.log', phase: 'queued', exit_code: null }),
    ])

    const cycle = await readCycleDetail(project.dir, runId, 1)
    expect(cycle.verify_total).toBe(2)
    expect(cycle.verify[0]).toMatchObject({
      slot: 'test',
      source: 'pinned',
      live_command: 'cd engine && npm run test:fast',
      exit_code: 0,
    })
    expect(cycle.verify[1]).toMatchObject({ phase: 'queued', exit_code: null })
  })

  it('reports an empty ledger for a cycle that predates it', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    const runId = (await readRuns(project.dir))[0]?.id ?? ''

    // Every cycle of every run written before this milestone has no `verify/`
    // directory at all, and that is not an error the Evidence tab should show.
    const cycle = await readCycleDetail(project.dir, runId, 1)
    expect(cycle.verify).toEqual([])
    expect(cycle.verify_total).toBe(0)
    expect(cycle.handoff).toBe(null)
  })

  it('caps the ledger it serves and says how many rows there were', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    const runId = (await readRuns(project.dir))[0]?.id ?? ''

    const overflow = CYCLE_VERIFY_MAX + 10
    await writeLedger(
      runId,
      1,
      Array.from({ length: overflow }, (_, index) => ledgerRow({ log: `test--${index}.log` })),
    )

    const cycle = await readCycleDetail(project.dir, runId, 1)
    // The tab re-fetches this document every time `revisions.cycle` moves. An
    // unbounded array here is a payload that grows for the length of the cycle
    // and is re-serialised roughly once a second.
    expect(cycle.verify).toHaveLength(CYCLE_VERIFY_MAX)
    expect(cycle.verify_total).toBe(overflow)
    // The newest rows survive: they are what the cycle's verdict rests on.
    expect(cycle.verify.at(-1)?.log).toBe(`test--${overflow - 1}.log`)
  })

  it('carries the handoff body, and bounds one it did not write', async () => {
    await seed()
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    const runId = (await readRuns(project.dir))[0]?.id ?? ''
    const dir = path.join(project.dir, '.mjloop', 'runs', runId, 'cycle-01')

    await fs.writeFile(path.join(dir, 'handoff.md'), '# Handoff — cycle 1\n\nThe label is renamed.\n', 'utf8')
    const written = await readCycleDetail(project.dir, runId, 1)
    expect(written.handoff).toContain('The label is renamed.')
    expect(written.handoff_truncated).toBe(false)

    // `writeHandoff` truncates at its own ceiling, so this case is the file the
    // engine did not write — an ordinary file a person or an agent can replace.
    await fs.writeFile(path.join(dir, 'handoff.md'), 'x'.repeat(CYCLE_HANDOFF_MAX + 500), 'utf8')
    const replaced = await readCycleDetail(project.dir, runId, 1)
    expect(replaced.handoff).toHaveLength(CYCLE_HANDOFF_MAX)
    expect(replaced.handoff_truncated).toBe(true)
  })

  it('reports a project that has never run without inventing a basis for it', async () => {
    await initLoop(project.dir, clock)

    const telemetry = await readTelemetryReport(project.dir)
    expect(telemetry).toMatchObject({ runs: 0, cycles: 0, specialists: [], truncated: 0, flagged: [] })

    const preflight = await readPreflightEstimate(project.dir, 'edit')
    expect(preflight.track).toBe('edit')
    expect(preflight.dispatches_per_cycle).toBe(2)
    // *No basis* is an answer, and an invented one is not.
    expect(preflight.comparable).toBe(null)
  })

  it('raises NotFound for a track this project does not define', async () => {
    await initLoop(project.dir, clock)
    // An unknown track is the operator asking about something that is not
    // there, not this server failing to read something it should have read.
    await expect(readPreflightEstimate(project.dir, 'nonsense')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('keeps the raw config, comments and all', async () => {
    await initLoop(project.dir, clock)
    const file = path.join(project.dir, '.mjloop', 'config.yaml')
    // Hand-added, because that is the case that matters: `writeConfig`
    // serialises the parsed document and drops every comment, which is why the
    // Config tab is read-only and shows the file as written.
    await fs.writeFile(file, `# keep me\n${await fs.readFile(file, 'utf8')}`, 'utf8')

    const view = await readConfigView(project.dir)
    expect(view.invalid).toBe(false)
    expect(view.parsed?.version).toBe(1)
    expect(view.raw).toContain('# keep me')
  })

  it('reports a config that does not parse without pretending it is missing', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(path.join(project.dir, '.mjloop', 'config.yaml'), 'version: "not a number"\n', 'utf8')
    const view = await readConfigView(project.dir)
    expect(view.invalid).toBe(true)
    expect(view.raw).toContain('not a number')
  })

  it('raises NotFound rather than inventing an empty answer', async () => {
    await seed()
    await expect(readPlanDetail(project.dir, 'P999')).rejects.toBeInstanceOf(NotFoundError)
    await expect(readStoryDetail(project.dir, 'P001-S99')).rejects.toBeInstanceOf(NotFoundError)
    await expect(readRunDetail(project.dir, 'nope')).rejects.toBeInstanceOf(NotFoundError)
    await expect(readMemoryEntry(project.dir, 'M999')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('serves memory whole so the page can facet it', async () => {
    await seed()
    const memories = await readMemories(project.dir)
    // `memorySearch` filters by none of kind, tag, time or run, so faceting
    // cannot be pushed to the server — and its `reason` is engine-authored
    // prose that must not cross this wire.
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ id: 'M001', kind: 'decision', title: 'Cookies over tokens' })
    expect(memories[0]?.body).toContain('SSR')
  })
})
