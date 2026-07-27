import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  ApprovalSchema,
  PlanFrontmatterSchema,
  StoryFrontmatterSchema,
  type Approval,
  type ApprovalDecision,
  type Manifest,
  type StoryFrontmatter,
  type StoryStatus,
} from '../schemas/plan.js'
import { ConfigMissingError, loadConfig } from '../store/config-store.js'
import { withLock } from '../store/lock.js'
import { resolveLoopPaths } from '../store/paths.js'
import {
  findPlanDir,
  listPlanIds,
  listStories,
  readPlan,
  readStory,
  storyFileName,
  usedStoryNumbers,
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

export class ApprovalRequiredError extends Error {
  constructor(planId: string) {
    super(
      `plan "${planId}" has no recorded approval and gates.plan_approval is "human", so no story may be added ` +
        'to it yet. Show the plan to the user, ask whether it is approved, and record their answer with ' +
        'loop_gate_set — including their own words. Never record an approval nobody gave; set ' +
        'gates.plan_approval to "auto" in .loop/config.yaml if this project does not want a human in the loop.',
    )
    this.name = 'ApprovalRequiredError'
  }
}

export interface GateSetInput {
  plan: string
  decision: ApprovalDecision
  by: string
  note?: string | null
}

/**
 * Record a decision about a plan.
 *
 * A tool is the right shape here where milestones 2 and 3 refused one: those
 * would have taken the leader's word for a fact that evidence could establish,
 * and an approval has no fact underneath it — the record is the thing. What the
 * engine cannot do is verify a human made the decision, so it records `by` and
 * the approver's own words instead of pretending to.
 */
export async function gateSet(
  projectDir: string,
  input: GateSetInput,
  now: Clock = () => new Date(),
): Promise<{ plan: string; approval: Approval; repaired: boolean }> {
  const paths = resolveLoopPaths(projectDir)
  await findPlanDir(projectDir, input.plan)

  return withLock(paths.lock, async () => {
    const plan = await readPlan(projectDir, input.plan)
    const approval = ApprovalSchema.safeParse({
      decision: input.decision,
      by: input.by,
      at: now().toISOString(),
      note: input.note ?? null,
    })
    if (!approval.success) throw new InvalidPlanInputError(z.prettifyError(approval.error))

    // Written back to the directory the plan was read from, not to one named
    // after the slug: the two can disagree, and the plan's stories live here.
    await writePlan(
      projectDir,
      { frontmatter: { ...plan.frontmatter, approval: approval.data }, body: plan.body },
      plan.dir,
    )
    // A repair is reported rather than left silent: it rewrote the file this
    // decision is being recorded in.
    return { plan: input.plan, approval: approval.data, repaired: plan.repaired }
  })
}

/** `S` plus two digits is the id format, so a plan holds at most 99 stories. */
const MAX_STORY_NUMBER = 99

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
): Promise<{ id: string; file: string; manifest: Manifest; repaired: boolean }> {
  const paths = resolveLoopPaths(projectDir)
  // findPlanDir throws PlanNotFoundError before the lock is taken, so a bad
  // plan id fails fast instead of serialising behind unrelated work.
  await findPlanDir(projectDir, input.plan)

  // The approval gate. A project with no .loop/config.yaml has not opted into
  // anything, so a missing config gates nothing. A config that is present and
  // unreadable is the opposite case: somebody wrote a gate setting there and it
  // cannot be read, so this fails closed exactly as runLog's gate does — a
  // typo in a hand-edited config must not silently remove the human.
  let requiresApproval = false
  try {
    requiresApproval = (await loadConfig(projectDir)).gates.plan_approval === 'human'
  } catch (error) {
    if (!(error instanceof ConfigMissingError)) throw error
  }

  return withLock(paths.lock, async () => {
    // Read under the lock. readPlan is a writer whenever the frontmatter was
    // clobbered, and an unlocked repair racing a locked gateSet lands on top of
    // an approval that was already reported as recorded.
    const plan = await readPlan(projectDir, input.plan)
    if (requiresApproval && plan.frontmatter.approval?.decision !== 'approved') {
      throw new ApprovalRequiredError(input.plan)
    }

    const existing = await listStories(projectDir, input.plan)
    // Allocated from the directory rather than from the parsed stories: a file
    // the schema can no longer read still owns its id.
    const used = await usedStoryNumbers(projectDir, input.plan)
    const next = used.length === 0 ? 1 : Math.max(...used) + 1
    // Two digits is the id format, so 99 is the ceiling. Saying so beats
    // handing the caller a validation error about an id it never supplied.
    if (next > MAX_STORY_NUMBER) {
      throw new InvalidPlanInputError(
        `plan "${input.plan}" is full: story ids run to S${MAX_STORY_NUMBER}. Split the remaining work into another plan`,
      )
    }
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
    // Reported rather than left silent: a repair rewrote PLAN.md on the way in,
    // and whoever wrote that file needs to know it was replaced.
    return { id, file, manifest, repaired: plan.repaired }
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

    // Only a patch that changes the edges is checked against the graph. A
    // dangling edge left by a story file somebody deleted is a pre-existing
    // condition, and gating an unrelated status or evidence write on it would
    // make the dependent story permanently un-updatable — with an error that
    // blames dependencies for a missing file.
    if (patch.depends_on !== undefined) {
      const siblings = (await listStories(projectDir, planId)).filter(
        (story) => story.frontmatter.id !== storyId,
      )
      assertDependenciesResolve(siblings, merged.data)
    }

    // A title change renames the file. The rename happens first and is one
    // syscall, so the story never occupies two paths at once: an interrupted
    // update cannot leave a second file claiming the same id, which nothing
    // afterwards would ever clean up.
    const renamed = path.join(path.dirname(current.file), storyFileName(merged.data))
    if (renamed !== current.file) await fs.rename(current.file, renamed)
    const file = await writeStory(projectDir, { frontmatter: merged.data, body: current.body })

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
