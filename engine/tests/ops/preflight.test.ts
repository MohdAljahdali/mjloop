import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { preflightEstimate } from '../../src/ops/preflight.js'
import { UnknownTrackError } from '../../src/ops/run.js'
import type { AgentResult } from '../../src/schemas/contract.js'
import { initialState, type State } from '../../src/schemas/state.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The estimate is asked before a run exists, so every test here calls it
 * against `status: 'idle'` — the state it must work in and the only one an
 * operator ever sees it from.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
})
afterEach(async () => {
  await project.cleanup()
})

function cycleDir(run: string, cycle: number): string {
  return path.join(project.dir, '.mjloop', 'runs', run, `cycle-${String(cycle).padStart(2, '0')}`)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function result(): AgentResult {
  return { status: 'pass', summary: 'did the thing', evidence: [], findings: [], files_touched: [], next_hint: null }
}

/** A run of `cycles` cycles, each dispatching `agents`. */
async function seedRun(run: string, cycles: number, agents: string[] = ['builder', 'verifier']): Promise<void> {
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await writeJson(path.join(cycleDir(run, cycle), 'roster.json'), { cycle, selected: agents, skipped: {} })
    for (const agent of agents) await writeJson(path.join(cycleDir(run, cycle), `${agent}.json`), result())
  }
}

async function writeState(fields: Partial<State>): Promise<void> {
  await writeJsonAtomic(path.join(project.dir, '.mjloop', 'state.json'), { ...initialState(NOW), ...fields })
}

describe('preflightEstimate', () => {
  it('reports the widest cycle the track allows', async () => {
    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    // builder + verifier, plus the six specialists the track offers. `docs` is
    // not among them: it runs once after the run passes.
    expect(preflight.dispatches_per_cycle).toBe(8)
    expect(preflight.roster.closing).toEqual(['docs'])
    expect(preflight.max_cycles).toBe(5)
    // Five widest cycles plus the one closing dispatch, which is a real
    // dispatch and would otherwise be missing from the widest run.
    expect(preflight.ceiling).toEqual({ cycles: 5, dispatches: 41 })
  })

  it('excludes a specialist set to never from the dispatch count', async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { security: 'never' }
    await writeConfig(project.dir, config)

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    expect(preflight.dispatches_per_cycle).toBe(7)
    expect(preflight.roster.forbidden).toEqual(['security'])
  })

  it('names only the forbidden specialists this track would have drafted', async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { security: 'never' }
    await writeConfig(project.dir, config)

    // `edit` never offers security, so a rule about it is a fact about another
    // track and has no business in this track's estimate.
    const preflight = await preflightEstimate(project.dir, { track: 'edit' })

    expect(preflight.roster.forbidden).toEqual([])
    expect(preflight.dispatches_per_cycle).toBe(2)
  })

  it('includes a specialist set to always', async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { reviewer: 'always' }
    await writeConfig(project.dir, config)

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    // Forced into every cycle whether the track offers it or not, so it is part
    // of the widest cycle even though no track names it.
    expect(preflight.dispatches_per_cycle).toBe(9)
    expect(preflight.roster.forced).toEqual(['reviewer'])
  })

  it('refuses a track the config does not define', async () => {
    await expect(preflightEstimate(project.dir, { track: 'invented' })).rejects.toBeInstanceOf(UnknownTrackError)
  })

  it('reports no basis for a track that has never run', async () => {
    await seedRun('2026-07-27-001--adhoc--edit', 1, ['editor', 'verifier'])

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    // No basis is an answer. An invented one is not.
    expect(preflight.comparable).toBeNull()
  })

  it('rests the numbers on past runs of the same track', async () => {
    await seedRun('2026-07-25-001--adhoc--build', 2)
    await seedRun('2026-07-26-001--adhoc--build', 4)
    await seedRun('2026-07-27-001--adhoc--edit', 9, ['editor'])

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    expect(preflight.comparable).toEqual({
      runs: 2,
      cycles: { median: 3, min: 2, max: 4 },
      // Two agents a cycle, over two and four cycles.
      dispatches: { median: 6, min: 4, max: 8 },
      minutes: null,
    })
  })

  it('compares a story run against story runs only', async () => {
    await seedRun('2026-07-25-001--adhoc--build', 1)
    await seedRun('2026-07-26-001--adhoc--build', 1)
    await seedRun('2026-07-27-001--P001-S01--build', 3)

    const bound = await preflightEstimate(project.dir, { track: 'build', story: 'P001-S02' })
    const adhoc = await preflightEstimate(project.dir, { track: 'build' })

    // A story is a bounded unit and a goal typed at a prompt is not. Averaging
    // the two together produces a range wide enough to be useless.
    expect(bound.comparable).toMatchObject({ runs: 1, cycles: { median: 3, min: 3, max: 3 } })
    expect(adhoc.comparable).toMatchObject({ runs: 2, cycles: { median: 1, min: 1, max: 1 } })
  })

  it('leaves a halted run out of the basis', async () => {
    await seedRun('2026-07-26-001--adhoc--build', 2)
    await seedRun('2026-07-27-001--adhoc--build', 5)
    await fs.writeFile(
      path.join(project.dir, '.mjloop', 'runs', '2026-07-27-001--adhoc--build', 'HALT.md'),
      '# halted\n',
      'utf8',
    )

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    // Its cycle count measures where a guard fired, not what the work took.
    expect(preflight.comparable).toMatchObject({ runs: 1, cycles: { median: 2, min: 2, max: 2 } })
  })

  it('leaves a run that is still going out of the basis', async () => {
    await seedRun('2026-07-26-001--adhoc--build', 3)
    await seedRun('2026-07-28-001--adhoc--build', 1)
    await writeState({
      run_id: '2026-07-28-001',
      track: 'build',
      status: 'running',
      cycle: 1,
      started_at: NOW.toISOString(),
    })

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    expect(preflight.comparable).toMatchObject({ runs: 1, cycles: { median: 3, min: 3, max: 3 } })
  })

  it('reports null minutes until a run has been timed', async () => {
    await seedRun('2026-07-26-001--adhoc--build', 2)

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    // Historical runs contribute cycles and dispatches and nothing to minutes:
    // nothing on disk remembers when a finished run opened.
    expect(preflight.comparable?.cycles.median).toBe(2)
    expect(preflight.comparable?.minutes).toBeNull()
  })

  it('reports minutes once a run has been timed', async () => {
    await seedRun('2026-07-28-001--adhoc--build', 2)
    await writeState({
      run_id: '2026-07-28-001',
      track: 'build',
      status: 'done',
      started_at: '2026-07-28T09:00:00.000Z',
      history: [
        { cycle: 1, agents: ['builder'], result: 'fail', ref: 'r', at: '2026-07-28T09:07:00.000Z' },
        { cycle: 2, agents: ['builder'], result: 'pass', ref: 'r', at: '2026-07-28T09:21:30.000Z' },
      ],
    })

    const preflight = await preflightEstimate(project.dir, { track: 'build' })

    // Run open to last cycle closed, to one decimal — a duration carried
    // further would claim a precision the clock does not have.
    expect(preflight.comparable?.minutes).toEqual({ median: 21.5, min: 21.5, max: 21.5 })
  })

  it('names no price and no model', async () => {
    const source = await fs.readFile(fileURLToPath(new URL('../../src/ops/preflight.ts', import.meta.url)), 'utf8')

    // Comments count. The reason this file names no currency figure is that the
    // engine cannot see what an agent runs on — it is frontmatter in a
    // directory the engine has never read — so any number here would be a guess
    // wearing an estimate's clothes, and wrong within a quarter as rates move.
    // A future reader adding one should have to argue with that sentence.
    for (const pattern of [
      /[$£€¥₿]/,
      /\busd\b/i,
      /\bprice\b/i,
      /\bcost\b/i,
      /\bclaude\b/i,
      /\bopus\b/i,
      /\bsonnet\b/i,
      /\bhaiku\b/i,
      /\bgpt\b/i,
      /\bmodel\b/i,
      /\btokens?\b/i,
    ]) {
      expect(source, String(pattern)).not.toMatch(pattern)
    }
  })
})
