import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { FindingSchema, ResultSchema, type Finding, type Result } from '../schemas/state.js'
import { LedgerSchema, type LedgerEntry } from '../schemas/verify.js'
import { resolveLoopPaths } from '../store/paths.js'
import { StateStore } from '../store/state-store.js'
import { runDirName } from './run.js'

/**
 * The one cross-run walk.
 *
 * `readTelemetry` and `preflightEstimate` are both projections of this
 * function, and neither touches `fs`. Two independent walkers would have to
 * agree about what a run is — whether a halted run counts, whether an
 * unparseable roster loses the cycle or the run, where the bound falls — and
 * they would disagree quietly, in two reports an operator would compare side by
 * side and take for two views of one truth.
 *
 * It lives in `ops/` rather than `web/` because both the MCP server and the
 * cockpit's read api need it, and `tests/web/boundary.test.ts` constrains what
 * `src/web/` may import. It is deliberately **not** on the `Snapshot`: that is
 * re-serialised at ~1.25 Hz while a run is live, and a walk over every run
 * directory in the project is precisely what that rule excludes.
 *
 * Nothing here writes. `readRunHistory` joins `tests/web/read.test.ts`'s
 * hash-everything-before-and-after assertion, which is this project's
 * contractual test for a non-destructive reader.
 */

/**
 * How many runs a walk reads when the caller names no bound.
 *
 * A cross-run walk that grew without bound would make the Config tab slower
 * every week the project was used — a defect that arrives quietly, months after
 * the change that caused it, and is blamed on something else.
 */
export const HISTORY_DEFAULT_LIMIT = 50

/** One `cycle-NN/<agent>.json`, or `<agent>--<instance>.json`. */
export interface AgentRecord {
  name: string
  /** The instance suffix, or `null` for the plain `<agent>.json`. */
  instance: string | null
  status: Result
  /** The agent's **own** findings. `findings.json` is a cycle aggregate with no attribution. */
  findings: Finding[]
  /** How many files it reported touching. The paths themselves are not a report's business. */
  files: number
}

export interface CycleRecord {
  /**
   * The cycle number, and `0` for the run's `closing/` pass — that pass belongs
   * to no cycle, which is the whole point of idea 9.
   */
  cycle: number
  selected: string[]
  /** agent name -> the leader's stated reason for leaving it out. */
  skipped: Record<string, string>
  agents: AgentRecord[]
  /** `cycle-NN/verify/index.json`. Empty when the run predates the ledger. */
  verify: LedgerEntry[]
  /**
   * When the cycle closed, from `state.history`. See `RunRecord.started_at`:
   * only the run `state.json` currently describes can carry one.
   */
  at: string | null
}

export interface RunRecord {
  /** The directory name, `<run_id>--<story|adhoc>--<track>`. */
  id: string
  run_id: string
  track: string
  /** `null` for an ad-hoc run. A story-bound run is a different kind of run, not a labelled one. */
  story: string | null
  halted: boolean
  /**
   * Whether `state.json` still describes this run as in flight.
   *
   * A live run's cycle count measures how far it has got, not what the work
   * took, so a projection comparing runs must be able to leave it out. Nothing
   * on disk says so — a run directory looks the same mid-run as it does after
   * a pass — so it can only come from state.
   */
  running: boolean
  /**
   * When the run opened, or `null`.
   *
   * `runStart` resets `state.history` and `state.started_at` describes the
   * current run only, so **at most one run in any walk carries timings**: the
   * one `state.json` currently describes. Nothing archives a finished run's
   * clock, and inventing one from the directory's mtime would report when the
   * last file landed rather than when the run opened.
   */
  started_at: string | null
  /** Ascending. */
  cycles: CycleRecord[]
  /** The run's `closing/` directory, walked the same way. `null` when absent. */
  closing: CycleRecord | null
}

export interface HistoryOptions {
  /** Newest `limit` runs. Defaults to `HISTORY_DEFAULT_LIMIT`. */
  limit?: number
  /** Only runs on this track. Matched against the directory name, so it costs no I/O. */
  track?: string
}

/**
 * Every run this project has recorded, newest first and bounded.
 *
 * Run directory names open with `YYYY-MM-DD-NNN`, so a descending sort of the
 * listing is chronological without a `stat` per entry, and the walk can stop at
 * `limit` before opening anything.
 */
export async function readRunHistory(projectDir: string, options: HistoryOptions = {}): Promise<RunRecord[]> {
  const limit = options.limit ?? HISTORY_DEFAULT_LIMIT
  if (limit <= 0) return []

  const runsDir = resolveLoopPaths(projectDir).runs
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()

  const live = await readLiveRun(projectDir)
  const runs: RunRecord[] = []
  for (const name of names) {
    // Exactly three segments or the name tells us nothing: a directory that
    // does not decompose into run, story and track cannot be attributed to a
    // track, and a report that guessed would attribute it to the wrong one.
    const parts = name.split('--')
    if (parts.length !== 3) continue
    const [runId, story, track] = parts as [string, string, string]
    if (options.track !== undefined && track !== options.track) continue

    runs.push(
      await readRun(path.join(runsDir, name), {
        id: name,
        run_id: runId,
        track,
        story: story === 'adhoc' ? null : story,
        live,
      }),
    )
    if (runs.length >= limit) break
  }
  return runs
}

/* ── the walk ─────────────────────────────────────────────────────────────── */

/** What `state.json` can say about the one run it currently describes. */
interface LiveRun {
  dir: string
  started_at: string | null
  running: boolean
  /** cycle number -> when it closed. */
  closedAt: Map<number, string | null>
}

async function readLiveRun(projectDir: string): Promise<LiveRun | null> {
  // `StateStore.read` is read-only even when it recovers from `.bak` — the
  // repair write deliberately lives in `update`, under the lock — so a reader
  // may use it without breaking the no-write property. A project that has
  // never been provisioned simply has no timings.
  const state = await new StateStore(projectDir).get().catch(() => null)
  if (state === null || state.run_id === null || state.track === null) return null
  return {
    // Composed by `runDirName` rather than re-spelled here, so this walk and
    // the writers cannot drift apart on the separator or the `adhoc` fallback.
    dir: runDirName(state),
    started_at: state.started_at,
    running: state.status === 'running',
    closedAt: new Map(state.history.map((entry) => [entry.cycle, entry.at])),
  }
}

interface RunIdentity {
  id: string
  run_id: string
  track: string
  story: string | null
  live: LiveRun | null
}

async function readRun(dir: string, identity: RunIdentity): Promise<RunRecord> {
  const inside = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const timing = identity.live !== null && identity.live.dir === identity.id ? identity.live : null

  // The directory name is kept rather than recomposed from the number: every
  // writer pads to two digits today, but a walk over history must read what is
  // on disk rather than what the current writer would have produced.
  const cycleDirs = inside
    .filter((entry) => entry.isDirectory() && /^cycle-\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, cycle: Number(entry.name.slice('cycle-'.length)) }))
    .sort((a, b) => a.cycle - b.cycle)

  const cycles: CycleRecord[] = []
  for (const { name, cycle } of cycleDirs) {
    cycles.push(await readCycle(path.join(dir, name), cycle, timing?.closedAt.get(cycle) ?? null))
  }

  const hasClosing = inside.some((entry) => entry.isDirectory() && entry.name === 'closing')

  return {
    id: identity.id,
    run_id: identity.run_id,
    track: identity.track,
    story: identity.story,
    halted: inside.some((entry) => entry.name === 'HALT.md'),
    running: timing?.running ?? false,
    started_at: timing?.started_at ?? null,
    cycles,
    // The closing pass has no cycle number and `state.history` has no entry for
    // it: it happens after the run's last cycle closed.
    closing: hasClosing ? await readCycle(path.join(dir, 'closing'), 0, null) : null,
  }
}

async function readCycle(dir: string, cycle: number, at: string | null): Promise<CycleRecord> {
  const inside = await fs.readdir(dir).catch((): string[] => [])
  const roster = await readJson(path.join(dir, 'roster.json'), RosterFields)
  const verify = await readJson(path.join(dir, 'verify', 'index.json'), LedgerSchema)

  const agents: AgentRecord[] = []
  for (const entry of inside.filter((name) => name.endsWith('.json')).sort()) {
    // `roster` and `findings` are reserved agent names, so neither file can be
    // an agent's result and neither can be shadowed by one.
    if (entry === 'roster.json' || entry === 'findings.json') continue
    const result = await readJson(path.join(dir, entry), ResultFields)
    // One unreadable result must not blank the cycle around it — the same rule
    // `readCycleDetail` already applies to the same files.
    if (result === null) continue
    const [name, instance] = splitInstance(entry.slice(0, -'.json'.length))
    agents.push({
      name,
      instance,
      status: result.status,
      findings: result.findings,
      files: result.files_touched.length,
    })
  }

  return {
    cycle,
    // A cycle whose roster is missing or unreadable keeps its agents and loses
    // only its drafted/skipped counts. Dropping the cycle instead would shorten
    // the run, and a run's length is what the preflight estimate rests on.
    selected: roster?.selected ?? [],
    skipped: roster?.skipped ?? {},
    agents,
    verify: verify ?? [],
    at,
  }
}

/**
 * `<agent>--<instance>` splits at the **first** separator: `AgentNameSchema`
 * forbids `--` inside an agent name for exactly this reason, so everything
 * after it is the instance.
 */
function splitInstance(base: string): [string, string | null] {
  const at = base.indexOf('--')
  if (at === -1) return [base, null]
  return [base.slice(0, at), base.slice(at + 2)]
}

/* ── what a historical file is read as ─────────────────────────────────────── */

/**
 * These read the fields this walk needs and ignore every other key, where
 * `RosterSchema` and `AgentResultSchema` are `strictObject`s that would reject
 * the whole file over one.
 *
 * That is the right trade **here and nowhere else**. A cross-run reader spans
 * every version of this repository that has ever written a run directory, in
 * both directions: `runLog` and `rosterSet` validate what they write with the
 * strict schemas, and a report about the past that refused a file because a
 * later milestone added a key to it would erase the cycle rather than shorten
 * it — silently, and in a table whose whole job is to say what happened.
 * `closing/roster.json` is the live example: its writer lands in a later batch
 * than this walk.
 */
const RosterFields = z.object({
  selected: z.array(z.string().min(1)).default([]),
  skipped: z.record(z.string().min(1), z.string().min(1)).default({}),
})

const ResultFields = z.object({
  status: ResultSchema,
  findings: z.array(FindingSchema).default([]),
  files_touched: z.array(z.string()).default([]),
})

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
