import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoActiveRunError, UnknownTrackError, cycleAdvance, halt, runDirName, runDirPath, runStart } from '../../src/ops/run.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
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
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    // The project is initialised, so gates.plan_approval is "human" and stories
    // need an approved plan. These tests are about runs, not about the gate.
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'test' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)

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

  it('clears findings, history, and the stagnation state from the previous run', async () => {
    const failing = {
      status: 'fail' as const,
      summary: 'the suite is still red',
      evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '1 failing' }],
      findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 6, claim: 'asserts the old label' }],
      files_touched: [],
      next_hint: null,
    }
    await runStart(project.dir, { track: 'build', goal: 'First' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(first.fingerprint).not.toBeNull()

    const second = await runStart(project.dir, { track: 'build', goal: 'Second' }, clock)
    expect(second.history).toEqual([])
    expect(second.findings).toEqual([])
    expect(second.halt_reason).toBeNull()
    // The counter and the fingerprint it counts against reset together, or the
    // new run's first cycle starts one strike into a stall it never had.
    expect(second.no_progress_count).toBe(0)
    expect(second.last_fingerprint).toBeNull()
    // And the repeated-error guard's state with them. It halts on one repeat
    // rather than two strikes, so a leak here is worse: the new run would halt
    // after a single cycle on a command it never ran.
    expect(second.cycle_errors).toEqual([])
    expect(second.last_error_fingerprint).toBeNull()
  })

  it('does not let a halted run arm the next run first cycle', async () => {
    const failing = (claim: string) => ({
      status: 'fail' as const,
      summary: 'the suite is still red',
      evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '1 failing: cannot resolve module' }],
      findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 6, claim }],
      files_touched: [],
      next_hint: null,
    })

    await runStart(project.dir, { track: 'build', goal: 'First' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('first') }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('second') }, clock)
    const halted = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    // `cycleAdvance` returns before the clear on a halt, so the signatures of
    // the cycle that halted are still on state when the next run opens.
    expect(halted.state.status).toBe('halted')

    // The operator narrows the goal and starts again. Cycle 1 reports a failure
    // with no command or test evidence at all — the previous run's signatures
    // must not halt it.
    await runStart(project.dir, { track: 'build', goal: 'A narrower goal' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: { ...failing('third'), evidence: [] },
      },
      clock,
    )
    const next = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(next.state.status).toBe('running')
    expect(next.state.cycle).toBe(2)
  })

  it('clears a previous run reproduction', async () => {
    await runStart(project.dir, { track: 'fix', goal: 'First defect' }, clock)
    await new StateStore(project.dir, clock).update((draft) => {
      draft.reproduction = { agent: 'reproducer', cycle: 1, ref: 'npm test', excerpt: '1 failing' }
    })

    const second = await runStart(project.dir, { track: 'fix', goal: 'Second defect' }, clock)
    expect(second.reproduction).toBeNull()
  })

  it('rejects a track that is not in config', async () => {
    await expect(runStart(project.dir, { track: 'ghost', goal: 'x' }, clock)).rejects.toBeInstanceOf(UnknownTrackError)
  })

  it('rejects a track name inherited from Object.prototype', async () => {
    // `'toString' in config.tracks` is true for any plain object, and the
    // "track" the lookup yields is a function: no required set, no cap, so the
    // cycle cap would never apply and the failure would surface as a TypeError.
    await expect(runStart(project.dir, { track: 'toString', goal: 'x' }, clock)).rejects.toBeInstanceOf(
      UnknownTrackError,
    )
  })

  it('rejects a story id that would escape the runs directory', async () => {
    // The story lookup rejects it first — no such story exists — and the state
    // schema is the second line of defence, which is what would stop such an id
    // if it ever reached state by another route.
    await expect(
      runStart(project.dir, { track: 'edit', goal: 'x', story: '../../../tmp/x' }, clock),
    ).rejects.toThrow()
    await expect(
      new StateStore(project.dir, clock).update((draft) => {
        draft.current.story = '../../../tmp/x'
      }),
    ).rejects.toBeInstanceOf(InvalidStateError)
    // the state write was rejected, so no run directory was created either
    await expect(fs.access(path.join(project.dir, 'tmp'))).rejects.toThrow()
    expect((await new StateStore(project.dir).get()).status).toBe('idle')
  })

  it('rejects a track name that would escape the runs directory', async () => {
    // The track is the third component of `<run_id>--<story>--<track>`, and it
    // arrives from a hand-editable config as well as from a tool call. The
    // config schema refuses to define it and the state schema refuses to hold
    // it, so nothing reaches runDirName that could steer the write.
    const config = await loadConfig(project.dir)
    config.tracks['../../../tmp/victim'] = { required: ['editor'], available: [], max_cycles: 1 }
    await writeConfig(project.dir, config)

    await expect(loadConfig(project.dir)).rejects.toThrow(/tracks/)
    await expect(
      runStart(project.dir, { track: '../../../tmp/victim', goal: 'x' }, clock),
    ).rejects.toThrow(/tracks/)

    await expect(
      new StateStore(project.dir, clock).update((draft) => {
        draft.track = '../../../tmp/victim'
      }),
    ).rejects.toBeInstanceOf(InvalidStateError)
    await expect(fs.access(path.join(project.dir, 'tmp'))).rejects.toThrow()
  })

  it('rejects a story id that does not exist', async () => {
    await expect(
      runStart(project.dir, { track: 'build', goal: 'Build it', plan: 'P001', story: 'P001-S01' }, clock),
    ).rejects.toThrow(/P001/)
  })

  it('accepts a story id that exists', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'test' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)

    const state = await runStart(
      project.dir,
      { track: 'build', goal: 'Build the login form', plan: 'P001', story: 'P001-S01' },
      clock,
    )
    expect(state.current.story).toBe('P001-S01')
    expect(runDirName(state)).toContain('P001-S01')
  })

  it('gives concurrent starts distinct run ids and directories', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'test' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)

    const [a, b] = await Promise.all([
      runStart(project.dir, { track: 'edit', goal: 'A', story: 'P001-S01' }, clock),
      runStart(project.dir, { track: 'edit', goal: 'B', story: 'P001-S02' }, clock),
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

  it('returns the closed cycle findings and clears them when the next cycle opens', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('assertion is stale') }, clock)

    const { state, carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier'], result: 'fail' },
      clock,
    )

    expect(carried_findings).toEqual([
      { severity: 'high', file: 'src/a.ts', line: 1, claim: 'assertion is stale' },
    ])
    expect(state.cycle).toBe(2)
    expect(state.findings).toEqual([])
  })

  it('keeps the findings on state when the run ends instead of opening a cycle', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('assertion is stale') }, clock)

    // The edit track caps at one cycle, so this fail halts the run. There is
    // no next cycle to hand the findings to, and HALT.md and the summary have
    // nothing but state to report them from.
    const { state, carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'fail' },
      clock,
    )

    expect(state.status).toBe('halted')
    expect(state.findings).toEqual(carried_findings)
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
    expect(state.findings).toEqual(carried_findings)
  })
})

describe('stagnation guard', () => {
  const sameFailure = {
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '1 failing' }],
    findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim: 'assertion is stale' }],
    files_touched: [],
    next_hint: null,
  }

  let attempt = 0

  /**
   * Log a failing verifier result, then close the cycle.
   *
   * Each cycle reports a distinct verification failure. The repeated-error
   * guard halts a cycle earlier than stagnation when the same failure recurs,
   * so a fixture that repeated its excerpt would never reach the guard under
   * test here — which is about findings that do not change, whatever the
   * command output around them does.
   */
  async function failCycle(claim = 'assertion is stale', line = 1) {
    const excerpt = `1 failing at step ${String.fromCharCode(97 + attempt++)}`
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          ...sameFailure,
          evidence: [{ ...sameFailure.evidence[0]!, excerpt }],
          findings: [{ ...sameFailure.findings[0]!, claim, line }],
        },
      },
      clock,
    )
    return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
  }

  beforeEach(async () => {
    attempt = 0
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
  })

  it('takes no strike on the first failing cycle', async () => {
    const { state, strikes, fingerprint } = await failCycle()
    expect(strikes).toBe(0)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(2)
  })

  it('takes a strike when a cycle closes with the same work remaining', async () => {
    await failCycle()
    const { state, strikes } = await failCycle()
    expect(strikes).toBe(1)
    expect(state.status).toBe('running')
  })

  it('halts on the second strike, naming stagnation rather than the cap', async () => {
    await failCycle()
    await failCycle()
    const { state } = await failCycle()

    expect(state.status).toBe('halted')
    expect(state.cycle).toBe(3)
    expect(state.halt_reason).toBe('no progress for 2 consecutive cycles on track build')

    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report).toContain('no progress for 2 consecutive cycles')
  })

  it('still strikes when the defect drifts down the file', async () => {
    // The builder adds an import or a guard clause above the defect each
    // cycle, so the verifier reports it a line lower every time. The work has
    // not changed and neither should the verdict.
    await failCycle('asserts the old label', 6)
    expect((await failCycle('asserts the old label', 7)).strikes).toBe(1)
    expect((await failCycle('asserts the old label', 8)).state.status).toBe('halted')
  })

  it('still strikes when a second agent reports the same defect', async () => {
    await failCycle()
    // Escalating to critic is what a leader does when a cycle stalls. It finds
    // the same defect, so state carries two copies of one piece of work — the
    // same work as last cycle, and it must count as such.
    await runLog(project.dir, { agent: 'critic', result: sameFailure }, clock)
    const { strikes } = await failCycle()
    expect(strikes).toBe(1)
  })

  it('does not carry a strike into the next run', async () => {
    await failCycle()
    await runStart(project.dir, { track: 'build', goal: 'A different goal' }, clock)
    const { state, strikes } = await failCycle()
    expect(strikes).toBe(0)
    expect(state.status).toBe('running')
  })

  it('resets the count when the remaining work changes', async () => {
    await failCycle()
    await failCycle()
    const { strikes } = await failCycle('a different defect')
    expect(strikes).toBe(0)
  })

  it('halts on stagnation before the cap when both would fire', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], max_cycles: 3 }
    await writeConfig(project.dir, config)

    await failCycle()
    await failCycle()
    const { state } = await failCycle()

    // Cycle 3 reaches both the second strike and the cap. Stagnation is the
    // more actionable reason, and it is checked first.
    expect(state.halt_reason).toContain('no progress')
    expect(state.halt_reason).not.toContain('cycle cap')
  })

  it('never strikes a passing cycle', async () => {
    await failCycle()
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: { ...sameFailure, status: 'pass', findings: [] },
      },
      clock,
    )
    const { state, strikes, fingerprint } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier'], result: 'pass' },
      clock,
    )
    expect(state.status).toBe('done')
    expect(fingerprint).toBeNull()
    expect(strikes).toBe(0)
  })
})

describe('the repeated-error guard', () => {
  function failing(headline: string, claim: string) {
    return {
      status: 'fail' as const,
      summary: 'the suite is red',
      evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: headline }],
      findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
      files_touched: [],
      next_hint: null,
    }
  }

  async function failCycle(headline: string, claim: string) {
    await runLog(project.dir, { agent: 'verifier', result: failing(headline, claim) }, clock)
    return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
  })

  it('does not halt on the first failure', async () => {
    const { state } = await failCycle('1 failing: cannot resolve module', 'first')
    expect(state.status).toBe('running')
  })

  it('halts on the first repeat, at cycle 2', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    const { state } = await failCycle('1 failing: cannot resolve module', 'second')

    expect(state.status).toBe('halted')
    expect(state.cycle).toBe(2)
    expect(state.halt_reason).toBe('the same verification failure recurred: npm test')
  })

  it('halts even when the findings changed, which stagnation would have missed', async () => {
    await failCycle('1 failing: cannot resolve module', 'a nit')
    const { state } = await failCycle('1 failing: cannot resolve module', 'a different nit')
    expect(state.status).toBe('halted')
    expect(state.halt_reason).toContain('same verification failure')
  })

  it('matches a repeat whose only difference is a count', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    const { state } = await failCycle('7 failing: cannot resolve module', 'second')
    expect(state.status).toBe('halted')
  })

  it('does not halt when the failure changes', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    const { state } = await failCycle('1 failing: type error in Button', 'second')
    expect(state.status).toBe('running')
  })

  it('never fires on a cycle with no error signatures', async () => {
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'no commands were run',
          evidence: [],
          findings: [{ severity: 'high', file: 'src/a.ts', line: 1, claim: 'same' }],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    const first = await cycleAdvance(project.dir, { agents: ['verifier'], result: 'fail' }, clock)
    expect(first.state.status).toBe('running')
  })

  it('reports the error reason rather than stagnation when both would fire', async () => {
    // Identical findings and an identical failure: stagnation needs a third
    // cycle, so the error guard is the one that can fire here at all.
    await failCycle('1 failing: cannot resolve module', 'same')
    const { state } = await failCycle('1 failing: cannot resolve module', 'same')
    expect(state.halt_reason).toContain('same verification failure')
    expect(state.halt_reason).not.toContain('no progress')
  })

  it('clears the signatures when the next cycle opens', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([])
  })

  it('never fires on a repeated blocked cycle', async () => {
    // The reproducer could not reach the database twice running. Nothing was
    // verified, so nothing recurred — the environment is what needs fixing, and
    // a halt naming a verification failure would send the reader to the suite.
    const blocked = (claim: string) => ({
      status: 'blocked' as const,
      summary: 'the database container is not up',
      evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: 'Error: connect ECONNREFUSED' }],
      findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
      files_touched: [],
      next_hint: null,
    })

    await runLog(project.dir, { agent: 'verifier', result: blocked('first') }, clock)
    await cycleAdvance(project.dir, { agents: ['verifier'], result: 'blocked' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: blocked('second') }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['verifier'], result: 'blocked' }, clock)

    expect(state.status).toBe('running')
    expect(state.halt_reason).toBeNull()
  })

  it('names the same command whichever agent logged first', async () => {
    // Agents are dispatched concurrently, so cycle_errors arrives in finish
    // order. The reason must not depend on it, or two identical runs blame two
    // different commands and send the operator to two different places.
    const failure = (ref: string, excerpt: string) => ({
      status: 'fail' as const,
      summary: 'the suite is red',
      evidence: [{ kind: 'command' as const, ref, excerpt }],
      findings: [],
      files_touched: [],
      next_hint: null,
    })
    const lint = () => runLog(project.dir, { agent: 'builder', result: failure('npm run lint', 'lint boom') }, clock)
    const test = () => runLog(project.dir, { agent: 'verifier', result: failure('npm test', 'test boom') }, clock)
    const close = () => cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    // Cycle 1: the builder lands first. Cycle 2: the verifier does — so the
    // cycle that halts holds "npm test" at index 0 in arrival order.
    await lint()
    await test()
    await close()
    await test()
    await lint()
    const { state } = await close()

    expect(state.status).toBe('halted')
    // Sorted, not first-to-arrive: the same two failures name the same command
    // whichever agent won the race.
    expect(state.halt_reason).toBe('the same verification failure recurred: npm run lint')
  })

  it('never fires on a pass', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'green',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '1 failing: cannot resolve module' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    const { state } = await cycleAdvance(project.dir, { agents: ['verifier'], result: 'pass' }, clock)
    expect(state.status).toBe('done')
  })
})

describe('the halt report next step', () => {
  const failing = (excerpt: string, claim: string) => ({
    status: 'fail' as const,
    summary: 'the suite is red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt }],
    findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
    files_touched: [],
    next_hint: null,
  })

  async function reportFor(state: Awaited<ReturnType<typeof runStart>>): Promise<string> {
    return fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
  }

  it('offers a wider cap only when the cap is what ended the run', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    expect(state.halt_reason).toContain('cycle cap')
    expect(await reportFor(state)).toContain('`max_cycles`')
  })

  it('does not send a stagnation halt to max_cycles', async () => {
    // The stagnation guard fires before the cap is consulted, so a wider cap
    // changes nothing — and the leader skill forbids raising one to get past a
    // halt, which it would be relaying if the report recommended it.
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    // A distinct excerpt each cycle, so the repeated-error guard — which fires
    // a cycle earlier — leaves this to stagnation.
    const failCycle = async (excerpt: string) => {
      await runLog(project.dir, { agent: 'verifier', result: failing(excerpt, 'the same defect') }, clock)
      return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    }
    await failCycle('step a')
    await failCycle('step b')
    const { state } = await failCycle('step c')

    expect(state.halt_reason).toContain('no progress')
    const report = await reportFor(state)
    expect(report).toContain('will not change the outcome')
    expect(report).not.toContain('widen the track')
  })

  it('does not send a repeated-error halt to max_cycles', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: boom', 'first') }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: boom', 'second') }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(state.halt_reason).toContain('same verification failure')
    const report = await reportFor(state)
    expect(report).toContain('the command named in the reason')
    expect(report).not.toContain('widen the track')
  })

  it('asks a hand-stopped run for nothing at all', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    const state = await halt(project.dir, 'user requested stop', clock)

    const report = await reportFor(state)
    expect(report).toContain('stopped by hand')
    expect(report).not.toContain('widen the track')
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
