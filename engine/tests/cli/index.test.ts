import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluateStateGuard, evaluateStopGuard, runCli } from '../../src/cli/index.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import type { ProjectComponent, ProposedProfile } from '../../src/schemas/project-profile.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import {
  acceptProfile,
  acceptedRevisionFile,
  listAcceptedRevisions,
  readAcceptedProfile,
  readProposedProfile,
  writeProposedProfile,
} from '../../src/store/project-profile-store.js'
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

  it('emits nothing for a project without .mjloop', async () => {
    const { stdout, exitCode } = await runCli(['session-start'], JSON.stringify({ cwd: project.dir }))
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('evaluateStateGuard', () => {
  it('denies a write to .mjloop/state.json', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.mjloop/state.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('mjloop_')
    // the guidance must only name tools the MCP server actually registers
    expect(verdict.reason).not.toContain('mjloop_story_update')
  })

  it('denies a write to a plan manifest.json', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.mjloop/plans/P001-auth/manifest.json' },
    })
    expect(verdict.deny).toBe(true)
  })

  it("denies a hand edit to a run directory's verify-pinned.json", () => {
    // The basename guard is the entire enforcement of the verify pin: what a
    // run may execute is decided once, at run start, and nothing the run itself
    // writes can change it. Adding the word to PROTECTED_BASENAMES is the whole
    // mechanism — evaluateStateGuard matches by basename anywhere under
    // .mjloop/, so no guard, hook or hooks.json change is needed. Asserted here
    // because here is where it lives.
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.mjloop/runs/2026-07-28-001--adhoc--build/verify-pinned.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('verify-pinned.json')
  })

  it("denies a hand edit to a run directory's skill-selection.json", () => {
    // The identical mechanism as the verify pin, and for the identical reason:
    // what a run's agents are told to use is decided once, at run start, by
    // `pinSkillManifest` (`ops/run.ts`), and adding the basename to
    // PROTECTED_BASENAMES is the whole enforcement — no guard, hook or
    // hooks.json change needed, since evaluateStateGuard already matches by
    // basename anywhere under .mjloop/.
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.mjloop/runs/2026-07-28-001--adhoc--build/skill-selection.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('skill-selection.json')
  })

  it('allows a verify log, which the engine writes and a reader may open', () => {
    // Only the pin is protected. The logs and the ledger beside it are the
    // engine's output, not its instructions.
    const under = (name: string): boolean =>
      evaluateStateGuard({
        tool_name: 'Write',
        tool_input: { file_path: `/repo/.mjloop/runs/2026-07-28-001--adhoc--build/cycle-01/verify/${name}` },
      }).deny
    expect(under('test.log')).toBe(false)
    expect(under('index.json')).toBe(false)
  })

  it('denies a hand edit to the profile proposal', () => {
    // A hand-edited proposal is `profile accept`'s entire input: a model that
    // can rewrite it can put any component map it likes in front of the person
    // pressing accept, and the acceptance would be genuine.
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.mjloop/profile/proposed.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('mjloop-cli profile accept')
    expect(verdict.reason).toContain('profile reject')
  })

  it('denies a hand edit to an accepted revision, whose whole contract is that it never changes', () => {
    // `rev-NNN.json` is why this is a protected *directory* and not three more
    // basenames: the names are a family, and a run may have pinned any of them.
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.mjloop/profile/accepted/rev-001.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('profile')
  })

  it('denies a hand edit to a feature brief revision', () => {
    // An approved brief is the evidence a later plan is built on, and the
    // approval it carries was a decision somebody made about one particular set
    // of words. A model that could edit a revision could approve work nobody
    // agreed to, and nothing on disk would show the words had moved.
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.mjloop/features/F001-passwordless-sign-in/rev-001.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('features')
    // Each protected directory has to name its own way back in. Sending
    // somebody who was editing a brief to `mjloop-cli profile accept` would
    // point them at a different record entirely.
    expect(verdict.reason).not.toContain('profile')
    expect(verdict.reason).toContain('mjloop_feature_')
  })

  it('denies the features directory through those same path shapes', () => {
    const denies = (filePath: string): boolean =>
      evaluateStateGuard({ tool_name: 'Write', tool_input: { file_path: filePath } }).deny
    expect(denies('/repo/.mjloop//features/F001-auth/rev-001.json')).toBe(true)
    expect(denies('/repo/.mjloop/plans/../features/F001-auth/rev-002.json')).toBe(true)
    expect(denies('/repo/.mjloop/./features/F001-auth/rev-001.json')).toBe(true)
  })

  it('allows a features directory that is not the loop\'s', () => {
    const denies = (filePath: string): boolean =>
      evaluateStateGuard({ tool_name: 'Write', tool_input: { file_path: filePath } }).deny
    expect(denies('/repo/src/features/signin.ts')).toBe(false)
    expect(denies('/repo/.mjloop/features-archive/notes.md')).toBe(false)
  })

  it.each([
    ['/repo/.mjloop/State.json', 'a protected basename'],
    ['/repo/.mjloop/runs/2026-07-28-001--adhoc--build/Verify-Pinned.json', 'the verify pin'],
    ['/repo/.mjloop/Profile/proposed.json', 'a protected directory'],
    ['/repo/.mjloop/Features/F001-auth/rev-001.json', 'the other protected directory'],
    ['/repo/.MJLOOP/profile/accepted/rev-001.json', 'the loop directory itself'],
  ])('denies %s — on a case-insensitive volume it names %s', (filePath) => {
    // macOS and Windows volumes are case-insensitive by default, and this
    // repository lives on one. Every path here resolves to a file the guard
    // exists to protect; a case-sensitive comparison returned `deny: false` for
    // all five, which is a bypass requiring nothing but the shift key.
    expect(evaluateStateGuard({ tool_name: 'Write', tool_input: { file_path: filePath } }).deny).toBe(true)
  })

  it('still allows a path that only looks like a protected one', () => {
    // Folding must not turn into substring matching. These differ by more than
    // case and remain a user's own files.
    const denies = (filePath: string): boolean =>
      evaluateStateGuard({ tool_name: 'Write', tool_input: { file_path: filePath } }).deny
    expect(denies('/repo/.mjloop/Profiles/notes.md')).toBe(false)
    expect(denies('/repo/.mjloopx/profile/proposed.json')).toBe(false)
    expect(denies('/repo/.mjloop/plans/P001-auth/States.json')).toBe(false)
  })

  it('denies the protected directory through path shapes that name the same file', () => {
    // `//` from joining a path that already ended in a separator, a `.` from a
    // relative reference, and an interior `..` that cancels the directory
    // before it: none of these is an attack, all three come out of ordinary
    // path building, and each one puts a segment between `.mjloop` and
    // `profile` that a raw split reads as an ordinary directory. Every one of
    // them still opens the immutable revision for writing.
    const denies = (filePath: string): boolean =>
      evaluateStateGuard({ tool_name: 'Write', tool_input: { file_path: filePath } }).deny
    expect(denies('/repo/.mjloop//profile/accepted/rev-001.json')).toBe(true)
    expect(denies('/repo/.mjloop/plans/../profile/accepted/rev-001.json')).toBe(true)
    expect(denies('/repo/.mjloop/./profile/proposed.json')).toBe(true)
  })

  it('denies the protected basenames through those same path shapes', () => {
    // The control that says what the rule above had to be brought up to: the
    // basename branch was never exposed to any of this, because `path.basename`
    // discards the dirname where all three shapes live.
    const denies = (filePath: string): boolean =>
      evaluateStateGuard({ tool_name: 'Write', tool_input: { file_path: filePath } }).deny
    expect(denies('/repo/.mjloop//state.json')).toBe(true)
    expect(denies('/repo/.mjloop/runs/../state.json')).toBe(true)
  })

  it('allows a profile directory that is not the loop\'s', () => {
    // The rule is `.mjloop/profile/`, matched on path segments. A project with
    // its own `profile` directory — or a fixture holding a copy of one — is
    // nothing to do with the engine.
    expect(
      evaluateStateGuard({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/src/profile/proposed.json' },
      }).deny,
    ).toBe(false)
    expect(
      evaluateStateGuard({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/.mjloop/plans/P001-auth/PLAN.md' },
      }).deny,
    ).toBe(false)
    // `/repo/.mjloop/../profile/` is `/repo/profile/`, which the engine has
    // never owned. Reading the path as written rather than as spelled is what
    // makes the rule above right in both directions.
    expect(
      evaluateStateGuard({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/.mjloop/../profile/proposed.json' },
      }).deny,
    ).toBe(false)
  })

  it('allows a path whose directory merely contains the protected name', () => {
    // Segments, not substrings: `.mjloop/profiles/` and `.mjloop/profile-old/`
    // are directories nothing in the engine owns, and a substring rule would
    // deny both while claiming to protect one.
    expect(
      evaluateStateGuard({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/.mjloop/profiles/notes.md' },
      }).deny,
    ).toBe(false)
  })

  it('allows a write to a story file', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.mjloop/plans/P001-auth/stories/P001-S01-login.md' },
    })
    expect(verdict.deny).toBe(false)
  })

  it('allows a state.json that is not inside .mjloop', () => {
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
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/.mjloop/state.json' } })
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
    recovered: false,
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
    expect(reason).toContain('mjloop-leader')
  })

  it('attributes the findings to the cycle that is open', () => {
    // cycleAdvance clears findings before it increments the cycle, so a count
    // on a running state was logged by this cycle's own agents. Calling it
    // carried-forward debt invites the model to re-plan around work it just did.
    const { reason } = evaluateStopGuard(input, running, true)
    expect(reason).toContain('in this cycle')
    expect(reason).not.toContain('previous cycle')
  })

  it('allows the stop when the state came from the backup', () => {
    // The store could not read state.json and fell back to .bak, so this is the
    // write before the last one: a run recorded here as running may already be
    // done. Blocking would send the model to continue a finished run.
    expect(evaluateStopGuard(input, { ...running, recovered: true }, true).block).toBe(false)
  })

  it('allows the stop when the running track has no cap', () => {
    // The track is gone from config — renamed, removed, or on another branch.
    // cycleAdvance throws UnknownTrackError before any status transition, so
    // none of the guards the reason promises can end this run.
    expect(evaluateStopGuard(input, { ...running, max_cycles: null }, true).block).toBe(false)
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

  it('emits nothing when a config that opted in no longer parses', async () => {
    // The single most safety-critical fail-open path: config.yaml is
    // hand-editable, and a run left `running` by a YAML typo must not be read
    // as still having opted into autonomy.
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)
    await fs.writeFile(path.join(project.dir, '.mjloop', 'config.yaml'), 'autonomous: true\ntracks: [unclosed', 'utf8')

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })

  it('emits nothing when state.json is corrupt and the value came from the backup', async () => {
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)

    const statePath = path.join(project.dir, '.mjloop', 'state.json')
    await fs.copyFile(statePath, `${statePath}.bak`)
    await fs.writeFile(statePath, '<<<<<<< HEAD\nnot json', 'utf8')

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })

  it('emits nothing when the running track has left config', async () => {
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)

    const renamed = await loadConfig(project.dir)
    delete renamed.tracks.build
    await writeConfig(project.dir, renamed)

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })
})

describe('runCli config get', () => {
  it('prints every orchestration setting and the revision the file is at', async () => {
    await initLoop(project.dir, clock)
    const { stdout, exitCode } = await runCli(['config', 'get', '--dir', project.dir], '')

    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/revision [a-f0-9]{64}/)
    for (const key of [
      'orchestration.profile.auto_accept',
      'orchestration.discovery.mode',
      'orchestration.discovery.question_budget',
      'orchestration.discovery.completion',
      'orchestration.execution.after_plan_approval',
      'orchestration.execution.uncertain_concurrency',
      'orchestration.execution.repair_attempts',
      'orchestration.quality.independent_plan_review',
      'orchestration.quality.independent_verification',
      'orchestration.skills.sources',
      'orchestration.skills.trusted_registries',
      'orchestration.skills.update_mode',
    ]) {
      expect(stdout).toContain(key)
    }
  })

  it('prints json when asked', async () => {
    await initLoop(project.dir, clock)
    const { stdout } = await runCli(['config', 'get', '--dir', project.dir, '--json'], '')
    const payload = JSON.parse(stdout)
    expect(payload.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(payload.orchestration.discovery.mode).toBe('off')
    expect(payload.orchestration.skills.sources).toEqual(['github'])
  })

  it('exits non-zero for a project with no loop', async () => {
    const { stdout, exitCode } = await runCli(['config', 'get', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('config.yaml')
  })

  it('reports a config that no longer parses instead of printing defaults', async () => {
    // Printing the schema's prefaults for a file nobody can read would tell a
    // person their project is configured the way they hoped it was.
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).config, 'tracks: [unclosed', 'utf8')

    const { stdout, exitCode } = await runCli(['config', 'get', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('not valid YAML')
  })
})

describe('runCli config set', () => {
  it('writes one setting and reports the revision it landed at', async () => {
    await initLoop(project.dir, clock)
    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.mode', 'always', '--dir', project.dir],
      '',
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('orchestration.discovery.mode = always')
    expect(stdout).toMatch(/revision [a-f0-9]{64}/)
    expect((await loadConfig(project.dir)).orchestration.discovery.mode).toBe('always')
  })

  it('leaves every sibling setting alone', async () => {
    await initLoop(project.dir, clock)
    await runCli(['config', 'set', 'orchestration.execution.repair_attempts', '3', '--dir', project.dir], '')

    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    expect(raw).toContain('repair_attempts: 3')
    const config = await loadConfig(project.dir)
    expect(config.orchestration.execution.repair_attempts).toBe(3)
    expect(config.orchestration.discovery.question_budget).toBe(8)
    expect(config.autonomous).toBe(false)
  })

  it('sets a list from a comma-separated value, and the empty string is the empty list', async () => {
    await initLoop(project.dir, clock)
    await runCli(['config', 'set', 'orchestration.skills.sources', 'github, web', '--dir', project.dir], '')
    expect((await loadConfig(project.dir)).orchestration.skills.sources).toEqual(['github', 'web'])

    await runCli(['config', 'set', 'orchestration.skills.sources', '', '--dir', project.dir], '')
    expect((await loadConfig(project.dir)).orchestration.skills.sources).toEqual([])
  })

  it('sets the one key that carries a section key of its own', async () => {
    await initLoop(project.dir, clock)
    const { exitCode } = await runCli(
      ['config', 'set', 'orchestration.quality.independent_verification', 'true', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(0)
    const quality = (await loadConfig(project.dir)).orchestration.quality
    expect(quality.independent_verification).toBe(true)
    expect(quality.independent_plan_review).toBe(false)
  })

  it('refuses an unknown key, names it, and writes nothing', async () => {
    await initLoop(project.dir, clock)
    const before = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')

    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.speed', 'always', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('orchestration.discovery.speed')
    expect(stdout).toContain('orchestration.discovery.mode')
    expect(await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')).toBe(before)
  })

  it.each(['toString', 'constructor', 'valueOf', '__proto__'])(
    'refuses %s, which the settings table inherits rather than declares',
    async (key) => {
      // `SETTINGS` is an object literal, so a plain `SETTINGS[key]` lookup
      // answers `toString` with a function and `__proto__` with an object, and
      // an `=== undefined` guard waves both through into a `.parse` that is not
      // one — a Node stack trace out of the binary instead of the list of keys.
      // The same hole `hasKey` in the detector is written to close.
      await initLoop(project.dir, clock)
      const before = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')

      const { stdout, exitCode } = await runCli(['config', 'set', key, 'true', '--dir', project.dir], '')
      expect(exitCode).toBe(1)
      expect(stdout).toContain(`${key} is not a setting`)
      expect(stdout).toContain('orchestration.discovery.mode')
      expect(await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')).toBe(before)
    },
  )

  it('refuses a value outside the bounds the schema states, and writes nothing', async () => {
    await initLoop(project.dir, clock)
    const before = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')

    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.question_budget', '99', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('orchestration.discovery.question_budget')
    expect(stdout).toContain('99')
    expect(stdout).toContain('20')
    expect(await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')).toBe(before)
  })

  it('refuses a value of the wrong shape before it opens the file at all', async () => {
    await initLoop(project.dir, clock)
    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.execution.repair_attempts', 'lots', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('whole number')
  })

  it('refuses a word the setting does not admit and names the ones it does', async () => {
    await initLoop(project.dir, clock)
    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.mode', 'sometimes', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('always')
  })

  it('refuses a change that would make the whole document contradict itself', async () => {
    // This is the reason the CLI goes through `mutateConfig` rather than
    // writing YAML: `auto-plan` is a perfectly good value for `completion` on
    // its own, and only illegal beside a `discovery.mode` of `off`. Nothing
    // short of re-parsing the whole document can see that.
    await initLoop(project.dir, clock)
    const before = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')

    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.completion', 'auto-plan', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('orchestration.discovery.completion')
    expect(await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')).toBe(before)
  })

  it('refuses to write when the config changed after the revision was read', async () => {
    await initLoop(project.dir, clock)
    const configFile = resolveLoopPaths(project.dir).config
    const readFile = fs.readFile.bind(fs)

    // A second writer lands the instant the CLI has the bytes it will hash.
    // `mutateConfig` re-reads under the lock, sees a revision that is no longer
    // the one it was handed, and must refuse rather than write over an edit it
    // never saw.
    let intercepted = false
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (file: unknown, encoding: unknown) => {
      const contents = await (readFile as (...rest: unknown[]) => Promise<string>)(file, encoding)
      if (!intercepted && String(file) === configFile) {
        intercepted = true
        await fs.writeFile(configFile, `# a second writer got here first\n${contents}`, 'utf8')
      }
      return contents
    })

    let result: Awaited<ReturnType<typeof runCli>>
    try {
      result = await runCli(['config', 'set', 'orchestration.discovery.mode', 'always', '--dir', project.dir], '')
    } finally {
      spy.mockRestore()
    }

    expect(intercepted).toBe(true)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('changed')
    const after = await fs.readFile(configFile, 'utf8')
    expect(after).toContain('# a second writer got here first')
    expect(after).not.toContain('mode: always')
  })

  it('exits non-zero for a project with no loop', async () => {
    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.mode', 'always', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('config.yaml')
  })

  it('exits non-zero when the key or the value is missing', async () => {
    await initLoop(project.dir, clock)
    expect((await runCli(['config', 'set', '--dir', project.dir], '')).exitCode).toBe(1)
    expect((await runCli(['config', 'set', 'orchestration.discovery.mode', '--dir', project.dir], '')).exitCode).toBe(1)
  })

  it('refuses a --dir with nothing after it rather than writing to the current directory', async () => {
    // `--dir "$PROJECT"` with `PROJECT` unset leaves a bare `--dir` behind, and
    // a flag read as absent falls back to `process.cwd()` — a different project
    // than the one that was named, and one this command would then write to.
    await initLoop(project.dir, clock)
    const before = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')

    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'orchestration.discovery.mode', 'always', '--dir'],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--dir')
    expect(await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')).toBe(before)
  })
})

/* ---------------------------------------------------------------- profile */

const MOBILE: ProjectComponent = {
  id: 'mobile',
  root: 'mobile',
  technology: 'flutter',
  verification: { test: 'cd mobile && flutter test', lint: null, build: null },
  skillTags: ['flutter'],
}

const WEB: ProjectComponent = {
  id: 'web',
  root: 'web',
  technology: 'nextjs',
  verification: { test: 'cd web && npm test', lint: null, build: 'cd web && npm run build' },
  skillTags: ['nextjs'],
}

function proposal(components: ProjectComponent[], generatedAt = '2026-07-31T09:00:00.000Z'): ProposedProfile {
  return { schema: 1, generatedAt, components, basis: components.map((c) => `${c.root}/manifest`) }
}

describe('runCli profile show', () => {
  it('reports a project with no accepted map at exit 0, because that is a state and not a failure', async () => {
    await initLoop(project.dir, clock)
    const { stdout, exitCode } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('no component map is accepted')
  })

  it('prints the accepted revision, when it was accepted, by whom, and its components', async () => {
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))
    await acceptProfile(
      project.dir,
      { components: [MOBILE, WEB], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )

    const { stdout, exitCode } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('revision 1')
    expect(stdout).toContain('cli:ada')
    expect(stdout).toContain(NOW.toISOString())
    expect(stdout).toContain('mobile')
    expect(stdout).toContain('flutter')
    expect(stdout).toContain('cd web && npm run build')
  })

  it('says plainly that the proposal differs from what is accepted', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(stdout).toContain('differs')
    expect(stdout).toContain('profile accept')
  })

  it('says plainly that the proposal matches what is accepted', async () => {
    // Same components, a later scan: the generated timestamp moved and nothing
    // else did. Reporting that as a difference would ask somebody to accept a
    // revision that changes nothing about how work is routed.
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE], '2026-08-01T09:00:00.000Z'))

    const { stdout } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(stdout).toContain('matches')
    expect(stdout).not.toContain('differs')
  })

  it('reports a component whose verify command moved as a difference, not just a component that appeared', async () => {
    // The regression a length check cannot see, and the one that actually
    // happens: the same component, in the same place, verified by a different
    // command. Reported as a match, the operator is told there is nothing to
    // accept and a live routing change is never activated.
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(
      project.dir,
      proposal([{ ...MOBILE, verification: { ...MOBILE.verification, test: 'cd mobile && flutter test --coverage' } }]),
    )

    const { stdout } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(stdout).toContain('differs')
    expect(stdout).not.toContain('there is nothing to accept')
  })

  it('reports changed skill tags as a difference, since the tags are what select a skill', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    // One tag replaced by another rather than added: same array length, so the
    // only thing that can tell the two maps apart is the element comparison.
    await writeProposedProfile(project.dir, proposal([{ ...MOBILE, skillTags: ['dart'] }]))

    const { stdout } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(stdout).toContain('differs')
    expect(stdout).not.toContain('there is nothing to accept')
  })

  it('prints json when asked', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout, exitCode } = await runCli(['profile', 'show', '--dir', project.dir, '--json'], '')
    expect(exitCode).toBe(0)
    const payload = JSON.parse(stdout)
    expect(payload.accepted.revision).toBe(1)
    expect(payload.accepted.acceptedBy).toBe('cli:ada')
    expect(payload.proposed.components.map((c: ProjectComponent) => c.id)).toEqual(['mobile', 'web'])
    expect(payload.differs).toBe(true)
  })

  it('refuses a --dir with nothing after it, because a retargeted read is what the acceptance is decided on', async () => {
    // `show` is a read, so nothing is lost on disk — but it is the read a
    // person accepts or rejects on the strength of, and answering it about
    // whichever directory the shell happened to be in is worse than answering
    // it not at all.
    const { stdout, exitCode } = await runCli(['profile', 'show', '--dir'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--dir')
  })

  it('says both are absent for a project that has never been scanned', async () => {
    const { stdout, exitCode } = await runCli(['profile', 'show', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('no component map is accepted')
    expect(stdout).toContain('no proposal')
  })
})

describe('runCli profile accept', () => {
  it('accepts the current proposal as revision 1 and names what it activated', async () => {
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('revision 1')
    expect(stdout).toContain('mobile')
    expect(stdout).toContain('web')

    const accepted = await readAcceptedProfile(project.dir)
    expect(accepted?.revision).toBe(1)
    expect(accepted?.components.map((c) => c.id)).toEqual(['mobile', 'web'])
    expect(accepted?.generatedAt).toBe('2026-07-31T09:00:00.000Z')
  })

  it('records who accepted it, prefixed cli: so the audit record says how', async () => {
    // `acceptedBy` is the only record of why a revision exists. The engine
    // cannot verify a username, but it can refuse to let one be typed in.
    await writeProposedProfile(project.dir, proposal([MOBILE]))
    await runCli(['profile', 'accept', '--dir', project.dir], '')

    const accepted = await readAcceptedProfile(project.dir)
    expect(accepted?.acceptedBy).toMatch(/^cli:.+/)
  })

  it('refuses when there is no proposal, and names what produces one', async () => {
    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('mjloop init')
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })

  it('refuses an --expect that does not match what is accepted, and writes nothing', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir, '--expect', '5'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('profile show')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
  })

  it('refuses --expect none on a project that already has an accepted map', async () => {
    // The whole point of the flag: somebody who believes nothing is accepted is
    // working from a screen that has since moved, and stacking their acceptance
    // on top of the one they never saw is the lost update this refuses.
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir, '--expect', 'none'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('profile show')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
  })

  it('accepts --expect none on a project that has none', async () => {
    await writeProposedProfile(project.dir, proposal([MOBILE]))
    const { exitCode } = await runCli(['profile', 'accept', '--dir', project.dir, '--expect', 'none'], '')
    expect(exitCode).toBe(0)
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
  })

  it('refuses an --expect that is not a revision number', async () => {
    await writeProposedProfile(project.dir, proposal([MOBILE]))
    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir, '--expect', 'latest'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--expect')
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })

  it('refuses an --expect with nothing after it rather than accepting without the guard', async () => {
    // The shape this fails in: `--expect $REV` with `REV` unset leaves the flag
    // on the line and takes its value away. Reading that as an absent flag is
    // not a smaller mistake — it is the auto-read path, which cannot notice the
    // revision that landed before this command ran, so the acceptance the flag
    // exists to refuse goes through instead, silently and at exit 0.
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir, '--expect'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--expect')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
  })

  it('refuses a --dir with nothing after it rather than accepting into another project', async () => {
    await writeProposedProfile(project.dir, proposal([MOBILE]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--dir')
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })

  it('supersedes the revision that is current when --expect is omitted', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('revision 2')
    const accepted = await readAcceptedProfile(project.dir)
    expect(accepted?.supersedes).toBe(1)
  })
})

describe('runCli profile reject', () => {
  it('discards the proposal and leaves the accepted revision exactly as it was', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'cli:ada', generatedAt: '2026-07-31T09:00:00.000Z', expectRevision: null },
      clock,
    )
    const before = await fs.readFile(acceptedRevisionFile(project.dir, 1), 'utf8')
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    const { exitCode } = await runCli(['profile', 'reject', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(await readProposedProfile(project.dir)).toBeNull()
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
    expect(await fs.readFile(acceptedRevisionFile(project.dir, 1), 'utf8')).toBe(before)
  })

  it('leaves nothing a later read can resurrect the proposal from', async () => {
    // `readProposedProfile` falls back to `proposed.json.bak`, which the atomic
    // write leaves behind on every scan after the first. A reject that removed
    // only the primary would appear to work and then hand the next reader the
    // proposal before the one that was just discarded.
    await writeProposedProfile(project.dir, proposal([MOBILE]))
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))

    expect((await runCli(['profile', 'reject', '--dir', project.dir], '')).exitCode).toBe(0)
    expect(await readProposedProfile(project.dir)).toBeNull()
  })

  it('refuses when there is no proposal to discard', async () => {
    const { stdout, exitCode } = await runCli(['profile', 'reject', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('no proposal')
  })

  it('refuses a --dir with nothing after it rather than discarding another project\'s proposal', async () => {
    await writeProposedProfile(project.dir, proposal([MOBILE]))

    const { stdout, exitCode } = await runCli(['profile', 'reject', '--dir'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--dir')
    expect(await readProposedProfile(project.dir)).not.toBeNull()
  })
})

describe('runCli profile rollback', () => {
  /**
   * Revisions 1 (`[mobile, web]`) and 2 (`[mobile]`), accepted the way a person
   * accepts them.
   *
   * `writeProposedProfile` stages the two scans and nothing else, because that
   * is the one thing in this story a person does not do — `initLoop` writes the
   * proposal, and the detector is not what these tests are about. Every step
   * after the scan goes through `runCli`, which is the whole point: a rollback
   * the store supports and the command line cannot reach is not a rollback.
   */
  async function twoRevisions(): Promise<void> {
    await writeProposedProfile(project.dir, proposal([MOBILE, WEB]))
    expect((await runCli(['profile', 'accept', '--dir', project.dir, '--expect', 'none'], '')).exitCode).toBe(0)
    await writeProposedProfile(project.dir, proposal([MOBILE], '2026-08-01T09:00:00.000Z'))
    expect((await runCli(['profile', 'accept', '--dir', project.dir, '--expect', '1'], '')).exitCode).toBe(0)
  }

  it('reselects an earlier component map as a new revision, rewriting no earlier record', async () => {
    // The entire rollback model. There is no mutable "current" pointer to move
    // back, so going back to revision 1's components means accepting them again
    // as revision 3 — and revisions 1 and 2 must still say what they always
    // said, because a run may have pinned either.
    await twoRevisions()
    const revisionOne = await fs.readFile(acceptedRevisionFile(project.dir, 1), 'utf8')
    const revisionTwo = await fs.readFile(acceptedRevisionFile(project.dir, 2), 'utf8')

    const { stdout, exitCode } = await runCli(
      ['profile', 'accept', '--from', '1', '--dir', project.dir, '--expect', '2'],
      '',
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('revision 3')
    expect(stdout).toContain('reselecting revision 1')

    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2, 3])
    const three = await readAcceptedProfile(project.dir)
    expect(three?.revision).toBe(3)
    // Forwards, at what was current — never back at the revision reselected. A
    // supersedes pointing backwards would make the chain unreadable.
    expect(three?.supersedes).toBe(2)
    // The map came from revision 1, not from the proposal sitting on disk —
    // which is `[mobile]`, scanned a day later, and is not read at all here.
    expect(three?.components).toEqual([MOBILE, WEB])
    expect(three?.generatedAt).toBe('2026-07-31T09:00:00.000Z')

    expect(await fs.readFile(acceptedRevisionFile(project.dir, 1), 'utf8')).toBe(revisionOne)
    expect(await fs.readFile(acceptedRevisionFile(project.dir, 2), 'utf8')).toBe(revisionTwo)
  })

  it('rolls back on a project with no proposal at all, because a proposal is not what it reads', async () => {
    // The case that made the old story impossible to tell honestly: accepting
    // read `proposed.json` and only `proposed.json`, so a project whose last
    // scan had been discarded could not reselect anything. Rolling back is a
    // statement about the history, and the history is on disk either way.
    await twoRevisions()
    expect((await runCli(['profile', 'reject', '--dir', project.dir], '')).exitCode).toBe(0)
    expect(await readProposedProfile(project.dir)).toBeNull()

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', '1', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('revision 3')
    expect((await readAcceptedProfile(project.dir))?.components).toEqual([MOBILE, WEB])
  })

  it('refuses a --from naming a revision that was never accepted, and names the ones that were', async () => {
    await twoRevisions()

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', '9', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('no accepted revision 9')
    expect(stdout).toContain('the revisions on record are 1, 2')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2])
  })

  it('refuses a --from on a project where nothing has ever been accepted', async () => {
    // A proposal is present and would accept perfectly well. It is still not
    // what was asked for, and quietly accepting it would activate a map nobody
    // chose under the name of a rollback.
    await writeProposedProfile(project.dir, proposal([MOBILE]))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', '1', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('no component map has ever been accepted')
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })

  it('refuses a --from that is not a revision number', async () => {
    // Not coerced, for `--expect`'s reason one step worse: `Number('previous')`
    // is NaN, and a NaN revision names `rev-NaN.json` — a file nothing has ever
    // written — so the person would be told a revision is missing when what
    // went wrong is the word they typed.
    await twoRevisions()

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', 'previous', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--from')
    expect(stdout).toContain('previous')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2])
  })

  it.each(['0', '-1', '1.5', '01'])('names the revisions on record when --from %s is malformed', async (raw) => {
    // The roster belongs on this refusal more than on the never-accepted one.
    // `01` is the likeliest of these to be typed, because the files on disk are
    // named `rev-001.json`, and somebody who already knows they mistyped the
    // number needs the one thing a bare "that is not a number" withholds: which
    // numbers they may retype.
    await twoRevisions()

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', raw, '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain(`got "${raw}"`)
    expect(stdout).toContain('the revisions on record are 1, 2')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2])
  })

  it('refuses a --from whose revision file no longer parses, and names the ones that do', async () => {
    // On record and unreadable. Listing decides membership, so this branch is
    // only reachable once a hand has been inside `accepted/` — and it is the one
    // refusal where the roster beside the error is what the reader acts on,
    // because the next thing they do is choose a different revision.
    await twoRevisions()
    const before = await fs.readFile(acceptedRevisionFile(project.dir, 2), 'utf8')
    await fs.writeFile(acceptedRevisionFile(project.dir, 1), '{ "schema": 1, "revi', 'utf8')

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', '1', '--dir', project.dir], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('is not a valid project profile')
    expect(stdout).toContain('the revisions on record are 1, 2')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2])
    // The refusal wrote nothing: no third revision, and the intact one untouched.
    expect(await fs.readFile(acceptedRevisionFile(project.dir, 2), 'utf8')).toBe(before)
  })

  it('refuses a --from with nothing after it rather than accepting the proposal instead', async () => {
    // `--from $REV` with `REV` unset leaves the flag on the line with its value
    // gone. Read as an absent flag it is not a smaller mistake — it becomes an
    // ordinary acceptance of whatever the tree last scanned to, which is the
    // exact opposite of the rollback that was typed, and it exits 0.
    await twoRevisions()

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--dir', project.dir, '--from'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('--from')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2])
  })

  it('refuses a --from composed with a stale --expect, and writes nothing', async () => {
    // `--from` changes where the components come from and nothing else. The
    // compare-and-swap is still on the accepted-revision counter, because a
    // rollback is still an append — and an append built on a revision that has
    // since moved is still the lost update `--expect` exists to refuse.
    await twoRevisions()

    const { stdout, exitCode } = await runCli(
      ['profile', 'accept', '--from', '1', '--expect', '1', '--dir', project.dir],
      '',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('profile show')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2])
  })

  it('accepts a --from naming the revision that is already current, writing a new revision for it', async () => {
    // Allowed rather than refused. The sibling case already behaves this way —
    // `accept` with an unchanged proposal writes a revision — and a refusal
    // here would be a rule about revision *numbers* dressed as a rule about
    // component maps: `--from 2` when 2 is current and `--from 1` when 1 and 2
    // hold identical components are the same request, and only the first is
    // detectable. A scripted rollback would then have to branch on state it did
    // not read.
    await twoRevisions()
    // A newer scan proposing something else entirely, so that "it wrote a
    // revision" and "it wrote *revision 2's* map" stay two separate claims.
    await writeProposedProfile(project.dir, proposal([WEB], '2026-08-02T09:00:00.000Z'))

    const { stdout, exitCode } = await runCli(['profile', 'accept', '--from', '2', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('revision 3')
    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2, 3])
    const three = await readAcceptedProfile(project.dir)
    expect(three?.supersedes).toBe(2)
    expect(three?.components).toEqual([MOBILE])
  })

  it('names --from in the usage text, since it is the only way to reach a rollback', async () => {
    const { stdout } = await runCli(['nope'], '')
    expect(stdout).toContain('--from')
  })
})

describe('runCli unknown command', () => {
  it('exits non-zero with usage', async () => {
    const { stdout, exitCode } = await runCli(['nope'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('usage')
  })

  it('exits non-zero with usage for config without a subcommand', async () => {
    const { stdout, exitCode } = await runCli(['config'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('usage')
  })

  it('names both config subcommands in the usage text', async () => {
    const { stdout } = await runCli(['nope'], '')
    expect(stdout).toContain('config get')
    expect(stdout).toContain('config set')
  })

  it('exits non-zero with usage for profile without a subcommand', async () => {
    const { stdout, exitCode } = await runCli(['profile'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('usage')
  })

  it('names all three profile subcommands in the usage text', async () => {
    const { stdout } = await runCli(['nope'], '')
    expect(stdout).toContain('profile show')
    expect(stdout).toContain('profile accept')
    expect(stdout).toContain('profile reject')
  })
})
