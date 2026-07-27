import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderSummaryLine, stateSummary } from '../../src/ops/summary.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { runLog } from '../../src/ops/log.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('stateSummary', () => {
  it('reports uninitialised for a project without .loop', async () => {
    const summary = await stateSummary(project.dir)
    expect(summary.initialised).toBe(false)
    expect(summary.status).toBe('uninitialised')
    expect(renderSummaryLine(summary)).toContain('/loop:init')
  })

  it('reports an idle loop after init', async () => {
    await initLoop(project.dir, clock)
    const summary = await stateSummary(project.dir)
    expect(summary.initialised).toBe(true)
    expect(summary.status).toBe('idle')
    expect(summary.track).toBeNull()
  })

  it('reports track, cycle, cap, and findings for a running loop', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'snapshot mismatch',
          evidence: [],
          findings: [
            { severity: 'high', file: 'a.ts', line: 1, claim: 'x' },
            { severity: 'low', file: 'b.ts', line: 2, claim: 'y' },
          ],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('running')
    expect(summary.track).toBe('edit')
    expect(summary.cycle).toBe(1)
    expect(summary.max_cycles).toBe(1)
    expect(summary.findings).toEqual({ high: 1, medium: 0, low: 1 })
    expect(renderSummaryLine(summary)).toContain('edit')
    expect(renderSummaryLine(summary)).toContain('cycle 1/1')
  })

  it('still reports the findings a halted run ended with', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'the assertion still expects the old label',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '1 failing' }],
          findings: [{ severity: 'high', file: 'test/button.test.js', line: 6, claim: 'asserts the old label' }],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    // HALT.md lists this finding as open. A summary reading 0H/0M/0L would
    // tell a resumed session the run ended with nothing outstanding.
    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('halted')
    expect(summary.findings).toEqual({ high: 1, medium: 0, low: 0 })
    expect(renderSummaryLine(summary)).toContain('findings 1H/0M/0L')
  })

  it('degrades to an unknown cap when config.yaml is hand-broken', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    // HALT.md explicitly directs users to edit config.yaml, so a YAML typo
    // must degrade the summary, not crash the SessionStart hook.
    await fs.writeFile(path.join(project.dir, '.loop', 'config.yaml'), 'tracks: [unclosed', 'utf8')

    const summary = await stateSummary(project.dir)
    expect(summary.max_cycles).toBeNull()
    expect(renderSummaryLine(summary)).toContain('cycle 1/?')
  })

  it('surfaces the halt reason', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('halted')
    expect(summary.halt_reason).toContain('cycle cap 1')
    expect(summary.last_cycle).toEqual({ result: 'fail', agents: ['editor', 'verifier'] })
    expect(renderSummaryLine(summary)).toContain('halted')
  })
})

describe('stateSummary and the gate', () => {
  it('reports null for a track with no gate', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    expect((await stateSummary(project.dir)).reproduction).toBeNull()
  })

  it('reports an unproven gate before the defect is reproduced', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache' }, clock)
    expect((await stateSummary(project.dir)).reproduction).toEqual({ proven: false, ref: null })
  })

  it('reports the reproducing command once the gate is open', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'reproducer',
        result: {
          status: 'pass',
          summary: 'A failing test that proves the stale read.',
          evidence: [{ kind: 'command', ref: 'npm test -- cache', excerpt: '1 failing' }],
          findings: [],
          files_touched: ['test/cache.test.ts'],
          next_hint: null,
        },
      },
      clock,
    )

    const summary = await stateSummary(project.dir)
    expect(summary.reproduction).toEqual({ proven: true, ref: 'npm test -- cache' })
    expect(renderSummaryLine(summary)).toContain('gate open')
  })

  it('says the gate is shut in the rendered line', async () => {
    // Rendered from the gate, not from one track's story: a custom track may
    // gate on something that has nothing to do with reproducing a defect.
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache' }, clock)
    expect(renderSummaryLine(await stateSummary(project.dir))).toContain('gate shut')
  })
})

describe('config_error', () => {
  it('is null for a sound config', async () => {
    await initLoop(project.dir, clock)
    expect((await stateSummary(project.dir)).config_error).toBeNull()
  })

  it('is null when there is no config at all', async () => {
    expect((await stateSummary(project.dir)).config_error).toBeNull()
  })

  it('reports a config that fails to parse', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).config, 'version: 1\ntracks: {}\nmystery: true\n', 'utf8')

    const summary = await stateSummary(project.dir)
    expect(summary.config_error).toContain('mystery')
    expect(summary.initialised).toBe(true)
  })

  it('reports unparseable yaml without throwing', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).config, 'version: [unclosed\n', 'utf8')
    expect((await stateSummary(project.dir)).config_error).not.toBeNull()
  })
})

describe('the design system flag', () => {
  it('is false for an uninitialised project', async () => {
    expect((await stateSummary(project.dir)).design_system).toBe(false)
  })

  it('is false after init, since nothing extracts one there', async () => {
    await initLoop(project.dir, clock)
    expect((await stateSummary(project.dir)).design_system).toBe(false)
  })

  it('is true once the file exists', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).designSystem, '# Design System\n', 'utf8')
    expect((await stateSummary(project.dir)).design_system).toBe(true)
  })

  it('is false rather than throwing when the path is a directory', async () => {
    await initLoop(project.dir, clock)
    await fs.mkdir(resolveLoopPaths(project.dir).designSystem)
    expect((await stateSummary(project.dir)).design_system).toBe(false)
  })
})
