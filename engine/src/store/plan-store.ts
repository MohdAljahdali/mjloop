import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  ApprovalSchema,
  PlanFrontmatterSchema,
  StoryFrontmatterSchema,
  type PlanFrontmatter,
  type StoryFrontmatter,
} from '../schemas/plan.js'
import { IdSchema } from '../schemas/state.js'
import { parseFrontmatter, serialiseFrontmatter, splitFrontmatter } from './frontmatter.js'
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

/** A PLAN.md that could not even be rebuilt. Named for the file it is about. */
export class InvalidPlanFileError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not a valid plan:\n${detail}`)
    this.name = 'InvalidPlanFileError'
  }
}

/**
 * A PLAN.md that exists but cannot be read as a file — a directory of that
 * name, or one whose mode was cleared.
 *
 * Repair cannot help here and a raw errno names neither the plan nor the path,
 * so it surfaces from deep inside an index render as an unattributed EISDIR.
 */
export class UnreadablePlanFileError extends Error {
  constructor(planId: string, file: string, code: string | undefined) {
    super(
      `PLAN.md for plan "${planId}" at ${file} could not be read (${code ?? 'unknown error'}) — ` +
        'it must be a regular file. Remove or rename whatever is at that path and the plan rebuilds itself.',
    )
    this.name = 'UnreadablePlanFileError'
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
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new UnreadablePlanFileError(planId, file, code)
    missing = true
  }

  // Whatever of the old block survived. Repair rebuilds only what is actually
  // broken, so a field that still validates on its own is carried across —
  // `approval` above all, which nothing else on disk records.
  let salvage: Record<string, unknown> = {}
  let body = missing ? '' : raw.trim()

  if (!missing) {
    const fenced = splitFrontmatter(raw)
    try {
      const parsed = parseFrontmatter(raw)
      // A fence whose contents parse to something other than a mapping was
      // never frontmatter: a document opening with a `---` thematic break.
      // Stripping to the next fence there would delete the head of the file.
      if (isMapping(parsed.data)) {
        salvage = parsed.data
        body = parsed.body
        const validated = PlanFrontmatterSchema.safeParse(parsed.data)
        // The directory name is authoritative for the slug. A frontmatter slug
        // that disagrees is repaired rather than trusted: `writePlan` follows
        // the directory, so a disagreement left standing would put the plan's
        // own manifest under a name no directory has.
        if (validated.success && validated.data.slug === derivedSlug(dir, planId)) {
          return { frontmatter: validated.data, body, dir, repaired: false }
        }
      }
    } catch {
      // A fence whose contents are not yaml at all is a clobbered block, so the
      // body is what follows it. No fence means the whole file is body.
      if (fenced !== null) body = fenced.body
    }
  }

  const frontmatter = await rebuildFrontmatter(dir, planId, salvage)
  await fs.writeFile(file, serialiseFrontmatter(frontmatter, body), 'utf8')
  return { frontmatter, body, dir, repaired: true }
}

function isMapping(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

/**
 * The slug the directory name carries.
 *
 * The remainder is taken verbatim when it is already a valid id, so an ordinary
 * plan never looks like it disagrees with itself. Anything else is sanitized the
 * way `storyFileName` sanitizes a title, because this value is fed back into
 * `IdSchema`: a directory renamed by hand to `P001-user-auth.v2` — or to
 * `P001-` — would otherwise make repair throw instead of repairing, and take
 * every other plan's row in `INDEX.md` down with it.
 */
function derivedSlug(dir: string, planId: string): string {
  const remainder = path.basename(dir).slice(planId.length + 1)
  if (IdSchema.safeParse(remainder).success) return remainder

  const slug = remainder
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return slug.length === 0 ? planId : slug
}

async function rebuildFrontmatter(
  dir: string,
  planId: string,
  salvage: Record<string, unknown>,
): Promise<PlanFrontmatter> {
  const slug = derivedSlug(dir, planId)

  // An approval is the one field in this block that is written down nowhere
  // else: the directory name cannot yield it and the manifest does not carry
  // it. A block that broke around it usually still holds it intact, so it is
  // salvaged before anything is rebuilt — a repair must never quietly delete a
  // decision somebody made.
  const salvagedApproval = ApprovalSchema.safeParse(salvage.approval)
  const salvagedTitle = z.string().min(1).safeParse(salvage.title)
  const salvagedCreatedAt = z.iso.datetime().safeParse(salvage.created_at)

  // The manifest is derived from the stories rather than from PLAN.md, so it
  // survives a clobbered PLAN.md and is the next best source for the title.
  let title = salvagedTitle.success ? salvagedTitle.data : slug
  let createdAt = salvagedCreatedAt.success ? salvagedCreatedAt.data : undefined
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      title?: unknown
      generated_at?: unknown
    }
    const manifestTitle = z.string().min(1).safeParse(manifest.title)
    if (!salvagedTitle.success && manifestTitle.success) title = manifestTitle.data
    // Validated rather than merely typed: a manifest is disposable, and one
    // bad `generated_at` copied through unchecked fails the assembled block
    // and bricks the plan — including the render that would replace it.
    const manifestCreatedAt = z.iso.datetime().safeParse(manifest.generated_at)
    if (createdAt === undefined && manifestCreatedAt.success) createdAt = manifestCreatedAt.data
  } catch {
    // No manifest, or an unreadable one. The slug is a usable title.
  }

  if (createdAt === undefined) {
    // The directory's own timestamp is the best remaining evidence of when
    // this plan came into existence.
    const stats = await fs.stat(dir)
    createdAt = new Date(stats.birthtimeMs || stats.mtimeMs).toISOString()
  }

  const parsed = PlanFrontmatterSchema.safeParse({
    id: planId,
    slug,
    title,
    created_at: createdAt,
    approval: salvagedApproval.success ? salvagedApproval.data : null,
  })
  if (!parsed.success) {
    throw new InvalidPlanFileError(path.join(dir, 'PLAN.md'), z.prettifyError(parsed.error))
  }
  return parsed.data
}

/**
 * `repaired` is a fact about a read, so a writer neither supplies it nor can.
 *
 * `dir` is the directory the plan was read from. Recomputing it from the slug
 * forks the plan into a second directory the moment the two disagree — an
 * agent editing `slug`, or a directory renamed by hand — leaving every story
 * behind in the first one while every tool reads the second. Only `planCreate`
 * omits it, because it is the one caller with no directory yet.
 */
export async function writePlan(
  projectDir: string,
  plan: Omit<Plan, 'dir' | 'repaired'>,
  dir = path.join(resolveLoopPaths(projectDir).plans, `${plan.frontmatter.id}-${plan.frontmatter.slug}`),
): Promise<string> {
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
