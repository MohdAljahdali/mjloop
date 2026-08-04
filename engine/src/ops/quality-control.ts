import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import type { QualityMode } from '../schemas/config.js'
import {
  QualityBudgetFieldSchema,
  type QualityBudget,
  type QualityDispatch,
  type QualityEnforcement,
  type QualityPolicy,
  type Supervision,
} from '../schemas/quality.js'
import type { State } from '../schemas/state.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { withLock } from '../store/lock.js'
import { resolveLoopPaths } from '../store/paths.js'
import { appendAmendment, readAmendments, readPolicy } from '../store/quality-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { effectiveBudget, isRepairInstance, type ContextPacketResult } from './quality-budget.js'
import { qualityRuntimeEnabled } from './quality-capability.js'
import { runDirPath } from './run.js'

export type QualityBudgetField = z.infer<typeof QualityBudgetFieldSchema>

/**
 * What a run has actually spent, kept beside the policy it is measured against.
 *
 * One flat list of reservation keys rather than four counters: a ceiling is
 * only meaningful if the same action cannot be charged twice, and the key —
 * agent, instance and the pinned plan's own fingerprint — is what decides when
 * twice has happened. Deliberately not scoped by cycle: the same dispatch
 * carrying the same context is the same work whichever cycle re-declares it,
 * which is the budget's half of the rule `refuseRepeatedDispatch` states for
 * results. A dispatch whose plan or context actually moved fingerprints to a
 * different key and is charged for it.
 */
export const QUALITY_USAGE_FILE = 'quality-usage.json'

const QualityUsageSchema = z.strictObject({
  version: z.literal(1),
  reservations: z.array(z.string().min(1)).max(10_000),
})

type QualityUsage = z.infer<typeof QualityUsageSchema>

/** A dispatch a caller wants charged, with whatever the caller already knows about it. */
export interface ReservableQualityDispatch extends QualityDispatch {
  /** The pinned plan's own fingerprint, when this dispatch came from the plan. */
  inputFingerprint?: string
  /** The packet this dispatch would carry, when the caller has already fitted one. */
  context?: ContextPacketResult
}

export interface BudgetAmendmentInput {
  /** The run the amendment is for; an amendment never applies to a different one. */
  run: string
  field: QualityBudgetField
  /** The current *effective* ceiling, so an amendment written against a stale reading is refused. */
  from: number
  to: number
  reason: string
  decided_by: string
}

/** The compact quality block `stateSummary` reports, computed where the budget lives. */
export interface QualityStateSummary {
  mode: QualityMode
  supervision: Supervision
  enforcement: QualityEnforcement
  dispatches: { used: number; max: number }
  waiting: { kind: 'budget' | 'decision'; reason: string } | null
}

/**
 * A run that would have exceeded a pinned ceiling, suspended before it did.
 *
 * Thrown *after* the state write, never instead of it: the run is already
 * `budget_exhausted` by the time a caller sees this, so the operator's next
 * step — one explicit amendment — is available rather than merely described.
 */
export class QualityBudgetExhaustedError extends Error {
  constructor(readonly field: QualityBudgetField, readonly detail: string) {
    super(detail)
    this.name = 'QualityBudgetExhaustedError'
  }
}

/** An operator write that does not match the run it claims to amend. */
export class QualityAmendmentRefusedError extends Error {
  constructor(detail: string) {
    super(`quality budget amendment refused: ${detail}`)
    this.name = 'QualityAmendmentRefusedError'
  }
}

/** `halt_reason` is read by the summary line and by HALT.md; a ceiling story does not need more than this. */
const REASON_MAX = 400

/**
 * Charge a set of dispatches against this run's effective budget, and suspend
 * rather than let it overspend.
 *
 * Three of the four budgeted fields are decided here, because all three are
 * questions about the *same* set of dispatches: the packet each one would
 * carry, how many dispatches the run has spent, and how many of those were
 * targeted repairs. The fourth — `max_cycles` — belongs to `cycleAdvance`,
 * which is the only seam that opens a cycle.
 *
 * Nothing is charged, read or written unless the rollout gate is open *and*
 * this run's own policy pinned `enforcement: active` — the same pair of
 * conditions `cycleRosterSet` and `assertRunCanPass` use. A shadow run
 * therefore reports `used: 0` because it has genuinely reserved nothing.
 */
export async function reserveQualityDispatches(
  projectDir: string,
  state: State,
  dispatches: readonly ReservableQualityDispatch[],
  now: Clock = () => new Date(),
): Promise<{ used: number; remaining: number }> {
  const pinned = await enforcedBudget(projectDir, state)
  if (pinned === null) return { used: 0, remaining: 0 }
  const { budget } = pinned

  // Before the lock and before anything is charged: a packet that does not fit
  // is not a dispatch the run may pay for at any price.
  for (const dispatch of dispatches) {
    const tokens = dispatch.context?.tokens.value
    if (tokens === undefined || tokens === null || tokens <= budget.max_context_tokens_per_dispatch) continue
    await suspend(projectDir, now, 'max_context_tokens_per_dispatch',
      `the context packet for "${basenameOf(dispatch)}" needs ${tokens} estimated input tokens and this run's ` +
        `ceiling is ${budget.max_context_tokens_per_dispatch}`)
  }

  const file = path.join(runDirPath(projectDir, state), QUALITY_USAGE_FILE)
  const outcome: { value: { used: number; remaining: number } | null; refusal: Refusal | null } = {
    value: null,
    refusal: null,
  }

  await withLock(resolveLoopPaths(projectDir).lock, async (ownership) => {
    const reserved = new Set((await readUsage(file)).reservations)
    const added = new Set(dispatches.map(reservationKey))
    for (const key of reserved) added.delete(key)

    const used = reserved.size + added.size
    if (used > budget.max_dispatches) {
      outcome.refusal = {
        field: 'max_dispatches',
        detail: `this run has reserved ${reserved.size} of ${budget.max_dispatches} quality dispatches and the ` +
          `next action needs ${added.size} more`,
      }
      return
    }

    const repairs = count(reserved, isRepairKey) + count(added, isRepairKey)
    if (repairs > budget.max_repair_attempts) {
      outcome.refusal = {
        field: 'max_repair_attempts',
        detail: `this run allows ${budget.max_repair_attempts} targeted repair attempt(s) and the next action ` +
          `would make ${repairs}`,
      }
      return
    }

    if (added.size > 0) {
      const next: QualityUsage = { version: 1, reservations: [...reserved, ...added] }
      await ownership.runIfOwned(async (stagingDir) => { await writeJsonAtomic(file, next, { stagingDir }) })
    }
    outcome.value = { used, remaining: budget.max_dispatches - used }
  })

  // Outside the lock the reservation was decided under: suspension writes state
  // through `StateStore`, which takes that same non-reentrant lock.
  if (outcome.refusal !== null) await suspend(projectDir, now, outcome.refusal.field, outcome.refusal.detail)
  if (outcome.value === null) throw new Error('quality dispatch reservation completed without an outcome')
  return outcome.value
}

/**
 * Suspend the run for a budget it may not exceed.
 *
 * `current.stage` is deliberately untouched: a suspension is a pause at the
 * stage the run was working at, and an amendment resumes it there rather than
 * anywhere else.
 */
export async function exhaustQualityBudget(projectDir: string, reason: string, now: Clock = () => new Date()): Promise<State> {
  return new StateStore(projectDir, now).update((draft) => { suspendDraft(draft, reason) })
}

/**
 * The same transition against a draft a caller already holds the lock for —
 * `cycleAdvance`'s locked update, which cannot call `exhaustQualityBudget`
 * because `StateStore.update` is not reentrant.
 */
export function suspendDraft(draft: State, reason: string): void {
  draft.status = 'budget_exhausted'
  draft.halt_reason = reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason
}

/**
 * Whether closing this cycle without a pass would need a cycle the run cannot
 * afford, and the reason to record if so.
 *
 * Takes no lock and reads only records: `cycleAdvance` calls it from inside its
 * own locked update, against that update's own draft, for the reason
 * `assertRunCanPass` gives.
 */
export async function nextCycleRefusal(projectDir: string, state: State): Promise<string | null> {
  const pinned = await enforcedBudget(projectDir, state)
  if (pinned === null || state.cycle < pinned.budget.max_cycles) return null
  return reasonFor(
    'max_cycles',
    `this run may work ${pinned.budget.max_cycles} cycle(s) and cycle ${state.cycle} did not pass`,
  )
}

/**
 * Raise one ceiling for one suspended run, and resume it.
 *
 * The pin is never touched. The amendment is appended first and the run is only
 * then set back to `running`: a crash between the two leaves a recorded
 * decision and a still-suspended run, which an operator can see and repeat —
 * the other order would leave a resumed run with no record of why.
 */
export async function amendQualityBudget(
  projectDir: string,
  input: BudgetAmendmentInput,
  now: Clock = () => new Date(),
): Promise<State> {
  const state = await new StateStore(projectDir, now).get()
  if (state.status !== 'budget_exhausted') {
    throw new QualityAmendmentRefusedError(`a budget is amended only while a run is suspended; this one is "${state.status}"`)
  }
  if (state.run_id === null || state.run_id !== input.run) {
    throw new QualityAmendmentRefusedError(`it names run "${input.run}" and the current run is "${String(state.run_id)}"`)
  }
  if (input.to <= input.from) {
    throw new QualityAmendmentRefusedError(`a ceiling is raised, never lowered: ${input.from} → ${input.to}`)
  }

  const pinned = await pinnedBudget(projectDir, state)
  if (pinned === null) throw new QualityAmendmentRefusedError('this run pinned no quality policy')
  const current = pinned.budget[input.field]
  if (current !== input.from) {
    throw new QualityAmendmentRefusedError(
      `it was written against ${input.field} = ${input.from} and the current effective ceiling is ${current}`,
    )
  }

  await appendAmendment(projectDir, state, {
    version: 1,
    run: state.run_id,
    field: input.field,
    from: input.from,
    to: input.to,
    reason: input.reason,
    decided_at: now().toISOString(),
    decided_by: input.decided_by,
  })

  return new StateStore(projectDir, now).update((draft) => {
    if (draft.status !== 'budget_exhausted' || draft.run_id !== state.run_id) {
      throw new QualityAmendmentRefusedError('the run moved on while the amendment was being recorded')
    }
    draft.status = 'running'
    draft.halt_reason = null
  })
}

/**
 * The quality block for `stateSummary`, or `null` for a run with no pin.
 *
 * Reported for shadow runs too — the counterfactual telemetry is the point of
 * the shadow phase — which is why the enforcement gate is not consulted here.
 */
export async function qualityStateSummary(projectDir: string, state: State): Promise<QualityStateSummary | null> {
  const pinned = await pinnedBudget(projectDir, state)
  if (pinned === null) return null
  const usage = await readUsage(path.join(runDirPath(projectDir, state), QUALITY_USAGE_FILE))
  return {
    mode: pinned.policy.mode,
    supervision: pinned.policy.supervision,
    enforcement: pinned.policy.enforcement,
    dispatches: { used: usage.reservations.length, max: pinned.budget.max_dispatches },
    waiting: waitingOn(state),
  }
}

interface Refusal {
  field: QualityBudgetField
  detail: string
}

function waitingOn(state: State): QualityStateSummary['waiting'] {
  if (state.status === 'budget_exhausted') return { kind: 'budget', reason: state.halt_reason ?? '' }
  if (state.status === 'waiting_for_user') return { kind: 'decision', reason: state.halt_reason ?? '' }
  return null
}

/** The pinned policy and the ceilings its accepted amendments produce, or `null` for a run with no pin. */
async function pinnedBudget(
  projectDir: string,
  state: State,
): Promise<{ policy: QualityPolicy; budget: QualityBudget } | null> {
  if (state.run_id === null || state.track === null || state.quality_policy_version !== 1) return null
  const policy = await readPolicy(projectDir, state)
  return { policy, budget: effectiveBudget(policy, await readAmendments(projectDir, state)) }
}

/**
 * The same, or `null` when this run enforces nothing. The gate is checked
 * first so a closed rollout reads no record at all and every seam below stays
 * byte-for-byte where it was.
 */
async function enforcedBudget(
  projectDir: string,
  state: State,
): Promise<{ policy: QualityPolicy; budget: QualityBudget } | null> {
  if (!qualityRuntimeEnabled()) return null
  const pinned = await pinnedBudget(projectDir, state)
  return pinned === null || pinned.policy.enforcement !== 'active' ? null : pinned
}

async function suspend(projectDir: string, now: Clock, field: QualityBudgetField, detail: string): Promise<never> {
  const reason = reasonFor(field, detail)
  await exhaustQualityBudget(projectDir, reason, now)
  throw new QualityBudgetExhaustedError(field, reason)
}

function reasonFor(field: QualityBudgetField, detail: string): string {
  return `quality budget ${field} reached: ${detail}. Raise it with one explicit amendment to resume.`
}

async function readUsage(file: string): Promise<QualityUsage> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, reservations: [] }
    throw error
  }
  const parsed = QualityUsageSchema.safeParse(JSON.parse(raw) as unknown)
  // Fails closed on purpose: a record that cannot be counted cannot show a
  // ceiling has room, and treating it as empty is the one direction that lets a
  // run overspend without anybody noticing.
  if (!parsed.success) throw new Error(`${file} is not a readable quality usage record: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/**
 * One charge. The fingerprint is the pinned plan's own where the caller has it,
 * so re-declaring a roster whose plan has not moved costs nothing; where it
 * does not, the dispatch's own content stands in.
 */
function reservationKey(dispatch: ReservableQualityDispatch): string {
  const fingerprint = dispatch.inputFingerprint ?? sha256(canonicalJson(dispatch))
  return [dispatch.agent, dispatch.instance ?? '', fingerprint].join('\0')
}

function isRepairKey(key: string): boolean {
  return isRepairInstance(key.split('\0')[1] ?? '')
}

function count(keys: Iterable<string>, predicate: (key: string) => boolean): number {
  let total = 0
  for (const key of keys) if (predicate(key)) total += 1
  return total
}

function basenameOf(dispatch: QualityDispatch): string {
  return dispatch.instance === null ? dispatch.agent : `${dispatch.agent}--${dispatch.instance}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}
