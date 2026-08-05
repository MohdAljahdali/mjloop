import type { StateSummary } from '../ops/summary.js'

/**
 * Whether the loop run a job started has finished.
 *
 * This exists because process exit cannot answer the question. `claude
 * "/mjloop:build P001-S02"` opens the interactive session, submits the command,
 * and then *stays open* waiting for the next message — so a queue that watched
 * for exit would wait forever on its first job. What ends a job is the run
 * ending, and the run is `.mjloop/state.json`.
 *
 * Kept pure and separate from the queue so the whole decision is testable
 * without spawning anything.
 */

export type Verdict =
  /** No run has started yet. The session is still booting, or the command was rejected. */
  | 'waiting'
  /** A run is under way. */
  | 'running'
  /** A run is suspended waiting for a person: not over, and not to be prompted about. */
  | 'suspended'
  /** The run this job started has reached a terminal status. */
  | 'complete'

export interface Tracker {
  /** True once this job's run has been seen `running`. */
  started: boolean
  /** The run id observed when it started, kept so a later run cannot end this job. */
  runId: string | null
  /**
   * What was on record the first time this job looked, and `null` until it has.
   *
   * A suspension can outlast anything — it is waiting on a person — so a job
   * queued while `state.json` already sits `waiting_for_user` would otherwise
   * adopt somebody else's run, and tear its own session down the moment the run
   * it actually started appeared under a different id.
   */
  prior: { runId: string | null } | null
}

export const NEW_TRACKER: Tracker = { started: false, runId: null, prior: null }

/**
 * `paused` is deliberately absent: a paused run is one somebody intends to
 * continue, and ending the job would kill the session they meant to return to.
 * `idle` is present because a run that was running and is now idle is over —
 * whatever reset the state, there is nothing left for this job to wait on.
 */
const TERMINAL: ReadonlySet<StateSummary['status']> = new Set(['done', 'halted', 'failed', 'idle'])

/**
 * The two statuses a run waits on a person in, and the reason they get a verdict
 * of their own rather than folding into `running`.
 *
 * Nonterminal, so the job keeps the terminal the operator will resume in — a
 * completed job takes its session with it, and the whole point of a resumable
 * suspension is that the same session picks the run back up. But not `running`
 * either: a run waiting on a decision is silent on purpose, and the stall
 * banner exists to say a *working* session has gone quiet.
 */
const SUSPENDED: ReadonlySet<StateSummary['status']> = new Set(['waiting_for_user', 'budget_exhausted'])

export interface Observation {
  tracker: Tracker
  verdict: Verdict
}

export function observe(tracker: Tracker, summary: StateSummary): Observation {
  // A recovered summary came from `.bak` — it describes the write *before* the
  // last one, so a run it calls finished may have finished, or may have been
  // mid-cycle when the primary went unreadable. Ending a job on it kills a live
  // session; waiting on it costs a stall banner. The cheap mistake is the one
  // to make, and `stateSummary` already flags the case for exactly this reason.
  if (summary.recovered) {
    return { tracker, verdict: tracker.started ? 'running' : 'waiting' }
  }

  if (!tracker.started) {
    const prior = tracker.prior ?? { runId: summary.run_id }
    // A suspended run counts as started, but only once it is a *different* run
    // from the one this job found on record: a run reaches one of those statuses
    // only by having run, so a job that never attached would still be `waiting`
    // when its own run finished, holding the session open forever — while a
    // suspension already there when the job was queued belongs to somebody else,
    // and adopting it would end this job the moment its own run appeared.
    const suspended = SUSPENDED.has(summary.status)
    if (summary.status !== 'running' && !(suspended && summary.run_id !== prior.runId)) {
      return { tracker: { ...tracker, prior }, verdict: 'waiting' }
    }
    return {
      tracker: { started: true, runId: summary.run_id, prior },
      verdict: suspended ? 'suspended' : 'running',
    }
  }

  // A different run id means this job's run ended and another began between two
  // polls — a queue advancing faster than the poller, or a human starting a run
  // in their own terminal. Either way this job's run is over.
  if (summary.run_id !== tracker.runId) return { tracker, verdict: 'complete' }

  if (SUSPENDED.has(summary.status)) return { tracker, verdict: 'suspended' }
  return { tracker, verdict: TERMINAL.has(summary.status) ? 'complete' : 'running' }
}

/**
 * Whether a session that is running has gone quiet long enough to be worth
 * mentioning.
 *
 * `config.yaml` ships `autonomous: false`, which means the Stop hook does not
 * carry a session across cycles: it can end its turn mid-run and wait for a
 * human who has gone to make coffee. Nothing is inferred from silence beyond
 * "say something to the user" — the page shows a banner and a button, and the
 * decision stays theirs.
 */
export function isStalled(verdict: Verdict, msSinceOutput: number, thresholdMs: number): boolean {
  return verdict === 'running' && msSinceOutput >= thresholdMs
}
