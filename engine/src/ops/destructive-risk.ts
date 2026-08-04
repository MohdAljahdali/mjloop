import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import type { State } from '../schemas/state.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { withLock } from '../store/lock.js'
import { resolveLoopPaths } from '../store/paths.js'
import { readPolicy } from '../store/quality-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { qualityRuntimeEnabled } from './quality-capability.js'
import { runDirPath } from './run.js'

/**
 * One operation a person has to decide on before it happens.
 *
 * `operation` is the text an operator reads and the text the fingerprint is
 * taken over, so a decision is bound to what was actually proposed rather than
 * to its category: "DROP TABLE users" and "DROP TABLE users, orders" are two
 * different decisions even though both are `table_drop` against a run.
 */
export interface DestructiveCandidate {
  kind: 'feature_delete' | 'table_drop' | 'table_truncate' | 'bulk_data_delete' | 'irreversible_migration' | 'project_wide'
  targets: string[]
  operation: string
  rollback: string | null
}

/** The run-scoped record of every protected operation this run has proposed. */
export const DESTRUCTIVE_REQUESTS_FILE = 'destructive-requests.json'

const DestructiveCandidateSchema = z.strictObject({
  kind: z.enum(['feature_delete', 'table_drop', 'table_truncate', 'bulk_data_delete', 'irreversible_migration', 'project_wide']),
  targets: z.array(z.string().min(1)).max(200),
  operation: z.string().min(1),
  rollback: z.string().nullable(),
})

/**
 * One request and, once an operator has answered it, their decision.
 *
 * `status` carries `used` as well as `approved` because an approval is spent
 * once: the same operation proposed a second time is a second decision. The
 * operator door that writes `approved` or `rejected` is Task 13's; nothing here
 * ever writes them.
 */
const DestructiveRequestSchema = z.strictObject({
  run: z.string().min(1),
  fingerprint: z.string().min(1),
  candidate: DestructiveCandidateSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'used']),
  /**
   * Whether the operation had already touched the worktree when it was caught.
   *
   * The two guards catch an operation at opposite ends of it: a command stopped
   * at the tool boundary has done nothing, while a feature deleted through edits
   * is already gone from disk by the time the result names it. Nothing about the
   * operation itself says which, and the difference decides what a *rejection*
   * means — nothing to undo, or a revert somebody has to perform and prove — so
   * it is recorded when the request is written rather than guessed at later.
   *
   * A record without the field defaults to `true`, which is the direction every
   * other unreadable-record rule here fails in: over-suspending costs an
   * operator one more step, while defaulting to `false` would resume a run whose
   * destructive action had already happened.
   */
  applied: z.boolean().default(true),
  requested_at: z.string().min(1),
  decided_at: z.string().nullable(),
  decided_by: z.string().nullable(),
  /** The operator's own words for the decision, once there is one. */
  note: z.string().max(2000).nullable().default(null),
})

export const DestructiveRequestsSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(DestructiveRequestSchema).max(1000),
})

export type DestructiveRequest = z.infer<typeof DestructiveRequestSchema>
export type DestructiveRequests = z.infer<typeof DestructiveRequestsSchema>

/** An agent result whose changes need a decision this run does not have. */
export class DestructiveApprovalRequiredError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DestructiveApprovalRequiredError'
  }
}

export interface DestructiveGuardOutcome {
  allowed: boolean
  reason: string
}

/** `halt_reason` is read by the summary line and by HALT.md, exactly as a budget suspension's is. */
const REASON_MAX = 400

/**
 * Directories whose contents are rebuilt by a command rather than written by a
 * person. Removing one recursively is the single most ordinary destructive-
 * looking thing a working agent does, and stopping the run for it would make
 * this gate something people route around.
 */
const EPHEMERAL_DIRECTORIES = new Set([
  '.cache', '.next', '.nuxt', '.turbo', '.venv', 'build', 'coverage', 'dist',
  'node_modules', 'out', 'target', 'tmp', 'venv',
])

/** What a removal deletes when the argv does not say — piped paths, and an `-exec` with no root. */
const UNKNOWN_TARGET = '<paths this command is given at run time>'

/** Whole-project targets: nothing under them is recoverable from the project itself. */
const PROJECT_WIDE_TARGETS = new Set(['.', './', '..', '../', '/', '~', '~/', '*', './*', '/*'])

/**
 * Words that are never a table name, and are what an English sentence puts
 * after these verbs. Without this, `git commit -m "truncate the log helper"`
 * reads as a truncated table called `the` — a false positive on the single most
 * ordinary command there is, which would teach people to work around the gate.
 * Nothing here is a plausible identifier, so no real statement loses by it.
 */
const NOT_A_TABLE = new Set([
  'a', 'all', 'an', 'and', 'any', 'every', 'for', 'from', 'in', 'into', 'it', 'its', 'my', 'of', 'on', 'or',
  'our', 'that', 'the', 'their', 'these', 'this', 'those', 'to', 'your',
])

const DROP_TABLE = /\bdrop\s+table\s+(?:if\s+exists\s+)?([\w.$-]+)/gi
const DROP_STORE = /\bdrop\s+(?:database|schema)\s+(?:if\s+exists\s+)?([\w.$-]+)/gi
const TRUNCATE = /\btruncate\s+(?:table\s+)?([\w.$-]+)/gi
const DELETE_FROM = /\bdelete\s+from\s+([\w.$-]+)([^;]*)/gi
const TRIVIAL_WHERE = /^(?:1\s*=\s*1|true)\s*;?\s*$/i
// `git clean` and its flags are matched separately because the flag that makes
// it destructive need not follow it: `git clean --force -d` and `git clean -x -f`
// both wipe uncommitted work, and both leave a word between the two halves.
const GIT_CLEAN = /\bgit\s+clean\b/i
const GIT_CLEAN_FORCE = /(?:^|\s)(?:--force|--recurse[a-z-]*|-[a-z]*[fd][a-z]*)(?=\s|$)/i
const GIT_RESET_HARD = /\bgit\s+reset\s+--hard\b/i
/** `find` removing what it matched: `-delete`, or an `-exec` that runs `rm`. */
const FIND_DELETE = /\bfind\b/i
const FIND_REMOVAL = /(?:^|\s)-delete(?=\s|$)|(?:^|\s)-exec[a-z]*\s+rm\b/i
const FIND_PATH = /\bfind\s+((?:[^\s-][^\s]*\s+)*)/i
const IRREVERSIBLE_MIGRATION =
  /--accept-data-loss|--no-rollback|--irreversible|--force-reset|\bmigrate:fresh\b|\bdb:migrate:reset\b|\bdb:reset\b|\bmigrate\s+reset\b/i
const PATCH_DELETE = /^\s*\*\*\*\s*Delete File:\s*(.+?)\s*$/gim
const FEATURE_REMOVAL = /\b(?:delet|remov|drop|rip(?:ped|ping)?\s+out)\w*\s+(?:the\s+|an?\s+)?(?:entire\s+|whole\s+)?[\w-]*\s*(?:feature|capability|module)\b/i

/** Deleting this many files from one directory is a feature leaving the project, not a refactor. */
const FEATURE_DELETE_FILES = 3

/**
 * The protected operation a tool call would perform, or `null`.
 *
 * Reads the hook's declared `tool_name` and `tool_input` and nothing else: the
 * command is never executed, and never handed to a shell to be parsed. What it
 * *is* given is the declared string, with quote characters replaced by spaces
 * rather than the quoted text removed — `psql -c "DROP TABLE users"` is the
 * ordinary spelling of a dropped table, and a classifier that threw away
 * quoted text would let precisely that through. The cost is the reverse
 * direction: a `DROP TABLE` appearing inside data or a comment stops the run
 * and asks. That is the direction this gate is allowed to be wrong in.
 */
export function classifyDestructiveTool(input: unknown): DestructiveCandidate | null {
  if (typeof input !== 'object' || input === null) return null
  const { tool_name: toolName, tool_input: toolInput } = input as { tool_name?: unknown; tool_input?: unknown }
  if (typeof toolName !== 'string' || typeof toolInput !== 'object' || toolInput === null) return null

  if (toolName.toLowerCase() === 'bash') {
    const command = (toolInput as { command?: unknown }).command
    return typeof command === 'string' ? classifyCommand(command) : null
  }
  if (/apply_?patch/i.test(toolName)) return classifyPatch(toolInput)
  return null
}

/**
 * The protected operation an agent's own result performed, or `null`.
 *
 * A feature can leave a project without any command that names it: an agent
 * with `Edit` and `Write` deletes the files one at a time. What that looks like
 * from here is a directory's worth of files that the result says it touched and
 * that are no longer on disk — or a summary that says in words what it did.
 */
export function classifyDestructiveResult(input: { goal: string; deletedFiles: string[]; summary: string }): DestructiveCandidate | null {
  const directory = featureDirectory(input.deletedFiles)
  if (directory !== null) {
    return {
      kind: 'feature_delete',
      targets: [directory],
      operation: `delete ${input.deletedFiles.length} files under ${directory} while working on: ${input.goal}`,
      rollback: 'the deletions are recoverable from the worktree until this cycle is committed',
    }
  }
  if (!FEATURE_REMOVAL.test(input.summary)) return null
  return {
    kind: 'feature_delete',
    targets: input.deletedFiles.length > 0 ? [...input.deletedFiles] : [input.goal],
    operation: `remove a feature while working on: ${input.goal} — ${input.summary}`,
    rollback: 'the change is recoverable from the worktree until this cycle is committed',
  }
}

/**
 * The identity of one proposed operation inside one run.
 *
 * Targets are sorted and de-duplicated first, so the same operation named in a
 * different order is the same decision; `operation` is included, so an
 * operation that changed at all is a different one and the approval that named
 * the old one buys nothing.
 */
export function operationFingerprint(runId: string, candidate: DestructiveCandidate): string {
  const canonical = JSON.stringify({
    run: runId,
    kind: candidate.kind,
    targets: normaliseTargets(candidate.targets),
    operation: candidate.operation,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

export function destructiveRequestsFile(projectDir: string, state: State): string {
  return path.join(runDirPath(projectDir, state), DESTRUCTIVE_REQUESTS_FILE)
}

export async function readDestructiveRequests(projectDir: string, state: State): Promise<DestructiveRequests> {
  return readDestructiveRequestsAt(destructiveRequestsFile(projectDir, state))
}

/**
 * Whether this operation may proceed, and what to say if it may not.
 *
 * The enforcement pair every other quality seam uses decides whether this runs
 * at all: with the rollout gate closed, or under a shadow policy, nothing is
 * read, nothing is written, and the operation is as unblocked as it was before
 * this milestone. When it does run, an approval recorded for this exact
 * fingerprint is spent — once — and everything else suspends the run.
 */
export async function guardDestructiveOperation(
  projectDir: string,
  state: State,
  candidate: DestructiveCandidate,
  now: Clock = () => new Date(),
  /** `true` from the seam that catches an operation *after* its edits landed. */
  options: { applied?: boolean } = {},
): Promise<DestructiveGuardOutcome> {
  if (!(await enforcementActive(projectDir, state)) || state.run_id === null) return { allowed: true, reason: '' }

  const fingerprint = operationFingerprint(state.run_id, candidate)
  if (await consumeApproval(projectDir, state, fingerprint, now)) return { allowed: true, reason: '' }
  return {
    allowed: false,
    reason: await requestDestructiveDecision(projectDir, state, candidate, fingerprint, now, options.applied === true),
  }
}

/**
 * The same question from the PreToolUse hook, which has no state in hand.
 *
 * The two failures are not the same failure. A project with no readable state
 * has no run to protect, and a guard that denied on its own confusion would
 * make every shell command in a half-initialised project impossible. A run that
 * *is* marked as pinning a policy and cannot produce it is the integrity case:
 * there is no fallback to live config, so the operation is refused.
 */
export async function guardDestructiveCommand(
  projectDir: string,
  candidate: DestructiveCandidate,
  now: Clock = () => new Date(),
): Promise<DestructiveGuardOutcome> {
  // The hook is handed the session's working directory, which is not always the
  // project root: a subagent working in a subdirectory would otherwise resolve a
  // `.mjloop` that does not exist, and the guard would silently protect nothing.
  const root = await loopProjectRoot(projectDir)
  if (root === null) return { allowed: true, reason: '' }

  try {
    const state = await new StateStore(root, now).get()
    return await guardDestructiveOperation(root, state, candidate, now)
  } catch (error) {
    // A state file that exists and cannot be read is not the same as a project
    // with no run. The first is the moment to be most careful — there may be a
    // run in progress and no way to see it — so it is refused, exactly as an
    // unreadable policy is. The absent case never reaches here: `root` is null.
    return { allowed: false, reason: unreadable(candidate, error) }
  }
}

/** The nearest directory at or above `from` that holds a `.mjloop/state.json`, or `null`. */
async function loopProjectRoot(from: string): Promise<string | null> {
  let directory = path.resolve(from)
  for (;;) {
    const exists = await fs.stat(resolveLoopPaths(directory).state).then(() => true, () => false)
    if (exists) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function unreadable(candidate: DestructiveCandidate, error: unknown): string {
  return bounded(
    `${candidate.operation} could not be checked against this run's state and quality policy ` +
      `(${error instanceof Error ? error.message : String(error)}). A protected operation is never allowed on a ` +
      'record the engine cannot read.',
  )
}

/**
 * Record that this run is waiting on a decision, and suspend it.
 *
 * The record is written first and the run is suspended second, for the reason
 * `amendQualityBudget` writes its amendment first: a crash between the two
 * leaves a pending request an operator can still answer, where the other order
 * would leave a suspended run with nothing to decide on.
 *
 * A pending request for the same fingerprint is not appended twice — the same
 * operation retried while it waits is the same decision — but a spent or
 * refused one is, because those are answered and this proposal is not.
 */
async function requestDestructiveDecision(
  projectDir: string,
  state: State,
  candidate: DestructiveCandidate,
  fingerprint: string,
  now: Clock,
  applied: boolean,
): Promise<string> {
  const file = destructiveRequestsFile(projectDir, state)
  await withLock(resolveLoopPaths(projectDir).lock, async (ownership) => {
    const current = await readDestructiveRequestsAt(file)
    if (latestFor(current, fingerprint)?.status === 'pending') return
    const next: DestructiveRequests = {
      version: 1,
      requests: [...current.requests, {
        run: state.run_id as string,
        fingerprint,
        candidate: { ...candidate, targets: normaliseTargets(candidate.targets) },
        status: 'pending',
        applied,
        requested_at: now().toISOString(),
        decided_at: null,
        decided_by: null,
        note: null,
      }],
    }
    await ownership.runIfOwned(async (stagingDir) => { await writeJsonAtomic(file, next, { stagingDir }) })
  })

  const reason = bounded(
    `destructive operation waiting for a human decision (${candidate.kind}): ${candidate.operation}. ` +
      `Targets: ${normaliseTargets(candidate.targets).join(', ')}. Rollback: ${candidate.rollback ?? 'none'}. ` +
      `Approve or reject operation ${fingerprint.slice(0, 12)}… to resume.`,
  )

  // Outside the lock above, which `StateStore.update` takes again. `current.stage`
  // is untouched: a decision resumes the run where it stopped.
  await new StateStore(projectDir, now).update((draft) => {
    if (draft.status !== 'running') return
    draft.status = 'waiting_for_user'
    draft.halt_reason = reason
  })
  return reason
}

/** Spend an approval for this exact operation, or report that there is none. */
async function consumeApproval(projectDir: string, state: State, fingerprint: string, now: Clock): Promise<boolean> {
  const file = destructiveRequestsFile(projectDir, state)
  let spent = false
  await withLock(resolveLoopPaths(projectDir).lock, async (ownership) => {
    const current = await readDestructiveRequestsAt(file)
    const approved = latestFor(current, fingerprint)
    if (approved === undefined || approved.status !== 'approved') return
    const next: DestructiveRequests = {
      version: 1,
      requests: current.requests.map((request) =>
        request === approved ? { ...request, status: 'used' as const, decided_at: request.decided_at ?? now().toISOString() } : request,
      ),
    }
    await ownership.runIfOwned(async (stagingDir) => { await writeJsonAtomic(file, next, { stagingDir }) })
    spent = true
  })
  return spent
}

/** The last word recorded about one operation: an earlier spent approval never answers a later proposal. */
function latestFor(requests: DestructiveRequests, fingerprint: string): DestructiveRequest | undefined {
  return requests.requests.filter((request) => request.fingerprint === fingerprint).at(-1)
}

/** The same pair every other quality seam gates on: the rollout gate, and this run's own pinned intent. */
async function enforcementActive(projectDir: string, state: State): Promise<boolean> {
  if (!qualityRuntimeEnabled()) return false
  if (state.run_id === null || state.track === null || state.quality_policy_version !== 1) return false
  return (await readPolicy(projectDir, state)).enforcement === 'active'
}

/**
 * One run's decision record, read by path.
 *
 * Exported alongside the state-based reader above because the web read surface
 * answers about a run *directory* rather than about the active state, and a
 * second parse of this file there would be a second place the fail-closed rule
 * below could be relaxed without anybody noticing.
 */
export async function readDestructiveRequestsAt(file: string): Promise<DestructiveRequests> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, requests: [] }
    throw error
  }
  const parsed = DestructiveRequestsSchema.safeParse(JSON.parse(raw) as unknown)
  // Fails closed, as the usage record does: a decision file that cannot be read
  // cannot show that anybody approved anything, and reading it as empty is the
  // one direction that would let an unapproved operation through unnoticed.
  if (!parsed.success) throw new Error(`${file} is not a readable destructive decision record: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

function classifyCommand(command: string): DestructiveCandidate | null {
  const text = command.replace(/['"`]/g, ' ')

  if (GIT_RESET_HARD.test(text) || segments(text).some((segment) => GIT_CLEAN.test(segment) && GIT_CLEAN_FORCE.test(segment))) {
    return candidate('project_wide', ['the working tree'], command, 'none — the discarded work is not in any commit')
  }
  const stores = matches(DROP_STORE, text)
  if (stores.length > 0) return candidate('project_wide', stores, command, null)

  const dropped = matches(DROP_TABLE, text)
  if (dropped.length > 0) return candidate('table_drop', dropped, command, null)

  const truncated = matches(TRUNCATE, text)
  if (truncated.length > 0) return candidate('table_truncate', truncated, command, null)

  const bulk = unboundedDeletes(text)
  if (bulk.length > 0) return candidate('bulk_data_delete', bulk, command, null)

  if (IRREVERSIBLE_MIGRATION.test(text)) return candidate('irreversible_migration', ['the project database'], command, null)

  return recursiveRemoval(text, command) ?? findRemoval(text, command)
}

/** Every stage of a pipeline, and every command in a list, considered on its own. */
function segments(text: string): string[] {
  return text.split(/[;&|\n]+/)
}

/**
 * `find` deleting what it matched.
 *
 * A separate rule from `rm`, because this shape names no `rm` at all:
 * `find src/billing -name '*.ts' -delete` removes a feature's files one by one
 * and the word `rm` never appears. The target is the path `find` was pointed
 * at, which is the closest thing to an operand this form has.
 */
function findRemoval(text: string, command: string): DestructiveCandidate | null {
  for (const segment of segments(text)) {
    if (!FIND_DELETE.test(segment) || !FIND_REMOVAL.test(segment)) continue
    const roots = (FIND_PATH.exec(segment)?.[1] ?? '').trim().split(/\s+/).filter((root) => root.length > 0)
    const kept = roots.filter((root) => !isEphemeral(root))
    if (roots.length > 0 && kept.length === 0) continue
    return candidate(
      'feature_delete',
      kept.length > 0 ? kept : [UNKNOWN_TARGET],
      command,
      'the files are recoverable from git only if they were committed',
    )
  }
  return null
}

/** The tables a `DELETE FROM` would empty: one bounded by a real `WHERE` is ordinary work. */
function unboundedDeletes(text: string): string[] {
  const targets: string[] = []
  for (const match of text.matchAll(DELETE_FROM)) {
    const where = /\bwhere\b([\s\S]*)/i.exec(match[2] ?? '')
    if (!isTableName(match[1] as string)) continue
    if (where === null || TRIVIAL_WHERE.test((where[1] ?? '').trim())) targets.push(match[1] as string)
  }
  return targets
}

/** A recursive `rm`, read from the declared argv shape rather than by running it. */
function recursiveRemoval(text: string, command: string): DestructiveCandidate | null {
  for (const segment of segments(text)) {
    const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0)
    const start = tokens.indexOf('rm')
    if (start === -1) continue
    const rest = tokens.slice(start + 1)
    const recursive = rest.some((token) => /^-[a-z]*r[a-z]*$/i.test(token) || token === '--recursive')
    if (!recursive) continue

    const operands = rest.filter((token) => !token.startsWith('-'))
    if (operands.some((operand) => PROJECT_WIDE_TARGETS.has(operand))) {
      return candidate('project_wide', operands, command, null)
    }
    // No operands means the paths arrive on stdin — `find … | xargs rm -rf`,
    // which is how a feature directory is most often actually removed. What is
    // deleted cannot be read from the argv, so it is unknown rather than
    // nothing, and an unknown target is decided in the destructive direction.
    if (operands.length === 0) {
      return candidate('feature_delete', [UNKNOWN_TARGET], command, 'unknown until the piped command that names the paths has run')
    }
    const kept = operands.filter((operand) => !isEphemeral(operand))
    if (kept.length > 0) {
      return candidate('feature_delete', kept, command, 'the files are recoverable from git only if they were committed')
    }
  }
  return null
}

/** The files a patch declares it deletes — the one tool shape that removes files without a command. */
function classifyPatch(toolInput: object): DestructiveCandidate | null {
  const deleted: string[] = []
  for (const value of Object.values(toolInput)) {
    if (typeof value !== 'string') continue
    for (const match of value.matchAll(PATCH_DELETE)) deleted.push(match[1] as string)
  }
  const directory = featureDirectory(deleted)
  if (directory === null) return null
  return candidate('feature_delete', [directory], `delete ${deleted.length} files under ${directory}`, null)
}

/**
 * The directory a set of deleted files takes with them, or `null`.
 *
 * A count rather than "any deletion": moving or splitting a couple of files is
 * how ordinary refactoring looks from here, and a gate that stopped for two
 * files would stop for most cycles. A directory's worth of files leaving at
 * once is the shape of a feature leaving.
 */
function featureDirectory(files: string[]): string | null {
  const counts = new Map<string, number>()
  for (const file of files) {
    const normalised = file.split(path.sep).join('/')
    if (isEphemeral(normalised)) continue
    // Every ancestor, not just the immediate one. A feature is not flat:
    // `src/billing/{index,types}.ts` plus `src/billing/api/create.ts` plus
    // `src/billing/ui/Panel.tsx` is one feature leaving, and counting exact
    // dirnames sees three directories of one or two files and lets it through.
    for (let directory = path.posix.dirname(normalised); ancestorWorthCounting(directory); directory = path.posix.dirname(directory)) {
      counts.set(directory, (counts.get(directory) ?? 0) + 1)
    }
  }
  // The deepest directory that reaches the threshold: `src/billing` names the
  // feature that left, where its parent `src` names the project.
  const reached = [...counts.entries()].filter(([, count]) => count >= FEATURE_DELETE_FILES)
  return reached.sort(([left], [right]) => right.split('/').length - left.split('/').length || (left < right ? -1 : 1))[0]?.[0] ?? null
}

function ancestorWorthCounting(directory: string): boolean {
  return directory !== '.' && directory !== '/' && directory !== '' && !isEphemeral(directory)
}

function isEphemeral(target: string): boolean {
  const segments = target.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  return segments.some((segment) => EPHEMERAL_DIRECTORIES.has(segment))
}

function candidate(
  kind: DestructiveCandidate['kind'],
  targets: string[],
  operation: string,
  rollback: string | null,
): DestructiveCandidate {
  return { kind, targets: normaliseTargets(targets), operation: bounded(operation), rollback }
}

function matches(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] as string).filter(isTableName)
}

function isTableName(target: string): boolean {
  return !NOT_A_TABLE.has(target.toLowerCase())
}

function normaliseTargets(targets: string[]): string[] {
  return [...new Set(targets.map((target) => target.trim()).filter((target) => target.length > 0))].sort()
}

function bounded(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text
}
