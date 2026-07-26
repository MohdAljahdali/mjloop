import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStateGuard, runCli } from '../../src/cli/index.js'
import { initLoop } from '../../src/ops/init.js'
import { runStart } from '../../src/ops/run.js'
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

describe('runCli unknown command', () => {
  it('exits non-zero with usage', async () => {
    const { stdout, exitCode } = await runCli(['nope'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('usage')
  })
})
