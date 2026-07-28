import fs from 'node:fs/promises'
import path from 'node:path'
import { stateSummary } from '../ops/summary.js'
import { ManifestSchema, PlanFrontmatterSchema } from '../schemas/plan.js'
import { parseFrontmatter } from '../store/frontmatter.js'
import { resolveLoopPaths } from '../store/paths.js'
import { findPlanDir, listPlanIds } from '../store/plan-store.js'
import type { PlanView, Snapshot, StoryView } from './protocol.js'

/**
 * Everything the page draws, read from `.mjloop/`.
 *
 * The page parses none of the loop's formats itself: it gets `stateSummary`'s
 * output and each plan's own manifest, so a schema change in the engine cannot
 * leave a second reader behind holding the old shape.
 *
 * Every read here is non-destructive, which rules out `readPlan` — that one
 * repairs clobbered frontmatter by rewriting the file, and a poller running
 * eight times a second is the last thing that should be writing to a project.
 */
export async function buildSnapshot(projectDir: string): Promise<Omit<Snapshot, 'queue' | 'session'>> {
  const [state, plans, runs] = await Promise.all([
    stateSummary(projectDir),
    readPlans(projectDir),
    listRuns(projectDir),
  ])
  return { project: projectDir, state, plans, runs }
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
  const [frontmatter, stories, manifestTitle] = await Promise.all([
    readPlanFrontmatter(dir),
    readStories(dir),
    readManifestTitle(dir),
  ])

  return {
    id,
    // The directory name is the last resort, and it always exists — `findPlanDir`
    // found the plan by it.
    title: frontmatter?.title ?? manifestTitle ?? path.basename(dir),
    approval: frontmatter?.approval?.decision ?? null,
    stories,
  }
}

async function readPlanFrontmatter(dir: string): Promise<{ title: string; approval: { decision: string } | null } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')
    const parsed = PlanFrontmatterSchema.safeParse(parseFrontmatter(raw).data)
    if (!parsed.success) return null
    return { title: parsed.data.title, approval: parsed.data.approval }
  } catch {
    return null
  }
}

async function readManifestTitle(dir: string): Promise<string | null> {
  const manifest = await readManifest(dir)
  return manifest?.title ?? null
}

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

/**
 * The manifest is the source for stories — it is what the engine derives from
 * the story files, so reading it keeps this in step with `INDEX.md` rather than
 * inventing a second interpretation of the same directory.
 */
async function readStories(dir: string): Promise<StoryView[]> {
  return (await readManifest(dir))?.stories ?? []
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
