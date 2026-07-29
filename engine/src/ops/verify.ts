import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import type { Config } from '../schemas/config.js'
import { AgentNameSchema } from '../schemas/contract.js'
import type { State } from '../schemas/state.js'
import {
  LedgerSchema,
  PinnedVerifySchema,
  VerifySlotSchema,
  type LedgerEntry,
  type PinnedVerify,
  type VerifySlot,
} from '../schemas/verify.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { loadConfig } from '../store/config-store.js'
import { worktreeDigest } from '../store/git.js'
import { LockTimeoutError, withLock } from '../store/lock.js'
import { resolveLoopPaths } from '../store/paths.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { verifyFingerprint } from './fingerprint.js'
import { cycleDirPath, runDirPath } from './run.js'

/**
 * The engine running the project's own verify commands, and keeping the
 * receipt.
 *
 * This file owns four things and nothing else owns any of them: spawning, the
 * log, the ledger (`cycle-NN/verify/index.json`) and the verify-result cache
 * (`<run>/verify-cache.json`).
 *
 * **It reports facts and never a verdict.** There is no `status` on
 * `VerifyDigest`, and the field that says how far an invocation got is called
 * `phase` precisely so the two words never sit beside each other in a leader's
 * context. Exit 127 is `exit_code: 127`, not `blocked`; exit 1 is `exit_code:
 * 1`, not `fail`. Mapping an exit code to a verdict is judgement about *this*
 * project and it stays with the agent holding the brief. Nothing here writes
 * `state.json`, files a finding, or opens a gate — the only path from a
 * command's output into the run's state is still `mjloop_run_log`.
 *
 * **The child's output never reaches this process's own streams.**
 * `StdioServerTransport` binds `process.stdout` as the JSON-RPC channel, so one
 * byte of a test suite's output on that stream corrupts the session's protocol
 * irrecoverably. The stdio mode that would hand the parent's streams to the
 * child is forbidden here, and `tests/ops/verify.test.ts` asserts that its name
 * appears nowhere in this file. stdout and stderr are interleaved
 * into one log in arrival order: a failure's stack and the test name that
 * produced it are usually on opposite streams, and separating them makes the
 * log unreadable.
 *
 * **Three mechanisms guard verify, and each answers a question the others
 * cannot.**
 * - The **pin** (`<run>/verify-pinned.json`, written by `runStart` and only
 *   ever read here) answers *what may this run execute?* and is decided once,
 *   at run start.
 * - The **in-flight map** answers *is this same command already in flight in
 *   this process?* and lives exactly as long as one child.
 * - The **project verify lock** (`.mjloop/.verify-lock`) answers *is any verify
 *   command executing in this project?* and lives across processes.
 *
 * Collapsing any two of them produces a defect: sharing the map's key with the
 * cache's gives a null key in every project with the cache off, so a `lint`
 * call is handed the in-flight `test` call's digest; stretching the map to
 * cover the lock's question gives a guarantee that is false the moment
 * `/mjloop:web` runs two jobs in one project; and reading the live config
 * instead of the pin makes all three moot, because the string being
 * de-duplicated, cached and serialised is one an agent could have rewritten a
 * moment ago.
 *
 * **Never inside the *state* lock.** State is read once, unlocked, exactly as
 * `rosterSet` and `runLog` read it. `withLock`'s default acquire timeout is
 * 5 000 ms, so a subprocess held inside `.mjloop/.lock` would starve every
 * other tool in the session. The verify lock is a different directory taken for
 * a different reason, and keeping the two apart is what lets a fifteen-minute
 * suite run while the leader still logs results.
 */

/* ── constants ────────────────────────────────────────────────────────────── */

/** At most this many decisive lines reach a digest. `failures_total` reports how many there were. */
export const FAILURES_MAX = 20

/** Every line the digest carries is trimmed to this. The log keeps the rest. */
export const HEADLINE_MAX = 240

/**
 * How long an invocation waits before answering `phase: 'running'`.
 *
 * Deliberately under the MCP SDK's 60 000 ms client-side request timeout, with
 * room for framing. A tool that blocked for a four-minute test suite would die
 * mid-request and the caller would learn nothing at all.
 */
export const DEFAULT_WAIT_MS = 45_000

/**
 * Added to `verify.timeout_ms` to derive the lock's staleness threshold.
 *
 * **The invariant: the staleness threshold is always strictly greater than the
 * longest a live holder can hold.** `withLock` ages a lock from its `mtime` and
 * nothing refreshes it, so a threshold below the ceiling would reclaim the lock
 * out from under a running suite and produce exactly the two-suites-on-one-port
 * state the lock exists to prevent. Deriving it means the two numbers cannot be
 * configured into contradiction — which is why this is a constant and not a
 * config key.
 */
export const VERIFY_LOCK_STALE_MARGIN_MS = 60_000

/**
 * Retry interval while waiting for the verify lock.
 *
 * A verify wait is measured in minutes; `withLock`'s 25 ms default would be
 * 72 000 wakeups over half an hour to answer a question that changes at most
 * once.
 */
export const VERIFY_LOCK_POLL_MS = 250

/** Grace between SIGTERM and SIGKILL for a command that outran its ceiling. */
const KILL_GRACE_MS = 5_000

/**
 * How long the log may keep filling after the child's exit code is known.
 *
 * `close` is the honest settle — process ended, output complete — but it waits
 * on every holder of the log pipes it was handed, including a grandchild the
 * command left behind. Without a bound, one leftover daemon holds the project
 * verify lock for as long as it lives. Generous enough that an ordinary exit
 * settles on `close` microseconds after `exit` and never reaches this timer.
 */
const DRAIN_GRACE_MS = 2_000

/**
 * Lines that are never candidates for `headline` or `failures[]`.
 *
 * npm's script echo (`> @mjloop/engine@0.4.1 test`) and vitest's banner
 * (` RUN  v4.1.10 …`) are identical on green and on red and carry no
 * information. They matter more than they look: `errorSignature` hashes the
 * *first line* of an excerpt, so a headline defined as "the first non-empty
 * line" would give every failure of a command one constant signature,
 * `errorFingerprint` would match on the second consecutive failing cycle, and
 * `cycleAdvance` would halt a run that was making progress with "the same
 * verification failure recurred". **A banner must never become a signature.**
 *
 * They stay in the log, which is complete; they are excluded from the digest,
 * which is a summary.
 */
const SKIP_PATTERNS: RegExp[] = [/^>\s/, /^\s*RUN\s+v[\d.]/]

/**
 * Summary-shaped lines. The **last** one before exit is the preferred headline.
 *
 * On this repository that is `Tests  17 failed | 764 passed (781)` — the single
 * most informative line in a 44 KB log, and the one a first-line rule misses.
 */
const SUMMARY_PATTERNS: RegExp[] = [/^\s*(Tests|Test Files|Snapshots)\s/, /\b\d+\s+(failed|passed|errors?)\b/]

/**
 * Documented defaults. `verify.failure_patterns.<slot>` overrides them.
 *
 * A configured pattern is compiled with `new RegExp` inside a `try`: an invalid
 * pattern falls back to these and is reported in the digest's `headline` rather
 * than thrown, because a typo in a regex must not stop a project verifying.
 */
export const FAILURE_PATTERNS: Record<VerifySlot, RegExp[]> = {
  test: [/^\s*(FAIL|×|✗|✕)\s/, /^\s*\d+\)\s/, /\bAssertionError\b/, /^\s*Error:\s/],
  lint: [/^[^\s].*\(\d+,\d+\):\s+error\s+TS\d+/, /^\s*error\s/i],
  build: [/^\s*(error|ERROR)\b/, /\bfailed\b/i],
}

/* ── errors ───────────────────────────────────────────────────────────────── */

/**
 * Its own error rather than `ops/run.ts`'s `NoActiveRunError`.
 *
 * The precondition here is genuinely wider than every other op's: a `done` run
 * may still verify, so that a closing agent can re-run the suite against the
 * code as it finally stands and the commit that ships the run can rest on a
 * green digest taken *after* the documentation landed. `NoActiveRunError` says
 * only "call mjloop_run_start first", which is a rule this op does not have —
 * a `done` run *is* a run to verify, and starting a fresh one to satisfy the
 * message would throw away the tree the digest is supposed to describe.
 *
 * The wider precondition is why the two errors stay distinct even though this
 * module now shares `ops/run.ts`'s path helpers: what differs is the rule, not
 * the plumbing.
 */
export class NoRunToVerifyError extends Error {
  constructor(status: string) {
    super(
      `no run to verify — this project's status is "${status}". ` +
        'mjloop_verify_run executes against a run that is running, or one that is done and still closing. ' +
        'Call mjloop_run_start first.',
    )
    this.name = 'NoRunToVerifyError'
  }
}

/**
 * The run has a pin and it is gone.
 *
 * The asymmetry with the legacy fallback is deliberate: **absent-and-old is
 * legacy; absent-and-new is a deletion.** `state.started_at` is what makes the
 * two decidable — `runStart` is its only writer and it landed with the pin, so
 * every run that *could* carry a pin does. Falling back to the live config here
 * would make `rm` the downgrade attack the pin exists to prevent, since the
 * `PreToolUse` guard matches `Write|Edit` and not `rm` through `Bash`. What an
 * agent earns for deleting the file is a run that refuses to verify at all.
 */
export class PinnedVerifyMissingError extends Error {
  constructor(file: string) {
    super(
      `${file} is missing — this run pinned its verify block at run start and the pin is gone. ` +
        'The engine will not fall back to .mjloop/config.yaml: that fallback is exactly the downgrade ' +
        'the pin exists to prevent. Start a new run.',
    )
    this.name = 'PinnedVerifyMissingError'
  }
}

/** A partial write, or tampering. Refused for the same reason as an absent pin. */
export class PinnedVerifyInvalidError extends Error {
  constructor(file: string, detail: string) {
    super(
      `${file} will not parse and the engine will not fall back to .mjloop/config.yaml:\n${detail}`,
    )
    this.name = 'PinnedVerifyInvalidError'
  }
}

export class UnknownVerifySlotError extends Error {
  constructor(slot: string) {
    super(`"${slot}" is not a verify slot — the configured slots are test, lint and build`)
    this.name = 'UnknownVerifySlotError'
  }
}

/**
 * A label names a file in the run directory, so it goes through
 * `AgentNameSchema` — the one path-traversal check this system has, applied in
 * one place, exactly as `runLog` applies it to an agent name.
 */
export class InvalidVerifyLabelError extends Error {
  constructor(label: string, detail: string) {
    super(`"${label}" is not a usable verify label — it names a file in the run's verify directory:\n${detail}`)
    this.name = 'InvalidVerifyLabelError'
  }
}

/* ── the digest ───────────────────────────────────────────────────────────── */

export type { VerifySlot }

export interface VerifyRunInput {
  slot: VerifySlot
  /** Distinguishes two runs of one slot in a cycle. Validated by `AgentNameSchema`. */
  label?: string
  /** How long to wait for the child before returning `phase: 'running'`. */
  wait_ms?: number
}

export interface VerifyFailure {
  /** One decisive line, trimmed, never longer than `HEADLINE_MAX`. */
  line: string
  /** Which line of the log it came from, 1-based, so the reader can jump to it. */
  at: number
}

export interface VerifyDigest {
  /**
   * `'queued'` means **nothing ran**: another verify command in this project
   * holds the lock. It is deliberately not `'running'` — no child of this call
   * exists, and a digest that said otherwise is the one lie this design is
   * built to avoid.
   */
  phase: 'complete' | 'running' | 'queued'
  slot: VerifySlot
  /** What was executed — from the run's **pinned** copy, never from the live `config.yaml`. */
  command: string
  /** Which copy of the verify block ran. `'live'` occurs only for a run started before the pin existed. */
  source: 'pinned' | 'live'
  /**
   * What `.mjloop/config.yaml` holds for this slot *now*, when it differs from
   * the command that ran. `null` when they agree and when there is no pin. A
   * mid-run edit is made visible without being obeyed — **drift refuses
   * nothing.** A rule that halted a run on drift would hand any agent holding
   * `Write` a way to stop the run by editing a file this design deliberately
   * leaves hand-editable.
   */
  live_command: string | null
  /**
   * Repo-relative: `.mjloop/runs/<run>/cycle-NN/verify/<name>.log`. Empty while
   * `phase === 'queued'` and for a null slot — nothing was written. On a cache
   * hit it points at the *original* cycle's log: the output is never copied.
   */
  log: string
  /** `null` while `phase` is `'running'` or `'queued'`, and on a timeout or a kill. */
  exit_code: number | null
  timed_out: boolean
  /** True when this digest was reused from an earlier cycle of this run. */
  cached: boolean
  cached_from_cycle: number | null
  /** The decisive line. Max `HEADLINE_MAX` characters. */
  headline: string
  /** At most `FAILURES_MAX` entries. */
  failures: VerifyFailure[]
  /** How many decisive lines were found, so the cap is visible rather than silent. */
  failures_total: number
  lines: number
  bytes: number
  duration_ms: number
  /**
   * The cache fingerprint. `null` when the cache is off or the worktree could
   * not be digested. It is **not** the in-flight de-duplication key: that one
   * is `slot::label::command`, is always available, and is never null.
   */
  fingerprint: string | null
}

/* ── the in-flight de-duplicator ──────────────────────────────────────────── */

/** What the wait branch needs to know about a run it is not itself performing. */
interface VerifyProgress {
  /**
   * Whether the child has been spawned. One field, and it is the difference
   * between two honest answers: a wait that expires before this is set is
   * `queued`, and after it is `running`.
   */
  spawned: boolean
  /**
   * Whether this invocation ever found the project verify lock held.
   *
   * `spawned` alone cannot tell a caller *why* nothing has run yet. The window
   * before the spawn also contains the cache lookup, two `worktreeDigest` calls
   * (three git invocations each), the ledger append, the mkdir and the log open
   * — hundreds of milliseconds on a real repository with nothing contended at
   * all. Reporting contention for that is a digest asserting something that
   * never happened, which is precisely what this file refuses to do elsewhere.
   */
  contended: boolean
  logFile: string
  startedAt: number
}

interface InFlight {
  /**
   * The **completion** promise — the one that settles when the child exits, not
   * the wait-bounded one a caller receives.
   *
   * Conflating the two breaks in both directions. Storing the wait-bounded
   * promise means a slow suite resolves once as `phase: 'running'` and every
   * later call is handed that same stale digest forever, so the exit code is
   * never observable and the cache (which requires `exit_code === 0`) can never
   * be populated for exactly the suites worth caching. Storing only the
   * completion promise means a second caller blocks past the client timeout,
   * which is the failure `wait_ms` exists to avoid.
   */
  promise: Promise<VerifyDigest>
  /** Mutated by the run itself, read by every waiter attached to it. */
  progress: VerifyProgress
}

/**
 * In-flight de-duplication only. **Lifetime bounded by the child process.**
 *
 * Keyed on `slot`, `label` and `command` — never on the cache fingerprint,
 * which is `string | null` and computed only when the cache is on, so every
 * call in every default project would collide on one null key.
 *
 * The entry is deleted the moment the child settles. Without that prune, a
 * module-level map in a process that lives for the whole session is a permanent
 * memo of every verify result across every cycle and every run: an
 * unconditional cache that ignores `verify_cache`, memoises **failing**
 * results, survives `runStart`, and never re-checks that the log still exists —
 * every safety rule the real cache establishes, bypassed by an optimisation.
 *
 * Its scope is one process, and that is not the scope the hazard has:
 * `/mjloop:web` spawns one `claude` per queued job, each with its own MCP
 * server. Mutual exclusion across processes is the verify lock's job, and the
 * two compose rather than one being stretched to cover the other's question.
 */
const inFlight = new Map<string, InFlight>()

/* ── the ledger ───────────────────────────────────────────────────────────── */

/** `<cycleDir>/verify/index.json` — the engine's record of what the engine executed. */
export function verifyLedgerPath(cycleDir: string): string {
  return path.join(cycleDir, 'verify', 'index.json')
}

/**
 * The ledger for one cycle (or for `closing/`), or `[]`.
 *
 * The reader `runLog`'s contradiction check and the cockpit's Evidence tab both
 * import. Absence is not an error and never will be: a cycle with no
 * `verify/index.json` is every cycle of every project that predates this
 * milestone, and the check that reads this is inert there by design. A file
 * that will not parse is treated the same way — one unreadable ledger must not
 * blank a cycle, which is the rule `readCycleDetail` already applies to an
 * unreadable agent result.
 */
export async function readVerifyLedger(cycleDir: string): Promise<LedgerEntry[]> {
  const raw = await fs.readFile(verifyLedgerPath(cycleDir), 'utf8').catch(() => null)
  if (raw === null) return []
  try {
    const parsed = LedgerSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/**
 * One entry of `<run>/verify-cache.json`.
 *
 * Declared here rather than in `schemas/verify.ts` because — unlike the ledger
 * and the pin — this file is the only reader and the only writer of it.
 * Run-scoped and on disk, deliberately not in `state.json`: a cache in state
 * would be a new field the MCP server has to validate on every read and every
 * write, for data whose loss costs one re-run.
 */
const CacheEntrySchema = z.strictObject({
  fingerprint: z.string().min(1),
  slot: VerifySlotSchema,
  command: z.string().min(1),
  cycle: z.number().int().positive(),
  /** Run-relative, e.g. `cycle-02/verify/test.log`. */
  log: z.string().min(1),
  /**
   * The identity of the log **as it was when the entry was green**, checked
   * again on every hit.
   *
   * The entry stores a path, and that path is not immutable: a second
   * invocation of the same slot in the same cycle opens the very same file with
   * flag `'w'`. So a green run, a red re-run and a revert put the green entry's
   * fingerprint back in reach while the file it names holds the red output — and
   * a hit would then return `exit_code: 0` beside a headline and failures
   * extracted from a failing run. Existence is not identity; these two fields
   * are. A mismatch is a miss, which costs one re-run and can never be wrong.
   */
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  at: z.iso.datetime(),
})
const CacheSchema = z.array(CacheEntrySchema)
type CacheEntry = z.infer<typeof CacheEntrySchema>

/**
 * Read-modify-writes of one file, serialised within this process.
 *
 * The ledger takes no lock — this file is its only writer — but "one writer"
 * is a statement about modules, not about calls. `test` and `lint` dispatched
 * in the same cycle each write a `queued` entry *before* contesting the verify
 * lock, so two interleaved read-modify-writes of `index.json` are the ordinary
 * case rather than a race worth ignoring, and the loser's row would simply
 * vanish. Across processes the interleaving remains possible; the ledger is a
 * record rather than a decision, so the residue is a missing row and not a
 * wrong one.
 */
const fileQueues = new Map<string, Promise<void>>()

async function serialise<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(file) ?? Promise.resolve()
  const result = previous.then(fn, fn)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  fileQueues.set(file, tail)
  // Bounded: the queue for a file exists only while a write of it is pending.
  void tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file)
  })
  return await result
}

async function appendLedgerEntry(cycleDir: string, entry: LedgerEntry): Promise<void> {
  const file = verifyLedgerPath(cycleDir)
  await serialise(file, async () => {
    const entries = await readVerifyLedger(cycleDir)
    entries.push(entry)
    await writeJsonAtomic(file, entries, { backup: false })
  })
}

/**
 * Rewrite an entry in place.
 *
 * An invocation writes its entry before it finishes — `queued` before the lock
 * is won, `running` once the child is spawned — and amends it when the child
 * exits. Without the amendment a suite that ultimately exits 1 leaves a ledger
 * reading `null` forever, and `runLog`'s contradiction check — the whole reason
 * the ledger exists — is inert against it.
 *
 * Matched on `at` and the log name, both known before the file exists, which is
 * what lets a queued entry be written before there is anything else to say. The
 * *last* match wins: with an injected clock two invocations can share a
 * timestamp, and the newest row is the one this call wrote.
 */
async function amendLedgerEntry(
  cycleDir: string,
  at: string,
  log: string,
  patch: Partial<LedgerEntry>,
): Promise<void> {
  const file = verifyLedgerPath(cycleDir)
  await serialise(file, async () => {
    const entries = await readVerifyLedger(cycleDir)
    const target = entries.filter((entry) => entry.at === at && entry.log === log).at(-1)
    if (target === undefined) return
    Object.assign(target, patch)
    await writeJsonAtomic(file, entries, { backup: false })
  })
}

async function readCache(runDir: string): Promise<CacheEntry[]> {
  const raw = await fs.readFile(path.join(runDir, 'verify-cache.json'), 'utf8').catch(() => null)
  if (raw === null) return []
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

async function appendCacheEntry(runDir: string, entry: CacheEntry): Promise<void> {
  const file = path.join(runDir, 'verify-cache.json')
  await serialise(file, async () => {
    const entries = await readCache(runDir)
    entries.push(entry)
    await writeJsonAtomic(file, entries, { backup: false })
  })
}

/* ── where things live ────────────────────────────────────────────────────── */

/**
 * Where this invocation's log and ledger go — through `ops/run.ts`'s helpers,
 * never re-joined here.
 *
 * A second derivation of the run directory does not fail loudly when it drifts.
 * It fails silently: this file would keep writing logs and ledger rows into a
 * directory `writeHandoff` and the cockpit's Evidence tab no longer read, and a
 * verified cycle would simply stop being visible from the cycle. One padding
 * rule, one story-less `adhoc`, one place.
 *
 * Sharing the path helpers costs nothing this file was protecting. What
 * `verifyRun` must not reach is the **pin**: `runStart` writes
 * `verify-pinned.json` and this module validates it through
 * `PinnedVerifySchema` and nothing else, so the reader can never end up
 * checking the file against its own author's idea of it. Where a cycle lives is
 * a different question, and the whole point is that there is one answer to it.
 *
 * A `done` run writes into `closing/verify/`, outside every cycle directory.
 * That is the one precondition in this milestone admitting a terminal state,
 * and it is admitted because the alternative is a run whose last verified tree
 * is not the tree it ships.
 */
function workDirectory(projectDir: string, state: State): string {
  if (state.status === 'done') return path.join(runDirPath(projectDir, state), 'closing')
  return cycleDirPath(projectDir, state)
}

/* ── the executor ─────────────────────────────────────────────────────────── */

interface Plan {
  projectDir: string
  state: State
  slot: VerifySlot
  command: string
  source: 'pinned' | 'live'
  liveCommand: string | null
  verify: Config['verify']
  cacheOn: boolean
  patterns: RegExp[]
  /** Prepended to the headline when a configured pattern would not compile. */
  patternNotice: string | null
  runDir: string
  workDir: string
  verifyDir: string
  logName: string
  logFile: string
  now: Clock
}

export async function verifyRun(
  projectDir: string,
  input: VerifyRunInput,
  now: Clock = () => new Date(),
  /**
   * Stops the *wait*, never the child.
   *
   * `mjloop_verify_run` receives the MCP request's `extra.signal`, which fires
   * when the client cancels or times out the request. A user with
   * `MCP_TIMEOUT=30000` would otherwise have a four-minute suite killed at 30 s
   * and re-run from zero by the next call — the exact opposite of what
   * `phase: 'running'` exists to achieve. On abort this call abandons its own
   * pending wait and leaves the child attached to the in-flight completion
   * promise, so the next call learns the exit code. **Only `verify.timeout_ms`
   * kills a child.**
   */
  waitSignal?: AbortSignal,
): Promise<VerifyDigest> {
  const slotParsed = VerifySlotSchema.safeParse(input.slot)
  if (!slotParsed.success) throw new UnknownVerifySlotError(String(input.slot))
  const slot = slotParsed.data

  let label: string | null = null
  if (input.label !== undefined) {
    const parsed = AgentNameSchema.safeParse(input.label)
    if (!parsed.success) throw new InvalidVerifyLabelError(input.label, z.prettifyError(parsed.error))
    label = parsed.data
  }

  // Read once, unlocked. Nothing below calls `StateStore.update`.
  const state = await new StateStore(projectDir).get()
  if (state.run_id === null || state.track === null || (state.status !== 'running' && state.status !== 'done')) {
    throw new NoRunToVerifyError(state.status)
  }

  const runDir = runDirPath(projectDir, state)
  const workDir = workDirectory(projectDir, state)
  const verifyDir = path.join(workDir, 'verify')
  const logName = label === null ? slot : `${slot}--${label}`
  const logFile = path.join(verifyDir, `${logName}.log`)

  const pinFile = path.join(runDir, 'verify-pinned.json')
  const pinned = await readPin(pinFile)
  if (pinned === null && state.started_at !== null) throw new PinnedVerifyMissingError(pinFile)

  let verify: Config['verify']
  let live: Config | null
  if (pinned === null) {
    // A run started before the pin existed. The live config is what runs, so
    // its failure is fatal here exactly as it is in every other op.
    live = await loadConfig(projectDir)
    verify = live.verify
  } else {
    // The pin decides what runs, so a `config.yaml` that no longer parses costs
    // the drift report and switches the cache off — it must not stop a run
    // verifying, or an agent holding `Write` could halt the run by breaking a
    // file the engine has already stopped obeying.
    live = await loadConfig(projectDir).catch(() => null)
    verify = pinned.verify
  }
  const source = pinned === null ? 'live' : 'pinned'
  const command = verify[slot]

  // Drift is reported, never obeyed. A live `null` cannot be reported — the
  // ledger's `live_command` is a non-empty string or nothing — so a slot
  // deleted from `config.yaml` mid-run reads as agreement. The pinned command
  // is what ran either way, which is the only claim this field makes.
  const liveSlot = live === null ? null : live.verify[slot]
  const liveCommand = source === 'pinned' && liveSlot !== command ? liveSlot : null

  if (command === null) {
    // Absent by design. A project with no build step has not made a mistake,
    // and `agents/verifier.md` already encodes a null slot as a rule the
    // verifier follows. No log, and no ledger entry either — `LedgerEntry`
    // requires a non-empty command, and inventing one to record that nothing
    // ran would be the ledger's first false row.
    return {
      phase: 'complete',
      slot,
      command: '',
      source,
      live_command: liveSlot,
      log: '',
      exit_code: null,
      timed_out: false,
      cached: false,
      cached_from_cycle: null,
      headline: 'slot is null in config — nothing to run',
      failures: [],
      failures_total: 0,
      lines: 0,
      bytes: 0,
      duration_ms: 0,
      fingerprint: null,
    }
  }

  const { patterns, patternNotice } = resolvePatterns(slot, verify.failure_patterns[slot])

  const plan: Plan = {
    projectDir,
    state,
    slot,
    command,
    source,
    liveCommand,
    verify,
    // `verify_cache` is top-level and deliberately **not** pinned: it decides
    // whether a proven-green result may be reused, not what runs.
    cacheOn: live?.verify_cache === true,
    patterns,
    patternNotice,
    runDir,
    workDir,
    verifyDir,
    logName,
    logFile,
    now,
  }

  const waitMs = input.wait_ms ?? DEFAULT_WAIT_MS

  // 1. The map first. A second call in this process for the same
  //    `slot::label::command` attaches and takes no lock. Reversing these two
  //    steps would queue a process behind a lock it already holds — `withLock`
  //    is not reentrant, so that is a self-inflicted `lock_timeout_ms` stall
  //    for an answer already in flight three lines away.
  const key = `${slot}::${label ?? ''}::${command}`
  const existing = inFlight.get(key)
  if (existing !== undefined) return await raceTheWait(existing, plan, waitMs, waitSignal)

  // 2. On a miss the completion promise is created and registered, and
  //    everything below happens inside it: the cache lookup (which takes no
  //    lock — a hit executes nothing and needs exclusion from nothing), then
  //    the verify lock, the pre-spawn digest, the child, the post-exit digest
  //    and the cache decision, and only then release.
  const progress: VerifyProgress = { spawned: false, contended: false, logFile, startedAt: Date.now() }
  const entry: InFlight = { promise: execute(plan, progress), progress }
  inFlight.set(key, entry)
  void entry.promise
    .finally(() => {
      inFlight.delete(key)
    })
    // The completion promise outlives this call. A rejection the wait branch
    // never observed must not surface as an unhandled rejection and take the
    // server down; the next caller sees it, or nobody does.
    .catch(() => {})

  // 3. The caller still receives `Promise.race([completion, waitTimer])`.
  return await raceTheWait(entry, plan, waitMs, waitSignal)
}

async function raceTheWait(
  entry: InFlight,
  plan: Plan,
  waitMs: number,
  waitSignal: AbortSignal | undefined,
): Promise<VerifyDigest> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs)
    if (waitSignal?.aborted === true) resolve(null)
    else waitSignal?.addEventListener('abort', () => resolve(null), { once: true })
  })
  try {
    const settled = await Promise.race([entry.promise, waited])
    if (settled !== null) return settled
    return await interimDigest(entry.progress, plan)
  } finally {
    clearTimeout(timer)
  }
}

/** What a caller is told when the wait expires before the child does. */
async function interimDigest(progress: VerifyProgress, plan: Plan): Promise<VerifyDigest> {
  const duration = Date.now() - progress.startedAt
  if (!progress.spawned) {
    return {
      ...emptyDigest(plan),
      phase: 'queued',
      // `queued` either way — nothing ran — but only one of these two sentences
      // is true at a time, and the lock is the only thing that knows which.
      headline: progress.contended
        ? 'another verify command is running in this project — call again'
        : 'the command has not started yet — call again',
      duration_ms: duration,
    }
  }
  // The log so far. A partial log digests exactly like a complete one; what
  // makes this digest honest is `exit_code: null`, not a shorter summary.
  const text = await fs.readFile(progress.logFile, 'utf8').catch(() => '')
  const extracted = extract(text, plan.patterns, plan.patternNotice)
  return {
    ...emptyDigest(plan),
    ...extracted,
    phase: 'running',
    log: path.relative(plan.projectDir, progress.logFile),
    headline: extracted.headline === '' ? 'the command is still running — call again for the exit code' : extracted.headline,
    duration_ms: duration,
  }
}

function emptyDigest(plan: Plan): VerifyDigest {
  return {
    phase: 'running',
    slot: plan.slot,
    command: plan.command,
    source: plan.source,
    live_command: plan.liveCommand,
    log: '',
    exit_code: null,
    timed_out: false,
    cached: false,
    cached_from_cycle: null,
    headline: '',
    failures: [],
    failures_total: 0,
    lines: 0,
    bytes: 0,
    duration_ms: 0,
    fingerprint: null,
  }
}

async function execute(plan: Plan, progress: VerifyProgress): Promise<VerifyDigest> {
  const at = plan.now().toISOString()

  // The cache lookup, deliberately outside the lock.
  if (plan.cacheOn) {
    const worktree = await worktreeDigest(plan.projectDir)
    if (worktree !== null) {
      const fingerprint = verifyFingerprint(plan.command, worktree)
      const hit = await findCacheHit(plan.runDir, fingerprint)
      if (hit !== null) return await reuse(plan, hit, fingerprint, at)
    }
  }

  // Nothing ran yet and this invocation is about to contest the lock. The entry
  // goes in now: without it a verifier could log `status: "pass"` citing a
  // command that only ever queued, and the contradiction check would have
  // nothing to read.
  await appendLedgerEntry(plan.workDir, {
    slot: plan.slot,
    command: plan.command,
    source: plan.source,
    live_command: plan.liveCommand,
    log: `${plan.logName}.log`,
    phase: 'queued',
    exit_code: null,
    timed_out: false,
    fingerprint: null,
    cached_from_cycle: null,
    duration_ms: null,
    at,
  })

  try {
    return await withLock(resolveLoopPaths(plan.projectDir).verifyLock, () => spawnAndDigest(plan, progress, at), {
      timeoutMs: plan.verify.lock_timeout_ms,
      staleMs: plan.verify.timeout_ms + VERIFY_LOCK_STALE_MARGIN_MS,
      pollMs: VERIFY_LOCK_POLL_MS,
      onWait: () => {
        progress.contended = true
      },
    })
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error
    // The acquire gave up. The ledger entry stays `queued`, which is what
    // happened, and the digest resolves rather than rejecting into a promise
    // nobody is awaiting.
    return {
      ...emptyDigest(plan),
      phase: 'queued',
      headline:
        `gave up waiting for the project verify lock after ${plan.verify.lock_timeout_ms}ms — ` +
        'another verify command is still running in this project',
      duration_ms: Date.now() - progress.startedAt,
    }
  }
}

/** What a hit carries: the entry, and the bytes it was proved against. */
interface CacheHit {
  entry: CacheEntry
  text: string
}

/**
 * A hit whose log is still, byte for byte, the output that was green.
 *
 * A digest must be able to point the reader at real output — and at the *right*
 * output. Existence alone was the first version of this check and it is not
 * enough: `spawnAndDigest` truncates and rewrites a slot's log on every
 * invocation in a cycle, so a file that still exists may since have been filled
 * with a failing run's text. The recorded size and hash are re-checked here, and
 * the verified bytes are handed to `reuse` so nothing re-reads a file that could
 * change between the check and the read.
 */
async function findCacheHit(runDir: string, fingerprint: string): Promise<CacheHit | null> {
  const entries = await readCache(runDir)
  // Newest first: a later cycle's entry describes the same tree and the same
  // command, and pointing at the most recent log keeps the reader near the
  // work. Matching on the fingerprint alone is deliberate — it already carries
  // the command, which is the only thing that could have run; the slot is a
  // label on it.
  for (const entry of [...entries].reverse()) {
    if (entry.fingerprint !== fingerprint) continue
    const raw = await fs.readFile(path.join(runDir, entry.log)).catch(() => null)
    if (raw === null) continue
    // An overwritten log does not disqualify an older entry that names an
    // untouched one, so this keeps looking rather than giving up.
    if (raw.byteLength !== entry.bytes || logIdentity(raw) !== entry.sha256) continue
    return { entry, text: raw.toString('utf8') }
  }
  return null
}

/** The log's content identity, recorded when it was green and re-checked on every hit. */
function logIdentity(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * A reused result. It still writes a ledger entry, so `verify/index.json`
 * remains a complete record of what this cycle's verification rested on,
 * whether or not a process ran.
 *
 * The headline is **not** prefixed with a reuse marker. Two structured booleans
 * the reader already has cost nothing; a sentence prepended to the one field
 * that ends up in an excerpt would make a hit more expensive than the run it
 * replaced — which is what the first draft of this idea did.
 */
async function reuse(plan: Plan, hit: CacheHit, fingerprint: string, at: string): Promise<VerifyDigest> {
  const original = path.join(plan.runDir, hit.entry.log)
  // The bytes `findCacheHit` proved, not a second read of a file that may have
  // been rewritten in between.
  const extracted = extract(hit.text, plan.patterns, plan.patternNotice)
  await appendLedgerEntry(plan.workDir, {
    slot: plan.slot,
    command: plan.command,
    source: plan.source,
    live_command: plan.liveCommand,
    // Run-relative rather than a bare name, because this log is not in this
    // cycle's directory. `cached_from_cycle` is what tells the reader to expect
    // that, and the output is never copied.
    log: hit.entry.log,
    phase: 'complete',
    exit_code: 0,
    timed_out: false,
    fingerprint,
    cached_from_cycle: hit.entry.cycle,
    duration_ms: 0,
    at,
  })
  return {
    ...emptyDigest(plan),
    ...extracted,
    phase: 'complete',
    log: path.relative(plan.projectDir, original),
    exit_code: 0,
    cached: true,
    cached_from_cycle: hit.entry.cycle,
    fingerprint,
  }
}

async function spawnAndDigest(plan: Plan, progress: VerifyProgress, at: string): Promise<VerifyDigest> {
  await fs.mkdir(plan.verifyDir, { recursive: true })

  // Both digests are taken **inside** the lock. They exist to prove the tree
  // did not move around the child; taken outside it they would be compared
  // against a tree a second verify process was already moving, which is the
  // same defect as having no second digest at all arriving by another route.
  const before = plan.cacheOn ? await worktreeDigest(plan.projectDir) : null
  const fingerprint = before === null ? null : verifyFingerprint(plan.command, before)

  const started = Date.now()
  const handle = await fs.open(plan.logFile, 'w')
  let open = true
  let writes: Promise<unknown> = Promise.resolve()

  const sink = (chunk: Buffer): void => {
    if (!open) return
    writes = writes.then(() => (open ? handle.write(chunk) : undefined)).catch(() => undefined)
  }

  // `shell: true` is mandatory: the config values are shell strings
  // (`cd engine && npm test`), not argv arrays, so there is no escaping to be
  // had. What bounds the exposure is the pin, not a quoting rule.
  //
  // `detached: true` is what makes `timeout_ms` mean anything. With a compound
  // command — `cd engine && npm test`, the shape `mjloop:init` detects and this
  // project's own config uses — `/bin/sh` cannot exec in place: it forks, and
  // `child.kill()` then signals the shell alone while the suite runs on holding
  // the log pipes it was handed. Detached makes the child a process group leader,
  // so `killTree` can signal the whole group. Not on Windows, where `detached`
  // means a new console rather than a new group and the group kill is not
  // available anyway.
  const child = spawn(plan.command, {
    cwd: plan.projectDir,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  progress.spawned = true

  // **Everything the child can say is subscribed in this tick, before any
  // await.** `spawn` returns before the process has run; `close`, `exit` and
  // `error` are all emitted asynchronously and none of them is replayed for a
  // listener that attaches later. An `await` here — the ledger amendment used
  // to sit exactly here — is a window in which a fast command's `close` is
  // emitted with nobody watching: the outcome promise never settles, the verify
  // lock is held until it goes stale, and an `error` with no listener is
  // rethrown by `EventEmitter` as an uncaught exception that ends the server.
  const settling = new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    let timedOut = false
    let done = false
    let killer: ReturnType<typeof setTimeout> | undefined
    let drain: ReturnType<typeof setTimeout> | undefined
    const ceiling = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      killer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }, plan.verify.timeout_ms)
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(ceiling)
      if (killer !== undefined) clearTimeout(killer)
      if (drain !== undefined) clearTimeout(drain)
      // This process's ends of the pipes, released explicitly. On the drain
      // path below they are still open and would otherwise keep an fd — and the
      // event loop — attached to a process nobody is waiting for any more.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code, timedOut })
    }
    // A spawn failure — no shell, a cwd that vanished — reports no exit code.
    // It is `exit_code: null` and nothing more: turning it into `blocked` would
    // be this file declaring a verdict.
    child.on('error', () => finish(null))
    // `close` is the preferred settle: it means the process ended *and* its
    // output is complete, which is what the digest is extracted from.
    child.on('close', (code) => finish(code))
    // `exit` is the fallback, and it is not redundant. A grandchild that
    // outlives the shell — a daemon a suite left running, or a survivor of a
    // group kill — keeps the log pipes open, and `close` then waits on
    // *its* lifetime rather than on the command's. Draining for a bounded
    // moment after the exit code is known settles with the truth instead of
    // holding the project verify lock indefinitely.
    child.on('exit', (code) => {
      // **The ceiling is disarmed here, not in `finish`.** By `exit` the exit
      // code is a fact and there is nothing left for a kill to bound. Left
      // armed, it would fire *during the drain* and flip `timedOut` under a
      // command that exited in time with a real code: the digest would carry
      // `timed_out: true, exit_code: null` — "it was killed at the configured
      // ceiling" — beside a headline reading `0 failed | 781 passed`, and the
      // green suite would be re-run.
      clearTimeout(ceiling)
      // Whether the ceiling had already fired is decided *here*, by the
      // callback that observed the exit, rather than read out of a variable at
      // resolve time two seconds later.
      const killed = timedOut
      drain ??= setTimeout(() => {
        // **The escalation, on the one path it exists for.** The leader is
        // dead — that is what `exit` means — so anything still holding the log
        // pipes two seconds after a group SIGTERM is an orphan that ignored it.
        // `finish` clears `killer`, so without this the drain would cancel the
        // SIGKILL three seconds before it was due and abandon the group: the
        // engine would report `timed_out: true`, release the verify lock, and
        // leave the thing that outran the ceiling holding whatever it holds.
        if (killed) killTree(child, 'SIGKILL')
        finish(code)
      }, DRAIN_GRACE_MS)
    })
  })

  child.stdout?.on('data', sink)
  child.stderr?.on('data', sink)

  await amendLedgerEntry(plan.workDir, at, `${plan.logName}.log`, { phase: 'running', fingerprint })

  const outcome = await settling

  await writes
  open = false
  await handle.close()
  const duration = Date.now() - started

  const after = plan.cacheOn ? await worktreeDigest(plan.projectDir) : null

  // Read once, as bytes: the digest is extracted from it and — if this run turns
  // out to be cacheable — its identity is recorded from the same read, so the
  // entry can never describe a file the log already moved on from.
  const raw = await fs.readFile(plan.logFile).catch(() => Buffer.alloc(0))
  const text = raw.toString('utf8')
  const extracted = extract(text, plan.patterns, plan.patternNotice)
  // A kill reports no exit code: the number a killed child carries describes
  // the signal, not the suite.
  const exitCode = outcome.timedOut ? null : outcome.code

  // What may enter the cache. **The post-exit re-digest is not optional.** Two
  // ordinary things move the tree while a command runs: other agents dispatched
  // concurrently write files, and the verify command itself writes tracked ones
  // (`npm run build` into a tracked `dist/`). Without the second digest the
  // entry asserts *green at D0* while the process observed a tree moving from
  // D0 to D1 — and the reuse then bites when a later cycle reverts a change,
  // putting the tree back at D0 and drawing a green hit for a state nothing
  // ever verified.
  //
  // A failure is never cached. Reusing a red result would let the
  // repeated-error guard fire on output nobody re-produced, halting a run with
  // "the same verification failure recurred" about a defect already fixed.
  if (exitCode === 0 && !outcome.timedOut && fingerprint !== null && after !== null && after === before) {
    await appendCacheEntry(plan.runDir, {
      fingerprint,
      slot: plan.slot,
      command: plan.command,
      cycle: plan.state.cycle,
      log: path.relative(plan.runDir, plan.logFile),
      // The log is not immutable — the next invocation of this slot in this
      // cycle truncates it — so the entry carries what it looked like green.
      bytes: raw.byteLength,
      sha256: logIdentity(raw),
      at,
    })
  }

  await amendLedgerEntry(plan.workDir, at, `${plan.logName}.log`, {
    phase: 'complete',
    exit_code: exitCode,
    timed_out: outcome.timedOut,
    duration_ms: duration,
    fingerprint,
  })

  return {
    ...emptyDigest(plan),
    ...extracted,
    phase: 'complete',
    log: path.relative(plan.projectDir, plan.logFile),
    exit_code: exitCode,
    timed_out: outcome.timedOut,
    duration_ms: duration,
    fingerprint,
  }
}

/**
 * Signal the command's whole process group, falling back to the shell alone.
 *
 * `child.kill()` addresses one pid. For any compound command the pid it
 * addresses is `/bin/sh`, and the suite is its child — so the ceiling would kill
 * the shell, orphan the suite, and leave the pipes (and the project verify lock)
 * held by a process the engine can no longer see. Because the child was spawned
 * `detached`, its pid is also its process group id, and the negative pid reaches
 * every descendant that has not deliberately left the group.
 *
 * Both calls are allowed to fail: the ordinary reason is that the group is
 * already gone, which is the outcome being asked for.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/* ── the pin ──────────────────────────────────────────────────────────────── */

/** `null` only when the file is absent. A pin that exists and will not parse is refused. */
async function readPin(file: string): Promise<PinnedVerify | null> {
  const raw = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return null
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch (error) {
    throw new PinnedVerifyInvalidError(file, (error as Error).message)
  }
  const parsed = PinnedVerifySchema.safeParse(document)
  if (!parsed.success) throw new PinnedVerifyInvalidError(file, z.prettifyError(parsed.error))
  return parsed.data
}

/* ── what a digest extracts ───────────────────────────────────────────────── */

function resolvePatterns(slot: VerifySlot, configured: string[]): { patterns: RegExp[]; patternNotice: string | null } {
  if (configured.length === 0) return { patterns: FAILURE_PATTERNS[slot], patternNotice: null }
  const compiled: RegExp[] = []
  for (const pattern of configured) {
    try {
      compiled.push(new RegExp(pattern))
    } catch {
      return {
        patterns: FAILURE_PATTERNS[slot],
        patternNotice: `verify.failure_patterns.${slot}: "${pattern}" will not compile — using the defaults. `,
      }
    }
  }
  return { patterns: compiled, patternNotice: null }
}

interface Extracted {
  headline: string
  failures: VerifyFailure[]
  failures_total: number
  lines: number
  bytes: number
}

/**
 * The bounded summary of a log.
 *
 * `headline` is, in order of preference: the **last** summary-shaped line
 * before exit; otherwise the first failure line; otherwise the first
 * non-skipped, non-empty line. Digit runs are left intact — the collapsing to
 * `N` happens inside `errorSignature`, and doing it twice would make the log
 * and the signature disagree about what was seen.
 */
function extract(text: string, patterns: RegExp[], notice: string | null): Extracted {
  const all = text.split(/\r?\n/)
  if (all.at(-1) === '') all.pop()

  // Every pattern is matched against the **raw** line and only the reported
  // copy is trimmed and capped. Matching a trimmed line would quietly change
  // what the patterns mean: `/^[^\s].*\(\d+,\d+\):\s+error\s+TS\d+/` exists to
  // pick tsc's own error lines out of the indented context it prints beneath
  // them, and trimming first makes every indented line eligible.
  const candidates: { raw: string; at: number }[] = []
  for (const [index, line] of all.entries()) {
    if (line.trim() === '') continue
    if (SKIP_PATTERNS.some((pattern) => pattern.test(line))) continue
    candidates.push({ raw: line, at: index + 1 })
  }

  const failures = candidates.filter((candidate) => patterns.some((pattern) => pattern.test(candidate.raw)))
  const summary = candidates.filter((candidate) => SUMMARY_PATTERNS.some((pattern) => pattern.test(candidate.raw))).at(-1)

  const headline = summary?.raw ?? failures[0]?.raw ?? candidates[0]?.raw ?? ''
  return {
    headline: cap(`${notice ?? ''}${headline.trim()}`),
    failures: failures.slice(0, FAILURES_MAX).map((candidate) => ({ line: cap(candidate.raw), at: candidate.at })),
    failures_total: failures.length,
    lines: all.length,
    bytes: Buffer.byteLength(text),
  }
}

function cap(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > HEADLINE_MAX ? trimmed.slice(0, HEADLINE_MAX) : trimmed
}
