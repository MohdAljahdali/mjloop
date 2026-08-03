import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStopGuard } from '../../src/cli/index.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW
const HOOK = { hook_event_name: 'Stop', cwd: '', stop_hook_active: false }

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  const config = await loadConfig(project.dir)
  config.autonomous = true
  await writeConfig(project.dir, config)
})
afterEach(async () => { await project.cleanup() })

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

describe('an autonomous run', () => {
  it('is kept going by the hook and released the moment its guard ends it', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)

    // Cycle 1 fails. The run continues, so the hook blocks the stop.
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: cannot resolve module', 'first') }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(first.state.status).toBe('running')

    const blocked = evaluateStopGuard(HOOK, await stateSummary(project.dir), true)
    expect(blocked.block).toBe(true)
    expect(blocked.reason).toContain('cycle 2 of 5')

    // Cycle 2 fails the same way. The repeated-error guard halts the run.
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: cannot resolve module', 'second') }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(second.state.status).toBe('halted')
    expect(second.state.halt_reason).toContain('same verification failure')

    // The hook goes quiet: the run is no longer running.
    const released = evaluateStopGuard(HOOK, await stateSummary(project.dir), true)
    expect(released.block).toBe(false)
  })

  it('is released by the cycle cap when nothing repeats', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], closing: [], max_cycles: 2, order: [] }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('error A', 'first') }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    await runLog(project.dir, { agent: 'verifier', result: failing('error B', 'second') }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.state.status).toBe('halted')
    expect(second.state.halt_reason).toContain('cycle cap 2')
    expect(evaluateStopGuard(HOOK, await stateSummary(project.dir), true).block).toBe(false)
  })

  it('removes one pause per turn, not every pause until the run ends', async () => {
    // The bound the prose has to tell the truth about: Claude Code sets
    // stop_hook_active once a Stop hook has already continued this turn, and
    // re-blocking on it is how a hook loops forever. So an autonomous run is
    // carried past the pause it is at, not automatically to completion — the
    // turn can end with the run still open, and /mjloop:resume is the way back in.
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: cannot resolve module', 'first') }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(first.state.status).toBe('running')

    const summary = await stateSummary(project.dir)
    expect(evaluateStopGuard(HOOK, summary, true).block).toBe(true)
    expect(evaluateStopGuard({ ...HOOK, stop_hook_active: true }, summary, true).block).toBe(false)
  })

  it('never blocks a project that did not opt in', async () => {
    const config = await loadConfig(project.dir)
    config.autonomous = false
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    expect(evaluateStopGuard(HOOK, await stateSummary(project.dir), false).block).toBe(false)
  })
})
