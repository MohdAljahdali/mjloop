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
}

export interface Story {
  frontmatter: StoryFrontmatter
  body: string
  /** Absolute path to the story file. */
  file: string
}

/** `<id>-<slugified title>.md` — identifiable in a directory listing. */
export function storyFileName(frontmatter: StoryFrontmatter): string {
  const slug = frontmatter.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${frontmatter.id}-${slug}.md`
}

export async function listPlanIds(projectDir: string): Promise<string[]> {
  const plansDir = resolveLoopPaths(projectDir).plans
  let entries: string[] = []
  try {
    entries = await fs.readdir(plansDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return entries
    .map((entry) => /^(P\d{3})-/.exec(entry)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort()
}

export async function findPlanDir(projectDir: string, planId: string): Promise<string> {
  const plansDir = resolveLoopPaths(projectDir).plans
  let entries: string[] = []
  try {
    entries = await fs.readdir(plansDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const match = entries.find((entry) => entry.startsWith(`${planId}-`))
  if (match === undefined) throw new PlanNotFoundError(planId, plansDir)
  return path.join(plansDir, match)
}

export async function readPlan(projectDir: string, planId: string): Promise<Plan> {
  const dir = await findPlanDir(projectDir, planId)
  const raw = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')
  const { data, body } = parseFrontmatter(raw)
  const parsed = PlanFrontmatterSchema.safeParse(data)
  if (!parsed.success) throw new InvalidStoryFileError(path.join(dir, 'PLAN.md'), z.prettifyError(parsed.error))
  return { frontmatter: parsed.data, body, dir }
}

export async function writePlan(projectDir: string, plan: Omit<Plan, 'dir'>): Promise<string> {
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
