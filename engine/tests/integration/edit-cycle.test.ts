import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
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
    await runLog(project.dir, { agent: 'verifier', result: PASSING_VERIFIER }, clock)

    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)
    expect(state.status).toBe('done')

    // every artefact of the cycle is on disk and traceable to the run
    const dir = runDirPath(project.dir, state)
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['cycle-01']))
    expect((await fs.readdir(path.join(dir, 'cycle-01'))).sort()).toEqual([
      'editor.json',
      'findings.json',
      'roster.json',
      'verifier.json',
    ])

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('done')
    expect(summary.findings).toEqual({ high: 0, medium: 0, low: 0 })
  })

  it('halts with a report when the single cycle fails', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label to Send' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
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

    const { state } = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)
    expect(state.status).toBe('halted')

    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report).toContain('cycle cap 1 reached for track edit')
    expect(report).toContain('asserts the old label')
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
