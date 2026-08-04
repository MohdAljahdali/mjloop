import * as z from 'zod'

/**
 * Plan ids, story ids and track names are interpolated into run directory
 * names (`<run_id>--<story>--<track>`), so they must stay filename-safe: a
 * value containing `/` or `..` would steer the run directory outside
 * `.mjloop/runs`, and all three arrive from the leader model — the ids through an
 * MCP tool call, the track through one as well as through `.mjloop/config.yaml`.
 */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'only letters, digits, "-" and "_" are allowed')

export const StatusSchema = z.enum(['idle', 'running', 'paused', 'waiting_for_user', 'budget_exhausted', 'halted', 'done', 'failed'])
export const StageSchema = z.enum(['idle', 'compose', 'execute', 'judge', 'halted', 'done'])
export const SeveritySchema = z.enum(['high', 'medium', 'low'])
export const ResultSchema = z.enum(['pass', 'fail', 'blocked'])

export const FindingSchema = z.strictObject({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  claim: z.string().min(1),
})

export const HistoryEntrySchema = z.strictObject({
  cycle: z.number().int().positive(),
  agents: z.array(z.string().min(1)).min(1),
  result: ResultSchema,
  ref: z.string().min(1),
  /**
   * When the cycle closed, so a run can be measured in minutes rather than
   * only in cycles.
   *
   * Nullable and defaulted for the reason `last_fingerprint` is: `StateSchema`
   * is strict, so without the default every history entry written before this
   * field existed would fail validation on read rather than gaining the field
   * on its next write. Its only writer is `cycleAdvance`, inside the update it
   * already takes the lock for.
   */
  at: z.iso.datetime().nullable().default(null),
})

/**
 * Proof that a defect exists, recorded when a gated track's proving agent
 * returns an evidenced pass. Its presence is what opens the gate; there is no
 * tool that sets it directly, because a defect somebody merely asserts was
 * reproduced is exactly what the fix track exists to rule out.
 */
export const ReproductionSchema = z.strictObject({
  /** The agent whose result opened the gate. */
  agent: z.string().min(1),
  /** The cycle it was proven in. */
  cycle: z.number().int().positive(),
  /** The command that reproduces the defect. */
  ref: z.string().min(1),
  /** Its decisive output. May be empty — the contract allows an empty excerpt. */
  excerpt: z.string(),
})

export const StateSchema = z.strictObject({
  schema: z.literal(1),
  run_id: z.string().min(1).nullable(),
  /** Names the run directory alongside the story, so it is bound by the same
   * schema rather than merely by convention. */
  track: IdSchema.nullable(),
  status: StatusSchema,
  cycle: z.number().int().nonnegative(),
  goal: z.string().min(1).nullable(),
  /**
   * When the run opened. Nullable and defaulted: a state file written before
   * this field existed must gain it on its next write rather than fail to read.
   *
   * It carries a second load, and the two readers never write it. Because
   * `runStart` is its only writer and it landed in the same change as the
   * verify pin, `started_at === null` identifies a run that predates the pin —
   * which is the one question `verifyRun` must answer to tell a legacy run
   * (fall back to the live config, and say so) apart from a run whose pin was
   * deleted (refuse). Without a marker the two absences are indistinguishable,
   * and falling back on both would make `rm` the downgrade attack the pin
   * exists to prevent.
   */
  started_at: z.iso.datetime().nullable().default(null),
  /**
   * Marks a run that has an immutable quality policy pin. It defaults to null
   * so state files written before quality policies existed remain readable.
   */
  quality_policy_version: z.literal(1).nullable().default(null),
  current: z.strictObject({
    plan: IdSchema.nullable(),
    story: IdSchema.nullable(),
    stage: StageSchema,
  }),
  findings: z.array(FindingSchema),
  no_progress_count: z.number().int().nonnegative(),
  /**
   * Fingerprint of the previous cycle, compared by the stagnation guard.
   *
   * The default is load-bearing: `StateSchema` is a strict object, so without
   * it every `state.json` written before this field existed would fail
   * validation on read rather than gaining the field on its next write.
   */
  last_fingerprint: z.string().min(1).nullable().default(null),
  /**
   * Normalised error signatures observed this cycle, appended by `runLog` and
   * cleared when the next cycle opens — the same lifecycle findings have, for
   * the same reason: they describe one cycle's failure, not the run's.
   */
  cycle_errors: z.array(z.string().min(1)).default([]),
  /** Fingerprint of the previous cycle's errors, compared by the repeated-error guard. */
  last_error_fingerprint: z.string().min(1).nullable().default(null),
  /**
   * The default matters for the same reason `last_fingerprint`'s does: without
   * it every state file written before this field existed would fail
   * validation on read rather than gaining the field on its next write.
   */
  reproduction: ReproductionSchema.nullable().default(null),
  history: z.array(HistoryEntrySchema),
  halt_reason: z.string().min(1).nullable(),
  updated_at: z.iso.datetime(),
})

export type Status = z.infer<typeof StatusSchema>
export type Stage = z.infer<typeof StageSchema>
export type Severity = z.infer<typeof SeveritySchema>
export type Result = z.infer<typeof ResultSchema>
export type Finding = z.infer<typeof FindingSchema>
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>
export type Reproduction = z.infer<typeof ReproductionSchema>
export type State = z.infer<typeof StateSchema>

/** A freshly provisioned, not-yet-running state. */
export function initialState(now: Date): State {
  return {
    schema: 1,
    run_id: null,
    track: null,
    status: 'idle',
    cycle: 0,
    goal: null,
    // Spelled out because `State` is the output type, in which a
    // `.nullable().default(null)` field is required — the same reason
    // `last_fingerprint`, `cycle_errors` and `reproduction` are written here.
    started_at: null,
    quality_policy_version: null,
    current: { plan: null, story: null, stage: 'idle' },
    findings: [],
    no_progress_count: 0,
    last_fingerprint: null,
    cycle_errors: [],
    last_error_fingerprint: null,
    reproduction: null,
    history: [],
    halt_reason: null,
    updated_at: now.toISOString(),
  }
}
