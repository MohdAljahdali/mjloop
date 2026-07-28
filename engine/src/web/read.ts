import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentResultSchema, RosterSchema } from '../schemas/contract.js'
import { FindingSchema, type State } from '../schemas/state.js'
import { ManifestSchema, PlanFrontmatterSchema, StoryFrontmatterSchema } from '../schemas/plan.js'
import { loadConfig, ConfigMissingError } from '../store/config-store.js'
import { parseFrontmatter } from '../store/frontmatter.js'
import { listMemories, readMemory } from '../store/memory-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { findPlanDir, listStories } from '../store/plan-store.js'
import { StateStore } from '../store/state-store.js'
import type { Config } from '../schemas/config.js'

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
  parsed: Config | null
  /** True when the file exists but does not parse. The text is in `raw`. */
  invalid: boolean
}

export async function readConfigView(projectDir: string): Promise<ConfigView> {
  const paths = resolveLoopPaths(projectDir)
  const raw = await fs.readFile(paths.config, 'utf8').catch(() => null)
  try {
    return { raw, parsed: await loadConfig(projectDir), invalid: false }
  } catch (error) {
    // A missing config is not an error — a project may be mid-provisioning.
    // Anything else means the file is there and unusable, which is exactly what
    // the Config tab exists to show.
    if (error instanceof ConfigMissingError) return { raw, parsed: null, invalid: false }
    return { raw, parsed: null, invalid: true }
  }
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

export interface CycleDetail {
  cycle: number
  /**
   * Agents drafted, and — the part recoverable from nowhere else — the ones the
   * leader skipped, with its stated reason.
   */
  roster: { selected: string[]; skipped: { agent: string; reason: string }[] } | null
  findings: { severity: string; file: string; line: number; claim: string }[]
  agents: { agent: string; result: unknown }[]
}

export async function readCycleDetail(projectDir: string, runId: string, cycle: number): Promise<CycleDetail> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId, `cycle-${String(cycle).padStart(2, '0')}`)
  const inside = await fs.readdir(dir).catch(() => null)
  if (inside === null) throw new NotFoundError('cycle')

  const roster = await readJson(path.join(dir, 'roster.json'), RosterSchema)
  const findings = await readJson(path.join(dir, 'findings.json'), FindingSchema.array())

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

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function readJson<T>(file: string, schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
    return parsed.success ? (parsed.data as T) : null
  } catch {
    return null
  }
}
