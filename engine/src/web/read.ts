import fs from 'node:fs/promises'
import path from 'node:path'
import { HISTORY_DEFAULT_LIMIT } from '../ops/history.js'
import { preflightEstimate, type Preflight } from '../ops/preflight.js'
import { UnknownTrackError } from '../ops/run.js'
import { readTelemetry, type Telemetry } from '../ops/telemetry.js'
import { readVerifyLedger } from '../ops/verify.js'
import { AgentResultSchema, RosterSchema } from '../schemas/contract.js'
import { FindingSchema, type State } from '../schemas/state.js'
import { ManifestSchema, PlanFrontmatterSchema, StoryFrontmatterSchema } from '../schemas/plan.js'
import type { LedgerEntry } from '../schemas/verify.js'
import { configRevision } from '../store/config-mutation.js'
import { loadConfig, ConfigMissingError } from '../store/config-store.js'
import { parseFrontmatter } from '../store/frontmatter.js'
import { listMemories, readMemory } from '../store/memory-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { findPlanDir, listStories } from '../store/plan-store.js'
import { readAcceptedProfile, readProposedProfile } from '../store/project-profile-store.js'
import { StateStore } from '../store/state-store.js'
import type { Config } from '../schemas/config.js'
import type { ProjectComponent } from '../schemas/project-profile.js'

/**
 * Everything the read API serves.
 *
 * Every function here is **non-destructive**, and that is a property with a
 * test: `read.test.ts` hashes every file under `.mjloop/`, calls all of these,
 * and re-hashes. A poller running once a second is the last thing that should
 * be writing to somebody's project.
 *
 * That rules out `readPlan`, which repairs clobbered frontmatter by rewriting
 * the file. Plans are read here from `PLAN.md` directly and their stories from
 * `listStories`, which skips a file it cannot parse rather than mending it.
 *
 * It also decides which half of `ops/verify.ts` this file may touch. That module
 * exports the ledger *reader* beside the executor that spawns a shell command
 * and takes the project verify lock; only the reader belongs on a wire a browser
 * can pull. `tests/web/boundary.test.ts` names `verifyRun` and `worktreeDigest`
 * in its `FORBIDDEN` list with the reason attached, so importing the executor
 * beside the reader fails a test rather than passing review.
 */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(what)
    this.name = 'NotFoundError'
  }
}

/* ── state ────────────────────────────────────────────────────────────────── */

export interface StateView {
  state: State
  recovered: boolean
}

export async function readState(projectDir: string): Promise<StateView> {
  try {
    const { state, recovered } = await new StateStore(projectDir).read()
    return { state, recovered }
  } catch {
    throw new NotFoundError('state')
  }
}

/* ── config ───────────────────────────────────────────────────────────────── */

export interface ConfigView {
  /** The file as written, comments intact. The page shows it and never sets it. */
  raw: string | null
  /** SHA-256 of `raw`, used as the compare-and-swap token for edits. */
  revision: string | null
  parsed: Config | null
  /** True when the file exists but does not parse. The text is in `raw`. */
  invalid: boolean
}

export async function readConfigView(projectDir: string): Promise<ConfigView> {
  const paths = resolveLoopPaths(projectDir)
  const raw = await fs.readFile(paths.config, 'utf8').catch(() => null)
  try {
    return {
      raw,
      revision: raw === null ? null : configRevision(raw),
      parsed: await loadConfig(projectDir),
      invalid: false,
    }
  } catch (error) {
    // A missing config is not an error — a project may be mid-provisioning.
    // Anything else means the file is there and unusable, which is exactly what
    // the Config tab exists to show.
    if (error instanceof ConfigMissingError) return { raw, revision: null, parsed: null, invalid: false }
    return { raw, revision: raw === null ? null : configRevision(raw), parsed: null, invalid: true }
  }
}

/* ── the project profile ──────────────────────────────────────────────────── */

export interface ProfileView {
  /** The accepted revision, or null when nothing has been accepted. */
  revision: number | null
  acceptedAt: string | null
  acceptedBy: string | null
  /**
   * The accepted revision's components, and *only* an accepted revision's.
   *
   * A proposal's components are deliberately absent: nothing routes off a
   * proposal, and handing the page a component map it would draw under the same
   * heading is how a suggestion starts reading as a decision.
   */
  components: ProjectComponent[]
  /** When the scan behind the current proposal ran; null when there is none. */
  proposedAt: string | null
  /** True when a proposal exists and maps this project differently. */
  proposalDiffers: boolean
}

/**
 * What this project is routed by, and whether a newer scan disagrees.
 *
 * A read, like everything else in this file, and one whose read-only-ness is
 * load-bearing rather than incidental: accepting a component map activates
 * routing for every later run, which is precisely the class of write
 * `web/writes.ts` denies the browser permanently. So this reports what was
 * accepted, reports that a proposal differs, and offers no way to resolve the
 * difference — resolving it is a command.
 *
 * An accepted revision that no longer parses raises rather than reading as
 * "unmapped", and that asymmetry with the proposal is deliberate — it is
 * `project-profile-store.ts`'s, restated here because it decides what a browser
 * sees: a proposal is regenerated by the next scan, an accepted revision is
 * immutable and load-bearing, and answering "no component map" for one that is
 * sitting on disk would route every later run as though the project had never
 * been mapped.
 */
export async function readProfileView(projectDir: string): Promise<ProfileView> {
  const [accepted, proposed] = await Promise.all([
    readAcceptedProfile(projectDir),
    readProposedProfile(projectDir),
  ])
  // Never scanned and never accepted is a project the operator is asking about
  // something that is not there, not this server failing to read something it
  // should have been able to read — the same call `readPreflightEstimate`
  // makes for a track a project does not define.
  if (accepted === null && proposed === null) throw new NotFoundError('profile')

  return {
    revision: accepted?.revision ?? null,
    acceptedAt: accepted?.acceptedAt ?? null,
    acceptedBy: accepted?.acceptedBy ?? null,
    components: accepted?.components ?? [],
    proposedAt: proposed?.generatedAt ?? null,
    proposalDiffers:
      proposed !== null && componentFingerprint(proposed.components) !== componentFingerprint(accepted?.components ?? []),
  }
}

/**
 * Two component maps compared by what they *say*, not by how they serialise.
 *
 * `JSON.stringify` would do the job today and would be the wrong instrument:
 * key order is not part of a record's meaning, a schema is free to hand its
 * fields back in whatever order it likes, and this answer decides whether a
 * person is told to go and look at a change. Every field the record carries is
 * named here, so a field added to `ProjectComponentSchema` and forgotten here
 * is a difference this cannot see — which is what the verification-changed test
 * in `read.test.ts` is standing guard over.
 */
function componentFingerprint(components: readonly ProjectComponent[]): string {
  return components
    .map((component) =>
      [
        component.id,
        component.root,
        component.technology,
        component.verification.test ?? '',
        component.verification.lint ?? '',
        component.verification.build ?? '',
        component.skillTags.join(' '),
      ].join(' '),
    )
    .join('\n')
}

/* ── plans and stories ────────────────────────────────────────────────────── */

export interface ApprovalView {
  decision: string
  by: string
  at: string
  note: string | null
}

export interface StoryDetail {
  id: string
  title: string
  status: string
  ui: boolean
  depends_on: string[]
  acceptance: string[]
  /** The run directory holding the proof this story is done. Null until it is. */
  evidence: string | null
}

export interface PlanDetail {
  id: string
  title: string
  approval: ApprovalView | null
  /** `PLAN.md`'s body. Rendered through `verbatim()`; the page escapes nothing. */
  body: string
  /** The plan-critic's review. Nothing in `engine/src` reads this file today. */
  review: string | null
  stories: StoryDetail[]
}

export async function readPlanDetail(projectDir: string, planId: string): Promise<PlanDetail> {
  let dir: string
  try {
    dir = await findPlanDir(projectDir, planId)
  } catch {
    throw new NotFoundError('plan')
  }

  const raw = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8').catch(() => null)
  const parsed = raw === null ? null : PlanFrontmatterSchema.safeParse(parseFrontmatter(raw).data)
  const frontmatter = parsed?.success === true ? parsed.data : null

  const [review, stories, manifestTitle] = await Promise.all([
    fs.readFile(path.join(dir, 'REVIEW.md'), 'utf8').catch(() => null),
    readStoryDetails(projectDir, planId),
    readManifestTitle(dir),
  ])

  return {
    id: planId,
    title: frontmatter?.title ?? manifestTitle ?? path.basename(dir),
    // The whole record — `decision`, `by`, `at`, `note` — where the snapshot
    // carries only the decision. An approval is auditable or it is a flag.
    approval: frontmatter?.approval ?? null,
    body: raw === null ? '' : parseFrontmatter(raw).body,
    review,
    stories,
  }
}

/**
 * Read from the story files rather than the manifest: `acceptance` and
 * `evidence` live in story frontmatter and are deliberately absent from
 * `ManifestEntry`, so the manifest cannot answer this.
 */
async function readStoryDetails(projectDir: string, planId: string): Promise<StoryDetail[]> {
  const stories = await listStories(projectDir, planId).catch(() => [])
  return stories.map((story) => toStoryDetail(story.frontmatter))
}

function toStoryDetail(frontmatter: ReturnType<typeof StoryFrontmatterSchema.parse>): StoryDetail {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    status: frontmatter.status,
    ui: frontmatter.ui,
    depends_on: frontmatter.depends_on,
    acceptance: frontmatter.acceptance,
    evidence: frontmatter.evidence,
  }
}

export async function readStoryDetail(projectDir: string, storyId: string): Promise<StoryDetail> {
  const found = (await readStoryDetails(projectDir, storyId.slice(0, 4))).find((story) => story.id === storyId)
  if (found === undefined) throw new NotFoundError('story')
  return found
}

async function readManifestTitle(dir: string): Promise<string | null> {
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')))
    return parsed.success ? parsed.data.title : null
  } catch {
    return null
  }
}

/* ── runs ─────────────────────────────────────────────────────────────────── */

export interface RunSummary {
  id: string
  /** Split out of the directory name, which is `<run_id>--<story|adhoc>--<track>`. */
  story: string | null
  track: string | null
  cycles: number
  halted: boolean
}

export async function readRuns(projectDir: string): Promise<RunSummary[]> {
  const runs = resolveLoopPaths(projectDir).runs
  const names = await fs
    .readdir(runs, { withFileTypes: true })
    .then((found) => found.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => [])

  const out: RunSummary[] = []
  // Newest first: run ids sort lexicographically because they open with a timestamp.
  for (const name of names.sort().reverse()) {
    const inside = await fs.readdir(path.join(runs, name)).catch((): string[] => [])
    const [, story, track] = name.split('--')
    out.push({
      id: name,
      story: story === undefined || story === 'adhoc' ? null : story,
      track: track ?? null,
      cycles: inside.filter((entry) => entry.startsWith('cycle-')).length,
      halted: inside.includes('HALT.md'),
    })
  }
  return out
}

export interface RunDetail {
  id: string
  /** The halt report, verbatim. Null when the run did not halt. */
  halt: string | null
  cycles: number[]
}

export async function readRunDetail(projectDir: string, runId: string): Promise<RunDetail> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId)
  const inside = await fs.readdir(dir).catch(() => null)
  if (inside === null) throw new NotFoundError('run')

  return {
    id: runId,
    halt: await fs.readFile(path.join(dir, 'HALT.md'), 'utf8').catch(() => null),
    cycles: inside
      .filter((entry) => /^cycle-\d+$/.test(entry))
      .map((entry) => Number(entry.slice('cycle-'.length)))
      .sort((a, b) => a - b),
  }
}

/**
 * How many ledger rows one cycle may put on the wire.
 *
 * `cycle-NN/verify/index.json` gains a row per invocation and a cycle can verify
 * as many times as its agents ask to, so the array has no ceiling of its own.
 * This document is what the Evidence tab re-fetches every time `revisions.cycle`
 * moves — roughly once a second while the run is live — so an unbounded array
 * here is a payload that grows for the length of the cycle and is re-serialised
 * at that rate. The newest rows are kept: they are the ones the cycle's verdict
 * is about to rest on.
 */
export const CYCLE_VERIFY_MAX = 50

/**
 * The ceiling on the handoff body this reader will carry.
 *
 * `writeHandoff` truncates at 6 000 bytes, so a handoff the engine wrote is
 * already bounded and this cap never fires. It exists for the one it did not
 * write: `handoff.md` is an ordinary file in an ordinary directory that a person
 * or an agent can replace, and the same once-a-second re-fetch applies to
 * whatever is found there.
 */
export const CYCLE_HANDOFF_MAX = 12_000

export interface CycleDetail {
  cycle: number
  /**
   * Agents drafted, and — the part recoverable from nowhere else — the ones the
   * leader skipped, with its stated reason.
   */
  roster: { selected: string[]; skipped: { agent: string; reason: string }[] } | null
  findings: { severity: string; file: string; line: number; claim: string }[]
  agents: { agent: string; result: unknown }[]
  /**
   * What the engine executed for this cycle, from `cycle-NN/verify/index.json`.
   *
   * At most `CYCLE_VERIFY_MAX` rows, oldest first. The pin's drift marker
   * (`source`, `live_command`) and the `queued` phase are fields on the entry
   * rather than a second channel, which is why an operator who edited
   * `config.yaml` mid-run can see which command actually ran without this file
   * gaining a route, a reader, or any knowledge of the pin.
   */
  verify: LedgerEntry[]
  /** Rows on disk, so `CYCLE_VERIFY_MAX` is visible rather than silent. */
  verify_total: number
  /**
   * `cycle-NN/handoff.md`, verbatim. Null when the cycle has none: every cycle
   * closed before the handoff existed, and any cycle whose handoff write failed
   * — `cycleAdvance` reports that as `handoff: null` rather than throwing, so
   * the absence is expected here too.
   */
  handoff: string | null
  /** True when `CYCLE_HANDOFF_MAX` cut the body above. */
  handoff_truncated: boolean
}

export async function readCycleDetail(projectDir: string, runId: string, cycle: number): Promise<CycleDetail> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId, `cycle-${String(cycle).padStart(2, '0')}`)
  const inside = await fs.readdir(dir).catch(() => null)
  if (inside === null) throw new NotFoundError('cycle')

  const roster = await readJson(path.join(dir, 'roster.json'), RosterSchema)
  const findings = await readJson(path.join(dir, 'findings.json'), FindingSchema.array())
  // Absence is the ordinary case, not an error: every cycle of every run that
  // predates the ledger has no `verify/` directory at all.
  const ledger = await readVerifyLedger(dir)
  const handoff = await fs.readFile(path.join(dir, 'handoff.md'), 'utf8').catch(() => null)

  const agents: { agent: string; result: unknown }[] = []
  for (const entry of inside.filter((name) => name.endsWith('.json')).sort()) {
    if (entry === 'roster.json' || entry === 'findings.json') continue
    // Parsed with the engine's own schema, and a file that fails to parse is
    // skipped rather than fatal — the same rule the snapshot already applies to
    // an unreadable plan. One bad result must not blank the whole cycle.
    const result = await readJson(path.join(dir, entry), AgentResultSchema)
    if (result !== null) agents.push({ agent: entry.replace(/\.json$/, ''), result })
  }

  return {
    cycle,
    roster:
      roster === null
        ? null
        : {
            selected: roster.selected,
            skipped: Object.entries(roster.skipped).map(([agent, reason]) => ({ agent, reason })),
          },
    findings: findings ?? [],
    agents,
    verify: ledger.slice(-CYCLE_VERIFY_MAX),
    verify_total: ledger.length,
    handoff: handoff === null ? null : handoff.slice(0, CYCLE_HANDOFF_MAX),
    handoff_truncated: handoff !== null && handoff.length > CYCLE_HANDOFF_MAX,
  }
}

/**
 * The roster's landed agents: which `cycle-NN/<agent>.json` files exist.
 *
 * This is the exact procedure `skills/mjloop-leader/SKILL.md:36-44` prescribes
 * for resuming, and it is the *only* real intra-cycle progress signal.
 * `StateSchema` permits stage `execute` and `judge`, but nothing in the engine
 * ever sets them — so a UI that promised a stage would be promising something
 * the engine never writes.
 */
export async function readRosterProgress(
  projectDir: string,
  runId: string,
  cycle: number,
): Promise<{ cycle: number; selected: string[]; landed: string[] } | null> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId, `cycle-${String(cycle).padStart(2, '0')}`)
  const roster = await readJson(path.join(dir, 'roster.json'), RosterSchema)
  if (roster === null) return null
  const inside = await fs.readdir(dir).catch((): string[] => [])
  const landed = roster.selected.filter((agent) => inside.includes(`${agent}.json`))
  return { cycle, selected: roster.selected, landed }
}

/* ── memory ───────────────────────────────────────────────────────────────── */

export interface MemoryView {
  id: string
  kind: string
  title: string
  tags: string[]
  at: string
  run: string | null
  body: string
}

/**
 * The whole corpus, so the page can facet it.
 *
 * `memorySearch` supports no filter by kind, tag, time or originating run, so
 * faceting cannot be pushed to the server — and its `reason` is English prose
 * composed in the engine, which must not cross this wire.
 */
export async function readMemories(projectDir: string): Promise<MemoryView[]> {
  const memories = await listMemories(projectDir).catch(() => [])
  return memories.map((memory) => ({ ...memory.frontmatter, body: memory.body }))
}

export async function readMemoryEntry(projectDir: string, id: string): Promise<MemoryView> {
  try {
    const memory = await readMemory(projectDir, id)
    return { ...memory.frontmatter, body: memory.body }
  } catch {
    throw new NotFoundError('memory')
  }
}

/* ── the two cross-run reports ────────────────────────────────────────────── */

/**
 * Both are projections of `readRunHistory`, and both live in `ops/` because the
 * MCP server serves the same two reports from the same walk. They are re-stated
 * here rather than routed straight out of `api.ts` for two reasons the route
 * table should not have to carry: the bound each one puts on the wire, and the
 * translation of an engine exception into this file's `NotFoundError`.
 */

/**
 * The specialist table, bounded twice over.
 *
 * `readTelemetry` caps its rows at `TELEMETRY_MAX_ROWS` and reports `truncated`
 * beside them; the limit passed here is the other ceiling — how many run
 * directories the walk opens. It is the default made explicit, because the
 * number that matters is the one this wire is willing to pay for, and inheriting
 * it would let a later change to the op's default silently change what a browser
 * poll costs.
 *
 * This answer moves with `revisions.runs` and not the cycle tick, which is why a
 * cross-run walk at ~1.25 Hz is not what the Config tab does: `revisions.runs`
 * is the run-directory listing plus that directory's mtime, so it does not move
 * when a `cycle-NN/<agent>.json` lands inside a run that already exists. The
 * table goes stale during a live run and refreshes when the next run opens —
 * correct for a report whose subject is the last fifty runs.
 */
export async function readTelemetryReport(projectDir: string): Promise<Telemetry> {
  return await readTelemetry(projectDir, { limit: HISTORY_DEFAULT_LIMIT })
}

/**
 * The shape of a run the operator has not started yet.
 *
 * A pure read, and the pre-dispatch surface: `runStart` is permanently forbidden
 * from the browser, so the idle Run tab can show what a run would cost and
 * nothing here can begin one. No story is passed — the idle tab has none — and
 * that is not a default standing in for one: it selects ad-hoc runs as the
 * comparable set, which is what an operator about to type a goal is choosing
 * between.
 *
 * A track the project does not define, and a project with no config at all, are
 * both 404s rather than 500s: neither is this server failing to read something
 * it should have been able to read.
 */
export async function readPreflightEstimate(projectDir: string, track: string): Promise<Preflight> {
  try {
    return await preflightEstimate(projectDir, { track })
  } catch (error) {
    if (error instanceof UnknownTrackError) throw new NotFoundError('track')
    if (error instanceof ConfigMissingError) throw new NotFoundError('config')
    throw error
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function readJson<T>(file: string, schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
    return parsed.success ? (parsed.data as T) : null
  } catch {
    return null
  }
}
