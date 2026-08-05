import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentResultSchema } from '../schemas/contract.js'
import type { QualityEvidenceKind, QualityVerdict } from '../schemas/quality.js'
import type { LedgerEntry } from '../schemas/verify.js'
import type { State } from '../schemas/state.js'
import { cycleDirPath } from './run.js'
import { readVerifyLedger } from './verify.js'
import { verifyFingerprint } from './fingerprint.js'

export interface QualityEvidenceReceipt {
  kind: Exclude<QualityEvidenceKind, 'human'>
  ref: string
  cycle: number
}

export interface ResolvedQualityEvidence {
  receipts: QualityEvidenceReceipt[]
  /** Validated agent file evidence is traceability only, never a ledger kind. */
  traceabilityRefs: string[]
  recordedCycle: number
}

export class QualityEvidenceReceiptError extends Error {
  constructor(message: string) {
    super(`quality evidence receipt rejected: ${message}`)
    this.name = 'QualityEvidenceReceiptError'
  }
}

/**
 * Resolves stable, run-relative receipt names into their engine-proven kind.
 * Callers never supply a kind: command/test come only from verify/index.json,
 * agent from a stored AgentResult, and human is deliberately absent because
 * only an operator-decision receipt may introduce it in a later operation.
 */
export async function resolveQualityEvidenceReceipts(
  projectDir: string,
  state: State,
  verdict: Exclude<QualityVerdict, 'not_applicable'>,
  refs: string[],
  worktree: string | null,
): Promise<ResolvedQualityEvidence> {
  const receipts: QualityEvidenceReceipt[] = []
  const traceabilityRefs: string[] = []
  for (const ref of refs) {
    const verify = normaliseVerifyRef(ref)
    if (verify !== null) {
      const receipt = await verifyReceipt(projectDir, state, verify, worktree)
      assertOutcome(receipt.entry, verdict, receipt.ref)
      receipts.push({ kind: receipt.entry.slot === 'test' ? 'test' : 'command', ref: receipt.ref, cycle: receipt.cycle })
      continue
    }

    const agent = parseAgentRef(ref)
    if (agent !== null) {
      const resolved = await agentReceipt(projectDir, state, agent.cycle, agent.file, verdict, ref, worktree)
      receipts.push(...resolved.receipts)
      traceabilityRefs.push(...resolved.traceabilityRefs)
      continue
    }
    throw new QualityEvidenceReceiptError(`"${ref}" is not an engine receipt in this run`)
  }
  const distinct = distinctReceipts(receipts)
  return { receipts: distinct, traceabilityRefs: [...new Set(traceabilityRefs)].sort(), recordedCycle: Math.min(...distinct.map((receipt) => receipt.cycle)) }
}

async function agentReceipt(
  projectDir: string,
  state: State,
  cycle: number,
  file: string,
  verdict: Exclude<QualityVerdict, 'not_applicable'>,
  ref: string,
  worktree: string | null,
): Promise<ResolvedQualityEvidence> {
  assertCycle(state, cycle, ref)
  const raw = await fs.readFile(path.join(cycleDirPath(projectDir, state, cycle), file), 'utf8').catch(() => null)
  if (raw === null) throw new QualityEvidenceReceiptError(`agent receipt "${ref}" does not exist`)
  let rawValue: unknown
  try {
    rawValue = JSON.parse(raw) as unknown
  } catch {
    throw new QualityEvidenceReceiptError(`agent receipt "${ref}" is not valid JSON`)
  }
  const parsed = AgentResultSchema.safeParse(rawValue)
  if (!parsed.success) throw new QualityEvidenceReceiptError(`agent receipt "${ref}" is not a validated AgentResult`)
  if (parsed.data.status !== verdict) {
    throw new QualityEvidenceReceiptError(`agent receipt "${ref}" has status ${parsed.data.status}, not ${verdict}`)
  }

  if (cycle < state.cycle && worktree !== null) throw new QualityEvidenceReceiptError(`agent receipt "${ref}" cannot prove the current worktree fingerprint`)
  const receipts: QualityEvidenceReceipt[] = [{ kind: 'agent', ref, cycle }]
  const traceabilityRefs: string[] = []
  for (const evidence of parsed.data.evidence) {
    if (evidence.kind === 'file') {
      traceabilityRefs.push(evidence.ref)
      continue
    }
    const directRef = normaliseVerifyRef(evidence.ref)
    const receipt = directRef === null
      ? await latestCommandReceipt(projectDir, state, evidence.ref, evidence.kind, cycle, worktree)
      : await verifyReceipt(projectDir, { ...state, cycle }, directRef, worktree)
    const receiptKind = receipt.entry.slot === 'test' ? 'test' : 'command'
    if (evidence.kind !== receiptKind) {
      throw new QualityEvidenceReceiptError(`agent receipt "${ref}" has wrong kind ${evidence.kind}; its engine receipt is ${receiptKind}`)
    }
    assertOutcome(receipt.entry, verdict, ref)
    receipts.push({ kind: receiptKind, ref: receipt.ref, cycle: receipt.cycle })
  }
  return { receipts, traceabilityRefs, recordedCycle: Math.min(...receipts.map((receipt) => receipt.cycle)) }
}

interface VerifyReceipt {
  cycle: number
  index: number
  entry: LedgerEntry
  ref: string
}

async function verifyReceipt(projectDir: string, state: State, ref: string, worktree: string | null): Promise<VerifyReceipt> {
  const all = await allVerifyReceipts(projectDir, state, state.cycle)
  const matches = all.filter((receipt) => receipt.ref === ref)
  if (matches.length === 0) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" does not exist`)
  const identities = new Set(matches.map(receiptIdentity))
  if (identities.size > 1) {
    throw new QualityEvidenceReceiptError(`verify receipt "${ref}" is ambiguous across verify slot/command identities`)
  }
  const identity = identities.values().next().value!
  const cited = matches.filter((receipt) => receiptIdentity(receipt) === identity).at(-1)!
  const latest = all.filter((receipt) => receiptIdentity(receipt) === identity).at(-1)
  if (latest === undefined || latest.cycle !== cited.cycle || latest.index !== cited.index) {
    throw new QualityEvidenceReceiptError(`verify receipt "${ref}" is superseded by a later invocation`)
  }
  await assertLogExists(projectDir, state, ref)
  assertCacheIntegrity(cited, state, worktree, ref)
  assertPriorFingerprint(cited, state, worktree, ref)
  return cited
}

function receiptIdentity(receipt: VerifyReceipt): string {
  return `${receipt.entry.slot}\0${receipt.entry.command}`
}

async function latestCommandReceipt(
  projectDir: string,
  state: State,
  command: string,
  kind: 'command' | 'test',
  maxCycle: number,
  worktree: string | null,
): Promise<VerifyReceipt> {
  const receipts = await allVerifyReceipts(projectDir, state, maxCycle)
  const matches = receipts.filter((candidate) => candidate.entry.command === command)
  if (matches.length === 0) throw new QualityEvidenceReceiptError(`agent evidence cites ${kind} "${command}" without an engine verify receipt`)
  const slots = new Set(matches.map((candidate) => candidate.entry.slot))
  if (slots.size > 1) throw new QualityEvidenceReceiptError(`agent evidence command "${command}" is ambiguous across verify slots`)
  const receipt = matches.at(-1)!
  const receiptKind = receipt.entry.slot === 'test' ? 'test' : 'command'
  if (kind !== receiptKind) throw new QualityEvidenceReceiptError(`agent evidence has wrong kind ${kind}; its engine receipt is ${receiptKind}`)
  await assertLogExists(projectDir, state, receipt.ref)
  assertCacheIntegrity(receipt, state, worktree, receipt.ref)
  assertPriorFingerprint(receipt, state, worktree, receipt.ref)
  return receipt
}

async function allVerifyReceipts(projectDir: string, state: State, maxCycle: number): Promise<VerifyReceipt[]> {
  const receipts: VerifyReceipt[] = []
  for (let cycle = 1; cycle <= maxCycle; cycle += 1) {
    const ledger = await readVerifyLedger(cycleDirPath(projectDir, state, cycle))
    ledger.forEach((entry, index) => {
      const ref = canonicalEntryRef(cycle, entry.log)
      if (ref !== null) receipts.push({ cycle, index, entry, ref })
    })
  }
  return receipts
}

function assertPriorFingerprint(receipt: VerifyReceipt, state: State, worktree: string | null, ref: string): void {
  if (receipt.cycle >= state.cycle || worktree === null) return
  if (receipt.entry.fingerprint !== verifyFingerprint(receipt.entry.command, worktree)) {
    throw new QualityEvidenceReceiptError(`prior-cycle verify receipt "${ref}" cannot prove the current worktree fingerprint`)
  }
}

function assertCacheIntegrity(receipt: VerifyReceipt, state: State, worktree: string | null, ref: string): void {
  const cachedFrom = receipt.entry.cached_from_cycle
  const source = normaliseVerifyRef(receipt.entry.log)
  if (cachedFrom === null) {
    if (source !== null && receipt.cycle !== sourceCycle(source)) {
      throw new QualityEvidenceReceiptError(`verify receipt "${ref}" points at an older canonical log without cache provenance`)
    }
    return
  }
  if (cachedFrom >= receipt.cycle) throw new QualityEvidenceReceiptError(`cached verify receipt "${ref}" has invalid source cycle`)
  if (source === null || sourceCycle(source) !== cachedFrom) throw new QualityEvidenceReceiptError(`cached verify receipt "${ref}" does not match cached_from_cycle`)
  if (worktree === null) throw new QualityEvidenceReceiptError(`cached verify receipt "${ref}" requires a current worktree digest`)
  if (receipt.entry.fingerprint !== verifyFingerprint(receipt.entry.command, worktree)) {
    throw new QualityEvidenceReceiptError(`cached verify receipt "${ref}" cannot prove the current worktree fingerprint`)
  }
}

function sourceCycle(ref: string): number {
  return Number(/^cycle-(\d{2})\//.exec(ref)![1])
}

async function assertLogExists(projectDir: string, state: State, ref: string): Promise<void> {
  const parsed = normaliseVerifyRef(ref)
  if (parsed === null) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" has an invalid log path`)
  const [, cycleText, log] = /^cycle-(\d{2})\/verify\/([A-Za-z0-9_.-]+)$/.exec(parsed) ?? []
  if (cycleText === undefined || log === undefined) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" has an invalid log path`)
  await fs.access(path.join(cycleDirPath(projectDir, state, Number(cycleText)), 'verify', log)).catch(() => {
    throw new QualityEvidenceReceiptError(`verify receipt "${ref}" has no engine log`)
  })
}

function assertOutcome(entry: LedgerEntry, verdict: Exclude<QualityVerdict, 'not_applicable'>, ref: string): void {
  if (entry.phase !== 'complete') throw new QualityEvidenceReceiptError(`verify receipt "${ref}" did not complete`)
  const passed = entry.exit_code === 0 && !entry.timed_out
  const failed = entry.exit_code !== null && (!passed || entry.timed_out)
  if (verdict === 'pass' && !passed) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" contradicts a passing verdict`)
  if (verdict === 'fail' && !failed) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" does not prove a failure`)
  if (verdict === 'blocked') throw new QualityEvidenceReceiptError(`verify receipt "${ref}" cannot prove a blocked tool`)
}

function normaliseVerifyRef(ref: string): string | null {
  const outer = /^cycle-\d{2}\/verify\/(.+)$/.exec(ref)
  if (outer === null) return null
  const nested = /^cycle-\d{2}\/verify\/[A-Za-z0-9_.-]+$/.exec(outer[1]!)
  if (nested !== null) return outer[1]!
  return /^cycle-\d{2}\/verify\/[A-Za-z0-9_.-]+$/.test(ref) ? ref : null
}

function parseAgentRef(ref: string): { cycle: number; file: string } | null {
  const match = /^cycle-(\d{2})\/([A-Za-z0-9_-]+(?:--[A-Za-z0-9_-]+)?\.json)$/.exec(ref)
  return match === null ? null : { cycle: Number(match[1]), file: match[2]! }
}

function assertCycle(state: State, cycle: number, ref: string): void {
  if (cycle < 1 || cycle > state.cycle) throw new QualityEvidenceReceiptError(`"${ref}" is outside active run cycle ${state.cycle}`)
}

function canonicalEntryRef(cycle: number, log: string): string | null {
  if (/^[A-Za-z0-9_.-]+$/.test(log)) return `cycle-${String(cycle).padStart(2, '0')}/verify/${log}`
  return normaliseVerifyRef(log)
}

function distinctReceipts(receipts: QualityEvidenceReceipt[]): QualityEvidenceReceipt[] {
  const keyed = new Map(receipts.map((receipt) => [`${receipt.kind}\0${receipt.ref}\0${receipt.cycle}`, receipt] as const))
  return [...keyed.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref))
}
