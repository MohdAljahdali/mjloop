import * as z from 'zod'
import { FindingSchema, ResultSchema } from './state.js'

/**
 * Names `runLog` may not use, because the cycle and run directories already
 * have them.
 *
 * Two of the six fix a real overwrite. `findings` would clobber the cycle's
 * findings archive, and `roster` would clobber `rosterSet`'s
 * `cycle-NN/roster.json` — an agent named `roster` has been able to do that
 * since milestone 1.
 *
 * The other four are reader clarity, and the honest reason is stated because
 * the tempting one is wrong: `runLog` always appends `.json`, so an agent named
 * `verify` writes `cycle-NN/verify.json`, which does not collide with the
 * `cycle-NN/verify/` directory at all — and the same is true of `evidence` (a
 * directory), `map` and `handoff` (both `.md`). They are reserved because a
 * human, `readCycleDetail`, `writeHandoff` and `readRunHistory` all walk those
 * directories, and a `verify.json` beside a `verify/` is a trap for every one
 * of them. What actually keeps the directories out of an agent list is that
 * every walk filters to `.json` files or skips directory entries.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = ['findings', 'roster', 'verify', 'evidence', 'handoff', 'map']

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
  // `runLog` writes an instance as `<agent>--<instance>.json`, so a name
  // carrying `--` makes that basename ambiguous: agent `a` instance `b` and
  // agent `a--b` would resolve to one file, and the second write would
  // silently discard the first verdict.
  .refine((name) => !name.includes('--'), '"--" is reserved: it separates an agent from its instance in the cycle file name')
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

/**
 * The ceiling a stored excerpt may occupy. Chosen so a failing suite's decisive
 * output survives intact and a full transcript does not.
 */
export const EVIDENCE_EXCERPT_MAX = 2_000

/**
 * A claim is a sentence. A ref is a path or a command. Neither loses anything
 * real at these ceilings, and both are truncated in place — no spill file,
 * because there is no plausible tail worth keeping. `Finding.file` takes the
 * ref ceiling, being the same kind of string.
 */
export const FINDING_CLAIM_MAX = 2_000
export const EVIDENCE_REF_MAX = 1_000

/** In-place truncation marker for the fields that have no spill file. */
const CLAMP_MARKER = '… (truncated)'

/** An excerpt's overflow, and which evidence entry it came from. */
export interface ExcerptSpill {
  index: number
  text: string
}

/**
 * Bound every excerpt in a result, returning the overflow so the caller can
 * write it somewhere retrievable. `spillPath(index)` is called only for the
 * entries that overflow, so a result under the ceiling costs nothing.
 *
 * Also bounds `Finding.claim`, `Evidence.ref` and `Finding.file` in place. The
 * excerpt was the largest channel into `state.json`, not the only one:
 * `state.findings` accumulates every finding every agent files for the whole
 * cycle, and an agent that pastes a stack trace into `claim` reproduces exactly
 * the cost the excerpt cap was added to remove, through a field it never
 * touched.
 *
 * This is a normalisation applied on the way *in*, at `runLog` — deliberately
 * not a `.max()` on the schema. `web/read.ts` re-parses historical
 * `cycle-NN/<agent>.json` files with the same schema, and a failed parse there
 * silently drops that agent from the cockpit's cycle view. A rejecting bound
 * would make old evidence *disappear* rather than be shortened, which is worse
 * than the unbounded string it prevents.
 *
 * The result is a new `AgentResult`; the input is not mutated. `runLog` must
 * derive `proof` and the error signatures from the value returned here, or
 * `state.reproduction.excerpt` keeps the uncapped string and the whole cap is
 * decorative.
 */
export function capEvidence(
  result: AgentResult,
  spillPath: (index: number) => string,
): { result: AgentResult; spills: ExcerptSpill[] } {
  const spills: ExcerptSpill[] = []
  const evidence = result.evidence.map((entry, index) => {
    const ref = clamp(entry.ref, EVIDENCE_REF_MAX)
    if (entry.excerpt.length <= EVIDENCE_EXCERPT_MAX) return { ...entry, ref }
    const excerpt = spillExcerpt(entry.excerpt, spillPath(index))
    spills.push({ index, text: entry.excerpt })
    return { ...entry, ref, excerpt }
  })
  const findings = result.findings.map((finding) => ({
    ...finding,
    file: clamp(finding.file, EVIDENCE_REF_MAX),
    claim: clamp(finding.claim, FINDING_CLAIM_MAX),
  }))
  return { result: { ...result, evidence, findings }, spills }
}

/**
 * Truncate to the ceiling and name where the rest went.
 *
 * The marker is counted **inside** the ceiling rather than added on top of it,
 * and two properties depend on that. The stored string never exceeds
 * `EVIDENCE_EXCERPT_MAX`, so `state.json`'s growth is bounded by the constant
 * rather than by the constant plus however long a run directory path happens to
 * be. And capping an already-capped result is a no-op, because the result sits
 * *at* the ceiling rather than over it — without which `runLog` re-capping its
 * own output would spill the marker itself into a second file and orphan the
 * first.
 */
function spillExcerpt(text: string, spill: string): string {
  // The marker names how many characters were kept, and its own length moves
  // when that number gains or loses a digit. The loop settles the fixed point
  // instead of assuming a width; it converges in two or three passes because
  // each pass changes the count by at most a digit.
  let kept = text.length
  let marker = ''
  for (let pass = 0; pass < 4; pass += 1) {
    marker = `\n… truncated: ${kept} of ${text.length} characters kept. Full output:\n${spill}`
    const next = Math.max(0, EVIDENCE_EXCERPT_MAX - marker.length)
    if (next === kept) break
    kept = next
  }
  return text.slice(0, kept) + marker
}

/**
 * A hard ceiling with no spill file. Idempotent for the same reason
 * `spillExcerpt` is: the marker is spent out of the budget, not added to it.
 */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - CLAMP_MARKER.length)) + CLAMP_MARKER
}

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
