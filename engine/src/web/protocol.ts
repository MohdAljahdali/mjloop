import * as z from 'zod'
import type { DestructiveRequest } from '../ops/destructive-risk.js'
import type { StateSummary } from '../ops/summary.js'
import type {
  QualityAmendment,
  QualityBudget,
  QualityDispatch,
  QualityLedger,
  QualityPolicy,
} from '../schemas/quality.js'
import type { WebCode } from './codes.js'
import type { Revisions } from './revision.js'
import { WriteSchema } from './writes.js'

/**
 * Everything the server says to the page is a code and its parameters, never
 * prose.
 *
 * The page owns the wording, which is what makes a fifteenth language cost one
 * JSON file rather than an audit of every string in this directory. The
 * discipline is cheap to keep and expensive to retrofit, so it is enforced by
 * the type: there is no field here that could hold a sentence.
 */
export interface Message {
  code: WebCode
  params?: Record<string, string | number>
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  /**
   * Unique across restarts, not merely within one.
   *
   * It used to be `j<n>` from a counter that resets to zero every boot, so
   * `j1` named a different job after every restart. That was harmless while
   * nothing outlived the process; it stops being harmless the moment anything
   * is filed under it, and a transcript on disk is exactly that. The shape is
   * `<server start, compact ISO>-<n>`: sortable, filename-safe, and it says
   * which run of the server a job belongs to.
   */
  id: string
  /** The loop command, exactly as it will be handed to `claude`. */
  command: string
  /**
   * The story this job is building, when it is building one.
   *
   * Null for a command somebody typed, for `/mjloop:plan`, and for anything
   * else with no story to name. Carried rather than parsed back out of
   * `command`: a story tab looking for its own job by string-matching
   * `/mjloop:build P001-S02` also matches a hand-typed line that happens to
   * read the same, and misses a `/mjloop:fix` that is working on it.
   */
  story: string | null
  status: JobStatus
  /** Why it ended, for the statuses that have a reason. Null while it runs. */
  reason: Message | null
  startedAt: string | null
  endedAt: string | null
}

/**
 * One agent, as the browser draws it.
 *
 * The same shape as `AgentDoc` minus `path`: an absolute path on the wire is
 * exactly what nothing here is allowed to send.
 */
export interface AgentView {
  name: string
  source: 'project' | 'plugin'
  description: string
  tools: string | null
  model: string | null
  extra: Record<string, unknown>
  body: string
  digest: string
}

/**
 * The two agent directories, side by side and never merged — a project agent
 * shadows a plugin one of the same name, and folding them into one list would
 * hide exactly that.
 */
export interface AgentsView {
  project: AgentView[]
  plugin: AgentView[]
  /** The plugin's own unreadable files are not reported here — see `readAgentsView`. */
  unreadable: { path: string }[]
}

/**
 * One planned quality dispatch, as the browser draws it.
 *
 * Exactly the four fields that say *what was planned and why*. Everything the
 * engine uses to charge and de-duplicate a dispatch — reservation keys, packet
 * text, fingerprints — is deliberately not here: a page that could see the key
 * would be a page one edit away from being able to name one.
 */
export type PublicQualityDispatch = Pick<QualityDispatch, 'agent' | 'instance' | 'dimensions' | 'reason'>

/** One budget amendment, minus `version` — a record-format fact, not an operator's. */
export type PublicQualityAmendment = Pick<
  QualityAmendment,
  'run' | 'field' | 'from' | 'to' | 'reason' | 'decided_at' | 'decided_by'
>

/**
 * One run's quality records, read-only.
 *
 * `pendingRequest` carries the whole `DestructiveRequest`, **including its
 * `fingerprint`**, and that is the deliberate part. The rule the design states
 * is that a decision token must never reach an *agent's* context; it has to
 * reach the operator's screen, because `quality.decision` (`web/writes.ts`)
 * refuses any decision that does not name the operation currently shown. A view
 * that redacted it would render an Approve button that cannot be pressed. The
 * record holds no capability, no secret and no absolute path — its `targets`
 * and `operation` are the proposal's own words, which are the thing being
 * decided and so may not be abridged either.
 */
export interface QualityRunView {
  policy: Omit<QualityPolicy, 'dispatches'> & { dispatches: PublicQualityDispatch[] }
  ledger: QualityLedger
  /** The newest `QUALITY_AMENDMENTS_MAX`; `effectiveBudget` still reflects them all. */
  amendments: PublicQualityAmendment[]
  /** The ceilings the run is actually working against — the pin plus every amendment on disk. */
  effectiveBudget: QualityBudget
  pendingRequest: DestructiveRequest | null
}

export interface StoryView {
  id: string
  title: string
  status: string
  ui: boolean
  depends_on: string[]
}

export interface PlanView {
  id: string
  title: string
  /** The approval decision, or null when nobody has looked at the plan yet. */
  approval: string | null
  stories: StoryView[]
}

export interface SessionView {
  /** The job whose terminal is live, or null when nothing is running. */
  jobId: string | null
  /**
   * The queue is holding after a failure or a stop and will not start the next
   * job until asked. Reported rather than inferred: "nothing running but jobs
   * queued" is also what a job looks like in the moment between two sessions.
   *
   * True whenever the queue is actually holding — never filtered by whether
   * there is anything queued behind it. A pause the page cannot see is how a
   * `Run` press turns into a job that sits there forever.
   */
  blocked: boolean
  /**
   * Why it is holding. The two causes need different words and different
   * advice: a failure asks you to read a transcript, a stop asks nothing.
   */
  pausedBy: 'failure' | 'stopped' | null
  /**
   * The live session is being closed — `/exit` sent, and the shutdown ladder
   * running. Between that and the pty going away is up to sixteen seconds in
   * which the page used to show a job still `running` and a Stop button that
   * did nothing.
   */
  closing: boolean
  /**
   * When the run is `running` but the session has produced no output for the
   * idle threshold. The page turns this into a banner and a nudge button —
   * `autonomous: false` lets a session end its turn mid-run, and a queue that
   * cannot see that waits forever on its first job.
   */
  stalledSince: string | null
}

/**
 * The stagnation counters, which say how close a halt is.
 *
 * Today a stagnation halt arrives without warning. Read from a second
 * `StateStore.read()` rather than added to `StateSummary`, because that type is
 * the compact view for the leader brief and the SessionStart hook and widening
 * it changes what every agent sees.
 */
export interface GuardView {
  strikes: number
  /** `limits.no_progress_strikes`, or null when config is unreadable. */
  strikesAllowed: number | null
  /** Normalised error signatures observed this cycle. */
  cycleErrors: string[]
  /** The signature that will halt the run if this cycle repeats it. */
  errorArmed: string | null
}

/**
 * Which agents this cycle drafted, and which have landed.
 *
 * `roster.selected` diffed against the `cycle-NN/<agent>.json` files that
 * exist. This is the only real intra-cycle progress signal there is:
 * `StateSchema` permits stage `execute` and `judge`, but nothing in the engine
 * ever sets them, so a UI that promised a stage would be promising something
 * the engine never writes.
 */
export interface RosterView {
  cycle: number
  selected: string[]
  landed: string[]
}

export interface Snapshot {
  /** Absolute path of the project being driven. Shown so two servers are told apart. */
  project: string
  state: StateSummary
  plans: PlanView[]
  /** Run directory names, newest first. */
  runs: string[]
  queue: Job[]
  session: SessionView
  guards: GuardView | null
  /** Null unless a run is open. */
  roster: RosterView | null
  /** What each tab subscribes to. The open tab *is* the subscription. */
  revisions: Revisions
}

export type ServerMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  /** A chunk of terminal output. `jobId` lets a late chunk from a job the page
   * has already navigated away from be dropped rather than drawn. */
  | { type: 'output'; jobId: string; data: string }
  /** The whole buffered transcript, sent on connect and on attach. */
  | { type: 'transcript'; jobId: string; data: string }
  | { type: 'notice'; message: Message }
  /**
   * The answer to one `{type:'write'}`, in send order.
   *
   * The snapshot broadcast goes out *before* the receipt, so a write that
   * receipts `ok` has already landed and is already on screen. That is why the
   * page needs no optimistic render and no rollback.
   */
  | { type: 'receipt'; id: string; ok: boolean; code: Message['code'] }

/**
 * Parsed rather than cast: this arrives from a browser tab, and every branch
 * below it either writes to a pty or spawns a process.
 */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), data: z.string() }),
  z.strictObject({
    type: z.literal('resize'),
    // Bounded because they reach an ioctl. A terminal 0 columns wide is not a
    // terminal, and an absurd one is a way to make the pty misbehave.
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.strictObject({
    type: z.literal('enqueue'),
    command: z.string().min(1).max(2000),
    // Optional and defaulted, so a page that predates it still enqueues — and
    // bounded to the id shape because it reaches a filename through the
    // transcript store, the same reason `StoryIdSchema` is a regex.
    story: z
      .string()
      .regex(/^P\d{3}-S\d{2}$/)
      .nullable()
      .default(null),
  }),
  z.strictObject({ type: z.literal('cancel'), jobId: z.string().min(1) }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('resume') }),
  z.strictObject({ type: z.literal('clear') }),
  z.strictObject({ type: z.literal('attach'), jobId: z.string().min(1) }),
  z.strictObject({ type: z.literal('nudge') }),
  /**
   * The one door for the guarded engine writes the browser can reach.
   *
   * `id` is the page's own correlation token, echoed back on the receipt; it is
   * never used to name anything on disk.
   *
   * The kinds it carries are `WriteSchema`'s and it widens only when that union
   * does, which is why `feature.approve` arrived without a line changing here.
   * That is also why no `FeatureView` joins `Snapshot` above: a brief is *read*
   * over `/api/features`, never pushed, so the only thing a browser can do to
   * one is this frame. A record that arrives by one route and leaves by another
   * has two surfaces to audit, and this one has one.
   */
  z.strictObject({ type: z.literal('write'), id: z.string().min(1).max(64), write: WriteSchema }),
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>
