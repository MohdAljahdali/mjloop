import fs from 'node:fs/promises'
import path from 'node:path'
import { stateSummary } from '../ops/summary.js'
import { loadConfig } from '../store/config-store.js'
import { ManifestSchema, PlanFrontmatterSchema } from '../schemas/plan.js'
import { parseFrontmatter } from '../store/frontmatter.js'
import { resolveLoopPaths } from '../store/paths.js'
import { findPlanDir, listPlanIds } from '../store/plan-store.js'
import { StateStore } from '../store/state-store.js'
import { readRosterProgress } from './read.js'
import { readRevisions, type Revisions } from './revision.js'
import type { GuardView, PlanView, RosterView, Snapshot, StoryView } from './protocol.js'

/**
 * Everything the page draws without asking for it, read from `.mjloop/`.
 *
 * The rule: **only facts already parsed from files already opened.** Anything
 * with a body — `PLAN.md`, `HALT.md`, an agent result, a memory entry — is
 * fetched over the read api instead, so this stays a handful of small reads
 * whether or not the project has forty runs in it.
 *
 * Every read here is non-destructive, which rules out `readPlan` — that one
 * repairs clobbered frontmatter by rewriting the file, and a poller running
 * once a second is the last thing that should be writing to a project.
 */

export type SnapshotBase = Omit<Snapshot, 'queue' | 'session'>

/**
 * Carried between ticks so an idle project costs about eight stats and a
 * readdir: the plans are re-read only when their revision has moved.
 */
export interface SnapshotCache {
  tick: number
  plansRevision: string
  plans: PlanView[]
}

export function emptyCache(): SnapshotCache {
  return { tick: 0, plansRevision: '', plans: [] }
}

export async function buildSnapshot(projectDir: string, cache: SnapshotCache = emptyCache()): Promise<SnapshotBase> {
  cache.tick += 1

  const [state, guards] = await Promise.all([stateSummary(projectDir), readGuards(projectDir)])
  const running = state.status === 'running'
  // The open run, however it is currently stopped: a run suspended for a budget
  // or a destructive decision is not `running`, and is exactly the one whose
  // quality records are about to move.
  const openRun = state.run_id === null || state.track === null
    ? null
    : runDirName(state.run_id, state.story, state.track)

  const revisions = await readRevisions(projectDir, cache.tick, running, openRun)

  // Paid for in cash: `manifest.json` used to be read twice per plan per tick,
  // and every plan was re-read on every tick whether or not anything had moved.
  // Serialised, not compared by reference: `revisions.plans` is a fresh object
  // every tick. Stable because `readRevisions` builds it from sorted ids.
  const plansRevision = JSON.stringify(revisions.plans)
  if (plansRevision !== cache.plansRevision) {
    cache.plans = await readPlans(projectDir)
    cache.plansRevision = plansRevision
  }

  const [runs, roster] = await Promise.all([
    listRuns(projectDir),
    running && openRun !== null ? readRosterProgress(projectDir, openRun, state.cycle) : Promise.resolve(null),
  ])

  return { project: projectDir, state, plans: cache.plans, runs, guards, roster, revisions }
}

/** Mirrors `ops/run.ts:runDirName`, which needs a whole `State` this never reads. */
function runDirName(runId: string, story: string | null, track: string): string {
  return `${runId}--${story ?? 'adhoc'}--${track}`
}

/**
 * The stagnation counters, from a second `StateStore.read()`.
 *
 * Read rather than added to `StateSummary` because that type is the compact
 * view for the leader brief and the SessionStart hook (`summary.ts:60-63`), and
 * widening it changes what every agent sees. `atomic.ts:55-59` says in so many
 * words that there is deliberately no repair write on a read, and 2 KB read
 * twice a second is free next to what a loop cycle costs.
 */
async function readGuards(projectDir: string): Promise<GuardView | null> {
  try {
    const [{ state }, config] = await Promise.all([
      new StateStore(projectDir).read(),
      loadConfig(projectDir).catch(() => null),
    ])
    return {
      strikes: state.no_progress_count,
      strikesAllowed: config?.limits.no_progress_strikes ?? null,
      cycleErrors: state.cycle_errors,
      // The signature that will halt the run if this cycle repeats it.
      errorArmed: state.last_error_fingerprint,
    }
  } catch {
    return null
  }
}

async function readPlans(projectDir: string): Promise<PlanView[]> {
  let ids: string[] = []
  try {
    ids = await listPlanIds(projectDir)
  } catch {
    return []
  }

  const plans: PlanView[] = []
  for (const id of ids) {
    // One unreadable plan directory must not blank the whole panel: the other
    // plans are still on disk and the user still needs to see them.
    try {
      plans.push(await readPlanView(projectDir, id))
    } catch {
      continue
    }
  }
  return plans
}

async function readPlanView(projectDir: string, id: string): Promise<PlanView> {
  const dir = await findPlanDir(projectDir, id)
  const [frontmatter, manifest] = await Promise.all([readPlanFrontmatter(dir), readManifest(dir)])

  return {
    id,
    // The directory name is the last resort, and it always exists — `findPlanDir`
    // found the plan by it.
    title: frontmatter?.title ?? manifest?.title ?? path.basename(dir),
    approval: frontmatter?.approval?.decision ?? null,
    stories: manifest?.stories ?? [],
  }
}

async function readPlanFrontmatter(
  dir: string,
): Promise<{ title: string; approval: { decision: string } | null } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')
    const parsed = PlanFrontmatterSchema.safeParse(parseFrontmatter(raw).data)
    if (!parsed.success) return null
    return { title: parsed.data.title, approval: parsed.data.approval }
  } catch {
    return null
  }
}

/**
 * The manifest is the source for stories — it is what the engine derives from
 * the story files, so reading it keeps this in step with `INDEX.md` rather than
 * inventing a second interpretation of the same directory.
 */
async function readManifest(dir: string): Promise<{ title: string; stories: StoryView[] } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')
    const parsed = ManifestSchema.safeParse(JSON.parse(raw) as unknown)
    if (!parsed.success) return null
    return {
      title: parsed.data.title,
      stories: parsed.data.stories.map((story) => ({
        id: story.id,
        title: story.title,
        status: story.status,
        ui: story.ui,
        depends_on: story.depends_on,
      })),
    }
  } catch {
    return null
  }
}

/** Newest first: run ids sort lexicographically because they open with a timestamp. */
async function listRuns(projectDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(resolveLoopPaths(projectDir).runs, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export type { Revisions }
