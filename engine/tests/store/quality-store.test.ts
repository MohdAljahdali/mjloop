import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QualityAmendment, QualityLedger, QualityPolicy } from '../../src/schemas/quality.js'
import { initialState, type State } from '../../src/schemas/state.js'
import { StateCorruptedError } from '../../src/store/atomic.js'
import {
  QUALITY_AMENDMENTS_FILE,
  QUALITY_LEDGER_FILE,
  QUALITY_POLICY_FILE,
  QualityPolicyExistsError,
  QualityLedgerStateDriftError,
  appendAmendment,
  qualityFiles,
  readAmendments,
  readLedger,
  readPolicy,
  updateLedger,
  writeLedger,
  writePolicyOnce,
} from '../../src/store/quality-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const AT = '2026-08-04T10:36:00.000Z'
let project: TmpProject

const state: State = {
  ...initialState(new Date(AT)),
  run_id: '2026-08-04-001',
  track: 'build',
  status: 'running',
  cycle: 1,
  goal: 'Persist the quality records.',
  started_at: AT,
}

function policy(overrides: Partial<QualityPolicy> = {}): QualityPolicy {
  return {
    version: 1,
    pinned_at: AT,
    mode: 'adaptive',
    supervision: 'supervised',
    enforcement: 'active',
    source: 'explicit',
    risk: { level: 'medium', signals: [] },
    budget: {
      max_cycles: 5,
      max_dispatches: 18,
      max_context_tokens_per_dispatch: 12_000,
      max_repair_attempts: 1,
      cost_estimate: null,
    },
    initial_quality_plan: {
      correctness: { value: 'required', reason: 'The feature changes executable behavior.' },
      security: { value: 'required', reason: 'The feature crosses a service boundary.' },
      alignment: { value: 'required', reason: 'The acceptance criteria are pinned.' },
      regression: { value: 'required', reason: 'The existing verification suite applies.' },
      ui: { value: 'not_applicable', reason: 'The intended files are backend-only.' },
    },
    dispatches: [{ agent: 'verifier', instance: null, dimensions: ['correctness'], reason: 'check the acceptance criteria' }],
    ...overrides,
  }
}

function ledger(): QualityLedger {
  const pending = {
    applicability: 'required' as const,
    status: 'pending' as const,
    required_evidence: ['test'] as 'test'[],
    evidence_refs: [],
    reason: 'required by the pinned quality plan',
    inputs_fingerprint: 'a'.repeat(64),
    worktree_digest: null,
    recorded_cycle: null,
    checked_at: null,
    invalidated_at: null,
  }
  return {
    version: 1,
    cycle: 1,
    dimensions: {
      correctness: { ...pending },
      security: { ...pending },
      alignment: { ...pending },
      regression: { ...pending },
      ui: { ...pending, applicability: 'not_applicable', status: 'not_applicable', required_evidence: [] },
    },
  }
}

function amendment(to: number): QualityAmendment {
  return {
    version: 1,
    run: '2026-08-04-001',
    field: 'max_dispatches',
    from: to - 1,
    to,
    reason: 'one targeted repair',
    decided_at: AT,
    decided_by: 'operator',
  }
}

beforeEach(async () => {
  project = await makeTmpProject()
  await writeCurrentState(state)
})
afterEach(async () => { await project.cleanup() })

describe('qualityFiles', () => {
  it('puts every quality record inside the active run directory', () => {
    const files = qualityFiles(project.dir, state)
    expect(files.policy).toMatch(new RegExp(`runs/.+/${QUALITY_POLICY_FILE}$`))
    expect(files.ledger).toMatch(new RegExp(`runs/.+/${QUALITY_LEDGER_FILE}$`))
    expect(files.amendments).toMatch(new RegExp(`runs/.+/${QUALITY_AMENDMENTS_FILE}$`))
  })
})

describe('quality policy', () => {
  it('writes the policy once and refuses replacement', async () => {
    const first = policy()
    await writePolicyOnce(project.dir, state, first)

    await expect(writePolicyOnce(project.dir, state, policy({ mode: 'strict' }))).rejects.toBeInstanceOf(QualityPolicyExistsError)
    expect(await readPolicy(project.dir, state)).toEqual(first)
  })
})

describe('quality ledger', () => {
  it('recovers the previous valid ledger from its backup', async () => {
    const first = ledger()
    await writeLedger(project.dir, state, first)
    await writeLedger(project.dir, state, { ...first, dimensions: { ...first.dimensions, correctness: { ...first.dimensions.correctness, status: 'pass', checked_at: AT } } })
    await fs.writeFile(qualityFiles(project.dir, state).ledger, '{ this is not json', 'utf8')

    expect(await readLedger(project.dir, state)).toEqual(first)
  })

  it('serializes ledger read-modify-write transitions under the project lock', async () => {
    await writeLedger(project.dir, state, ledger())

    await Promise.all([
      updateLedger(project.dir, state, (draft) => { draft.dimensions.correctness.status = 'pass'; draft.dimensions.correctness.checked_at = AT }),
      updateLedger(project.dir, state, (draft) => { draft.dimensions.security.status = 'blocked'; draft.dimensions.security.checked_at = AT }),
    ])

    expect(await readLedger(project.dir, state)).toMatchObject({
      dimensions: {
        correctness: { status: 'pass', checked_at: AT },
        security: { status: 'blocked', checked_at: AT },
      },
    })
  })

  it('rejects a supplied state after the active run advances under the lock', async () => {
    await writeLedger(project.dir, state, ledger())
    await writeCurrentState({ ...state, cycle: 2 })
    await expect(updateLedger(project.dir, state, () => undefined)).rejects.toBeInstanceOf(QualityLedgerStateDriftError)
  })
})

async function writeCurrentState(value: State): Promise<void> {
  const file = path.join(project.dir, '.mjloop', 'state.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

describe('quality amendments', () => {
  it('appends validated amendments in their write order', async () => {
    const first = amendment(19)
    const second = amendment(20)
    await appendAmendment(project.dir, state, first)
    await appendAmendment(project.dir, state, second)

    expect(await readAmendments(project.dir, state)).toEqual([first, second])
  })

  it('returns no amendments before an amendment is recorded', async () => {
    await expect(readAmendments(project.dir, state)).resolves.toEqual([])
  })

  it('rejects a malformed existing line before adding another amendment', async () => {
    const file = qualityFiles(project.dir, state).amendments
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ malformed json }\n', 'utf8')

    await expect(appendAmendment(project.dir, state, amendment(19))).rejects.toBeInstanceOf(StateCorruptedError)
    expect(await fs.readFile(file, 'utf8')).toBe('{ malformed json }\n')
  })
})
