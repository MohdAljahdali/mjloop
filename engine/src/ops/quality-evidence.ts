import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentResultSchema } from '../schemas/contract.js'
import type { QualityEvidenceKind, QualityVerdict } from '../schemas/quality.js'
import type { LedgerEntry } from '../schemas/verify.js'
import type { State } from '../schemas/state.js'
import { cycleDirPath } from './run.js'
import { readVerifyLedger } from './verify.js'

export interface QualityEvidenceReceipt {
  kind: Exclude<QualityEvidenceKind, 'human'>
  ref: string
}

export interface ResolvedQualityEvidence {
  receipts: QualityEvidenceReceipt[]
  /** Validated agent file evidence is traceability only, never a ledger kind. */
  traceabilityRefs: string[]
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
): Promise<ResolvedQualityEvidence> {
  const receipts: QualityEvidenceReceipt[] = []
  const traceabilityRefs: string[] = []
  for (const ref of refs) {
    const verify = parseVerifyRef(ref)
    if (verify !== null) {
      const entry = await verifyReceipt(projectDir, state, verify.cycle, verify.log)
      assertOutcome(entry, verdict, ref)
      receipts.push({ kind: entry.slot === 'test' ? 'test' : 'command', ref })
      continue
    }

    const agent = parseAgentRef(ref)
    if (agent !== null) {
      const resolved = await agentReceipt(projectDir, state, agent.cycle, agent.file, verdict, ref)
      receipts.push(...resolved.receipts)
      traceabilityRefs.push(...resolved.traceabilityRefs)
      continue
    }
    throw new QualityEvidenceReceiptError(`"${ref}" is not an engine receipt in this run`)
  }
  return { receipts: distinctReceipts(receipts), traceabilityRefs: [...new Set(traceabilityRefs)].sort() }
}

async function agentReceipt(
  projectDir: string,
  state: State,
  cycle: number,
  file: string,
  verdict: Exclude<QualityVerdict, 'not_applicable'>,
  ref: string,
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

  const receipts: QualityEvidenceReceipt[] = [{ kind: 'agent', ref }]
  const traceabilityRefs: string[] = []
  const ledger = await readVerifyLedger(cycleDirPath(projectDir, state, cycle))
  for (const evidence of parsed.data.evidence) {
    if (evidence.kind === 'file') {
      traceabilityRefs.push(evidence.ref)
      continue
    }
    const entry = ledger.find((candidate) => candidate.command === evidence.ref)
    if (entry === undefined) throw new QualityEvidenceReceiptError(`agent receipt "${ref}" cites ${evidence.kind} "${evidence.ref}" without an engine verify receipt`)
    const receiptKind = entry.slot === 'test' ? 'test' : 'command'
    if (evidence.kind !== receiptKind) {
      throw new QualityEvidenceReceiptError(`agent receipt "${ref}" has wrong kind ${evidence.kind}; its engine receipt is ${receiptKind}`)
    }
    assertOutcome(entry, verdict, ref)
    receipts.push({ kind: receiptKind, ref: verifyRef(cycle, entry.log) })
  }
  return { receipts, traceabilityRefs }
}

async function verifyReceipt(projectDir: string, state: State, cycle: number, log: string): Promise<LedgerEntry> {
  assertCycle(state, cycle, verifyRef(cycle, log))
  const entry = (await readVerifyLedger(cycleDirPath(projectDir, state, cycle))).find((candidate) => candidate.log === log)
  if (entry === undefined) throw new QualityEvidenceReceiptError(`verify receipt "${verifyRef(cycle, log)}" does not exist`)
  return entry
}

function assertOutcome(entry: LedgerEntry, verdict: Exclude<QualityVerdict, 'not_applicable'>, ref: string): void {
  if (entry.phase !== 'complete') throw new QualityEvidenceReceiptError(`verify receipt "${ref}" did not complete`)
  const passed = entry.exit_code === 0 && !entry.timed_out
  const failed = entry.exit_code !== null && (!passed || entry.timed_out)
  if (verdict === 'pass' && !passed) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" contradicts a passing verdict`)
  if (verdict === 'fail' && !failed) throw new QualityEvidenceReceiptError(`verify receipt "${ref}" does not prove a failure`)
  if (verdict === 'blocked') throw new QualityEvidenceReceiptError(`verify receipt "${ref}" cannot prove a blocked tool`)
}

function parseVerifyRef(ref: string): { cycle: number; log: string } | null {
  const match = /^cycle-(\d{2})\/verify\/([A-Za-z0-9_.-]+)$/.exec(ref)
  return match === null ? null : { cycle: Number(match[1]), log: match[2]! }
}

function parseAgentRef(ref: string): { cycle: number; file: string } | null {
  const match = /^cycle-(\d{2})\/([A-Za-z0-9_-]+(?:--[A-Za-z0-9_-]+)?\.json)$/.exec(ref)
  return match === null ? null : { cycle: Number(match[1]), file: match[2]! }
}

function assertCycle(state: State, cycle: number, ref: string): void {
  if (cycle < 1 || cycle > state.cycle) throw new QualityEvidenceReceiptError(`"${ref}" is outside active run cycle ${state.cycle}`)
}

function verifyRef(cycle: number, log: string): string {
  return `cycle-${String(cycle).padStart(2, '0')}/verify/${log}`
}

function distinctReceipts(receipts: QualityEvidenceReceipt[]): QualityEvidenceReceipt[] {
  const keyed = new Map(receipts.map((receipt) => [`${receipt.kind}\0${receipt.ref}`, receipt] as const))
  return [...keyed.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref))
}
