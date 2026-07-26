import * as z from 'zod'

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

export const StateSchema = z.strictObject({
  schema: z.literal(1),
  run_id: z.string().min(1).nullable(),
  track: z.string().min(1).nullable(),
  status: StatusSchema,
  cycle: z.number().int().nonnegative(),
  goal: z.string().min(1).nullable(),
  current: z.strictObject({
    plan: z.string().min(1).nullable(),
    story: z.string().min(1).nullable(),
    stage: StageSchema,
  }),
  findings: z.array(FindingSchema),
  no_progress_count: z.number().int().nonnegative(),
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
    history: [],
    halt_reason: null,
    updated_at: now.toISOString(),
  }
}
