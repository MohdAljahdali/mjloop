import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import {
  destructiveRequestsFile,
  guardDestructiveOperation,
  operationFingerprint,
  readDestructiveRequests,
  type DestructiveCandidate,
} from '../../src/ops/destructive-risk.js'
import {
  QualityBudgetExhaustedError,
  QualityDecisionRefusedError,
  amendQualityBudget,
  decideDestructiveRequest,
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

/** Turn the pin into the shadow policy a run that never named a quality mode gets. */
async function seedShadowPolicy(dir: string): Promise<void> {
  const state = await new StateStore(dir).get()
  const file = policyFile(dir, state)
  const policy = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  await fs.writeFile(file, `${JSON.stringify({ ...policy, source: 'legacy', enforcement: 'shadow' }, null, 2)}\n`, 'utf8')
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

  // The three seams, each seeded at a ceiling the enforcing tests above prove
  // suspends: the roster's context packet, a targeted repair, and the next
  // cycle. Neither lever below may move the run.
  const ZERO_HEADROOM = { max_cycles: 1, max_context_tokens_per_dispatch: 1, max_repair_attempts: 0 }

  async function runEverySeam(dir: string): Promise<void> {
    await expect(rosterSet(dir, nextRoster())).resolves.toMatchObject({ path: expect.stringContaining('roster.json') })
    await expect(runLog(dir, { agent: 'verifier', instance: 'repair-1', result: PASS }, clock)).resolves.toBeTruthy()
    await expect(cycleAdvance(dir, { agents: ['editor'], result: 'fail' }, clock)).resolves.toBeTruthy()
    const state = await new StateStore(dir).get()
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(2)
  }

  it('leaves every seam alone while the rollout gate is closed', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(false)
    await seedBudget(project.dir, ZERO_HEADROOM)

    await runEverySeam(project.dir)
  })

  it('leaves a shadow policy alone even with the rollout gate open', async () => {
    await seedShadowPolicy(project.dir)
    await seedBudget(project.dir, ZERO_HEADROOM)

    await runEverySeam(project.dir)
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

describe('decideDestructiveRequest', () => {
  const dropUsers: DestructiveCandidate = {
    kind: 'table_drop',
    targets: ['users'],
    operation: 'psql -c DROP TABLE users',
    rollback: null,
  }

  /** Suspend the run the way the guard does, so a decision answers a request the engine actually wrote. */
  async function askForDecision(): Promise<{ run: string; fingerprint: string }> {
    const state = await new StateStore(project.dir).get()
    await guardDestructiveOperation(project.dir, state, dropUsers, clock)
    return { run: state.run_id as string, fingerprint: operationFingerprint(state.run_id as string, dropUsers) }
  }

  it('approves the operation the operator was shown, and resumes where the run stopped', async () => {
    const { run, fingerprint } = await askForDecision()
    const suspended = await new StateStore(project.dir).get()

    const resumed = await decideDestructiveRequest(
      project.dir,
      { run, fingerprint, decision: 'approve', note: null, decided_by: 'operator' },
      clock,
    )

    expect(resumed.status).toBe('running')
    expect(resumed.current.stage).toBe(suspended.current.stage)
    expect((await readDestructiveRequests(project.dir, resumed)).requests.at(-1)).toMatchObject({
      fingerprint,
      status: 'approved',
      decided_by: 'operator',
    })
    // The approval the operator wrote is the one the guard spends.
    expect((await guardDestructiveOperation(project.dir, resumed, dropUsers, clock)).allowed).toBe(true)
  })

  it('records a rejection and leaves the refused operation unspendable', async () => {
    const { run, fingerprint } = await askForDecision()

    const decided = await decideDestructiveRequest(
      project.dir,
      { run, fingerprint, decision: 'reject', note: 'Not this table.', decided_by: 'operator' },
      clock,
    )

    // The command was stopped at the tool boundary and never ran, so there is
    // nothing to undo and the cycle may try a non-destructive alternative.
    expect(decided.status).toBe('running')
    expect((await readDestructiveRequests(project.dir, decided)).requests.at(-1)).toMatchObject({ status: 'rejected' })
    expect((await guardDestructiveOperation(project.dir, decided, dropUsers, clock)).allowed).toBe(false)
  })

  it('holds the run suspended when the rejected deletion is already in the worktree', async () => {
    const deleted: DestructiveCandidate = {
      kind: 'feature_delete',
      targets: ['src/billing'],
      operation: 'delete 3 files under src/billing while working on: Rename the submit label',
      rollback: 'the deletions are recoverable from the worktree until this cycle is committed',
    }
    const state = await new StateStore(project.dir).get()
    await guardDestructiveOperation(project.dir, state, deleted, clock, { applied: true })

    const held = await decideDestructiveRequest(
      project.dir,
      {
        run: state.run_id as string,
        fingerprint: operationFingerprint(state.run_id as string, deleted),
        decision: 'reject',
        note: null,
        decided_by: 'operator',
      },
      clock,
    )

    // Recorded, and still suspended: reverting the edits is the executor's work
    // and the engine never claims to have done it.
    expect((await readDestructiveRequests(project.dir, held)).requests.at(-1)).toMatchObject({ status: 'rejected' })
    expect(held.status).toBe('waiting_for_user')
    expect(held.halt_reason).toContain('new worktree fingerprint')
  })

  it('reads a record written before `applied` existed as the worse case', async () => {
    // Over-suspending costs an operator one more step. The other default would
    // resume a run whose destructive action had already happened, which is the
    // one mistake this gate exists to make impossible.
    const state = await new StateStore(project.dir).get()
    const run = state.run_id as string
    const fingerprint = operationFingerprint(run, dropUsers)
    const legacy = {
      version: 1,
      requests: [{
        run,
        fingerprint,
        candidate: dropUsers,
        status: 'pending',
        requested_at: NOW.toISOString(),
        decided_at: null,
        decided_by: null,
      }],
    }
    await fs.writeFile(destructiveRequestsFile(project.dir, state), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
    await new StateStore(project.dir, clock).update((draft) => { draft.status = 'waiting_for_user' })

    expect((await readDestructiveRequests(project.dir, state)).requests[0]).toMatchObject({ applied: true, note: null })

    const held = await decideDestructiveRequest(
      project.dir,
      { run, fingerprint, decision: 'reject', note: null, decided_by: 'operator' },
      clock,
    )
    expect(held.status).toBe('waiting_for_user')
  })

  it.each([
    { why: 'an operation nobody is waiting on', patch: { fingerprint: 'f'.repeat(64) } },
    { why: 'a run that is not the current one', patch: { run: '2026-01-01-001' } },
  ])('refuses $why and changes nothing', async ({ patch }) => {
    const { run, fingerprint } = await askForDecision()
    const before = await new StateStore(project.dir).get()

    await expect(
      decideDestructiveRequest(
        project.dir,
        { run, fingerprint, decision: 'approve', note: null, decided_by: 'operator', ...patch },
        clock,
      ),
    ).rejects.toBeInstanceOf(QualityDecisionRefusedError)

    expect(await new StateStore(project.dir).get()).toEqual(before)
    expect((await readDestructiveRequests(project.dir, before)).requests).toHaveLength(1)
  })
})
