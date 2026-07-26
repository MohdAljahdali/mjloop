import fs from 'node:fs/promises'
import * as z from 'zod'
import { PlanFrontmatterSchema, StoryFrontmatterSchema, type Manifest } from '../schemas/plan.js'
import { withLock } from '../store/lock.js'
import { resolveLoopPaths } from '../store/paths.js'
import { findPlanDir, listPlanIds, listStories, writePlan, writeStory } from '../store/plan-store.js'
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

    const file = await writeStory(projectDir, { frontmatter: frontmatter.data, body: input.body ?? '' })
    const manifest = await renderManifest(projectDir, input.plan, now)
    return { id, file, manifest }
  })
}
