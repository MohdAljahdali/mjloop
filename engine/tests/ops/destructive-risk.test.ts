import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ops/quality-capability.js', () => ({ qualityRuntimeEnabled: vi.fn(() => true) }))
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'

import {
  classifyDestructiveResult,
  classifyDestructiveTool,
  destructiveRequestsFile,
  guardDestructiveOperation,
  operationFingerprint,
  readDestructiveRequests,
  type DestructiveCandidate,
} from '../../src/ops/destructive-risk.js'
import { initLoop } from '../../src/ops/init.js'
import { runStart } from '../../src/ops/run.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const clock = (): Date => new Date('2026-08-04T10:00:00.000Z')

function bashInput(command: string): unknown {
  return { tool_name: 'Bash', tool_input: { command } }
}

describe('classifyDestructiveTool', () => {
  it.each([
    ['DROP TABLE users', 'table_drop'],
    ['TRUNCATE audit_log', 'table_truncate'],
    ['DELETE FROM guests', 'bulk_data_delete'],
    ['rm -rf src/billing', 'feature_delete'],
  ] as const)('classifies %s as %s', (command, kind) => {
    expect(classifyDestructiveTool(bashInput(command))?.kind).toBe(kind)
  })

  it.each([
    'DELETE FROM guests WHERE id = 7',
    'rm src/unused.test.ts',
    'rm -rf node_modules',
    'git commit -m "truncate the log helper"',
  ])(
    'does not stop bounded ordinary change %s',
    (command) => {
      expect(classifyDestructiveTool(bashInput(command))).toBeNull()
    },
  )

  // The quoting a real client always carries. Removing quoted text rather than
  // the quote characters would hide exactly the statements this guard exists for.
  it('sees a statement its database client passes as one quoted argument', () => {
    expect(classifyDestructiveTool(bashInput(`psql -c "TRUNCATE audit_log"`))?.kind).toBe('table_truncate')
  })
})

describe('classifyDestructiveResult', () => {
  it('catches a feature deleted through an agent’s own edits', () => {
    const candidate = classifyDestructiveResult({
      goal: 'Drop the billing experiment',
      deletedFiles: ['src/billing/index.ts', 'src/billing/invoice.ts', 'src/billing/tax.ts'],
      summary: 'Removed the code that is no longer reachable.',
    })
    expect(candidate?.kind).toBe('feature_delete')
    expect(candidate?.targets).toEqual(['src/billing'])
  })

  it('leaves an ordinary file deletion alone', () => {
    expect(
      classifyDestructiveResult({
        goal: 'Rename the submit label',
        deletedFiles: ['src/unused.test.ts'],
        summary: 'Dropped a test that duplicated its neighbour.',
      }),
    ).toBeNull()
  })
})

describe('operationFingerprint', () => {
  const candidate: DestructiveCandidate = {
    kind: 'table_drop',
    targets: ['users', 'orders'],
    operation: 'DROP TABLE users, orders',
    rollback: null,
  }

  it('ignores target ordering and moves with the run and the operation', () => {
    expect(operationFingerprint('run-1', { ...candidate, targets: ['orders', 'users'] })).toBe(
      operationFingerprint('run-1', candidate),
    )
    expect(operationFingerprint('run-1', { ...candidate, operation: 'DROP TABLE users, orders CASCADE' })).not.toBe(
      operationFingerprint('run-1', candidate),
    )
    expect(operationFingerprint('run-2', candidate)).not.toBe(operationFingerprint('run-1', candidate))
  })
})

describe('guardDestructiveOperation', () => {
  let project: TmpProject

  const dropUsers: DestructiveCandidate = {
    kind: 'table_drop',
    targets: ['users'],
    operation: 'DROP TABLE users',
    rollback: null,
  }

  /** Task 13 owns the operator door; a test seeds the record it will write. */
  async function seedDecision(dir: string, candidate: DestructiveCandidate, status: 'approved' | 'rejected'): Promise<void> {
    const state = await new StateStore(dir).get()
    const file = destructiveRequestsFile(dir, state)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const request = {
      run: state.run_id,
      fingerprint: operationFingerprint(state.run_id as string, candidate),
      candidate,
      status,
      requested_at: clock().toISOString(),
      decided_at: clock().toISOString(),
      decided_by: 'operator',
    }
    await fs.writeFile(file, `${JSON.stringify({ version: 1, requests: [request] }, null, 2)}\n`, 'utf8')
  }

  beforeEach(async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    project = await makeTmpProject()
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.orchestration.quality.mode = 'economy'
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
  })
  afterEach(async () => {
    await project.cleanup()
  })

  it('suspends the run and records the exact operation waiting for a decision', async () => {
    const state = await new StateStore(project.dir).get()

    const outcome = await guardDestructiveOperation(project.dir, state, dropUsers, clock)

    expect(outcome.allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
    const { requests } = await readDestructiveRequests(project.dir, state)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      run: state.run_id,
      fingerprint: operationFingerprint(state.run_id as string, dropUsers),
      candidate: dropUsers,
      status: 'pending',
    })
  })

  it('spends an approval on exactly one attempt', async () => {
    await seedDecision(project.dir, dropUsers, 'approved')
    const state = await new StateStore(project.dir).get()

    expect((await guardDestructiveOperation(project.dir, state, dropUsers, clock)).allowed).toBe(true)
    expect((await new StateStore(project.dir).get()).status).toBe('running')

    expect((await guardDestructiveOperation(project.dir, state, dropUsers, clock)).allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
  })

  it('refuses an approval whose operation has since changed', async () => {
    await seedDecision(project.dir, dropUsers, 'approved')
    const state = await new StateStore(project.dir).get()

    const outcome = await guardDestructiveOperation(
      project.dir,
      state,
      { ...dropUsers, targets: ['users', 'orders'], operation: 'DROP TABLE users, orders' },
      clock,
    )

    expect(outcome.allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
  })

  it('leaves the run alone while the rollout gate is closed', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(false)
    const state = await new StateStore(project.dir).get()

    expect((await guardDestructiveOperation(project.dir, state, dropUsers, clock)).allowed).toBe(true)
    expect((await new StateStore(project.dir).get()).status).toBe('running')
  })
})
