import * as z from 'zod'
import { VerifySchema } from './config.js'

/**
 * The shapes the engine's own verification rests on: what a run is allowed to
 * execute, and the record of what it executed.
 *
 * Both live in `schemas/` rather than in `ops/verify.ts` because their writers
 * and their readers are different modules that must not import each other.
 * `runStart` writes the pin and `verifyRun` reads it; `verifyRun` writes the
 * ledger and `runLog`, `writeHandoff`, `readRunHistory` and the cockpit's read
 * api all parse it. A shape declared beside one of those writers would make
 * every other one depend on a module it has no business importing.
 */

/** The three slots a project may configure. Mirrors `VerifySchema`'s keys. */
export const VerifySlotSchema = z.enum(['test', 'lint', 'build'])

/**
 * How far an invocation got.
 *
 * Three members, not two, and the third is the one that is easy to omit.
 * `queued` means **nothing ran**: another verify command in this project holds
 * the project verify lock. It is not `running` — no child of that invocation
 * exists — and it is not a failure either. `runLog`'s contradiction check
 * refuses a `pass` citing a `queued` command for the same reason it refuses one
 * citing a `running` command: a verdict resting on a suite that never started
 * is a verdict resting on nothing.
 *
 * Deliberately not called `status`. `VerifyDigest` reports facts and never a
 * verdict, and the two words must not sit beside each other in a leader's
 * context.
 */
export const VerifyPhaseSchema = z.enum(['queued', 'running', 'complete'])

/**
 * One line of `cycle-NN/verify/index.json` — the engine's record of what the
 * engine itself executed.
 *
 * An entry is written before its command finishes and amended in place when it
 * does. That is why `exit_code` and `duration_ms` are nullable: an invocation
 * that is still queued for the lock, or whose child is still running, has
 * neither, and leaving the row out until it did would make the ledger silent
 * for exactly as long as the question "did this actually run?" is live.
 */
export const LedgerEntrySchema = z.strictObject({
  slot: VerifySlotSchema,
  /** What was executed — the pinned string, byte for byte. */
  command: z.string().min(1),
  /**
   * Which copy of the verify block this invocation executed. `'live'` occurs
   * only for a run started before the pin existed (`state.started_at === null`).
   */
  source: z.enum(['pinned', 'live']),
  /**
   * What `.mjloop/config.yaml` holds for this slot *now*, when it differs from
   * the command that ran. `null` when they agree, and when there is no pin.
   *
   * Drift is recorded and never obeyed, and never refuses anything: a rule that
   * halted a run on drift would hand any agent holding `Write` a way to stop
   * the run by editing a file this project deliberately leaves hand-editable.
   */
  live_command: z.string().min(1).nullable().default(null),
  /** Log file name within `cycle-NN/verify/`. Empty when nothing was written. */
  log: z.string(),
  phase: VerifyPhaseSchema,
  /** `null` while queued or running, and on a timeout or a kill. */
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean().default(false),
  /**
   * The cache fingerprint (`verifyFingerprint`). `null` when the cache is off
   * or the worktree could not be digested. It is **not** the in-flight
   * de-duplication key — that one is `slot::label::command` and always exists.
   */
  fingerprint: z.string().min(1).nullable().default(null),
  /** Set when this entry reused an earlier cycle's green result. */
  cached_from_cycle: z.number().int().positive().nullable().default(null),
  /** Filled in by the amendment; `null` until the child exits. */
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  /**
   * When the entry was first written. The amendment matches on this and the
   * log name, both of which are known before the file exists — which is what
   * lets a queued entry be written before there is anything else to say.
   */
  at: z.iso.datetime(),
})

export const LedgerSchema = z.array(LedgerEntrySchema)

/**
 * The run's frozen copy of the verify block:
 * `.mjloop/runs/<run>/verify-pinned.json`.
 *
 * The invariant it exists for: **what the engine executes during a run is
 * decided once, at run start, and nothing the run itself writes can change
 * it.** `config.yaml` is hand-editable by deliberate decision, so an agent
 * holding `Write` can rewrite a verify command mid-run — and this milestone
 * hands that string straight to `spawn`. The pin bounds the window to a run
 * boundary, which is where an operator already expects a configuration change
 * to land.
 *
 * `verify-pinned.json` is in `PROTECTED_BASENAMES`, which the `PreToolUse`
 * guard enforces by basename anywhere under `.mjloop/`. That single word is the
 * whole enforcement mechanism.
 */
export const PinnedVerifySchema = z.strictObject({
  /**
   * Bumped only if this wrapper's own shape changes. The block inside it needs
   * no version of its own: it is re-parsed through the live `VerifySchema`, so
   * a pin written before a key existed gains that key's default on read. That
   * is the whole reason this wraps `VerifySchema` rather than restating the
   * three command strings — every future `verify.*` key is pinned
   * automatically, and every older pin keeps parsing.
   */
  version: z.literal(1),
  pinned_at: z.string().min(1),
  verify: VerifySchema,
})

export type VerifySlot = z.infer<typeof VerifySlotSchema>
export type VerifyPhase = z.infer<typeof VerifyPhaseSchema>
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>
export type PinnedVerify = z.infer<typeof PinnedVerifySchema>
