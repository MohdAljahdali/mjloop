import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRunHistory } from '../../src/ops/history.js'
import { initLoop } from '../../src/ops/init.js'
import type { AgentResult } from '../../src/schemas/contract.js'
import { initialState, type State } from '../../src/schemas/state.js'
import type { LedgerEntry } from '../../src/schemas/verify.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The walk is the only cross-run reader, so its tests seed run directories by
 * hand rather than driving `runStart`/`runLog`: what matters here is what the
 * walk makes of a directory tree it did not create — including trees written by
 * a milestone that predates it, and one written by a batch that has not landed.
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

function runsDir(): string {
  return path.join(project.dir, '.mjloop', 'runs')
}

function cycleDir(run: string, cycle: number): string {
  return path.join(runsDir(), run, `cycle-${String(cycle).padStart(2, '0')}`)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: 'pass',
    summary: 'did the thing',
    evidence: [],
    findings: [],
    files_touched: [],
    next_hint: null,
    skills_used: [],
    ...overrides,
  }
}

/** A roster and one passing result, which is the smallest thing a cycle can be. */
async function seedCycle(run: string, cycle: number, selected: string[]): Promise<void> {
  await writeJson(path.join(cycleDir(run, cycle), 'roster.json'), { cycle, selected, skipped: {} })
  for (const agent of selected) await writeJson(path.join(cycleDir(run, cycle), `${agent}.json`), result())
}

describe('readRunHistory', () => {
  it('reads runs newest first', async () => {
    for (const run of [
      '2026-07-26-001--adhoc--edit',
      '2026-07-27-001--adhoc--build',
      '2026-07-26-002--P001-S01--build',
    ]) {
      await seedCycle(run, 1, ['builder'])
    }

    const history = await readRunHistory(project.dir)

    expect(history.map((run) => run.id)).toEqual([
      '2026-07-27-001--adhoc--build',
      '2026-07-26-002--P001-S01--build',
      '2026-07-26-001--adhoc--edit',
    ])
    expect(history[0]?.run_id).toBe('2026-07-27-001')
    expect(history[0]?.track).toBe('build')
    // `adhoc` is the absence of a story, not a story called "adhoc".
    expect(history[0]?.story).toBeNull()
    expect(history[1]?.story).toBe('P001-S01')
  })

  it('stops at the limit', async () => {
    for (const day of ['01', '02', '03', '04']) {
      await seedCycle(`2026-07-${day}-001--adhoc--build`, 1, ['builder'])
    }

    const history = await readRunHistory(project.dir, { limit: 2 })

    expect(history.map((run) => run.run_id)).toEqual(['2026-07-04-001', '2026-07-03-001'])
  })

  it('reads only the named track', async () => {
    await seedCycle('2026-07-26-001--adhoc--edit', 1, ['editor'])
    await seedCycle('2026-07-27-001--adhoc--build', 1, ['builder'])

    const history = await readRunHistory(project.dir, { track: 'build' })

    expect(history.map((run) => run.track)).toEqual(['build'])
  })

  it('skips a cycle whose roster is unreadable without losing the run', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, ['builder'])
    await fs.mkdir(cycleDir(run, 2), { recursive: true })
    await fs.writeFile(path.join(cycleDir(run, 2), 'roster.json'), '{ not json at all', 'utf8')
    await writeJson(path.join(cycleDir(run, 2), 'builder.json'), result({ status: 'fail' }))

    const history = await readRunHistory(project.dir)

    // The run keeps both cycles: a run's length is what the preflight estimate
    // rests on, so a lost roster must cost the roster's two fields and nothing
    // else.
    expect(history[0]?.cycles.map((cycle) => cycle.cycle)).toEqual([1, 2])
    expect(history[0]?.cycles[1]?.selected).toEqual([])
    expect(history[0]?.cycles[1]?.agents.map((agent) => agent.name)).toEqual(['builder'])
  })

  it('counts an instance file as the agent that produced it', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await writeJson(path.join(cycleDir(run, 1), 'roster.json'), { cycle: 1, selected: ['critic'], skipped: {} })
    await writeJson(path.join(cycleDir(run, 1), 'critic.json'), result())
    await writeJson(path.join(cycleDir(run, 1), 'critic--api.json'), result({ status: 'fail' }))

    const history = await readRunHistory(project.dir)

    expect(history[0]?.cycles[0]?.agents).toEqual([
      { name: 'critic', instance: 'api', status: 'fail', findings: [], files: 0 },
      { name: 'critic', instance: null, status: 'pass', findings: [], files: 0 },
    ])
  })

  it('walks the closing directory alongside the cycles', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, ['builder'])
    await writeJson(path.join(runsDir(), run, 'closing', 'roster.json'), {
      cycle: 1,
      selected: ['docs'],
      skipped: {},
    })
    await writeJson(path.join(runsDir(), run, 'closing', 'docs.json'), result({ files_touched: ['README.md'] }))

    const history = await readRunHistory(project.dir)

    // The closing pass is not one of the cycles — it happens after the last one
    // closed — so it never inflates a cycle count.
    expect(history[0]?.cycles).toHaveLength(1)
    expect(history[0]?.closing?.cycle).toBe(0)
    expect(history[0]?.closing?.selected).toEqual(['docs'])
    expect(history[0]?.closing?.agents).toEqual([
      { name: 'docs', instance: null, status: 'pass', findings: [], files: 1 },
    ])
  })

  it('reads a closing roster that carries keys this walk does not', async () => {
    // `closing/roster.json`'s writer lands in a later batch. Parsing it with a
    // strict schema would make one added key erase the dispatch from every
    // report about the past, silently.
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, ['builder'])
    await writeJson(path.join(runsDir(), run, 'closing', 'roster.json'), {
      closing: true,
      selected: ['docs'],
      skipped: { changelog: 'nothing user-visible changed' },
    })

    const history = await readRunHistory(project.dir)

    expect(history[0]?.closing?.selected).toEqual(['docs'])
    expect(history[0]?.closing?.skipped).toEqual({ changelog: 'nothing user-visible changed' })
  })

  it('reads the verify ledger beside the cycle, queued entries included', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, ['verifier'])
    const ledger: LedgerEntry[] = [
      {
        slot: 'test',
        command: 'npm test',
        source: 'pinned',
        live_command: null,
        log: 'test.log',
        phase: 'queued',
        exit_code: null,
        timed_out: false,
        fingerprint: null,
        cached_from_cycle: null,
        duration_ms: null,
        at: NOW.toISOString(),
      },
    ]
    await writeJson(path.join(cycleDir(run, 1), 'verify', 'index.json'), ledger)

    const history = await readRunHistory(project.dir)

    expect(history[0]?.cycles[0]?.verify).toEqual(ledger)
  })

  it('reports an empty ledger for a run written before the ledger existed', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, ['builder'])

    const history = await readRunHistory(project.dir)

    expect(history[0]?.cycles[0]?.verify).toEqual([])
  })

  it('carries the timings of the run state still describes, and no other', async () => {
    await seedCycle('2026-07-26-001--adhoc--build', 1, ['builder'])
    await seedCycle('2026-07-28-001--adhoc--build', 1, ['builder'])
    await writeState({
      run_id: '2026-07-28-001',
      track: 'build',
      status: 'done',
      started_at: '2026-07-28T09:00:00.000Z',
      history: [
        {
          cycle: 1,
          agents: ['builder'],
          result: 'pass',
          ref: '.mjloop/runs/2026-07-28-001--adhoc--build',
          at: '2026-07-28T09:12:00.000Z',
        },
      ],
    })

    const history = await readRunHistory(project.dir)

    expect(history[0]?.started_at).toBe('2026-07-28T09:00:00.000Z')
    expect(history[0]?.cycles[0]?.at).toBe('2026-07-28T09:12:00.000Z')
    expect(history[0]?.running).toBe(false)
    // `runStart` resets `state.history`, so nothing on disk remembers when an
    // earlier run opened. Reporting null is the honest answer.
    expect(history[1]?.started_at).toBeNull()
    expect(history[1]?.cycles[0]?.at).toBeNull()
  })

  it('marks the run state still calls running', async () => {
    await seedCycle('2026-07-28-001--adhoc--build', 1, ['builder'])
    await writeState({ run_id: '2026-07-28-001', track: 'build', status: 'running', started_at: NOW.toISOString() })

    const history = await readRunHistory(project.dir)

    expect(history[0]?.running).toBe(true)
  })

  it('marks a halted run', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, ['builder'])
    await fs.writeFile(path.join(runsDir(), run, 'HALT.md'), '# halted\n', 'utf8')

    const history = await readRunHistory(project.dir)

    expect(history[0]?.halted).toBe(true)
  })

  it('ignores a directory whose name is not a run', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, ['builder'])
    await fs.mkdir(path.join(runsDir(), 'scratch'), { recursive: true })

    const history = await readRunHistory(project.dir)

    expect(history.map((run) => run.id)).toEqual(['2026-07-27-001--adhoc--build'])
  })

  it('returns nothing for a project that has never run', async () => {
    await initLoop(project.dir, clock)

    expect(await readRunHistory(project.dir)).toEqual([])
  })

  it('writes nothing', async () => {
    await initLoop(project.dir, clock)
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, ['builder', 'verifier'])
    await writeJson(path.join(runsDir(), run, 'closing', 'docs.json'), result())
    // A file the walk cannot parse is the interesting case: a reader that
    // repaired one would be writing to somebody's project from a poll.
    await fs.writeFile(path.join(cycleDir(run, 1), 'critic.json'), 'not json', 'utf8')

    const before = await hashTree(project.dir)
    await readRunHistory(project.dir)
    expect(await hashTree(project.dir)).toEqual(before)
  })
})

/** State describing one run, written the way the engine writes it. */
async function writeState(fields: Partial<State>): Promise<void> {
  await writeJsonAtomic(path.join(project.dir, '.mjloop', 'state.json'), { ...initialState(NOW), ...fields })
}

/** Every file under `.mjloop/`, hashed — the contractual test for a reader. */
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
