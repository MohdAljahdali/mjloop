import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CycleClosedError,
  GateClosedError,
  InvalidAgentNameError,
  InvalidAgentResultError,
  RunReplacedError,
  UnknownAgentError,
  runLog,
} from '../../src/ops/log.js'
import { initLoop } from '../../src/ops/init.js'
import { UnknownTrackError, cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
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
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['ui-critic_2'], max_cycles: 1 }
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)).resolves.toBeDefined()
    await expect(runLog(project.dir, { agent: 'ui-critic_2', result: RESULT }, clock)).resolves.toBeDefined()
  })

  it('refuses a name whose "--" would collide with an instance', async () => {
    // `a` with instance `b` and the agent `a--b` would both write `a--b.json`,
    // and the second write would discard the first verdict.
    await expect(runLog(project.dir, { agent: 'editor--verifier', result: RESULT }, clock)).rejects.toBeInstanceOf(
      InvalidAgentNameError,
    )
    await expect(
      runLog(project.dir, { agent: 'editor', instance: 'a--b', result: RESULT }, clock),
    ).rejects.toBeInstanceOf(InvalidAgentNameError)
  })
})

describe('runLog against the track roster', () => {
  it('refuses an agent the track does not define', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: RESULT }, clock)).rejects.toBeInstanceOf(
      UnknownAgentError,
    )

    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual([])
    expect(await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('accepts a specialist the config forces into every cycle', async () => {
    const config = await loadConfig(project.dir)
    config.specialists.security = 'always'
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'security', result: RESULT }, clock)).resolves.toBeDefined()
  })

  it('refuses the log when the running track has gone missing from config', async () => {
    // rosterSet and cycleAdvance both fail closed on a missing track; a gate
    // that cannot be found must refuse the log rather than vanish.
    const config = await loadConfig(project.dir)
    delete config.tracks.edit
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)).rejects.toBeInstanceOf(
      UnknownTrackError,
    )
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

  // Both agents belong to the `fix` track, and `runLog` accepts only agents the
  // running track defines.
  beforeEach(async () => {
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
  })

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

describe('the reproduction gate', () => {
  const proof = {
    status: 'pass' as const,
    summary: 'A test that fails because the cache returns a stale entry.',
    evidence: [{ kind: 'command' as const, ref: 'npm test -- cache', excerpt: '1 failing: expected fresh, got stale' }],
    findings: [],
    files_touched: ['test/cache.test.ts'],
    next_hint: null,
  }

  const fix = {
    status: 'pass' as const,
    summary: 'Invalidated the entry on write.',
    evidence: [{ kind: 'file' as const, ref: 'src/cache.ts', excerpt: 'this.map.delete(key)' }],
    findings: [],
    files_touched: ['src/cache.ts'],
    next_hint: null,
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
  })

  it('rejects a blocked agent while the gate is shut', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: fix }, clock)).rejects.toBeInstanceOf(
      GateClosedError,
    )
  })

  it('rejects a spelling variant of a blocked agent', async () => {
    // On a case-insensitive filesystem `Fixer.json` *is* `fixer.json`, so a
    // gate keyed on an exact string would let the blocked work through under
    // the blocked agent's own path.
    const config = await loadConfig(project.dir)
    config.tracks.fix = {
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['Fixer'],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
    }
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'Fixer', result: fix }, clock)).rejects.toBeInstanceOf(GateClosedError)
  })

  it('rejects an agent no track defines rather than letting it record the blocked work', async () => {
    await expect(runLog(project.dir, { agent: 'fixer2', result: fix }, clock)).rejects.toBeInstanceOf(
      UnknownAgentError,
    )

    const state = await new StateStore(project.dir).get()
    await expect(fs.access(path.join(runDirPath(project.dir, state), 'cycle-01', 'fixer2.json'))).rejects.toThrow()
  })

  it('names the agent that would open it', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: fix }, clock)).rejects.toThrow(/reproducer/)
  })

  it('writes nothing and touches no state when it rejects', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: fix }, clock)).rejects.toThrow()

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    await expect(fs.access(path.join(cycleDir, 'fixer.json'))).rejects.toThrow()
    expect(state.reproduction).toBeNull()
  })

  it('opens on an evidenced pass from the proving agent', async () => {
    const { gateOpened } = await runLog(project.dir, { agent: 'reproducer', result: proof }, clock)
    expect(gateOpened).toBe(true)

    const state = await new StateStore(project.dir).get()
    expect(state.reproduction).toEqual({
      agent: 'reproducer',
      cycle: 1,
      ref: 'npm test -- cache',
      excerpt: '1 failing: expected fresh, got stale',
    })
  })

  it('lets the blocked agent through once it is open', async () => {
    await runLog(project.dir, { agent: 'reproducer', result: proof }, clock)
    const { path: file } = await runLog(project.dir, { agent: 'fixer', result: fix }, clock)
    expect(path.basename(file)).toBe('fixer.json')
  })

  it('stays shut for a pass with no command or test evidence', async () => {
    const { gateOpened } = await runLog(
      project.dir,
      { agent: 'reproducer', result: { ...proof, evidence: [] } },
      clock,
    )
    expect(gateOpened).toBe(false)
    expect((await new StateStore(project.dir).get()).reproduction).toBeNull()
  })

  it('stays shut when the proving agent could not reproduce', async () => {
    const { gateOpened } = await runLog(
      project.dir,
      { agent: 'reproducer', result: { ...proof, status: 'blocked' as const } },
      clock,
    )
    expect(gateOpened).toBe(false)
  })

  it('re-records a later reproduction, so a second attempt wins', async () => {
    await runLog(project.dir, { agent: 'reproducer', result: proof }, clock)
    await runLog(
      project.dir,
      {
        agent: 'reproducer',
        result: { ...proof, evidence: [{ kind: 'command' as const, ref: 'npm test -- cache -t eviction', excerpt: '1 failing' }] },
      },
      clock,
    )
    expect((await new StateStore(project.dir).get()).reproduction?.ref).toBe('npm test -- cache -t eviction')
  })

  it('blocks nothing on a track with no gate', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { path: file, gateOpened } = await runLog(project.dir, { agent: 'editor', result: fix }, clock)
    expect(path.basename(file)).toBe('editor.json')
    expect(gateOpened).toBe(false)
  })

  it('never opens the gate of a run that proved nothing', async () => {
    // The leader can issue both calls in one turn. `runStart` resets to cycle
    // 1, so cycle equality alone would read as the same run and file this
    // reproduction against a defect the new run has not demonstrated.
    const [logged] = await Promise.allSettled([
      runLog(project.dir, { agent: 'reproducer', result: proof }, clock),
      runStart(project.dir, { track: 'fix', goal: 'A different defect' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    if (logged.status === 'rejected') {
      expect(logged.reason).toBeInstanceOf(RunReplacedError)
      expect(state.reproduction).toBeNull()
    } else {
      // The log won the lock: its proof belongs to the run it was logged
      // against, and runStart cleared it on the way in.
      expect(state.goal).toBe('A different defect')
      expect(state.reproduction).toBeNull()
    }
  })
})
