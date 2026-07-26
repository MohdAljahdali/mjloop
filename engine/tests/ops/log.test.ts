import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CycleClosedError, InvalidAgentNameError, InvalidAgentResultError, runLog } from '../../src/ops/log.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

const RESULT = {
  status: 'fail',
  summary: 'Two tests still fail after the rename.',
  evidence: [{ kind: 'command', ref: 'npm test', excerpt: '2 failed, 10 passed' }],
  findings: [{ severity: 'high', file: 'src/Button.tsx', line: 14, claim: 'label no longer matches the snapshot' }],
  files_touched: ['src/Button.tsx'],
  next_hint: 'update the snapshot',
}

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('runLog', () => {
  it('writes the agent result under the cycle directory', async () => {
    const { path: file, findingsAdded } = await runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)

    const state = await new StateStore(project.dir).get()
    expect(file).toBe(path.join(runDirPath(project.dir, state), 'cycle-01', 'verifier.json'))
    expect(JSON.parse(await fs.readFile(file, 'utf8')).summary).toBe(RESULT.summary)
    expect(findingsAdded).toBe(1)
  })

  it('folds the agent findings into state', async () => {
    await runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)
    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual(RESULT.findings)
  })

  it('rejects a malformed result with a readable error', async () => {
    await expect(runLog(project.dir, { agent: 'verifier', result: { status: 'fail' } }, clock)).rejects.toBeInstanceOf(
      InvalidAgentResultError,
    )
    await expect(runLog(project.dir, { agent: 'verifier', result: { status: 'fail' } }, clock)).rejects.toThrow(/summary/)
  })

  it('does not touch state when the result is rejected', async () => {
    await expect(runLog(project.dir, { agent: 'verifier', result: {} }, clock)).rejects.toThrow()
    expect((await new StateStore(project.dir).get()).findings).toEqual([])
  })

  it('keeps results from different agents side by side', async () => {
    await runLog(project.dir, { agent: 'editor', result: { ...RESULT, findings: [] } }, clock)
    await runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)

    const state = await new StateStore(project.dir).get()
    const entries = await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01'))
    expect(entries.sort()).toEqual(['editor.json', 'verifier.json'])
  })
})

describe('runLog agent names', () => {
  it('refuses a name that would write outside the cycle directory', async () => {
    // The name arrives from the leader model, and `.loop/state.json` is three
    // levels up from the cycle directory.
    await expect(runLog(project.dir, { agent: '../../../state', result: RESULT }, clock)).rejects.toBeInstanceOf(
      InvalidAgentNameError,
    )

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('running')
    expect(state.findings).toEqual([])
    expect(await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('refuses a name reserved by the cycle directory', async () => {
    // `cycle-NN/findings.json` is the archive cycleAdvance writes; an agent by
    // that name would have its result overwritten at cycle close.
    await expect(runLog(project.dir, { agent: 'findings', result: RESULT }, clock)).rejects.toBeInstanceOf(
      InvalidAgentNameError,
    )
  })

  it('accepts the ordinary agent names', async () => {
    await expect(runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)).resolves.toBeDefined()
    await expect(runLog(project.dir, { agent: 'ui-critic_2', result: RESULT }, clock)).resolves.toBeDefined()
  })
})

describe('runLog instances', () => {
  const verdict = {
    status: 'fail' as const,
    summary: 'The hypothesis does not hold: the cache is populated before the read.',
    evidence: [{ kind: 'command' as const, ref: 'npm test -- cache', excerpt: 'ordering is correct' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  it('keeps two runs of the same agent side by side', async () => {
    const first = await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'stale-cache', result: verdict }, clock)
    const second = await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'race-on-write', result: verdict }, clock)

    expect(first.path).not.toBe(second.path)
    expect(path.basename(first.path)).toBe('hypothesis-tester--stale-cache.json')
    expect(path.basename(second.path)).toBe('hypothesis-tester--race-on-write.json')

    const state = await new StateStore(project.dir).get()
    const entries = await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01'))
    expect(entries.sort()).toEqual(['hypothesis-tester--race-on-write.json', 'hypothesis-tester--stale-cache.json'])
  })

  it('writes the plain agent name when no instance is given', async () => {
    const { path: file } = await runLog(project.dir, { agent: 'investigator', result: verdict }, clock)
    expect(path.basename(file)).toBe('investigator.json')
  })

  it('rejects an instance that would escape the cycle directory', async () => {
    await expect(
      runLog(project.dir, { agent: 'hypothesis-tester', instance: '../../../state', result: verdict }, clock),
    ).rejects.toBeInstanceOf(InvalidAgentNameError)
  })

  it('reuses the same file when the same instance is logged twice', async () => {
    const first = await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'stale-cache', result: verdict }, clock)
    const second = await runLog(
      project.dir,
      { agent: 'hypothesis-tester', instance: 'stale-cache', result: { ...verdict, summary: 'Revised verdict.' } },
      clock,
    )
    expect(second.path).toBe(first.path)
    expect(JSON.parse(await fs.readFile(first.path, 'utf8')).summary).toBe('Revised verdict.')
  })
})

describe('runLog against a cycle that closes under it', () => {
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], max_cycles: 3 }
    await writeConfig(project.dir, config)
  })

  it('never files findings into a cycle that did not do the work', async () => {
    // The leader issues both calls in one turn. runLog reads state unlocked,
    // so the advance may land in between; whichever order they take, the
    // finding must not become cycle 2's.
    const [logged] = await Promise.allSettled([
      runLog(project.dir, { agent: 'verifier', result: RESULT }, clock),
      cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    expect(state.cycle).toBe(2)
    expect(state.findings).toEqual([])
    if (logged.status === 'rejected') expect(logged.reason).toBeInstanceOf(CycleClosedError)
  })

  it('never leaves an open finding on a run that has finished', async () => {
    const [logged] = await Promise.allSettled([
      runLog(project.dir, { agent: 'verifier', result: RESULT }, clock),
      cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('done')
    // Either the finding was in the cycle that passed — and the leader's pass
    // rule owns that judgement — or it was rejected. It is never filed after.
    if (logged.status === 'rejected') expect(state.findings).toEqual([])
  })
})
