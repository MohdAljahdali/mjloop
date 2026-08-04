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
  recordQualityEvidenceBatch,
} from '../../src/ops/quality-ledger.js'
import type { QualityLedger, QualityPolicy } from '../../src/schemas/quality.js'
import { initialState, type State } from '../../src/schemas/state.js'
import { worktreeDigest } from '../../src/store/git.js'
import { verifyFingerprint } from '../../src/ops/fingerprint.js'
import { readLedger, writeLedger } from '../../src/store/quality-store.js'
import { cycleDirPath } from '../../src/ops/run.js'
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
    worktree_digest: null,
    recorded_cycle: 1,
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
      ui: { ...entry, applicability: 'not_applicable', status: 'not_applicable', required_evidence: [], evidence_refs: [], checked_at: null, recorded_cycle: null },
    },
    cycle: 1,
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

beforeEach(async () => {
  project = await makeTmpProject()
  await writeCurrentState(state)
})
afterEach(async () => { await project.cleanup() })

describe('closing evidence', () => {
  it.each(['correctness', 'security', 'alignment', 'regression'] as const)('refuses close when %s is not passing', (dimension) => {
    const ledger = passingLedger()
    ledger.dimensions[dimension].status = 'pending'
    expect(() => assertQualityCloseable(policy(), ledger, 1)).toThrow(dimension)
  })

  it('refuses close for blocked, stale, contradicted, or missing evidence', () => {
    const blocked = passingLedger()
    blocked.dimensions.security.status = 'blocked'
    expect(() => assertQualityCloseable(policy(), blocked, 1)).toThrow('security')

    const stale = passingLedger()
    stale.dimensions.regression.invalidated_at = AT
    expect(() => assertQualityCloseable(policy(), stale, 1)).toThrow('regression')

    const contradicted = passingLedger()
    contradicted.dimensions.correctness.status = 'fail'
    expect(() => assertQualityCloseable(policy(), contradicted, 1)).toThrow('correctness')

    const missing = passingLedger()
    missing.dimensions.alignment.evidence_refs = []
    expect(() => assertQualityCloseable(policy(), missing, 1)).toThrow('alignment')
  })

  it('refuses null-worktree evidence recorded in an older ledger cycle', () => {
    const ledger = passingLedger()
    ledger.cycle = 2
    expect(() => assertQualityCloseable(policy(), ledger, 2)).toThrow('correctness')
  })
})

describe('one transition per dispatch', () => {
  it('stamps every dimension of one answer against the same tree sample', async () => {
    await makeRepo()
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('correctness-tool.log', 'test', 0)
    await writeVerifyReceipt('security-tool.log', 'lint', 0, 'npm run lint')
    const digest = await worktreeDigest(project.dir)

    const { ledger, rejected } = await recordQualityEvidenceBatch(project.dir, state, [
      { ...evidence('correctness', 'pass', ['test'], digest) },
      { ...evidence('security', 'pass', ['command'], digest) },
    ], clock)

    expect(rejected).toEqual([])
    expect(ledger.dimensions.correctness).toMatchObject({ status: 'pass', worktree_digest: digest })
    expect(ledger.dimensions.security).toMatchObject({ status: 'pass', worktree_digest: digest })
  })

  it('rejects only the dimension whose receipt it will not stand behind', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('correctness-tool.log', 'test', 0)

    const { ledger, rejected } = await recordQualityEvidenceBatch(project.dir, state, [
      { ...evidence('correctness', 'pass', ['test']) },
      { ...evidence('security', 'pass', ['command']), evidenceRefs: ['cycle-01/verify/never-ran.log'] },
    ], clock)

    expect(rejected.map((entry) => entry.dimension)).toEqual(['security'])
    expect(ledger.dimensions.correctness.status).toBe('pass')
    expect(ledger.dimensions.security).toMatchObject({ status: 'pending', evidence_refs: [] })
  })

  it('refuses the whole batch for a dimension the pinned plan marked not applicable', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('correctness-tool.log', 'test', 0)

    await expect(recordQualityEvidenceBatch(project.dir, state, [
      { ...evidence('correctness', 'pass', ['test']) },
      { ...evidence('correctness', 'pass', ['test']), dimension: 'ui' as never },
    ], clock)).rejects.toThrow(/not applicable/i)
    expect((await readLedger(project.dir, state)).dimensions.correctness.status).toBe('pending')
  })
})

describe('engine-owned evidence transitions', () => {
  it('keeps unrelated database evidence when only a UI file changes', async () => {
    await writeLedger(project.dir, state, passingLedger())
    const next = await invalidateQualityEvidence(project.dir, state, { files: ['src/Button.vue'], criteriaChanged: false }, clock)
    expect(next.dimensions.security.status).toBe('pass')
    expect(next.dimensions.ui).toMatchObject({ applicability: 'required', status: 'pending', evidence_refs: [] })
    expect(next.dimensions.ui.invalidated_at).toBe(AT)
    expect(next.dimensions.alignment.status).toBe('pending')
  })

  it('records a blocked tool as blocked instead of allowing a pass', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeAgentReceipt('security.json', 'blocked')
    const next = await recordQualityEvidence(project.dir, state, evidence('security', 'blocked', ['agent'], null, ['cycle-01/security.json']), clock)
    expect(next.dimensions.security).toMatchObject({ status: 'blocked', evidence_refs: ['cycle-01/security.json'], checked_at: AT })
    expect(() => assertQualityCloseable(policy(), withRequiredUi(next), 1)).toThrow('security')
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
    await writeVerifyReceipt('correctness-tool.log', 'test', 0)
    const before = await worktreeDigest(project.dir)
    await fs.writeFile(path.join(project.dir, 'src', 'work.ts'), 'export const work = 2\n', 'utf8')

    const next = await recordQualityEvidence(project.dir, state, evidence('correctness', 'pass', ['test'], before), clock)
    expect(next.dimensions.correctness).toMatchObject({ status: 'pending', evidence_refs: [], checked_at: null, invalidated_at: AT })
    expect(next.dimensions.correctness.reason).toMatch(/stale/i)
  })

  it('does not let an agent pass override failed command evidence', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('security-tool.log', 'lint', 1)
    await recordQualityEvidence(project.dir, state, evidence('security', 'fail', ['command']), clock)
    await writeAgentReceipt('security.json', 'pass', [{ kind: 'command', ref: 'npm test', excerpt: 'claimed pass' }])

    await expect(recordQualityEvidence(project.dir, state, evidence('security', 'pass', ['agent'], null, ['cycle-01/security.json']), clock)).rejects.toThrow(/contradicts/i)
    expect((await readLedger(project.dir, state)).dimensions.security.status).toBe('fail')
  })

  it('does not reuse a null-worktree fingerprint across cycles', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('correctness-tool.log', 'test', 0)
    const first = await recordQualityEvidence(project.dir, state, evidence('correctness', 'pass', ['test']), clock)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    expect((await readLedger(project.dir, state)).dimensions.correctness.inputs_fingerprint).toBe(first.dimensions.correctness.inputs_fingerprint)
    expect(() => assertQualityCloseable(policy(), first, nextState.cycle)).toThrow('correctness')
  })

  it('uses canonical evidence inputs so ordering cannot change a fingerprint', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('a.log', 'test', 0, 'npm test:a')
    await writeVerifyReceipt('b.log', 'test', 0, 'npm test:b')
    const first = await recordQualityEvidence(project.dir, state, {
      ...evidence('correctness', 'pass', ['test']), criteria: ['B', 'A'], changedFiles: ['src/b.ts', 'src/a.ts'], evidenceRefs: ['cycle-01/verify/b.log', 'cycle-01/verify/a.log'],
    }, clock)
    const second = await recordQualityEvidence(project.dir, state, {
      ...evidence('correctness', 'pass', ['test']), criteria: ['A', 'B'], changedFiles: ['src/a.ts', 'src/b.ts'], evidenceRefs: ['cycle-01/verify/a.log', 'cycle-01/verify/b.log'],
    }, clock)
    expect(second.dimensions.correctness.inputs_fingerprint).toBe(first.dimensions.correctness.inputs_fingerprint)
  })

  it('rejects a bogus verify reference instead of accepting a caller-claimed test kind', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await expect(recordQualityEvidence(project.dir, state, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-01/verify/forged.log'], reason: 'forged',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)).rejects.toThrow(/verify receipt/i)
  })

  it('accepts only a completed engine verify receipt for a passing test', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0)
    const next = await recordQualityEvidence(project.dir, state, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-01/verify/test.log'], reason: 'tests passed',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)
    expect(next.dimensions.correctness.status).toBe('pass')
  })

  it('maps a validated agent result to agent provenance plus its engine test receipt', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0)
    await writeAgentReceipt('verifier.json', 'pass', [
      { kind: 'test', ref: 'npm test', excerpt: 'passed' },
      { kind: 'file', ref: 'src/work.ts', excerpt: 'trace only' },
    ])
    const next = await recordQualityEvidence(project.dir, state, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-01/verifier.json'], reason: 'verified',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)
    expect(next.dimensions.correctness.evidence_refs).toEqual(['cycle-01/verifier.json', 'cycle-01/verify/test.log'])
  })

  it('rejects an agent command claim whose engine receipt is a test', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0)
    await writeAgentReceipt('verifier.json', 'pass', [{ kind: 'command', ref: 'npm test', excerpt: 'wrong kind' }])
    await expect(recordQualityEvidence(project.dir, state, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-01/verifier.json'], reason: 'forged kind',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)).rejects.toThrow(/wrong kind/i)
  })

  it('closes unattended UI evidence through a validated agent receipt, not a human claim', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await invalidateQualityEvidence(project.dir, state, { files: ['src/Button.vue'], criteriaChanged: false }, clock)
    await writeAgentReceipt('ui-review.json', 'pass')
    const next = await recordQualityEvidence(project.dir, state, {
      dimension: 'ui', verdict: 'pass', evidenceRefs: ['cycle-01/ui-review.json'], reason: 'UI review passed',
      criteria: ['Acceptance A1'], changedFiles: ['src/Button.vue'], worktree: null,
    }, clock)
    expect(next.dimensions.ui).toMatchObject({ status: 'pass', required_evidence: ['agent'], evidence_refs: ['cycle-01/ui-review.json'] })
  })

  it('does not let a validated agent receipt satisfy an operator-only human requirement', async () => {
    const ledger = pendingLedger()
    ledger.dimensions.ui = { ...ledger.dimensions.ui, applicability: 'required', status: 'pending', required_evidence: ['human'], reason: 'operator decision required' }
    await writeLedger(project.dir, state, ledger)
    await writeAgentReceipt('ui-review.json', 'pass')
    const next = await recordQualityEvidence(project.dir, state, {
      dimension: 'ui', verdict: 'pass', evidenceRefs: ['cycle-01/ui-review.json'], reason: 'agent review',
      criteria: ['Acceptance A1'], changedFiles: ['src/Button.vue'], worktree: null,
    }, clock)
    expect(next.dimensions.ui.status).toBe('pending')
    expect(next.dimensions.ui.reason).toMatch(/human/i)
  })

  it('rejects a prior green verify log after the command has a later failure', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('old.log', 'test', 0)
    await writeVerifyReceipt('new.log', 'test', 1)
    await expect(recordQualityEvidence(project.dir, state, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-01/verify/old.log'], reason: 'stale green',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)).rejects.toThrow(/superseded/i)
  })

  it('keeps an explicitly re-recorded null-digest prior-cycle receipt stale', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    const next = await recordQualityEvidence(project.dir, nextState, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-01/verify/test.log'], reason: 'old receipt',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)
    expect(next.dimensions.correctness.recorded_cycle).toBe(1)
    expect(() => assertQualityCloseable(policy(), next, nextState.cycle)).toThrow(/correctness.*stale/i)
  })

  it('accepts an authentic cached verify receipt without nesting its run-relative log', async () => {
    await makeRepo()
    await writeLedger(project.dir, state, pendingLedger())
    const digest = await worktreeDigest(project.dir)
    expect(digest).not.toBeNull()
    const fingerprint = verifyFingerprint('npm test', digest!)
    await writeVerifyReceipt('test.log', 'test', 0, 'npm test', 1, null, fingerprint)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    await writeVerifyReceipt('cycle-01/verify/test.log', 'test', 0, 'npm test', 2, 1, fingerprint)
    const next = await recordQualityEvidence(project.dir, nextState, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-02/verify/cycle-01/verify/test.log'], reason: 'cached receipt',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: digest,
    }, clock)
    expect(next.dimensions.correctness).toMatchObject({ recorded_cycle: 2, evidence_refs: ['cycle-01/verify/test.log'] })
  })

  it('rejects an older canonical log that lacks cache provenance', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    await writeVerifyReceipt('cycle-01/verify/test.log', 'test', 0, 'npm test', 2)
    await expect(recordQualityEvidence(project.dir, nextState, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-02/verify/cycle-01/verify/test.log'], reason: 'forged cache',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)).rejects.toThrow(/cache provenance/i)
  })

  it('rejects ambiguous agent command evidence across test, lint, and build slots', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0, 'npm shared')
    await writeVerifyReceipt('lint.log', 'lint', 1, 'npm shared')
    await writeVerifyReceipt('build.log', 'build', 0, 'npm shared')
    await writeAgentReceipt('reviewer.json', 'pass', [{ kind: 'command', ref: 'npm shared', excerpt: 'ambiguous' }])
    await expect(recordQualityEvidence(project.dir, state, {
      dimension: 'alignment', verdict: 'pass', evidenceRefs: ['cycle-01/reviewer.json'], reason: 'ambiguous command',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)).rejects.toThrow(/ambiguous/i)
  })

  it('uses an agent canonical verify ref to preserve its exact lint slot', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0, 'npm shared')
    await writeVerifyReceipt('lint.log', 'lint', 0, 'npm shared')
    await writeVerifyReceipt('build.log', 'build', 1, 'npm shared')
    await writeAgentReceipt('reviewer.json', 'pass', [{ kind: 'command', ref: 'cycle-01/verify/lint.log', excerpt: 'exact slot' }])
    const next = await recordQualityEvidence(project.dir, state, {
      dimension: 'alignment', verdict: 'pass', evidenceRefs: ['cycle-01/reviewer.json'], reason: 'exact command',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)
    expect(next.dimensions.alignment.evidence_refs).toEqual(['cycle-01/reviewer.json', 'cycle-01/verify/lint.log'])
  })

  it('rejects a shared cached canonical ref before another slot can mask a later failure', async () => {
    await makeRepo()
    await writeLedger(project.dir, state, pendingLedger())
    const digest = await worktreeDigest(project.dir)
    expect(digest).not.toBeNull()
    const fingerprint = verifyFingerprint('npm shared', digest!)
    await writeVerifyReceipt('shared.log', 'test', 0, 'npm shared', 1, null, fingerprint)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    await writeVerifyReceipt('cycle-01/verify/shared.log', 'test', 0, 'npm shared', 2, 1, fingerprint)
    await writeVerifyReceipt('cycle-01/verify/shared.log', 'lint', 0, 'npm shared', 2, 1, fingerprint)
    await writeVerifyReceipt('cycle-01/verify/shared.log', 'build', 0, 'npm shared', 2, 1, fingerprint)
    await writeVerifyReceipt('lint-failed.log', 'lint', 1, 'npm shared', 2, null, fingerprint)
    await writeAgentReceipt('reviewer.json', 'pass', [
      { kind: 'command', ref: 'cycle-01/verify/shared.log', excerpt: 'cached pass' },
    ], 2)

    await expect(recordQualityEvidence(project.dir, nextState, {
      dimension: 'alignment', verdict: 'pass', evidenceRefs: ['cycle-02/reviewer.json'], reason: 'shared cached receipt',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: digest,
    }, clock)).rejects.toThrow(/ambiguous/i)
    expect((await readLedger(project.dir, nextState)).dimensions.alignment.status).toBe('pending')
  })

  it('rejects cached reuse when the current worktree cannot be digested', async () => {
    await writeLedger(project.dir, state, pendingLedger())
    await writeVerifyReceipt('test.log', 'test', 0)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    await writeVerifyReceipt('cycle-01/verify/test.log', 'test', 0, 'npm test', 2, 1)
    await expect(recordQualityEvidence(project.dir, nextState, {
      dimension: 'correctness', verdict: 'pass', evidenceRefs: ['cycle-02/verify/cycle-01/verify/test.log'], reason: 'cache no tree',
      criteria: ['Acceptance A1'], changedFiles: ['src/work.ts'], worktree: null,
    }, clock)).rejects.toThrow(/requires a current worktree digest/i)
  })

  it('rejects old null-digest evidence after state advances without publishing a ledger side file', async () => {
    const ledger = passingLedger()
    await writeLedger(project.dir, state, ledger)
    const nextState = { ...state, cycle: 2 }
    await writeCurrentState(nextState)
    expect(await readLedger(project.dir, state)).toEqual(ledger)
    expect(() => assertQualityCloseable(policy(), ledger, nextState.cycle)).toThrow(/correctness.*stale/i)
  })
})

async function writeCurrentState(value: State): Promise<void> {
  const file = path.join(project.dir, '.mjloop', 'state.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

async function writeVerifyReceipt(
  log: string,
  slot: 'test' | 'lint' | 'build',
  exitCode: number,
  command = 'npm test',
  cycle = state.cycle,
  cachedFrom: number | null = null,
  fingerprint = 'a'.repeat(64),
): Promise<void> {
  const receiptState = { ...state, cycle }
  const dir = path.join(cycleDirPath(project.dir, receiptState), 'verify')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'index.json')
  const entries: unknown[] = await fs.readFile(file, 'utf8').then((raw) => JSON.parse(raw) as unknown[]).catch(() => [])
  entries.push({
    slot, command, source: 'pinned', live_command: null, log, phase: 'complete', exit_code: exitCode,
    timed_out: false, fingerprint, cached_from_cycle: cachedFrom, duration_ms: 1, at: AT,
  })
  await fs.writeFile(file, `${JSON.stringify(entries)}\n`, 'utf8')
  const canonicalLog = log.match(/^cycle-(\d{2})\/verify\/([A-Za-z0-9_.-]+)$/)
  const logDir = canonicalLog === null ? dir : path.join(cycleDirPath(project.dir, { ...state, cycle: Number(canonicalLog[1]) }), 'verify')
  await fs.mkdir(logDir, { recursive: true })
  await fs.writeFile(path.join(logDir, canonicalLog?.[2] ?? log), 'receipt\n', 'utf8')
}

async function writeAgentReceipt(
  file: string,
  status: 'pass' | 'fail' | 'blocked',
  evidence: Array<{ kind: 'command' | 'test' | 'file'; ref: string; excerpt: string }> = [],
  cycle = state.cycle,
): Promise<void> {
  const dir = cycleDirPath(project.dir, { ...state, cycle })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, file), `${JSON.stringify({
    status, summary: `agent ${status}`, evidence, findings: [], files_touched: [], next_hint: null, skills_used: [],
  })}\n`, 'utf8')
}

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
  return { ...ledger, dimensions: { ...ledger.dimensions, ui: { ...ledger.dimensions.ui, applicability: 'required', status: 'pass', required_evidence: ['agent'], evidence_refs: ['cycle-01/ui.json'], checked_at: AT, recorded_cycle: 1 } } }
}

function evidence(
  dimension: 'correctness' | 'security',
  verdict: 'pass' | 'fail' | 'blocked',
  evidenceKinds: ('command' | 'test' | 'agent' | 'human')[],
  worktree: string | null = null,
  evidenceRefs: string[] = [`cycle-01/verify/${dimension}-tool.log`],
) {
  return {
    dimension,
    verdict,
    evidenceKinds,
    evidenceRefs,
    reason: `${dimension} check ${verdict}.`,
    criteria: ['Acceptance A1'],
    changedFiles: ['src/work.ts'],
    worktree,
  }
}
