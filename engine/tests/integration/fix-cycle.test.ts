import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { GateClosedError, runLog } from '../../src/ops/log.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/tiny-app')

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await fs.cp(FIXTURE, project.dir, { recursive: true })
  await initLoop(project.dir, clock)
  await runStart(project.dir, { track: 'fix', goal: 'submitLabel returns a stale value' }, clock)
})
afterEach(async () => { await project.cleanup() })

const REPRODUCED = {
  status: 'pass' as const,
  summary: 'test/button.test.js now fails because submitLabel returns the previous label.',
  evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: "1 failing: expected 'Send', got 'Submit'" }],
  findings: [],
  files_touched: ['test/button.test.js'],
  next_hint: null,
}

// Hypotheses rank by array order, most likely first. They are not filed as
// `high`: severity is what the leader's pass rule reads, and nothing closes a
// finding inside a cycle, so a `high` hypothesis would fail the cycle that
// fixed and verified the defect it named.
const HYPOTHESES = {
  status: 'pass' as const,
  summary: 'Two candidates, ranked.',
  evidence: [{ kind: 'file' as const, ref: 'src/button.js', excerpt: "return 'Submit'" }],
  findings: [
    { severity: 'medium' as const, file: 'src/button.js', line: 2, claim: 'the literal was never updated' },
    { severity: 'low' as const, file: 'test/button.test.js', line: 6, claim: 'the assertion may be wrong instead' },
  ],
  files_touched: [],
  next_hint: null,
}

function verdict(refuted: boolean) {
  return {
    status: (refuted ? 'fail' : 'pass') as 'fail' | 'pass',
    summary: refuted ? 'Refuted by the assertion history.' : 'Supported: the literal is stale.',
    evidence: [{ kind: 'command' as const, ref: 'git log -1 test/button.test.js', excerpt: 'assertion unchanged' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }
}

describe('a full fix run', () => {
  it('reproduces, tests hypotheses in parallel, fixes, and passes', async () => {
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['reproducer', 'investigator', 'hypothesis-tester', 'fixer', 'verifier'],
      skipped: { critic: 'single-line change with a proven reproduction' },
    })

    const reproduced = await runLog(project.dir, { agent: 'reproducer', result: REPRODUCED }, clock)
    expect(reproduced.gateOpened).toBe(true)
    expect((await stateSummary(project.dir)).reproduction).toEqual({ proven: true, ref: 'npm test' })

    await runLog(project.dir, { agent: 'investigator', result: HYPOTHESES }, clock)
    await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'stale-literal', result: verdict(false) }, clock)
    await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'wrong-assertion', result: verdict(true) }, clock)

    await runLog(
      project.dir,
      {
        agent: 'fixer',
        result: {
          status: 'pass',
          summary: "Updated the literal to 'Send'; the reproducing test passes.",
          evidence: [
            { kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" },
            { kind: 'command', ref: 'npm test', excerpt: '1 passing' },
          ],
          findings: [],
          files_touched: ['src/button.js'],
          next_hint: null,
        },
      },
      clock,
    )

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    const entries = (await fs.readdir(cycleDir)).sort()
    expect(entries).toContain('hypothesis-tester--stale-literal.json')
    expect(entries).toContain('hypothesis-tester--wrong-assertion.json')
    expect(entries).toContain('fixer.json')

    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'The reproducing command passes and the rest of the suite is unchanged.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    // The state the leader's pass rule reads: a `pass` is only legitimate with
    // no `high` finding open, and nothing inside a cycle can close one.
    expect((await stateSummary(project.dir)).findings.high).toBe(0)

    const closed = await cycleAdvance(
      project.dir,
      { agents: ['reproducer', 'investigator', 'hypothesis-tester', 'fixer', 'verifier'], result: 'pass' },
      clock,
    )
    expect(closed.state.status).toBe('done')
  })
})

describe('the gate holds', () => {
  it('refuses a fix for a defect that was never reproduced', async () => {
    await expect(
      runLog(
        project.dir,
        {
          agent: 'fixer',
          result: {
            status: 'pass',
            summary: 'Changed the literal on a hunch.',
            evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" }],
            findings: [],
            files_touched: ['src/button.js'],
            next_hint: null,
          },
        },
        clock,
      ),
    ).rejects.toBeInstanceOf(GateClosedError)

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    await expect(fs.access(path.join(cycleDir, 'fixer.json'))).rejects.toThrow()
    expect(state.reproduction).toBeNull()
    expect(state.findings).toEqual([])
  })

  it('stays shut when the reproducer could not reproduce', async () => {
    await runLog(
      project.dir,
      {
        agent: 'reproducer',
        result: {
          status: 'blocked',
          summary: 'The reported behaviour does not occur: submitLabel already returns the expected value.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    expect((await stateSummary(project.dir)).reproduction).toEqual({ proven: false, ref: null })
    await expect(
      runLog(
        project.dir,
        {
          agent: 'fixer',
          result: {
            status: 'pass',
            summary: 'Attempted anyway.',
            evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: 'x' }],
            findings: [],
            files_touched: ['src/button.js'],
            next_hint: null,
          },
        },
        clock,
      ),
    ).rejects.toBeInstanceOf(GateClosedError)
  })
})
