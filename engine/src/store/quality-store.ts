import fs from 'node:fs/promises'
import path from 'node:path'
import {
  QualityAmendmentSchema,
  QualityLedgerSchema,
  QualityPolicySchema,
  type QualityAmendment,
  type QualityLedger,
  type QualityPolicy,
} from '../schemas/quality.js'
import type { State } from '../schemas/state.js'
import { runDirPath } from '../ops/run.js'
import { StateCorruptedError, readJsonValidated, writeJsonAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'

export const QUALITY_POLICY_FILE = 'quality-policy.json'
export const QUALITY_LEDGER_FILE = 'quality-ledger.json'
export const QUALITY_AMENDMENTS_FILE = 'quality-amendments.jsonl'

export interface QualityFiles {
  policy: string
  ledger: string
  amendments: string
}

/** The three records that belong to one concrete run, never to mutable project configuration. */
export function qualityFiles(projectDir: string, state: State): QualityFiles {
  const runDir = runDirPath(projectDir, state)
  return {
    policy: path.join(runDir, QUALITY_POLICY_FILE),
    ledger: path.join(runDir, QUALITY_LEDGER_FILE),
    amendments: path.join(runDir, QUALITY_AMENDMENTS_FILE),
  }
}

/** A policy is a pin: a second writer must fail without changing the first record. */
export class QualityPolicyExistsError extends Error {
  constructor(file: string) {
    super(`${file} already exists — a run quality policy is never rewritten`)
    this.name = 'QualityPolicyExistsError'
  }
}

export async function writePolicyOnce(projectDir: string, state: State, policy: QualityPolicy): Promise<void> {
  const file = qualityFiles(projectDir, state).policy
  const parsed = QualityPolicySchema.parse(policy)
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new QualityPolicyExistsError(file)
    throw error
  }
}

export async function readPolicy(projectDir: string, state: State): Promise<QualityPolicy> {
  const { value } = await readJsonValidated(qualityFiles(projectDir, state).policy, QualityPolicySchema)
  return value
}

/**
 * The ledger changes over a run, so writes retain the preceding valid revision
 * for recovery. It intentionally takes no lock itself: the quality transition
 * that composes this write with a StateStore update already holds the project
 * lock, and acquiring it again would deadlock that transition.
 */
export async function writeLedger(projectDir: string, state: State, ledger: QualityLedger): Promise<void> {
  const file = qualityFiles(projectDir, state).ledger
  await writeJsonAtomic(file, QualityLedgerSchema.parse(ledger))
}

/**
 * The closed quality operations use this read-modify-write seam instead of
 * composing an unlocked read and `writeLedger`. It shares the state lock, but
 * remains separate from StateStore because a ledger transition does not alter
 * resumable state in this task.
 */
export async function updateLedger(
  projectDir: string,
  state: State,
  mutate: (draft: QualityLedger) => void | Promise<void>,
): Promise<QualityLedger> {
  const file = qualityFiles(projectDir, state).ledger
  const paths = resolveLoopPaths(projectDir)
  return withLock(paths.lock, async (ownership) => {
    const { value, recovered } = await readJsonValidated(file, QualityLedgerSchema)
    const draft = structuredClone(value)
    await mutate(draft)
    const parsed = QualityLedgerSchema.parse(draft)
    await ownership.runIfOwned(async (stagingDir) => {
      await writeJsonAtomic(file, parsed, { backup: !recovered, stagingDir })
    })
    return parsed
  })
}

export async function readLedger(projectDir: string, state: State): Promise<QualityLedger> {
  const { value } = await readJsonValidated(qualityFiles(projectDir, state).ledger, QualityLedgerSchema)
  return value
}

/**
 * Adds one budget amendment after validating the entire existing journal while
 * holding the project lock. A corrupt previous line stops the append: otherwise
 * a later reader could not distinguish a complete history from a torn one.
 */
export async function appendAmendment(projectDir: string, state: State, amendment: QualityAmendment): Promise<void> {
  const file = qualityFiles(projectDir, state).amendments
  const paths = resolveLoopPaths(projectDir)
  await fs.mkdir(paths.root, { recursive: true })
  await withLock(paths.lock, async () => {
    const { raw } = await readAmendmentFile(file)
    const parsed = QualityAmendmentSchema.parse(amendment)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const separator = raw.length > 0 && !raw.endsWith('\n') ? '\n' : ''
    await fs.appendFile(file, `${separator}${JSON.stringify(parsed)}\n`, 'utf8')
  })
}

export async function readAmendments(projectDir: string, state: State): Promise<QualityAmendment[]> {
  return (await readAmendmentFile(qualityFiles(projectDir, state).amendments)).amendments
}

async function readAmendmentFile(file: string): Promise<{ raw: string; amendments: QualityAmendment[] }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: '', amendments: [] }
    throw error
  }

  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const amendments = lines.map((line, index) => parseAmendmentLine(file, line, index + 1))
  return { raw, amendments }
}

function parseAmendmentLine(file: string, line: string, lineNumber: number): QualityAmendment {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (error) {
    throw new StateCorruptedError(`${file} has an invalid quality amendment on line ${lineNumber}: ${(error as Error).message}`)
  }
  const parsed = QualityAmendmentSchema.safeParse(value)
  if (!parsed.success) {
    throw new StateCorruptedError(`${file} has an invalid quality amendment on line ${lineNumber}: ${parsed.error.message}`)
  }
  return parsed.data
}
