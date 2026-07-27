import * as z from 'zod'

/**
 * Plan ids, story ids and track names are interpolated into run directory
 * names (`<run_id>--<story>--<track>`), so they must stay filename-safe: a
 * value containing `/` or `..` would steer the run directory outside
 * `.loop/runs`, and all three arrive from the leader model — the ids through an
 * MCP tool call, the track through one as well as through `.loop/config.yaml`.
 */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'only letters, digits, "-" and "_" are allowed')

export const StatusSchema = z.enum(['idle', 'running', 'paused', 'halted', 'done', 'failed'])
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
