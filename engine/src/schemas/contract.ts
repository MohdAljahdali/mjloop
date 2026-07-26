import * as z from 'zod'
import { FindingSchema, ResultSchema } from './state.js'

export const EvidenceSchema = z.strictObject({
  kind: z.enum(['command', 'file', 'test']),
  ref: z.string().min(1),
  excerpt: z.string(),
})

/** The single shape every loop agent must return. */
export const AgentResultSchema = z.strictObject({
  status: ResultSchema,
  summary: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  findings: z.array(FindingSchema),
  files_touched: z.array(z.string().min(1)),
  next_hint: z.string().min(1).nullable().default(null),
})

/** The leader's declared cycle composition. */
export const RosterSchema = z.strictObject({
  cycle: z.number().int().positive(),
  selected: z.array(z.string().min(1)).min(1),
  /** agent name -> why omitting it was safe */
  skipped: z.record(z.string().min(1), z.string().min(1)).default({}),
})

export type Evidence = z.infer<typeof EvidenceSchema>
export type AgentResult = z.infer<typeof AgentResultSchema>
export type Roster = z.infer<typeof RosterSchema>

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Parse an agent's return value. The caller gives the error text back to the
 * agent as a single corrective retry rather than failing the whole loop.
 */
export function parseAgentResult(input: unknown): ParseOutcome<AgentResult> {
  const parsed = AgentResultSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: z.prettifyError(parsed.error) }
}
