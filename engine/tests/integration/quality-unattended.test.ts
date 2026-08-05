import { afterEach, describe, expect, it } from 'vitest'

// No injected gate, for the reason `quality-modes.test.ts` states: the decision
// door is reached through the real `qualityRuntimeEnabled`.
import {
  DestructiveApprovalRequiredError,
  classifyDestructiveResult,
  classifyDestructiveTool,
  guardDestructiveOperation,
  operationFingerprint,
  readDestructiveRequests,
  type DestructiveCandidate,
} from '../../src/ops/destructive-risk.js'
import { runLog } from '../../src/ops/log.js'
import { QualityDecisionRefusedError, decideDestructiveRequest, qualityStateSummary } from '../../src/ops/quality-control.js'
import { StateStore } from '../../src/store/state-store.js'
import { mediumBackendScenario } from '../fixtures/quality/scenarios.js'
import {
  builderPass,
  declareRoster,
  openQualityScenario,
  type ScenarioHandle,
} from '../helpers/quality-scenario.js'
import type { TmpProject } from '../helpers/tmp-project.js'

const opened: TmpProject[] = []
afterEach(async () => {
  for (const project of opened.splice(0)) await project.cleanup()
})

async function scenario(supervision: 'supervised' | 'unattended'): Promise<ScenarioHandle> {
  const handle = await openQualityScenario({ mode: 'strict', supervision, scenario: mediumBackendScenario() })
  opened.push(handle.project)
  await declareRoster(handle)
  return handle
}

/** The operation under decision, read from the tool call an agent would have made. */
function dropUsers(): DestructiveCandidate {
  const candidate = classifyDestructiveTool({ tool_name: 'Bash', tool_input: { command: 'psql -c "DROP TABLE users"' } })
  if (candidate === null) throw new Error('the fixture command is not classified as destructive')
  return candidate
}

const state = async (handle: ScenarioHandle) => new StateStore(handle.dir, handle.clock).get()

describe('the operator decision door', () => {
  it('suspends a supervised run on a protected operation and resumes it on one approval', async () => {
    const handle = await scenario('supervised')
    const candidate = dropUsers()

    const blocked = await guardDestructiveOperation(handle.dir, handle.state, candidate, handle.clock)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toMatch(/waiting for a human decision \(table_drop\)/)

    const waiting = await state(handle)
    expect(waiting.status).toBe('waiting_for_user')
    // The stage is untouched: a decision resumes the run where it stopped.
    expect(waiting.current.stage).toBe(handle.state.current.stage)

    const summary = await qualityStateSummary(handle.dir, waiting)
    expect(summary?.supervision).toBe('supervised')
    expect(summary?.waiting?.kind).toBe('decision')

    const fingerprint = operationFingerprint(waiting.run_id as string, candidate)
    const resumed = await decideDestructiveRequest(handle.dir, {
      run: waiting.run_id as string,
      fingerprint,
      decision: 'approve',
      note: 'the table is a leftover from the old importer',
      decided_by: 'operator',
    }, handle.clock)
    expect(resumed.status).toBe('running')
    expect(resumed.halt_reason).toBeNull()

    const allowed = await guardDestructiveOperation(handle.dir, resumed, candidate, handle.clock)
    expect(allowed.allowed).toBe(true)
  })

  it('spends an approval exactly once', async () => {
    const handle = await scenario('supervised')
    const candidate = dropUsers()
    await guardDestructiveOperation(handle.dir, handle.state, candidate, handle.clock)

    const waiting = await state(handle)
    const fingerprint = operationFingerprint(waiting.run_id as string, candidate)
    const resumed = await decideDestructiveRequest(handle.dir, {
      run: waiting.run_id as string,
      fingerprint,
      decision: 'approve',
      note: null,
      decided_by: 'operator',
    }, handle.clock)

    expect((await guardDestructiveOperation(handle.dir, resumed, candidate, handle.clock)).allowed).toBe(true)
    // The same operation proposed again is a second decision, not a second use
    // of the first one.
    const again = await guardDestructiveOperation(handle.dir, await state(handle), candidate, handle.clock)
    expect(again.allowed).toBe(false)
    expect((await state(handle)).status).toBe('waiting_for_user')

    // Append-only: the original proposal, the approval that answered it (now
    // spent), and the fresh proposal that approval does not cover.
    const record = await readDestructiveRequests(handle.dir, await state(handle))
    expect(record.requests.map((request) => request.status)).toEqual(['pending', 'used', 'pending'])
  })

  it('buys nothing with an approval once a single target has moved', async () => {
    const handle = await scenario('supervised')
    const approved = dropUsers()
    await guardDestructiveOperation(handle.dir, handle.state, approved, handle.clock)
    const waiting = await state(handle)
    const resumed = await decideDestructiveRequest(handle.dir, {
      run: waiting.run_id as string,
      fingerprint: operationFingerprint(waiting.run_id as string, approved),
      decision: 'approve',
      note: null,
      decided_by: 'operator',
    }, handle.clock)

    const wider = classifyDestructiveTool({
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "DROP TABLE users, orders"' },
    })
    expect((await guardDestructiveOperation(handle.dir, resumed, wider as DestructiveCandidate, handle.clock)).allowed).toBe(false)
  })

  it('resumes on a rejection when nothing had run yet', async () => {
    const handle = await scenario('supervised')
    const candidate = dropUsers()
    await guardDestructiveOperation(handle.dir, handle.state, candidate, handle.clock)
    const waiting = await state(handle)

    const resumed = await decideDestructiveRequest(handle.dir, {
      run: waiting.run_id as string,
      fingerprint: operationFingerprint(waiting.run_id as string, candidate),
      decision: 'reject',
      note: 'find a non-destructive alternative',
      decided_by: 'operator',
    }, handle.clock)
    expect(resumed.status).toBe('running')
    expect(resumed.halt_reason).toBeNull()
  })

  it('holds the run on a rejection whose edits had already landed', async () => {
    const handle = await scenario('supervised')
    const candidate = dropUsers()
    await guardDestructiveOperation(handle.dir, handle.state, candidate, handle.clock, { applied: true })
    const waiting = await state(handle)

    const held = await decideDestructiveRequest(handle.dir, {
      run: waiting.run_id as string,
      fingerprint: operationFingerprint(waiting.run_id as string, candidate),
      decision: 'reject',
      note: null,
      decided_by: 'operator',
    }, handle.clock)
    expect(held.status).toBe('waiting_for_user')
    expect(held.halt_reason).toMatch(/stays suspended until the executor reverts them/)
  })

  it('refuses a decision that names an operation this run is not waiting on', async () => {
    const handle = await scenario('supervised')
    await guardDestructiveOperation(handle.dir, handle.state, dropUsers(), handle.clock)
    const waiting = await state(handle)

    await expect(decideDestructiveRequest(handle.dir, {
      run: waiting.run_id as string,
      fingerprint: 'f'.repeat(64),
      decision: 'approve',
      note: null,
      decided_by: 'operator',
    }, handle.clock)).rejects.toThrow(QualityDecisionRefusedError)
  })
})

describe('an unattended run', () => {
  it('suspends on a protected operation and stays suspended with nobody to answer', async () => {
    const handle = await scenario('unattended')
    const blocked = await guardDestructiveOperation(handle.dir, handle.state, dropUsers(), handle.clock)
    expect(blocked.allowed).toBe(false)

    const waiting = await state(handle)
    expect(waiting.status).toBe('waiting_for_user')

    const summary = await qualityStateSummary(handle.dir, waiting)
    expect(summary?.supervision).toBe('unattended')
    expect(summary?.waiting).toEqual({ kind: 'decision', reason: waiting.halt_reason })

    // Retried while it waits, the same operation is still refused and appends
    // no second request: an unattended run is never waved through.
    expect((await guardDestructiveOperation(handle.dir, waiting, dropUsers(), handle.clock)).allowed).toBe(false)
    expect((await readDestructiveRequests(handle.dir, waiting)).requests).toHaveLength(1)
    expect((await state(handle)).status).toBe('waiting_for_user')
  })

  it('refuses a logged result that removed a feature', async () => {
    const handle = await scenario('unattended')
    const deleted = ['src/billing/index.ts', 'src/billing/api/create.ts', 'src/billing/ui/Panel.tsx']
    expect(classifyDestructiveResult({ goal: handle.state.goal ?? '', deletedFiles: deleted, summary: 'gone' })).not.toBeNull()

    await expect(runLog(handle.dir, {
      agent: 'builder',
      result: { ...(builderPass() as object), files_touched: deleted },
    }, handle.clock)).rejects.toThrow(DestructiveApprovalRequiredError)

    expect((await state(handle)).status).toBe('waiting_for_user')
  })
})
