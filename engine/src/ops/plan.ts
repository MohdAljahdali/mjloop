import fs from 'node:fs/promises'
import * as z from 'zod'
import {
  PlanFrontmatterSchema,
  StoryFrontmatterSchema,
  type Manifest,
  type StoryFrontmatter,
  type StoryStatus,
} from '../schemas/plan.js'
import { withLock } from '../store/lock.js'
import { resolveLoopPaths } from '../store/paths.js'
import {
  findPlanDir,
  listPlanIds,
  listStories,
  readStory,
  writePlan,
  writeStory,
  type Story,
} from '../store/plan-store.js'
import type { Clock } from '../store/state-store.js'
import { renderManifest } from './manifest.js'

export class InvalidPlanInputError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'InvalidPlanInputError'
  }
}

export interface PlanCreateInput {
  slug: string
  title: string
  body?: string
}

/**
 * Allocation runs under the write lock for the same reason `nextRunId` does:
 * two overlapping creates that each scanned the directory before either wrote
 * would allocate the same id and one would silently overwrite the other.
 */
export async function planCreate(
  projectDir: string,
  input: PlanCreateInput,
  now: Clock = () => new Date(),
): Promise<{ id: string; dir: string; manifest: Manifest }> {
  const paths = resolveLoopPaths(projectDir)
  // The lock is a directory created with a deliberately non-recursive `mkdir`,
  // so `.loop` itself must already exist. It does for every operation that
  // follows `loop init`, but the first plan can be created before anything
  // else has written there. `storyAdd` needs no equivalent: `findPlanDir`
  // rejects the plan before the lock is reached if `.loop` is missing.
  await fs.mkdir(paths.root, { recursive: true })
  return withLock(paths.lock, async () => {
    const existing = await listPlanIds(projectDir)
    const next = existing.length === 0 ? 1 : Math.max(...existing.map((id) => Number(id.slice(1)))) + 1
    const id = `P${String(next).padStart(3, '0')}`

    const frontmatter = PlanFrontmatterSchema.safeParse({
      id,
      slug: input.slug,
      title: input.title,
      created_at: now().toISOString(),
    })
    if (!frontmatter.success) throw new InvalidPlanInputError(z.prettifyError(frontmatter.error))

    const dir = await writePlan(projectDir, { frontmatter: frontmatter.data, body: input.body ?? '' })
    const manifest = await renderManifest(projectDir, id, now)
    return { id, dir, manifest }
  })
}

export interface StoryAddInput {
  plan: string
  title: string
  acceptance?: string[]
  ui?: boolean
  depends_on?: string[]
  body?: string
}

export async function storyAdd(
  projectDir: string,
  input: StoryAddInput,
  now: Clock = () => new Date(),
): Promise<{ id: string; file: string; manifest: Manifest }> {
  const paths = resolveLoopPaths(projectDir)
  // findPlanDir throws PlanNotFoundError before the lock is taken, so a bad
  // plan id fails fast instead of serialising behind unrelated work.
  await findPlanDir(projectDir, input.plan)

  return withLock(paths.lock, async () => {
    const existing = await listStories(projectDir, input.plan)
    const used = existing.map((story) => Number(story.frontmatter.id.slice(-2)))
    const next = used.length === 0 ? 1 : Math.max(...used) + 1
    const id = `${input.plan}-S${String(next).padStart(2, '0')}`

    const frontmatter = StoryFrontmatterSchema.safeParse({
      id,
      plan: input.plan,
      title: input.title,
      status: 'todo',
      ui: input.ui ?? false,
      depends_on: input.depends_on ?? [],
      acceptance: input.acceptance ?? [],
      evidence: null,
    })
    if (!frontmatter.success) throw new InvalidPlanInputError(z.prettifyError(frontmatter.error))

    assertDependenciesResolve(existing, frontmatter.data)

    const file = await writeStory(projectDir, { frontmatter: frontmatter.data, body: input.body ?? '' })
    const manifest = await renderManifest(projectDir, input.plan, now)
    return { id, file, manifest }
  })
}

export class DependencyError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DependencyError'
  }
}

/**
 * A dangling edge makes `--next` unanswerable and a cycle makes it silently
 * return nothing forever, so both are rejected where they are introduced
 * rather than discovered later by a leader with no way to explain the stall.
 */
export function assertDependenciesResolve(stories: Story[], candidate: StoryFrontmatter): void {
  const byId = new Map(stories.map((story) => [story.frontmatter.id, story.frontmatter.depends_on]))
  byId.set(candidate.id, candidate.depends_on)

  for (const dependency of candidate.depends_on) {
    if (dependency === candidate.id) {
      throw new DependencyError(`"${candidate.id}" cannot depend on itself`)
    }
    if (!byId.has(dependency)) {
      throw new DependencyError(`"${candidate.id}" depends on "${dependency}", which does not exist in this plan`)
    }
  }

  // Depth-first search from the candidate. Only the candidate's edges changed,
  // so any new cycle must pass through it.
  const seen = new Set<string>()
  const stack: string[] = []

  const visit = (id: string): void => {
    if (stack.includes(id)) {
      throw new DependencyError(`dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`)
    }
    if (seen.has(id)) return
    seen.add(id)
    stack.push(id)
    for (const next of byId.get(id) ?? []) visit(next)
    stack.pop()
  }

  visit(candidate.id)
}

export interface StoryPatch {
  status?: StoryStatus
  evidence?: string | null
  acceptance?: string[]
  ui?: boolean
  depends_on?: string[]
  title?: string
}

export async function storyUpdate(
  projectDir: string,
  storyId: string,
  patch: StoryPatch,
  now: Clock = () => new Date(),
): Promise<{ id: string; file: string; manifest: Manifest }> {
  const paths = resolveLoopPaths(projectDir)
  const planId = storyId.slice(0, 4)

  return withLock(paths.lock, async () => {
    const current = await readStory(projectDir, storyId)
    const merged = StoryFrontmatterSchema.safeParse({ ...current.frontmatter, ...patch })
    if (!merged.success) throw new InvalidPlanInputError(z.prettifyError(merged.error))

    const siblings = (await listStories(projectDir, planId)).filter(
      (story) => story.frontmatter.id !== storyId,
    )
    assertDependenciesResolve(siblings, merged.data)

    const file = await writeStory(projectDir, { frontmatter: merged.data, body: current.body })
    // A title change renames the file; the old one would otherwise linger and
    // the manifest would list the story twice.
    if (file !== current.file) await fs.rm(current.file, { force: true })

    const manifest = await renderManifest(projectDir, planId, now)
    return { id: storyId, file, manifest }
  })
}

export async function storyGet(projectDir: string, storyId: string): Promise<Story> {
  return readStory(projectDir, storyId)
}

/**
 * Resolve `--next`: the lowest-id story that is ready to start.
 *
 * Returning nothing is a normal answer rather than an error — every story may
 * be done, or the remainder may be waiting on something. The reason says which,
 * because "nothing to do" and "everything is stuck" call for opposite responses.
 */
export async function storyNext(
  projectDir: string,
  planId?: string,
): Promise<{ story: Story | null; reason: string }> {
  const planIds = planId === undefined ? await listPlanIds(projectDir) : [planId]
  if (planIds.length === 0) return { story: null, reason: 'no plans exist yet — create one first' }

  const waiting: string[] = []
  let sawAny = false
  let allDone = true

  for (const id of planIds) {
    const stories = await listStories(projectDir, id)
    const done = new Set(
      stories.filter((story) => story.frontmatter.status === 'done').map((story) => story.frontmatter.id),
    )

    for (const story of stories) {
      sawAny = true
      if (story.frontmatter.status !== 'done') allDone = false
      if (story.frontmatter.status !== 'todo') continue

      const unmet = story.frontmatter.depends_on.filter((dependency) => !done.has(dependency))
      if (unmet.length === 0) return { story, reason: `${story.frontmatter.id} is todo with every dependency done` }
      waiting.push(`${story.frontmatter.id} waiting on ${unmet.join(', ')}`)
    }
  }

  if (!sawAny) return { story: null, reason: 'no stories exist yet — add one first' }
  if (allDone) return { story: null, reason: 'every story is done' }
  if (waiting.length > 0) return { story: null, reason: `nothing is ready: ${waiting.join('; ')}` }
  return { story: null, reason: 'no story is todo — the remainder is doing or blocked' }
}
