import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  PlanFrontmatterSchema,
  StoryFrontmatterSchema,
  type PlanFrontmatter,
  type StoryFrontmatter,
} from '../schemas/plan.js'
import { parseFrontmatter, serialiseFrontmatter } from './frontmatter.js'
import { resolveLoopPaths } from './paths.js'

export class PlanNotFoundError extends Error {
  constructor(planId: string, dir: string) {
    super(`no plan "${planId}" under ${dir}`)
    this.name = 'PlanNotFoundError'
  }
}

export class StoryNotFoundError extends Error {
  constructor(storyId: string, dir: string) {
    super(`no story "${storyId}" under ${dir}`)
    this.name = 'StoryNotFoundError'
  }
}

export class InvalidStoryFileError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not a valid story:\n${detail}`)
    this.name = 'InvalidStoryFileError'
  }
}

export interface Plan {
  frontmatter: PlanFrontmatter
  body: string
  /** Absolute path to the plan directory. */
  dir: string
  /** True when PLAN.md's frontmatter was missing or invalid and was rebuilt. */
  repaired: boolean
}

export interface Story {
  frontmatter: StoryFrontmatter
  body: string
  /** Absolute path to the story file. */
  file: string
}

/**
 * The slug is bounded because the whole basename is: a title is free text, and
 * `NAME_MAX` is 255 bytes on every filesystem this runs on. A truncated slug
 * still identifies the file — the id in front of it is what makes it unique.
 */
const SLUG_MAX = 60

/** `<id>-<slugified title>.md` — identifiable in a directory listing. */
export function storyFileName(frontmatter: StoryFrontmatter): string {
  const slug = frontmatter.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return `${frontmatter.id}-${slug}.md`
}

/** Plan directories only: a stray file named like a plan is not one. */
async function listPlanDirs(plansDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
}

export async function listPlanIds(projectDir: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const entry of await listPlanDirs(resolveLoopPaths(projectDir).plans)) {
    const id = /^(P\d{3})-/.exec(entry)?.[1]
    // Deduplicated: two directories can share an id (`P001-auth` beside a
    // stale `P001-old`), and rendering that plan twice would double-count it
    // in INDEX.md.
    if (id !== undefined) ids.add(id)
  }
  return [...ids].sort()
}

export async function findPlanDir(projectDir: string, planId: string): Promise<string> {
  const plansDir = resolveLoopPaths(projectDir).plans
  const entries = await listPlanDirs(plansDir)
  const match = entries.find((entry) => entry.startsWith(`${planId}-`))
  if (match === undefined) throw new PlanNotFoundError(planId, plansDir)
  return path.join(plansDir, match)
}

/**
 * Read a plan, rebuilding its frontmatter if an agent clobbered it.
 *
 * `planner` writes prose into PLAN.md, so the frontmatter the engine depends on
 * is reachable by an agent's `Write`. Failing loudly would let one careless
 * write brick a directory that still holds every story — and repair is cheap
 * here precisely because the identifying facts were never stored in only one
 * place: the directory is named `<id>-<slug>`.
 */
export async function readPlan(projectDir: string, planId: string): Promise<Plan> {
  const dir = await findPlanDir(projectDir, planId)
  const file = path.join(dir, 'PLAN.md')

  let raw = ''
  let missing = false
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    missing = true
  }

  if (!missing) {
    try {
      const { data, body } = parseFrontmatter(raw)
      const parsed = PlanFrontmatterSchema.safeParse(data)
      if (parsed.success) return { frontmatter: parsed.data, body, dir, repaired: false }
    } catch {
      // Fall through to repair: an unparseable block is a clobbered block.
    }
  }

  const body = missing ? '' : recoverBody(raw)
  const frontmatter = await rebuildFrontmatter(dir, planId)
  await fs.writeFile(file, serialiseFrontmatter(frontmatter, body), 'utf8')
  return { frontmatter, body, dir, repaired: true }
}

/** Everything after a frontmatter block, or the whole file when there is none. */
function recoverBody(raw: string): string {
  const closed = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  return (closed?.[1] ?? raw).trim()
}

async function rebuildFrontmatter(dir: string, planId: string): Promise<PlanFrontmatter> {
  const basename = path.basename(dir)
  const slug = basename.slice(planId.length + 1)

  // The manifest is derived from the stories rather than from PLAN.md, so it
  // survives a clobbered PLAN.md and is the best source for the title.
  let title = slug
  let createdAt: string | undefined
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      title?: unknown
      generated_at?: unknown
    }
    if (typeof manifest.title === 'string' && manifest.title.length > 0) title = manifest.title
    if (typeof manifest.generated_at === 'string') createdAt = manifest.generated_at
  } catch {
    // No manifest, or an unreadable one. The slug is a usable title.
  }

  if (createdAt === undefined) {
    // The directory's own timestamp is the best remaining evidence of when
    // this plan came into existence.
    const stats = await fs.stat(dir)
    createdAt = new Date(stats.birthtimeMs || stats.mtimeMs).toISOString()
  }

  const parsed = PlanFrontmatterSchema.safeParse({ id: planId, slug, title, created_at: createdAt })
  if (!parsed.success) {
    throw new InvalidStoryFileError(path.join(dir, 'PLAN.md'), z.prettifyError(parsed.error))
  }
  return parsed.data
}

/** `repaired` is a fact about a read, so a writer neither supplies it nor can. */
export async function writePlan(
  projectDir: string,
  plan: Omit<Plan, 'dir' | 'repaired'>,
): Promise<string> {
  const dir = path.join(
    resolveLoopPaths(projectDir).plans,
    `${plan.frontmatter.id}-${plan.frontmatter.slug}`,
  )
  await fs.mkdir(path.join(dir, 'stories'), { recursive: true })
  await fs.writeFile(path.join(dir, 'PLAN.md'), serialiseFrontmatter(plan.frontmatter, plan.body), 'utf8')
  return dir
}

export async function listStories(projectDir: string, planId: string): Promise<Story[]> {
  const dir = path.join(await findPlanDir(projectDir, planId), 'stories')
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const stories: Story[] = []
  for (const entry of entries.filter((name) => name.endsWith('.md'))) {
    const file = path.join(dir, entry)
    // A file that is not a story is skipped rather than failing the whole plan:
    // one stray notes file must not make every other story unreadable.
    try {
      const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf8'))
      const parsed = StoryFrontmatterSchema.safeParse(data)
      if (!parsed.success) continue
      stories.push({ frontmatter: parsed.data, body, file })
    } catch {
      continue
    }
  }
  return stories.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))
}

/**
 * Story numbers already spoken for in a plan, read from the filenames rather
 * than from the parsed stories.
 *
 * `listStories` skips a file whose frontmatter no longer parses — one stray
 * key is enough — but that file still owns its id, and handing the id out
 * again would put two stories under one name. Allocation therefore reads the
 * directory, which cannot be talked out of an id by a bad edit.
 */
export async function usedStoryNumbers(projectDir: string, planId: string): Promise<number[]> {
  const dir = path.join(await findPlanDir(projectDir, planId), 'stories')
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const numbers = new Set<number>()
  for (const entry of entries) {
    const match = /^(P\d{3})-S(\d{2})(?:[-.]|$)/.exec(entry)
    if (match?.[1] === planId && match[2] !== undefined) numbers.add(Number(match[2]))
  }
  // A story whose file was renamed out of the convention is still a story:
  // its frontmatter id counts too.
  for (const story of await listStories(projectDir, planId)) {
    const match = /^(P\d{3})-S(\d{2})$/.exec(story.frontmatter.id)
    if (match?.[1] === planId && match[2] !== undefined) numbers.add(Number(match[2]))
  }
  return [...numbers]
}

export async function readStory(projectDir: string, storyId: string): Promise<Story> {
  const planId = storyId.slice(0, 4)
  const stories = await listStories(projectDir, planId)
  const found = stories.find((story) => story.frontmatter.id === storyId)
  if (found === undefined) {
    throw new StoryNotFoundError(storyId, path.join(await findPlanDir(projectDir, planId), 'stories'))
  }
  return found
}

export async function writeStory(projectDir: string, story: Omit<Story, 'file'>): Promise<string> {
  const dir = path.join(await findPlanDir(projectDir, story.frontmatter.plan), 'stories')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, storyFileName(story.frontmatter))
  await fs.writeFile(file, serialiseFrontmatter(story.frontmatter, story.body), 'utf8')
  return file
}
