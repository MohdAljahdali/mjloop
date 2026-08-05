import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { rosterSet } from '../../src/ops/roster.js'
import { QualityBudgetExhaustedError } from '../../src/ops/quality-control.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { StateStore } from '../../src/store/state-store.js'
import { pinInstantVerify, qualityEvidence } from '../helpers/quality-evidence.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/tiny-app')

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await fs.cp(FIXTURE, project.dir, { recursive: true })
})
afterEach(async () => { await project.cleanup() })

const PASSING_VERIFIER = {
  status: 'pass' as const,
  summary: 'Lint and the affected test both pass after the rename.',
  evidence: [
    { kind: 'command' as const, ref: 'npm run lint', excerpt: 'ok' },
    { kind: 'command' as const, ref: 'npm test', excerpt: '1 passing' },
  ],
  findings: [],
  files_touched: [],
  next_hint: null,
}

describe('a full edit cycle', () => {
  it('detects the fixture verify commands at init', async () => {
    const result = await initLoop(project.dir, clock)
    expect(result.verify).toEqual({ test: 'npm test', lint: 'npm run lint', build: null })
  })

  it('runs init -> start -> roster -> log -> advance and lands on done', async () => {
    await initLoop(project.dir, clock)
    await pinInstantVerify(project.dir)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label to Send' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })

    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: {
          status: 'pass',
          summary: 'Renamed the label and updated the assertion.',
          evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" }],
          findings: [],
          files_touched: ['src/button.js', 'test/button.test.js'],
          next_hint: null,
        },
      },
      clock,
    )
    // The claimed commands are replaced by receipts the engine produced: this
    // project pins an explicit quality mode, and a claim closes nothing.
    await runLog(
      project.dir,
      { agent: 'verifier', result: { ...PASSING_VERIFIER, evidence: await qualityEvidence(project.dir, clock) } },
      clock,
    )

    const { state, handoff, closing_agents } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'pass' },
      clock,
    )
    expect(state.status).toBe('done')
    // `edit` declares no closing agents, so the pass really is the end of the
    // run: nothing is dispatched after it and the leader commits straight away.
    expect(closing_agents).toEqual([])

    // every artefact of the cycle is on disk and traceable to the run
    const dir = runDirPath(project.dir, state)
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['cycle-01']))
    // `handoff.md` among them: `cycleAdvance` writes one on every close,
    // including the pass that ends a one-cycle track, where it is the run's
    // closing record rather than a brief for a cycle that will never open.
    // `verify/` among them: the quality plan closes on receipts the engine
    // produced, so this cycle really did run the two slots.
    expect((await fs.readdir(path.join(dir, 'cycle-01'))).sort()).toEqual([
      'editor.json',
      'findings.json',
      'handoff.md',
      'roster.json',
      'verifier.json',
      'verify',
    ])
    // The path the leader is handed is the document on disk. A returned path
    // that resolved to nothing would be worse than the `null` a failed write
    // reports, because the leader would pass it on to the next reader.
    expect(handoff).toBe(path.relative(project.dir, path.join(dir, 'cycle-01', 'handoff.md')))

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('done')
    expect(summary.findings).toEqual({ high: 0, medium: 0, low: 0 })
  })

  /**
   * The enforcing form of "the single cycle failed".
   *
   * Under an active quality policy the pinned `max_cycles` supersedes the
   * track's own cycle-cap halt: the run is *suspended* rather than ended,
   * because one explicit amendment can legitimately continue a run that a
   * terminal halt could not. So there is no HALT.md — there is a resumable
   * suspension, and the reason says how to lift it.
   */
  it('suspends for an amendment when the single cycle fails', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label to Send' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    // `verifier` is ordered after `editor` on the edit track — nothing to
    // check until the rename exists.
    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: {
          status: 'pass',
          summary: 'Renamed the label.',
          evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" }],
          findings: [],
          files_touched: ['src/button.js'],
          next_hint: null,
        },
      },
      clock,
    )
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'The assertion still expects the old label.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '1 failing' }],
          findings: [{ severity: 'high', file: 'test/button.test.js', line: 6, claim: 'asserts the old label' }],
          files_touched: [],
          next_hint: 'update the assertion',
        },
      },
      clock,
    )

    await expect(cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock))
      .rejects.toThrow(QualityBudgetExhaustedError)

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('budget_exhausted')
    expect(state.halt_reason).toContain('quality budget max_cycles reached')
    expect(state.halt_reason).toContain('Raise it with one explicit amendment to resume')

    // The cycle's own findings are untouched by the suspension, so the operator
    // deciding on the amendment can still read what went wrong.
    const summary = await stateSummary(project.dir)
    expect(summary.findings).toEqual({ high: 1, medium: 0, low: 0 })
  })

  it('blocks the escalation case without corrupting the run', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Restructure the whole component tree' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: {
          status: 'blocked',
          summary: 'This touches 9 files and changes two exported signatures. Recommend /mjloop:build.',
          evidence: [],
          findings: [],
          files_touched: [],
          next_hint: 'run /mjloop:build',
        },
      },
      clock,
    )

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(1)
  })
})
