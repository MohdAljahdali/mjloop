import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoActiveRunError, UnknownTrackError, cycleAdvance, halt, runDirName, runDirPath, runStart } from '../../src/ops/run.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { InvalidStateError, StateStore } from '../../src/store/state-store.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

describe('runStart', () => {
  it('opens a run and creates its directory', async () => {
    const state = await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)

    expect(state.run_id).toBe('2026-07-26-001')
    expect(state.track).toBe('edit')
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(1)
    expect(state.current.stage).toBe('compose')
    expect(state.goal).toBe('Rename submit label')
    expect(runDirName(state)).toBe('2026-07-26-001--adhoc--edit')
    expect((await fs.stat(runDirPath(project.dir, state))).isDirectory()).toBe(true)
  })

  it('names the run directory after the story when there is one', async () => {
    const state = await runStart(
      project.dir,
      { track: 'edit', goal: 'Fix label', plan: 'P001', story: 'P001-S02' },
      clock,
    )
    expect(runDirName(state)).toBe('2026-07-26-001--P001-S02--edit')
    expect(state.current.story).toBe('P001-S02')
    expect(state.current.plan).toBe('P001')
  })

  it('increments the daily sequence number', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'First' }, clock)
    const second = await runStart(project.dir, { track: 'edit', goal: 'Second' }, clock)
    expect(second.run_id).toBe('2026-07-26-002')
  })

  it('clears findings and history from the previous run', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'First' }, clock)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)
    const second = await runStart(project.dir, { track: 'edit', goal: 'Second' }, clock)
    expect(second.history).toEqual([])
    expect(second.findings).toEqual([])
    expect(second.halt_reason).toBeNull()
  })

  it('rejects a track that is not in config', async () => {
    await expect(runStart(project.dir, { track: 'ghost', goal: 'x' }, clock)).rejects.toBeInstanceOf(UnknownTrackError)
  })

  it('rejects a story id that would escape the runs directory', async () => {
    await expect(
      runStart(project.dir, { track: 'edit', goal: 'x', story: '../../../tmp/x' }, clock),
    ).rejects.toBeInstanceOf(InvalidStateError)
    // the state write was rejected, so no run directory was created either
    await expect(fs.access(path.join(project.dir, 'tmp'))).rejects.toThrow()
    expect((await new StateStore(project.dir).get()).status).toBe('idle')
  })

  it('gives concurrent starts distinct run ids and directories', async () => {
    const [a, b] = await Promise.all([
      runStart(project.dir, { track: 'edit', goal: 'A', story: 'S-A' }, clock),
      runStart(project.dir, { track: 'edit', goal: 'B', story: 'S-B' }, clock),
    ])
    expect(a.run_id).not.toBe(b.run_id)
    expect((await fs.stat(runDirPath(project.dir, a))).isDirectory()).toBe(true)
    expect((await fs.stat(runDirPath(project.dir, b))).isDirectory()).toBe(true)
  })
})

describe('cycleAdvance', () => {
  it('records the cycle and finishes the run on pass', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)

    expect(state.status).toBe('done')
    expect(state.current.stage).toBe('done')
    expect(state.cycle).toBe(1)
    expect(state.history).toEqual([
      { cycle: 1, agents: ['editor', 'verifier'], result: 'pass', ref: '.loop/runs/2026-07-26-001--adhoc--edit' },
    ])
  })

  it('halts with a cycle-cap reason when the track cap is reached', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    expect(state.status).toBe('halted')
    expect(state.current.stage).toBe('halted')
    expect(state.halt_reason).toBe('cycle cap 1 reached for track edit')

    const haltFile = path.join(runDirPath(project.dir, state), 'HALT.md')
    const report = await fs.readFile(haltFile, 'utf8')
    expect(report).toContain('cycle cap 1 reached for track edit')
    expect(report).toContain('editor, verifier')
  })

  it('opens the next cycle when the cap allows it', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], max_cycles: 3 }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    expect(state.status).toBe('running')
    expect(state.cycle).toBe(2)
    expect(state.current.stage).toBe('compose')
    expect(state.history).toHaveLength(1)
  })

  it('refuses to advance when no run is active', async () => {
    await expect(cycleAdvance(project.dir, { agents: ['editor'], result: 'pass' }, clock)).rejects.toBeInstanceOf(NoActiveRunError)
  })

  it('never advances past the cycle cap under concurrent advances', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], max_cycles: 2 }
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)

    // Both advances race from cycle 1; each must judge the state the other
    // left behind, so the second one sees the cap and halts instead of
    // stepping to cycle 3.
    await Promise.all([
      cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock),
      cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    expect(state.cycle).toBe(2)
    expect(state.status).toBe('halted')
    expect(state.halt_reason).toBe('cycle cap 2 reached for track edit')
  })
})

describe('cycleAdvance findings lifecycle', () => {
  const failing = (claim: string) => ({
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '1 failing' }],
    findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
    files_touched: [],
    next_hint: null,
  })

  it('returns the closed cycle findings and clears them from state', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('assertion is stale') }, clock)

    const { state, carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'fail' },
      clock,
    )

    expect(carried_findings).toEqual([
      { severity: 'high', file: 'src/a.ts', line: 1, claim: 'assertion is stale' },
    ])
    expect(state.findings).toEqual([])
  })

  it('archives the closed cycle findings next to the agent results', async () => {
    const started = await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('assertion is stale') }, clock)
    const { carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'fail' },
      clock,
    )

    const file = path.join(runDirPath(project.dir, started), 'cycle-01', 'findings.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(carried_findings)
  })

  it('carries a passing cycle findings too, with no next cycle to hand them to', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: { ...failing('minor nit'), status: 'pass', findings: [{ severity: 'low', file: 'src/a.ts', line: 2, claim: 'minor nit' }] },
      },
      clock,
    )
    const { state, carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'pass' },
      clock,
    )
    expect(state.status).toBe('done')
    expect(carried_findings).toHaveLength(1)
    expect(state.findings).toEqual([])
  })
})

describe('halt', () => {
  it('refuses to halt when no run exists and leaves state untouched', async () => {
    await expect(halt(project.dir, 'user requested stop', clock)).rejects.toBeInstanceOf(NoActiveRunError)
    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('idle')
    expect(state.halt_reason).toBeNull()
  })

  it('stops the run and writes a report', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const state = await halt(project.dir, 'user requested stop', clock)

    expect(state.status).toBe('halted')
    expect(state.halt_reason).toBe('user requested stop')
    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report).toContain('user requested stop')
  })
})
