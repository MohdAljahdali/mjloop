import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderSummaryLine, stateSummary } from '../../src/ops/summary.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { runLog } from '../../src/ops/log.js'
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
