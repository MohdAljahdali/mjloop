import * as z from 'zod'
import { FindingSchema, ResultSchema } from './state.js'

/** Names `runLog` may not use, because the cycle directory already has them. */
export const RESERVED_AGENT_NAMES: readonly string[] = ['findings']

/**
 * An agent name becomes a file name under `cycle-NN/`, and it arrives from the
 * leader model via an MCP tool call. The pattern admits no separator and no
 * dot, so no name can steer a write out of the cycle directory: the state file
 * is three levels up, and the `PreToolUse` guard that protects it inspects
 * `Write` and `Edit`, not this server. `findings` is reserved on top of that —
 * the cycle's findings archive is written to `cycle-NN/findings.json` and
 * would otherwise overwrite that agent's own result.
 */
export const AgentNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'only letters, digits, "-" and "_" are allowed')
  .refine((name) => !RESERVED_AGENT_NAMES.includes(name), `reserved by the cycle directory: ${RESERVED_AGENT_NAMES.join(', ')}`)

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
