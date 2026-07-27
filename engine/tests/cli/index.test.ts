import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStateGuard, evaluateStopGuard, runCli } from '../../src/cli/index.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('runCli summary', () => {
  it('prints a one-line summary', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { stdout, exitCode } = await runCli(['summary', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('track edit')
  })

  it('prints json when asked', async () => {
    await initLoop(project.dir, clock)
    const { stdout } = await runCli(['summary', '--dir', project.dir, '--json'], '')
    expect(JSON.parse(stdout).status).toBe('idle')
  })
})

describe('runCli session-start', () => {
  it('emits additionalContext when the project has a loop', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { stdout } = await runCli(['session-start'], JSON.stringify({ cwd: project.dir }))
    const payload = JSON.parse(stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(payload.hookSpecificOutput.additionalContext).toContain('track edit')
  })

  it('emits nothing for a project without .loop', async () => {
    const { stdout, exitCode } = await runCli(['session-start'], JSON.stringify({ cwd: project.dir }))
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('evaluateStateGuard', () => {
  it('denies a write to .loop/state.json', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.loop/state.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('loop_')
    // the guidance must only name tools the MCP server actually registers
    expect(verdict.reason).not.toContain('loop_story_update')
  })

  it('denies a write to a plan manifest.json', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.loop/plans/P001-auth/manifest.json' },
    })
    expect(verdict.deny).toBe(true)
  })

  it('allows a write to a story file', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.loop/plans/P001-auth/stories/P001-S01-login.md' },
    })
    expect(verdict.deny).toBe(false)
  })

  it('allows a state.json that is not inside .loop', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/fixtures/state.json' },
    })
    expect(verdict.deny).toBe(false)
  })

  it('allows a call with no file_path', () => {
    expect(evaluateStateGuard({ tool_name: 'Write', tool_input: {} }).deny).toBe(false)
  })

  it('allows malformed hook input rather than blocking the user', () => {
    expect(evaluateStateGuard(null).deny).toBe(false)
    expect(evaluateStateGuard('nonsense').deny).toBe(false)
  })
})

describe('runCli state-guard', () => {
  it('emits a deny decision for a protected path', async () => {
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/.loop/state.json' } })
    const { stdout } = await runCli(['state-guard'], stdin)
    const payload = JSON.parse(stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('emits nothing for an allowed path', async () => {
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } })
    const { stdout } = await runCli(['state-guard'], stdin)
    expect(stdout).toBe('')
  })
})

describe('evaluateStopGuard', () => {
  const running = {
    initialised: true,
    status: 'running' as const,
    track: 'build',
    run_id: '2026-07-27-001',
    cycle: 2,
    max_cycles: 5,
    plan: null,
    story: null,
    stage: 'compose',
    goal: 'Add a Send button',
    findings: { high: 2, medium: 0, low: 1 },
    last_cycle: { result: 'fail', agents: ['builder', 'verifier'] },
    halt_reason: null,
    reproduction: null,
  }

  const input = { hook_event_name: 'Stop', cwd: '/repo', stop_hook_active: false }

  it('blocks a running autonomous loop', () => {
    const verdict = evaluateStopGuard(input, running, true)
    expect(verdict.block).toBe(true)
  })

  it('names the track, the cycle, and the open findings', () => {
    const { reason } = evaluateStopGuard(input, running, true)
    expect(reason).toContain('build')
    expect(reason).toContain('cycle 2 of 5')
    expect(reason).toContain('Add a Send button')
    expect(reason).toContain('3 open findings')
    expect(reason).toContain('loop-leader')
  })

  it('allows the stop when a Stop hook already continued this turn', () => {
    expect(evaluateStopGuard({ ...input, stop_hook_active: true }, running, true).block).toBe(false)
  })

  it('allows the stop when the project has not opted into autonomy', () => {
    expect(evaluateStopGuard(input, running, false).block).toBe(false)
  })

  it('allows the stop when the project has no loop', () => {
    const uninitialised = { ...running, initialised: false, status: 'uninitialised' as const }
    expect(evaluateStopGuard(input, uninitialised, true).block).toBe(false)
  })

  it('allows the stop for every status that is not running', () => {
    for (const status of ['idle', 'done', 'halted', 'paused', 'failed'] as const) {
      expect(evaluateStopGuard(input, { ...running, status }, true).block).toBe(false)
    }
  })

  it('allows the stop on malformed hook input rather than trapping the session', () => {
    expect(evaluateStopGuard(null, running, true).block).toBe(false)
    expect(evaluateStopGuard('nonsense', running, true).block).toBe(false)
  })

  it('says there are no open findings when there are none', () => {
    const clean = { ...running, findings: { high: 0, medium: 0, low: 0 } }
    expect(evaluateStopGuard(input, clean, true).reason).toContain('no open findings')
  })
})

describe('runCli stop-guard', () => {
  it('emits nothing for a project with no loop', async () => {
    const { stdout, exitCode } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })

  it('emits nothing for an initialised project that has not opted in', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)
    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })

  it('emits a top-level block decision for a running autonomous loop', async () => {
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    const payload = JSON.parse(stdout)
    expect(payload.decision).toBe('block')
    expect(payload.reason).toContain('build')
    // Not the hookSpecificOutput shape the other two hooks use.
    expect(payload.hookSpecificOutput).toBeUndefined()
  })

  it('emits nothing once the run is done', async () => {
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })

  it('emits nothing on unparseable stdin', async () => {
    const { stdout, exitCode } = await runCli(['stop-guard'], 'not json')
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('runCli unknown command', () => {
  it('exits non-zero with usage', async () => {
    const { stdout, exitCode } = await runCli(['nope'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('usage')
  })
})
