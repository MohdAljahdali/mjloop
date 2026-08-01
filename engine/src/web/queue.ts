import type { StateSummary } from '../ops/summary.js'
import { NEW_TRACKER, isStalled, observe, type Tracker, type Verdict } from './completion.js'
import type { Job, JobStatus, Message, SessionView } from './protocol.js'
import type { LoopSession, SessionFactory } from './session.js'

/** How long a running session may stay silent before the page is told. */
export const STALL_MS = 90_000

/**
 * The shutdown ladder. An interactive session does not exit when its run ends,
 * so every finished job is closed by us: ask, insist, compel, and finally stop
 * waiting. The last rung matters — a wedged pty must not hold the queue.
 */
const EXIT_WAIT_MS = 10_000
const TERM_WAIT_MS = 3_000
const KILL_WAIT_MS = 3_000

/** Per job. Enough to scroll back through a cycle, bounded so a loud run cannot eat the heap. */
const TRANSCRIPT_MAX = 1_000_000
/** How many finished transcripts to keep. */
const TRANSCRIPT_KEEP = 20

export interface QueueEvents {
  onOutput: (jobId: string, data: string) => void
  /** Anything that changes what the page should draw: job status, session, stall. */
  onChange: () => void
  onNotice: (message: Message) => void
}

export interface QueueOptions extends QueueEvents {
  cwd: string
  spawn: SessionFactory
  clock?: () => Date
}

type ShutdownPhase = 'exit' | 'term' | 'kill'

interface Active {
  job: Job
  session: LoopSession
  tracker: Tracker
  verdict: Verdict
  /** Timestamp of the last byte out of the pty, for the stall detector. */
  lastOutput: number
  /** Null while the job is live; set once we have started closing it. */
  shutdown: { phase: ShutdownPhase; since: number } | null
  /**
   * What the job's status becomes once the session is gone. Set when we decide
   * to close it, so the exit handler does not have to re-derive whether this
   * was a completed run, a cancellation, or a crash.
   */
  outcome: { status: JobStatus; reason: Message | null } | null
  cols: number
  rows: number
}

/**
 * A strictly sequential queue of loop commands.
 *
 * Sequential is not a simplification. `.mjloop/state.json` holds one run, and
 * two loops running against one project overwrite each other's state — so the
 * constraint is enforced here in code rather than left to whoever is clicking.
 *
 * The queue never polls. `observe` is called by the server's poller with the
 * summary it already read, which keeps every decision in this class synchronous
 * and testable against a fake session and a hand-written summary.
 */
export class JobQueue {
  private readonly options: QueueOptions
  private readonly clock: () => Date
  private readonly pending: Job[] = []
  private readonly finished: Job[] = []
  private readonly transcripts = new Map<string, string>()
  private active: Active | null = null
  private counter = 0
  private cols = 120
  private rows = 40
  private stalledSince: string | null = null
  /**
   * Set when a job fails. The queue stops rather than running the rest, because
   * a person who returns to fifteen repetitions of one failure has been given
   * less than a person who returns to one.
   *
   * It is lifted again the moment there is nothing left for it to hold — see
   * `settle`. A pause that outlives the jobs it was protecting is indistinct
   * from a broken Run button.
   */
  private blocked = false
  private pausedBy: 'failure' | 'stopped' | null = null

  constructor(options: QueueOptions) {
    this.options = options
    this.clock = options.clock ?? (() => new Date())
    this.epoch = this.clock().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  }

  /**
   * The server-start stamp every job id carries.
   *
   * Computed once, from the same clock the queue is given, so a test can pin
   * it. `2026-08-01T13:45:00.000Z` becomes `20260801T134500`.
   */
  private readonly epoch: string

  enqueue(command: string, story: string | null = null): Job {
    this.counter += 1
    const job: Job = {
      id: `${this.epoch}-${this.counter}`,
      command,
      story,
      status: 'queued',
      reason: null,
      startedAt: null,
      endedAt: null,
    }
    this.pending.push(job)
    this.pump()
    this.options.onChange()
    return job
  }

  /**
   * Cancel a job by id, whichever half of the queue it is in.
   *
   * The running job is stopped rather than refused. One `×` on one row means
   * one thing to the person clicking it, and a control that quietly does
   * nothing on the only row that is actually doing something is the version of
   * this that shipped.
   */
  cancel(jobId: string): void {
    if (this.active?.job.id === jobId) {
      this.stop()
      return
    }
    const index = this.pending.findIndex((job) => job.id === jobId)
    if (index === -1) return
    const [job] = this.pending.splice(index, 1)
    if (job === undefined) return
    job.status = 'cancelled'
    job.endedAt = this.clock().toISOString()
    job.reason = { code: 'job.cancelled.cleared' }
    this.finished.push(job)
    this.settle()
    this.options.onChange()
  }

  /**
   * Stop the running job. Anything queued behind it holds until `resume`.
   *
   * A second press while the ladder is already running is not an escalation:
   * `beginShutdown` is what owns the timings, and re-arming it here would reset
   * them and make Stop take longer the more often it is pressed.
   */
  stop(): void {
    const active = this.active
    if (active === null || active.shutdown !== null) return
    this.blocked = true
    this.pausedBy = 'stopped'
    this.beginShutdown(active, { status: 'cancelled', reason: { code: 'job.cancelled.stopped' } })
  }

  clear(): void {
    while (this.pending.length > 0) {
      const job = this.pending.pop()
      if (job === undefined) break
      job.status = 'cancelled'
      job.endedAt = this.clock().toISOString()
      job.reason = { code: 'job.cancelled.cleared' }
      this.finished.push(job)
    }
    // Emptying the queue is also the answer to "why is nothing starting": there
    // is no longer a held job for the pause to be protecting.
    this.settle()
    this.options.onChange()
  }

  /** Start the head again after a failure or a stop. */
  resume(): void {
    this.blocked = false
    this.pausedBy = null
    this.pump()
    this.options.onChange()
  }

  /**
   * Lift a pause that has nothing left to hold.
   *
   * The pause exists to stop the *rest* of the queue running into the same
   * wall. With nothing pending there is no rest, and leaving the flag set made
   * the next command the user typed sit at `queued` with no banner, no Resume
   * button and no explanation — the single worst behaviour this page had.
   */
  private settle(): void {
    if (this.pending.length > 0) return
    this.blocked = false
    this.pausedBy = null
  }

  write(data: string): void {
    this.active?.session.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.active?.session.resize(cols, rows)
  }

  /**
   * Send a newline to a session that has gone quiet mid-run.
   *
   * The user asks for this; the queue never does it on its own. Deciding on the
   * user's behalf that a silent session wants input is how an agent gets told
   * "yes" to a question nobody read.
   */
  nudge(): void {
    this.active?.session.write('\r')
  }

  jobs(): Job[] {
    const active = this.active === null ? [] : [this.active.job]
    return [...this.finished, ...active, ...this.pending]
  }

  session(): SessionView {
    return {
      jobId: this.active?.job.id ?? null,
      blocked: this.blocked,
      pausedBy: this.blocked ? this.pausedBy : null,
      closing: this.active?.shutdown !== null && this.active !== null,
      stalledSince: this.stalledSince,
    }
  }

  transcript(jobId: string): string {
    return this.transcripts.get(jobId) ?? ''
  }

  /** Called by the server's poller with the summary it just read. */
  observe(summary: StateSummary): void {
    const active = this.active
    if (active === null) return

    const now = this.clock().getTime()

    if (active.shutdown !== null) {
      this.advanceShutdown(active, now)
      return
    }

    const { tracker, verdict } = observe(active.tracker, summary)
    active.tracker = tracker
    active.verdict = verdict

    if (verdict === 'complete') {
      this.stalledSince = null
      this.beginShutdown(active, { status: 'done', reason: null })
      return
    }

    const stalled = isStalled(verdict, now - active.lastOutput, STALL_MS)
    const next = stalled ? new Date(active.lastOutput + STALL_MS).toISOString() : null
    if (next !== this.stalledSince) {
      this.stalledSince = next
      this.options.onChange()
    }
  }

  /** Close every session. Called when the server shuts down. */
  dispose(): void {
    this.active?.session.kill('SIGKILL')
    this.active = null
  }

  private pump(): void {
    if (this.active !== null || this.blocked) return
    const job = this.pending.shift()
    if (job === undefined) return

    job.status = 'running'
    job.startedAt = this.clock().toISOString()

    const session = this.options.spawn({
      cwd: this.options.cwd,
      command: job.command,
      cols: this.cols,
      rows: this.rows,
    })

    const active: Active = {
      job,
      session,
      tracker: NEW_TRACKER,
      verdict: 'waiting',
      lastOutput: this.clock().getTime(),
      shutdown: null,
      outcome: null,
      cols: this.cols,
      rows: this.rows,
    }
    this.active = active
    this.transcripts.set(job.id, '')

    session.onData((chunk) => {
      active.lastOutput = this.clock().getTime()
      if (this.stalledSince !== null) {
        this.stalledSince = null
        this.options.onChange()
      }
      this.append(job.id, chunk)
      this.options.onOutput(job.id, chunk)
    })

    session.onExit((code) => this.handleExit(active, code))
  }

  private append(jobId: string, chunk: string): void {
    const existing = this.transcripts.get(jobId) ?? ''
    const next = existing + chunk
    this.transcripts.set(jobId, next.length > TRANSCRIPT_MAX ? next.slice(-TRANSCRIPT_MAX) : next)
  }

  private beginShutdown(active: Active, outcome: { status: JobStatus; reason: Message | null }): void {
    if (active.shutdown !== null) return
    active.outcome = outcome
    active.shutdown = { phase: 'exit', since: this.clock().getTime() }
    // `/exit` rather than a signal: the session may be mid-write to `.mjloop/`,
    // and the engine's atomic writes protect the state file, not whatever a
    // cycle was part-way through saying.
    active.session.write('/exit\r')
    this.options.onChange()
  }

  private advanceShutdown(active: Active, now: number): void {
    const shutdown = active.shutdown
    if (shutdown === null) return
    const waited = now - shutdown.since

    if (shutdown.phase === 'exit' && waited >= EXIT_WAIT_MS) {
      active.session.kill('SIGTERM')
      active.shutdown = { phase: 'term', since: now }
      return
    }
    if (shutdown.phase === 'term' && waited >= TERM_WAIT_MS) {
      active.session.kill('SIGKILL')
      active.shutdown = { phase: 'kill', since: now }
      return
    }
    if (shutdown.phase === 'kill' && waited >= KILL_WAIT_MS) {
      // SIGKILL was ignored, which on a pty means the process is unkillable —
      // uninterruptible I/O, or a child we do not own. Waiting on it forever
      // costs the user every remaining job, so the queue lets go and says so.
      this.options.onNotice({ code: 'job.abandoned', params: { job: active.job.command } })
      this.handleExit(active, -1)
    }
  }

  private handleExit(active: Active, code: number): void {
    // A late exit from a session the queue has already finished with. Nothing
    // to do, and re-finishing would push a second copy of the job into history.
    if (this.active !== active) return

    const job = active.job
    const outcome =
      active.outcome ??
      // No outcome means we did not ask it to close: the session ended on its
      // own. That is a failure whatever the exit code says, because the run it
      // was started for never reached a terminal status.
      (code === 0
        ? { status: 'failed' as JobStatus, reason: { code: 'job.failed.early' } }
        : { status: 'failed' as JobStatus, reason: { code: 'job.failed.exit', params: { code } } })

    job.status = outcome.status
    job.reason = outcome.reason
    job.endedAt = this.clock().toISOString()

    this.finished.push(job)
    this.trimTranscripts()
    this.active = null
    this.stalledSince = null

    if (job.status === 'failed') {
      this.blocked = true
      this.pausedBy = 'failure'
    }
    // Said after `settle`, because which sentence is true depends on whether
    // the pause survived: "the rest of the queue is holding" with nothing
    // behind it sends the user looking for a queue that is not there.
    this.settle()
    if (job.status === 'failed') {
      this.options.onNotice({
        code: this.blocked ? 'queue.blocked' : 'queue.failed',
        params: { job: job.command },
      })
    }

    this.pump()
    this.options.onChange()
  }

  private trimTranscripts(): void {
    const keep = new Set(this.finished.slice(-TRANSCRIPT_KEEP).map((job) => job.id))
    if (this.active !== null) keep.add(this.active.job.id)
    for (const id of this.transcripts.keys()) {
      if (!keep.has(id)) this.transcripts.delete(id)
    }
  }
}
