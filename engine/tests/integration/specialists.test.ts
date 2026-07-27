import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { RosterViolationError, rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject

const ALL_SKIPPED = {
  scout: 'the story names the file',
  critic: 'single-file change',
  security: 'no auth, network or input handling',
  docs: 'no documented behaviour changed',
  perf: 'not on a hot path',
}

/**
 * The UI pair is available on `build` too, so a cycle that drafts neither owes
 * a reason for both. Kept out of ALL_SKIPPED because the UI cycle below drafts
 * them, and an agent cannot be selected and skipped in the same roster.
 */
const NO_UI = {
  'ui-designer': 'no visible surface changed',
  'ui-critic': 'no visible surface changed',
}

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  await runStart(project.dir, { track: 'build', goal: 'Add the Send button' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('a UI cycle', () => {
  it('drafts the UI pair and records why the others were skipped', async () => {
    const { path: file } = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier', 'ui-designer', 'ui-critic'],
      skipped: ALL_SKIPPED,
    })

    const roster = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(roster.selected).toContain('ui-designer')
    expect(roster.selected).toContain('ui-critic')
    expect(Object.keys(roster.skipped).sort()).toEqual(['critic', 'docs', 'perf', 'scout', 'security'])
  })

  it('carries a ui-critic finding into the next cycle', async () => {
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier', 'ui-designer', 'ui-critic'],
      skipped: ALL_SKIPPED,
    })
    await runLog(
      project.dir,
      {
        agent: 'ui-critic',
        result: {
          status: 'fail',
          summary: 'The button hardcodes its accent colour.',
          evidence: [{ kind: 'file', ref: 'src/SendButton.tsx', excerpt: "background: '#2f6fed'" }],
          findings: [
            { severity: 'medium', file: 'src/SendButton.tsx', line: 12, claim: 'hardcodes #2f6fed where --color-accent exists' },
          ],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    const closed = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier', 'ui-designer', 'ui-critic'], result: 'fail' },
      clock,
    )
    expect(closed.state.status).toBe('running')
    expect(closed.carried_findings[0]?.claim).toContain('--color-accent')
  })

  it('reports no design system until one is written', async () => {
    expect((await stateSummary(project.dir)).design_system).toBe(false)
    await fs.writeFile(resolveLoopPaths(project.dir).designSystem, '# Design System\n', 'utf8')
    expect((await stateSummary(project.dir)).design_system).toBe(true)
  })
})

describe('never holds', () => {
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { security: 'never' }
    await writeConfig(project.dir, config)
  })

  it('rejects a roster that drafts the forbidden specialist', async () => {
    await expect(
      rosterSet(project.dir, {
        cycle: 1,
        selected: ['builder', 'verifier', 'security'],
        skipped: { ...ALL_SKIPPED, ...NO_UI, security: 'forbidden by config' },
      }),
    ).rejects.toBeInstanceOf(RosterViolationError)
  })

  it('leaves an otherwise identical cycle working', async () => {
    const { path: file } = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: { ...ALL_SKIPPED, ...NO_UI },
    })
    expect(file).toContain('roster.json')

    const closed = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)
    expect(closed.state.status).toBe('done')
  })
})
