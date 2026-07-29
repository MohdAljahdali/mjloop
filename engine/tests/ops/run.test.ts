import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoActiveRunError, UnknownTrackError, cycleAdvance, halt, runDirName, runDirPath, runStart } from '../../src/ops/run.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { InvalidStateError, StateStore } from '../../src/store/state-store.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
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
      {
        cycle: 1,
        agents: ['editor', 'verifier'],
        result: 'pass',
        ref: '.mjloop/runs/2026-07-26-001--adhoc--edit',
        at: NOW.toISOString(),
      },
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
    const { strikes, carried_findings } = await failCycle()
    expect(strikes).toBe(1)
    // The guard's identity and the task list's are allowed to differ, and here
    // they must: two agents reported one defect, so the cycle looks unchanged
    // to the guard and the next cycle is handed one piece of work.
    expect(carried_findings).toHaveLength(1)
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

describe('the run verify pin', () => {
  const PIN = 'verify-pinned.json'

  async function readPin(state: Awaited<ReturnType<typeof runStart>>): Promise<Record<string, any>> {
    return JSON.parse(await fs.readFile(path.join(runDirPath(project.dir, state), PIN), 'utf8'))
  }

  it('pins the resolved verify block into the run directory at run start', async () => {
    const state = await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)

    const pin = await readPin(state)
    expect(pin.version).toBe(1)
    expect(pin.pinned_at).toBe(NOW.toISOString())
    expect(pin.verify.test).toBe('npm test')
  })

  it('pins the ceiling and the failure patterns, not only the commands', async () => {
    // Both are executed policy: a timeout of 1 ms kills every suite the engine
    // starts, and a failure pattern is a regular expression this engine
    // compiles and runs. A pin of the three commands alone would leave an
    // agent holding `Write` two ways to change what verification means.
    const config = await loadConfig(project.dir)
    config.verify.timeout_ms = 5_000
    config.verify.failure_patterns.test = ['^boom']
    await writeConfig(project.dir, config)

    const pin = await readPin(await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock))
    expect(pin.verify.timeout_ms).toBe(5_000)
    expect(pin.verify.failure_patterns.test).toEqual(['^boom'])
    // Defaulted rather than configured, and pinned all the same.
    expect(pin.verify.lock_timeout_ms).toBe(1_800_000)
  })

  it('leaves an existing pin untouched', async () => {
    // `nextRunId` hands every start a directory of its own, so a second pin is
    // unreachable through `runStart` itself. The collision is staged at the one
    // moment it could happen — the run directory already carrying a pin when
    // the write lands, which is what a re-pinning resume would look like — and
    // the `wx` flag is what makes that case something nobody has to reason
    // about. A resume that re-pinned would execute a `config.yaml` edited since
    // the run began, which is the whole hole the pin closes.
    const earlier = `${JSON.stringify(
      {
        version: 1,
        pinned_at: '2026-07-01T00:00:00.000Z',
        verify: {
          test: 'npm run the-command-this-run-started-with',
          lint: null,
          build: null,
          timeout_ms: 900_000,
          lock_timeout_ms: 1_800_000,
          failure_patterns: { test: [], lint: [], build: [] },
        },
      },
      null,
      2,
    )}\n`

    const realMkdir = fs.mkdir.bind(fs)
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (target: any, options: any) => {
      const created = await realMkdir(target, options)
      if (String(target).endsWith('--adhoc--edit')) {
        await fs.writeFile(path.join(String(target), PIN), earlier, 'utf8')
      }
      return created
    })

    try {
      const state = await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
      expect(await fs.readFile(path.join(runDirPath(project.dir, state), PIN), 'utf8')).toBe(earlier)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the run timestamps', () => {
  it('stamps the run with its start time', async () => {
    const state = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    expect(state.started_at).toBe(NOW.toISOString())
  })

  it('stamps each history entry with the time its cycle closed', async () => {
    const first = new Date('2026-07-26T11:00:00.000Z')
    const second = new Date('2026-07-26T12:30:00.000Z')

    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, () => first)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, () => second)

    const state = await new StateStore(project.dir).get()
    expect(state.history.map((entry) => entry.at)).toEqual([first.toISOString(), second.toISOString()])
  })

  it('reads a state file written before the timestamps existed', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    // Exactly what a state file written by an earlier milestone looks like:
    // the fields are absent, not null. Without their defaults the whole
    // document would fail validation on read rather than gaining them on its
    // next write, and the run would be unresumable.
    const file = resolveLoopPaths(project.dir).state
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    delete raw.started_at
    for (const entry of raw.history) delete entry.at
    await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    const legacy = await new StateStore(project.dir).get()
    expect(legacy.started_at).toBeNull()
    expect(legacy.history[0]?.at).toBeNull()

    const { state } = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    // The cycle closed here is stamped; the one that predates the field is
    // left as it was rather than back-dated to a time nobody observed.
    expect(state.history.at(-1)?.at).toBe(NOW.toISOString())
    expect(state.history[0]?.at).toBeNull()
  })
})

describe('the closing set', () => {
  it('returns the closing set once the run passes', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    const { closing_agents } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier'], result: 'pass' },
      clock,
    )
    expect(closing_agents).toEqual(['docs'])
  })

  it('returns an empty closing set on a halt', async () => {
    // A run that did not land its work has nothing to document, and documenting
    // it would describe a state of the code that no longer exists.
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], closing: ['docs'], max_cycles: 1 }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    const { state, closing_agents } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier'], result: 'fail' },
      clock,
    )
    expect(state.status).toBe('halted')
    expect(closing_agents).toEqual([])
  })

  it('returns an empty closing set on a track that declares none', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { closing_agents } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'pass' },
      clock,
    )
    expect(closing_agents).toEqual([])
  })
})

describe('the cycle handoff', () => {
  /** One optional agent, so a roster's skip reason is one readable line. */
  async function narrowBuildTrack(maxCycles = 5): Promise<void> {
    const config = await loadConfig(project.dir)
    config.tracks.build = {
      required: ['builder', 'verifier'],
      available: ['security'],
      closing: [],
      max_cycles: maxCycles,
    }
    await writeConfig(project.dir, config)
  }

  function result(over: Record<string, unknown> = {}) {
    return {
      status: 'pass' as const,
      summary: 'Added the route and its test.',
      evidence: [],
      findings: [],
      files_touched: [],
      next_hint: null,
      ...over,
    }
  }

  /** The ledger `verifyRun` writes. This is its only reader under test. */
  function ledgerEntry(over: Record<string, unknown> = {}) {
    return {
      slot: 'test',
      command: 'cd engine && npm test',
      source: 'pinned',
      live_command: null,
      log: 'test.log',
      phase: 'complete',
      exit_code: 1,
      timed_out: false,
      fingerprint: null,
      cached_from_cycle: null,
      duration_ms: 1_200,
      at: NOW.toISOString(),
      ...over,
    }
  }

  async function writeLedger(
    state: Awaited<ReturnType<typeof runStart>>,
    cycle: number,
    entries: unknown[],
  ): Promise<void> {
    const dir = path.join(runDirPath(project.dir, state), `cycle-0${cycle}`, 'verify')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(entries, null, 2), 'utf8')
  }

  async function handoffFor(state: Awaited<ReturnType<typeof runStart>>, cycle = 1): Promise<string> {
    return fs.readFile(path.join(runDirPath(project.dir, state), `cycle-0${cycle}`, 'handoff.md'), 'utf8')
  }

  const close = (result: 'pass' | 'fail' | 'blocked' = 'fail', agents = ['builder', 'verifier']) =>
    cycleAdvance(project.dir, { agents, result }, clock)

  it('writes a handoff for the cycle that closed, not the one that opened', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    const { state } = await close()

    // State has already stepped to cycle 2; the document describes cycle 1.
    expect(state.cycle).toBe(2)
    expect(await handoffFor(started)).toContain('# Handoff — cycle 1 of 2026-07-26-001')
    await expect(fs.access(path.join(runDirPath(project.dir, started), 'cycle-02'))).rejects.toThrow()
  })

  it('returns the handoff path', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    const { handoff } = await close()

    expect(handoff).toBe(path.join('.mjloop', 'runs', '2026-07-26-001--adhoc--build', 'cycle-01', 'handoff.md'))
    // Repo-relative, so the leader can hand the string to an agent as it is.
    expect(await fs.readFile(path.join(project.dir, handoff!), 'utf8')).toContain('# Handoff')
    expect(handoff).toBe(path.join('.mjloop', 'runs', runDirName(started), 'cycle-01', 'handoff.md'))
  })

  it('names every agent the roster drafted and every one it skipped', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: { security: 'no auth surface touched' },
    })
    await runLog(project.dir, { agent: 'builder', result: result() }, clock)
    await runLog(
      project.dir,
      { agent: 'verifier', result: result({ status: 'fail', summary: 'One assertion still expects the old shape.' }) },
      clock,
    )
    await close()

    const doc = await handoffFor(started)
    expect(doc).toContain('| builder | pass | Added the route and its test. |')
    expect(doc).toContain('| verifier | fail | One assertion still expects the old shape. |')
    // The stated reason is recoverable from nowhere else, and it is the whole
    // product of the roster's "either drafted or explained" invariant.
    expect(doc).toContain('Skipped: `security` — no auth surface touched')
  })

  it('marks a drafted agent that left no result file', async () => {
    // `runLog` only enters its locked update when a result has findings, a gate
    // proof or error signatures, so a pass carrying only file evidence can land
    // in a cycle that has just closed. Without a row the agent would be absent
    // with nothing saying so.
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: { security: 'no auth surface touched' },
    })
    await runLog(project.dir, { agent: 'builder', result: result() }, clock)
    await close()

    expect(await handoffFor(started)).toContain('| verifier | — | no result recorded |')
  })

  it('lists the files each agent touched', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(
      project.dir,
      { agent: 'builder', result: result({ files_touched: ['src/routes/health.ts', 'test/health.test.ts'] }) },
      clock,
    )
    await close()

    const doc = await handoffFor(started)
    expect(doc).toContain('- `src/routes/health.ts` — builder')
    expect(doc).toContain('- `test/health.test.ts` — builder')
  })

  it('carries the verification table from the cycle ledger', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await writeLedger(started, 1, [ledgerEntry(), ledgerEntry({ slot: 'lint', command: 'npm run typecheck', log: 'lint.log', exit_code: 0 })])
    await close()

    const doc = await handoffFor(started)
    expect(doc).toContain('| `cd engine && npm test` | 1 | `cycle-01/verify/test.log` |')
    expect(doc).toContain('| `npm run typecheck` | 0 | `cycle-01/verify/lint.log` |')
  })

  it('notes a reused result and a diverged live command in the verification table', async () => {
    // Both are read straight off the ledger entry and neither costs a column.
    // The second is the only place a person who is not watching the cockpit
    // finds out that a mid-run edit to config.yaml is waiting for the next run.
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await close()
    await writeLedger(started, 2, [
      ledgerEntry({ slot: 'lint', command: 'npm run typecheck', log: 'lint.log', exit_code: 0, cached_from_cycle: 1 }),
      ledgerEntry({ slot: 'build', command: 'npm run build', log: 'build.log', exit_code: 0, live_command: 'npm run bundle' }),
    ])
    await close()

    const doc = await handoffFor(started, 2)
    // A reused entry's log belongs to the cycle that produced it.
    expect(doc).toContain('`cycle-01/verify/lint.log` (cached, cycle 1)')
    expect(doc).toContain('`cycle-02/verify/build.log` (config.yaml now says `npm run bundle`)')
  })

  it('writes a handoff on a pass, a fail and a halt', async () => {
    // On a pass it is the run's closing record; on a halt it sits beside
    // HALT.md and answers a different question — HALT.md says why the run
    // stopped, the handoff says what the cycle did.
    await narrowBuildTrack()
    const failing = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await close()
    expect(await handoffFor(failing)).toContain('next: cycle 2 of 5')

    const passing = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await close('pass')
    expect(await handoffFor(passing)).toContain('the run is done')

    const halting = await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)
    const halted = await handoffFor(halting)
    expect(halted).toContain('halted: cycle cap 1 reached for track edit')
    await expect(fs.access(path.join(runDirPath(project.dir, halting), 'HALT.md'))).resolves.toBeUndefined()
  })

  it('writes a short handoff when the cycle directory holds nothing', async () => {
    // A run must never fail to advance because a derived document could not be
    // assembled: no roster, no results, no ledger is a short handoff.
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await close()

    const doc = await handoffFor(started)
    expect(doc).toContain('| builder | — | no result recorded |')
    expect(doc).toContain('_nothing was verified through the engine_')
    expect(doc).toContain('_none recorded_')
  })

  it('never exceeds the handoff ceiling', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'builder',
        result: result({
          summary: 'x'.repeat(50_000),
          // Long paths as well as many of them: `files_touched` has no schema
          // ceiling, so thirty entries of a deep monorepo path clear 6 KB on
          // their own and the per-section caps alone would not hold the file.
          files_touched: Array.from({ length: 200 }, (_, index) => `src/${'deep/'.repeat(40)}file-${index}.ts`),
        }),
      },
      clock,
    )
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: result({
          status: 'fail',
          findings: Array.from({ length: 200 }, (_, index) => ({
            severity: 'high' as const,
            file: 'src/a.ts',
            line: index + 1,
            claim: `defect number ${index}`,
          })),
        }),
      },
      clock,
    )
    await close()

    const doc = await handoffFor(started)
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThanOrEqual(6_000)
    expect(doc).toContain('Truncated at 6000 bytes')
    expect(doc).toContain('cycle-01/')
  })

  it('names where the elided findings went', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: result({
          status: 'fail',
          findings: Array.from({ length: 25 }, (_, index) => ({
            severity: 'low' as const,
            file: 'src/a.ts',
            line: index + 1,
            claim: `nit ${index}`,
          })),
        }),
      },
      clock,
    )
    await close()

    // Nothing is discarded — the marker names the file that still holds it.
    expect(await handoffFor(started)).toContain('*5 more in cycle-01/findings.json*')
  })

  it('still advances the cycle when the handoff cannot be written', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    // A directory where the document goes: the write fails, and the state
    // transition it follows has already committed.
    await fs.mkdir(path.join(runDirPath(project.dir, started), 'cycle-01', 'handoff.md'), { recursive: true })

    const { state, carried_findings } = await close()
    expect(state.cycle).toBe(2)
    expect(state.status).toBe('running')
    expect(carried_findings).toEqual([])
  })

  it('returns null for the handoff path when the write failed', async () => {
    // There is no path-shaped value for a document that was not written, and
    // this result is serialised straight to the leader.
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await fs.mkdir(path.join(runDirPath(project.dir, started), 'cycle-01', 'handoff.md'), { recursive: true })

    expect((await close()).handoff).toBeNull()
  })

  it('skips a result file it cannot parse rather than losing the whole handoff', async () => {
    await narrowBuildTrack()
    const started = await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(project.dir, { agent: 'builder', result: result() }, clock)
    await fs.writeFile(path.join(runDirPath(project.dir, started), 'cycle-01', 'verifier.json'), '{ not json', 'utf8')
    await close()

    const doc = await handoffFor(started)
    expect(doc).toContain('| builder | pass | Added the route and its test. |')
    expect(doc).toContain('# Handoff — cycle 1')
  })
})

describe('deduplicating the carried findings', () => {
  /** Two genuine defects in one file, and one of them reported twice. */
  const auth = (line: number) => ({
    severity: 'high' as const,
    file: 'src/auth.ts',
    line,
    claim: 'missing null check',
  })

  function reported(findings: ReturnType<typeof auth>[]) {
    return {
      status: 'fail' as const,
      summary: 'the suite is still red',
      evidence: [],
      findings,
      files_touched: [],
      next_hint: null,
    }
  }

  async function twoAgentsOneDefect(track: string): Promise<void> {
    await runStart(project.dir, { track, goal: 'Fix the null check' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: reported([auth(12), auth(88)]) }, clock)
    await runLog(project.dir, { agent: 'critic', result: reported([auth(12)]) }, clock)
  }

  it('carries one entry per distinct finding', async () => {
    // Line 12 twice is one piece of work; line 88 is another. Collapsing on the
    // guard's coarser identity would lose it, and the loop would then halt for
    // "no progress" over work it was never shown.
    await twoAgentsOneDefect('build')
    const { carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier', 'critic'], result: 'fail' },
      clock,
    )

    expect(carried_findings).toEqual([auth(12), auth(88)])
  })

  it('archives the deduplicated list', async () => {
    await twoAgentsOneDefect('build')
    const started = await new StateStore(project.dir).get()
    const { carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier', 'critic'], result: 'fail' },
      clock,
    )

    const file = path.join(runDirPath(project.dir, started), 'cycle-01', 'findings.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(carried_findings)
  })

  it('prints one line per distinct finding in the halt report', async () => {
    // The edit track caps at one cycle, so this fail halts the run.
    await runStart(project.dir, { track: 'edit', goal: 'Fix the null check' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: reported([auth(12)]) }, clock)
    await runLog(project.dir, { agent: 'editor', result: reported([auth(12)]) }, clock)
    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report.split('src/auth.ts:12')).toHaveLength(2)
  })

  it('prints the same list whether the halt was a guard or a person', async () => {
    const openFindings = (report: string) => report.split('## Open findings')[1]?.split('## Next step')[0]

    await runStart(project.dir, { track: 'edit', goal: 'Fix the null check' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: reported([auth(12), auth(88)]) }, clock)
    await runLog(project.dir, { agent: 'editor', result: reported([auth(12)]) }, clock)
    const { state: byGuard } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)
    const guard = await fs.readFile(path.join(runDirPath(project.dir, byGuard), 'HALT.md'), 'utf8')

    await runStart(project.dir, { track: 'edit', goal: 'Fix the null check' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: reported([auth(12), auth(88)]) }, clock)
    await runLog(project.dir, { agent: 'editor', result: reported([auth(12)]) }, clock)
    const byPerson = await halt(project.dir, 'user requested stop', clock)
    const person = await fs.readFile(path.join(runDirPath(project.dir, byPerson), 'HALT.md'), 'utf8')

    expect(openFindings(person)).toBe(openFindings(guard))
  })
})
