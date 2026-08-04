import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertQualityCloseable,
  invalidateQualityEvidence,
  recordQualityEvidence,
} from '../../src/ops/quality-ledger.js'
import type { QualityLedger, QualityPolicy } from '../../src/schemas/quality.js'
import { initialState, type State } from '../../src/schemas/state.js'
import { worktreeDigest } from '../../src/store/git.js'
import { readLedger, writeLedger } from '../../src/store/quality-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const run = promisify(execFile)
const AT = '2026-08-04T10:36:00.000Z'
const clock = (): Date => new Date(AT)
let project: TmpProject

const state: State = {
  ...initialState(new Date(AT)),
  run_id: '2026-08-04-001',
  track: 'build',
  status: 'running',
  cycle: 1,
  goal: 'Keep the quality evidence current.',
  started_at: AT,
}

function policy(): QualityPolicy {
  return {
    version: 1,
    pinned_at: AT,
    mode: 'adaptive',
    supervision: 'supervised',
    enforcement: 'active',
    source: 'explicit',
    risk: { level: 'medium', signals: [] },
    budget: { max_cycles: 5, max_dispatches: 18, max_context_tokens_per_dispatch: 12_000, max_repair_attempts: 1, cost_estimate: null },
    initial_quality_plan: {
      correctness: { value: 'required', reason: 'Executable behavior changed.' },
      security: { value: 'required', reason: 'Every run requires a security check.' },
      alignment: { value: 'required', reason: 'Acceptance criteria are pinned.' },
      regression: { value: 'required', reason: 'Regression coverage is required.' },
      ui: { value: 'not_applicable', reason: 'The initial scope is not user visible.' },
    },
    dispatches: [],
  }
}

function passingLedger(): QualityLedger {
  const entry = {
    applicability: 'required' as const,
    status: 'pass' as const,
    required_evidence: ['test'] as ('command' | 'test' | 'agent' | 'human')[],
    evidence_refs: ['cycle-01/verify.json'],
    reason: 'The required check passed.',
    inputs_fingerprint: 'a'.repeat(64),
    checked_at: AT,
    invalidated_at: null,
  }
  return {
    version: 1,
    dimensions: {
      correctness: { ...entry },
      security: { ...entry, required_evidence: ['command'] },
      alignment: { ...entry, required_evidence: ['agent'] },
      regression: { ...entry },
      ui: { ...entry, applicability: 'not_applicable', status: 'not_applicable', required_evidence: [], evidence_refs: [], checked_at: null },
    },
  }
}

async function makeRepo(): Promise<void> {
  await run('git', ['init', '-q', '-b', 'main'], { cwd: project.dir })
  const source = path.join(project.dir, 'src', 'work.ts')
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, 'export const work = 1\n', 'utf8')
  await run('git', ['add', '-A'], { cwd: project.dir })
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first'], { cwd: project.dir })
}

beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('closing evidence', () => {
  it.each(['correctness', 'security', 'alignment', 'regression'] as const)('refuses close when %s is not passing', (dimension) => {
    const ledger = passingLedger()
    ledger.dimensions[dimension].status = 'pending'
    expect(() => assertQualityCloseable(policy(), ledger)).toThrow(dimension)
  })

  it('refuses close for blocked, stale, contradicted, or missing evidence', () => {
    const blocked = passingLedger()
    blocked.dimensions.security.status = 'blocked'
    expect(() => assertQualityCloseable(policy(), blocked)).toThrow('security')

    const stale = passingLedger()
    stale.dimensions.regression.invalidated_at = AT
    expect(() => assertQualityCloseable(policy(), stale)).toThrow('regression')

    const contradicted = passingLedger()
    contradicted.dimensions.correctness.status = 'fail'
    expect(() => assertQualityCloseable(policy(), contradicted)).toThrow('correctness')

    const missing = passingLedger()
    missing.dimensions.alignment.evidence_refs = []
    expect(() => assertQualityCloseable(policy(), missing)).toThrow('alignment')
  })
})

describe('engine-owned evidence transitions', () => {
  it('keeps unrelated database evidence when only a UI file changes', async () => {
    await writeLedger(project.dir, state, passingLedger())
    const next = await invalidateQualityEvidence(project.dir, state, { files: ['src/Button.vue'], criteriaChanged: false }, clock)
    expect(next.dimensions.security.status).toBe('pass')
    expect(next.dimensions.ui).toMatchObject({ applicability: 'required', status: 'pending', evidence_refs: [] })
    expect(next.dimensions.ui.invalidated_at).toBe(AT)
  })

  it('records a blocked tool as blocked instead of allowing a pass', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    const next = await recordQualityEvidence(project.dir, state, evidence('security', 'blocked', ['command']), clock)
    expect(next.dimensions.security).toMatchObject({ status: 'blocked', evidence_refs: ['cycle-01/security-tool.log'], checked_at: AT })
    expect(() => assertQualityCloseable(policy(), withRequiredUi(next))).toThrow('security')
  })

  it('leaves a verdict pending when its evidence references are missing', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    const next = await recordQualityEvidence(project.dir, state, {
      ...evidence('correctness', 'pass', ['test']), evidenceRefs: [],
    }, clock)
    expect(next.dimensions.correctness).toMatchObject({ status: 'pending', evidence_refs: [], checked_at: null, invalidated_at: AT })
    expect(next.dimensions.correctness.reason).toMatch(/references/i)
  })

  it('rejects an agent attempt to mark a dimension not applicable', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await expect(recordQualityEvidence(project.dir, state, {
      ...evidence('correctness', 'pass', ['test']),
      verdict: 'not_applicable' as never,
    }, clock)).rejects.toThrow(/cannot set.*not_applicable/i)
    expect((await readLedger(project.dir, state)).dimensions.correctness.status).toBe('pending')
  })

  it('rejects evidence captured for a stale worktree digest', async () => {
    await makeRepo()
    await writeLedger(project.dir, state, pendingLedger())
    const before = await worktreeDigest(project.dir)
    await fs.writeFile(path.join(project.dir, 'src', 'work.ts'), 'export const work = 2\n', 'utf8')

    const next = await recordQualityEvidence(project.dir, state, evidence('correctness', 'pass', ['test'], before), clock)
    expect(next.dimensions.correctness).toMatchObject({ status: 'pending', evidence_refs: [], checked_at: null, invalidated_at: AT })
    expect(next.dimensions.correctness.reason).toMatch(/stale/i)
  })

  it('does not let an agent pass override failed command evidence', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await recordQualityEvidence(project.dir, state, evidence('security', 'fail', ['command']), clock)

    const next = await recordQualityEvidence(project.dir, state, evidence('security', 'pass', ['agent']), clock)
    expect(next.dimensions.security.status).toBe('fail')
    expect(next.dimensions.security.reason).toMatch(/command/i)
  })

  it('does not reuse a null-worktree fingerprint across cycles', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    const first = await recordQualityEvidence(project.dir, state, evidence('correctness', 'pass', ['test']), clock)
    const nextState = { ...state, cycle: 2 }
    const second = await recordQualityEvidence(project.dir, nextState, evidence('correctness', 'pass', ['test']), clock)
    expect(first.dimensions.correctness.inputs_fingerprint).not.toBe(second.dimensions.correctness.inputs_fingerprint)
  })

  it('uses canonical evidence inputs so ordering cannot change a fingerprint', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    const first = await recordQualityEvidence(project.dir, state, {
      ...evidence('correctness', 'pass', ['test']), criteria: ['B', 'A'], changedFiles: ['src/b.ts', 'src/a.ts'], evidenceRefs: ['cycle-01/b', 'cycle-01/a'],
    }, clock)
    const second = await recordQualityEvidence(project.dir, state, {
      ...evidence('correctness', 'pass', ['test']), criteria: ['A', 'B'], changedFiles: ['src/a.ts', 'src/b.ts'], evidenceRefs: ['cycle-01/a', 'cycle-01/b'],
    }, clock)
    expect(second.dimensions.correctness.inputs_fingerprint).toBe(first.dimensions.correctness.inputs_fingerprint)
  })
})

function pendingLedger(): QualityLedger {
  const ledger = passingLedger()
  for (const entry of Object.values(ledger.dimensions)) {
    if (entry.applicability === 'required') {
      entry.status = 'pending'
      entry.evidence_refs = []
      entry.checked_at = null
    }
  }
  return ledger
}

function withRequiredUi(ledger: QualityLedger): QualityLedger {
  return { ...ledger, dimensions: { ...ledger.dimensions, ui: { ...ledger.dimensions.ui, applicability: 'required', status: 'pass', required_evidence: ['human'], evidence_refs: ['cycle-01/ui.png'], checked_at: AT } } }
}

function evidence(
  dimension: 'correctness' | 'security',
  verdict: 'pass' | 'fail' | 'blocked',
  evidenceKinds: ('command' | 'test' | 'agent' | 'human')[],
  worktree: string | null = null,
) {
  return {
    dimension,
    verdict,
    evidenceKinds,
    evidenceRefs: [`cycle-01/${dimension}-tool.log`],
    reason: `${dimension} check ${verdict}.`,
    criteria: ['Acceptance A1'],
    changedFiles: ['src/work.ts'],
    worktree,
  }
}
