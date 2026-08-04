import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import {
  QualityBudgetExhaustedError,
  amendQualityBudget,
  reserveQualityDispatches,
  type QualityBudgetField,
} from '../../src/ops/quality-control.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, cycleDirPath, runStart } from '../../src/ops/run.js'
import type { QualityBudget } from '../../src/schemas/quality.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { qualityFiles, readAmendments } from '../../src/store/quality-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

// The rollout gate is closed in production until Task 17, so mocking it open is
// the only way this file can reach the enforcing path at all. The last test
// closes it again, because a closed gate must leave every seam exactly where it
// was.
vi.mock('../../src/ops/quality-capability.js', () => ({ qualityRuntimeEnabled: vi.fn(() => true) }))
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'

const NOW = new Date('2026-08-04T09:00:00.000Z')
const clock = () => NOW

const PASS = { status: 'pass' as const, summary: 'The rename landed.', evidence: [], findings: [], files_touched: [] }

let project: TmpProject

/** The composition this one-cycle track accepts, with every omission explained. */
function nextRoster(): { cycle: number; selected: string[]; skipped: Record<string, string> } {
  return {
    cycle: 1,
    selected: ['editor', 'verifier'],
    skipped: { scout: 'goal names the file', critic: 'single-file change' },
  }
}

function policyFile(dir: string, state: Awaited<ReturnType<StateStore['get']>>): string {
  return qualityFiles(dir, state).policy
}

/** Lower one pinned ceiling on disk, so a ceiling is reachable in one action rather than in a whole run. */
async function seedBudget(dir: string, budget: Partial<QualityBudget>): Promise<void> {
  const state = await new StateStore(dir).get()
  const file = policyFile(dir, state)
  const policy = JSON.parse(await fs.readFile(file, 'utf8')) as { budget: QualityBudget }
  await fs.writeFile(file, `${JSON.stringify({ ...policy, budget: { ...policy.budget, ...budget } }, null, 2)}\n`, 'utf8')
}

/** Spend dispatch slots the way the engine does — through the reservation itself, never by writing its record. */
async function seedUsed(dir: string, count: number): Promise<void> {
  const state = await new StateStore(dir).get()
  await reserveQualityDispatches(
    dir,
    state,
    Array.from({ length: count }, (_, index) => ({
      agent: 'verifier',
      instance: `seed-${index + 1}`,
      dimensions: ['correctness' as const],
      reason: 'Occupy one dispatch slot for this test.',
    })),
  )
}

async function cycleFiles(dir: string): Promise<string[]> {
  const state = await new StateStore(dir).get()
  return fs.readdir(cycleDirPath(dir, state)).catch(() => [])
}

async function seedAtCeiling(dir: string, field: QualityBudgetField): Promise<void> {
  if (field === 'max_cycles') return seedBudget(dir, { max_cycles: 1 })
  if (field === 'max_context_tokens_per_dispatch') return seedBudget(dir, { max_context_tokens_per_dispatch: 1 })
  if (field === 'max_repair_attempts') return seedBudget(dir, { max_repair_attempts: 0 })
  await seedBudget(dir, { max_dispatches: 1 })
  await seedUsed(dir, 1)
}

async function attemptNextBudgetedAction(dir: string, field: QualityBudgetField): Promise<unknown> {
  if (field === 'max_cycles') return cycleAdvance(dir, { agents: ['editor'], result: 'fail' }, clock)
  if (field === 'max_repair_attempts') {
    return runLog(dir, { agent: 'verifier', instance: 'repair-1', result: PASS }, clock)
  }
  return rosterSet(dir, nextRoster())
}

beforeEach(async () => {
  vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  const config = await loadConfig(project.dir)
  config.tracks.edit = { required: ['editor', 'verifier'], available: ['scout', 'critic'], closing: [], max_cycles: 3, order: [] }
  // Written back in full, which names `orchestration.quality.mode` in the
  // document — the opt-in that pins `enforcement: active` for this run.
  config.orchestration.quality.mode = 'economy'
  await writeConfig(project.dir, config)
  await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
})
afterEach(async () => {
  await project.cleanup()
})

describe('quality budget suspension', () => {
  it('suspends before a roster would exceed the pinned dispatch ceiling', async () => {
    await seedBudget(project.dir, { max_dispatches: 2 })
    await seedUsed(project.dir, 2)

    await expect(rosterSet(project.dir, nextRoster())).rejects.toBeInstanceOf(QualityBudgetExhaustedError)

    expect((await new StateStore(project.dir).get()).status).toBe('budget_exhausted')
    expect(await cycleFiles(project.dir)).toEqual([])
  })

  it.each(['max_cycles', 'max_dispatches', 'max_context_tokens_per_dispatch', 'max_repair_attempts'] as const)(
    'suspends before exceeding %s',
    async (field) => {
      await seedAtCeiling(project.dir, field)

      await expect(attemptNextBudgetedAction(project.dir, field)).rejects.toBeInstanceOf(QualityBudgetExhaustedError)

      const state = await new StateStore(project.dir).get()
      expect(state.status).toBe('budget_exhausted')
      // The suspended action left nothing behind: the cycle never advanced and
      // the stage the run was working at is still the stage it resumes at.
      expect(state.cycle).toBe(1)
      expect(state.current.stage).toBe('compose')
      expect(await cycleFiles(project.dir)).toEqual([])
    },
  )

  it('leaves every seam alone while the rollout gate is closed', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(false)
    await seedBudget(project.dir, { max_cycles: 1, max_dispatches: 1, max_repair_attempts: 0 })

    await expect(rosterSet(project.dir, nextRoster())).resolves.toMatchObject({ path: expect.stringContaining('roster.json') })
    await expect(runLog(project.dir, { agent: 'verifier', instance: 'repair-1', result: PASS }, clock)).resolves.toBeTruthy()
    expect((await new StateStore(project.dir).get()).status).toBe('running')
  })
})

describe('amendQualityBudget', () => {
  it('applies ordered amendments without mutating the policy pin, and resumes where the run stopped', async () => {
    await seedBudget(project.dir, { max_dispatches: 2 })
    await seedUsed(project.dir, 2)
    await expect(rosterSet(project.dir, nextRoster())).rejects.toBeInstanceOf(QualityBudgetExhaustedError)

    const suspended = await new StateStore(project.dir).get()
    const before = await fs.readFile(policyFile(project.dir, suspended), 'utf8')
    const resumed = await amendQualityBudget(
      project.dir,
      {
        run: suspended.run_id ?? '',
        field: 'max_dispatches',
        from: 2,
        to: 4,
        reason: 'one targeted repair',
        decided_by: 'operator',
      },
      clock,
    )

    expect(await fs.readFile(policyFile(project.dir, suspended), 'utf8')).toBe(before)
    expect(await readAmendments(project.dir, suspended)).toHaveLength(1)
    expect(resumed.status).toBe('running')
    expect(resumed.cycle).toBe(suspended.cycle)
    expect(resumed.current.stage).toBe(suspended.current.stage)
    // The raised ceiling is what the next action is measured against.
    await expect(rosterSet(project.dir, nextRoster())).resolves.toMatchObject({
      path: expect.stringContaining('roster.json'),
    })
  })

  it.each([
    { field: 'max_dispatches' as const, from: 2, to: 1, why: 'a decrease' },
    { field: 'max_dispatches' as const, from: 3, to: 5, why: 'a stale current ceiling' },
  ])('refuses $why', async ({ field, from, to }) => {
    await seedBudget(project.dir, { max_dispatches: 2 })
    await seedUsed(project.dir, 2)
    await expect(rosterSet(project.dir, nextRoster())).rejects.toBeInstanceOf(QualityBudgetExhaustedError)
    const suspended = await new StateStore(project.dir).get()

    await expect(
      amendQualityBudget(
        project.dir,
        { run: suspended.run_id ?? '', field, from, to, reason: 'raise it', decided_by: 'operator' },
        clock,
      ),
    ).rejects.toThrow()

    expect(await readAmendments(project.dir, suspended)).toHaveLength(0)
    expect((await new StateStore(project.dir).get()).status).toBe('budget_exhausted')
  })
})
