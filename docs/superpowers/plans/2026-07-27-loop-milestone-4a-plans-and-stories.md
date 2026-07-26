# Loop — Milestone 4a: Plans and Stories as Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a plan and its stories real artefacts on disk, and let `/loop:build P001-S02` and `/loop:build --next` run against them.

**Architecture:** The story markdown file is the sole source of truth for its story. `manifest.json` is an index derived from the story files and regenerated whole on every write, and `INDEX.md` is derived from the manifests — so no fact lives in two places and there is no synchronisation step to get wrong. Five MCP tools are the supported way to touch any of it.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · yaml 2.9.0 · @modelcontextprotocol/sdk 1.29.0 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-27-loop-milestone-4a-plans-and-stories-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json` or any `manifest.json`.
- **The manifest is derived.** Never patch it; regenerate it whole from the story files.
- **The engine does not know agent names.** Any rule naming a specific agent belongs in track config.
- **Any string that reaches the filesystem is validated** before it is interpolated into a path — plan ids, story ids, and slugs all reach the filesystem.
- Every operation that stamps a timestamp takes an injectable `now: Clock` defaulting to `() => new Date()`.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/store/frontmatter.ts` | **New.** Parse and serialise markdown-with-frontmatter. Pure, no I/O |
| `engine/src/schemas/plan.ts` | **New.** Plan, story, and manifest schemas plus id patterns |
| `engine/src/store/plan-store.ts` | **New.** Reading and writing plan directories and story files |
| `engine/src/ops/manifest.ts` | **New.** Derive `manifest.json` from the story files |
| `engine/src/ops/plan.ts` | **New.** `planCreate`, `storyAdd`, `storyUpdate`, `storyGet`, dependency validation |
| `engine/src/ops/index-render.ts` | **New.** Derive `.loop/INDEX.md` from every manifest |
| `engine/src/ops/run.ts` | `runStart` validates a story id that is given |
| `engine/src/mcp/server.ts` | Five new tools |
| `commands/build.md` | The three argument forms |
| `skills/loop-leader/SKILL.md` | Briefing from a story, writing evidence back |
| `engine/tests/**` | One test file per source module, mirrored paths |
| `tests/e2e/run-story.sh` | **New.** Opt-in real-CLI smoke test |

---

## Task 1: Frontmatter and the plan schemas

**Files:**
- Create: `engine/src/store/frontmatter.ts`, `engine/src/schemas/plan.ts`
- Test: `engine/tests/store/frontmatter.test.ts`, `engine/tests/schemas/plan.test.ts`

**Interfaces:**
- Consumes: `IdSchema` from `engine/src/schemas/state.ts`.
- Produces: `parseFrontmatter(raw: string): { data: unknown; body: string }`, `serialiseFrontmatter(data: unknown, body: string): string`, `FrontmatterError`; `PlanIdSchema`, `StoryIdSchema`, `StoryStatusSchema`, `PlanFrontmatterSchema`, `StoryFrontmatterSchema`, `ManifestEntrySchema`, `ManifestSchema` and their inferred types `PlanFrontmatter`, `StoryFrontmatter`, `StoryStatus`, `ManifestEntry`, `Manifest`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/store/frontmatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FrontmatterError, parseFrontmatter, serialiseFrontmatter } from '../../src/store/frontmatter.js'

describe('parseFrontmatter', () => {
  it('splits the block from the body', () => {
    const { data, body } = parseFrontmatter('---\nid: P001\n---\n\nSome prose.\n')
    expect(data).toEqual({ id: 'P001' })
    expect(body).toBe('Some prose.')
  })

  it('accepts a document with no body', () => {
    const { data, body } = parseFrontmatter('---\nid: P001\n---\n')
    expect(data).toEqual({ id: 'P001' })
    expect(body).toBe('')
  })

  it('keeps --- inside the body', () => {
    const { body } = parseFrontmatter('---\nid: P001\n---\n\nBefore\n\n---\n\nAfter\n')
    expect(body).toContain('---')
    expect(body).toContain('After')
  })

  it('throws when there is no frontmatter block', () => {
    expect(() => parseFrontmatter('# Just a heading\n')).toThrow(FrontmatterError)
  })

  it('throws on unparseable yaml', () => {
    expect(() => parseFrontmatter('---\nid: [unclosed\n---\n')).toThrow(FrontmatterError)
  })
})

describe('serialiseFrontmatter', () => {
  it('round-trips through parse unchanged', () => {
    const data = { id: 'P001-S02', depends_on: ['P001-S01'], acceptance: ['a', 'b'], evidence: null }
    const parsed = parseFrontmatter(serialiseFrontmatter(data, 'Body text.'))
    expect(parsed.data).toEqual(data)
    expect(parsed.body).toBe('Body text.')
  })

  it('emits readable yaml rather than json', () => {
    const raw = serialiseFrontmatter({ id: 'P001', title: 'User auth' }, '')
    expect(raw).toContain('id: P001')
    expect(raw).not.toContain('{')
  })

  it('ends with a newline whether or not there is a body', () => {
    expect(serialiseFrontmatter({ id: 'P001' }, '')).toMatch(/\n$/)
    expect(serialiseFrontmatter({ id: 'P001' }, 'Body.')).toMatch(/\n$/)
  })
})
```

`engine/tests/schemas/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ManifestSchema,
  PlanFrontmatterSchema,
  PlanIdSchema,
  StoryFrontmatterSchema,
  StoryIdSchema,
} from '../../src/schemas/plan.js'

const STORY = {
  id: 'P001-S02',
  plan: 'P001',
  title: 'Session token issuance',
  status: 'todo',
  ui: false,
  depends_on: ['P001-S01'],
  acceptance: ['Tokens expire after 24h'],
  evidence: null,
}

describe('id patterns', () => {
  it('accepts a well-formed plan id', () => {
    expect(PlanIdSchema.safeParse('P001').success).toBe(true)
  })

  it('rejects a plan id that is not three digits', () => {
    expect(PlanIdSchema.safeParse('P1').success).toBe(false)
    expect(PlanIdSchema.safeParse('P0001').success).toBe(false)
  })

  it('accepts a well-formed story id', () => {
    expect(StoryIdSchema.safeParse('P001-S02').success).toBe(true)
  })

  it('rejects a story id that could steer a path', () => {
    expect(StoryIdSchema.safeParse('../../etc').success).toBe(false)
    expect(StoryIdSchema.safeParse('P001-S02/x').success).toBe(false)
  })
})

describe('StoryFrontmatterSchema', () => {
  it('accepts a complete story', () => {
    expect(StoryFrontmatterSchema.parse(STORY)).toEqual(STORY)
  })

  it('defaults the optional fields', () => {
    const minimal = { id: 'P001-S01', plan: 'P001', title: 'Login form', status: 'todo' }
    const parsed = StoryFrontmatterSchema.parse(minimal)
    expect(parsed.ui).toBe(false)
    expect(parsed.depends_on).toEqual([])
    expect(parsed.acceptance).toEqual([])
    expect(parsed.evidence).toBeNull()
  })

  it('rejects a status outside the four values', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, status: 'in-progress' }).success).toBe(false)
  })

  it('rejects an unknown frontmatter key', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, priority: 'high' }).success).toBe(false)
  })

  it('rejects a dependency that is not a story id', () => {
    expect(StoryFrontmatterSchema.safeParse({ ...STORY, depends_on: ['../x'] }).success).toBe(false)
  })
})

describe('PlanFrontmatterSchema', () => {
  it('accepts a complete plan', () => {
    const plan = { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: '2026-07-27T09:00:00.000Z' }
    expect(PlanFrontmatterSchema.parse(plan)).toEqual(plan)
  })

  it('rejects a slug that could steer a path', () => {
    const bad = { id: 'P001', slug: '../escape', title: 'x', created_at: '2026-07-27T09:00:00.000Z' }
    expect(PlanFrontmatterSchema.safeParse(bad).success).toBe(false)
  })
})

describe('ManifestSchema', () => {
  it('accepts a generated manifest', () => {
    const manifest = {
      schema: 1,
      plan: 'P001',
      slug: 'user-auth',
      title: 'User authentication',
      generated_at: '2026-07-27T09:14:00.000Z',
      stories: [
        {
          id: 'P001-S01',
          title: 'Login form',
          status: 'done',
          ui: true,
          depends_on: [],
          file: 'stories/P001-S01-login-form.md',
        },
      ],
    }
    expect(ManifestSchema.parse(manifest)).toEqual(manifest)
  })

  it('rejects a schema version other than 1', () => {
    const bad = { schema: 2, plan: 'P001', slug: 's', title: 't', generated_at: '2026-07-27T09:14:00.000Z', stories: [] }
    expect(ManifestSchema.safeParse(bad).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/store/frontmatter.test.ts tests/schemas/plan.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `engine/src/store/frontmatter.ts`**

```ts
import * as YAML from 'yaml'

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

/**
 * The opening block only. The pattern is anchored at the start and
 * non-greedy up to the first closing fence, so a `---` inside the body is
 * body text rather than a second frontmatter block.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseFrontmatter(raw: string): { data: unknown; body: string } {
  const match = FRONTMATTER.exec(raw)
  if (match === null) {
    throw new FrontmatterError('no frontmatter block: the file must open with a --- fenced yaml block')
  }
  let data: unknown
  try {
    data = YAML.parse(match[1] ?? '') as unknown
  } catch (error) {
    throw new FrontmatterError(`the frontmatter is not valid yaml: ${(error as Error).message}`)
  }
  return { data, body: (match[2] ?? '').trim() }
}

export function serialiseFrontmatter(data: unknown, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 100 }).trimEnd()
  const trimmed = body.trim()
  return trimmed.length === 0 ? `---\n${yaml}\n---\n` : `---\n${yaml}\n---\n\n${trimmed}\n`
}
```

- [ ] **Step 4: Write `engine/src/schemas/plan.ts`**

```ts
import * as z from 'zod'
import { IdSchema } from './state.js'

export const StoryStatusSchema = z.enum(['todo', 'doing', 'done', 'blocked'])

/**
 * Ids reach the filesystem — they name directories and files — so their shape
 * is constrained rather than merely conventional. Milestone 2 shipped the same
 * constraint on run directory ids after a review found a story id could steer a
 * write outside `.loop`.
 */
export const PlanIdSchema = z.string().regex(/^P\d{3}$/, 'a plan id looks like P001')
export const StoryIdSchema = z.string().regex(/^P\d{3}-S\d{2}$/, 'a story id looks like P001-S02')

export const PlanFrontmatterSchema = z.strictObject({
  id: PlanIdSchema,
  /** Also reaches the filesystem: the directory is `<id>-<slug>`. */
  slug: IdSchema,
  title: z.string().min(1),
  created_at: z.iso.datetime(),
})

export const StoryFrontmatterSchema = z.strictObject({
  id: StoryIdSchema,
  plan: PlanIdSchema,
  title: z.string().min(1),
  status: StoryStatusSchema,
  /** Drives the conditional UI specialists in a later milestone. */
  ui: z.boolean().default(false),
  depends_on: z.array(StoryIdSchema).default([]),
  acceptance: z.array(z.string().min(1)).default([]),
  /** Run directory holding the proof this story is done. Null until it is. */
  evidence: z.string().min(1).nullable().default(null),
})

export const ManifestEntrySchema = z.strictObject({
  id: StoryIdSchema,
  title: z.string().min(1),
  status: StoryStatusSchema,
  ui: z.boolean(),
  depends_on: z.array(StoryIdSchema),
  /** Relative to the plan directory. */
  file: z.string().min(1),
})

/** Derived from the story files. Never hand-edited, never patched in place. */
export const ManifestSchema = z.strictObject({
  schema: z.literal(1),
  plan: PlanIdSchema,
  slug: IdSchema,
  title: z.string().min(1),
  generated_at: z.iso.datetime(),
  stories: z.array(ManifestEntrySchema),
})

export type StoryStatus = z.infer<typeof StoryStatusSchema>
export type PlanFrontmatter = z.infer<typeof PlanFrontmatterSchema>
export type StoryFrontmatter = z.infer<typeof StoryFrontmatterSchema>
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>
export type Manifest = z.infer<typeof ManifestSchema>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/store/frontmatter.test.ts tests/schemas/plan.test.ts && npm run typecheck`
Expected: PASS — 8 frontmatter tests, 12 schema tests.

- [ ] **Step 6: Commit**

```bash
git add engine/src/store/frontmatter.ts engine/src/schemas/plan.ts engine/tests/store/frontmatter.test.ts engine/tests/schemas/plan.test.ts
git commit -m "feat(engine): add frontmatter parsing and the plan schemas"
```

---

## Task 2: The plan store

**Files:**
- Create: `engine/src/store/plan-store.ts`
- Test: `engine/tests/store/plan-store.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`, `serialiseFrontmatter` (Task 1); `PlanFrontmatterSchema`, `StoryFrontmatterSchema`, `PlanFrontmatter`, `StoryFrontmatter` (Task 1); `resolveLoopPaths` from `engine/src/store/paths.ts`.
- Produces: `PlanNotFoundError`, `StoryNotFoundError`, `InvalidStoryFileError`; `Story { frontmatter: StoryFrontmatter; body: string; file: string }`; `Plan { frontmatter: PlanFrontmatter; body: string; dir: string }`; `findPlanDir(projectDir, planId): Promise<string>`; `readPlan(projectDir, planId): Promise<Plan>`; `writePlan(projectDir, plan): Promise<string>`; `listPlanIds(projectDir): Promise<string[]>`; `readStory(projectDir, storyId): Promise<Story>`; `writeStory(projectDir, story): Promise<string>`; `listStories(projectDir, planId): Promise<Story[]>`; `storyFileName(frontmatter): string`.

- [ ] **Step 1: Write the failing test**

`engine/tests/store/plan-store.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PlanNotFoundError,
  StoryNotFoundError,
  findPlanDir,
  listPlanIds,
  listStories,
  readPlan,
  readStory,
  storyFileName,
  writePlan,
  writeStory,
} from '../../src/store/plan-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const CREATED = '2026-07-27T09:00:00.000Z'

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

const PLAN = {
  frontmatter: { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: CREATED },
  body: 'The problem and the approach.',
  dir: '',
}

const STORY = {
  frontmatter: {
    id: 'P001-S02',
    plan: 'P001',
    title: 'Session token issuance',
    status: 'todo' as const,
    ui: false,
    depends_on: ['P001-S01'],
    acceptance: ['Tokens expire after 24h'],
    evidence: null,
  },
  body: 'Context for the story.',
  file: '',
}

describe('storyFileName', () => {
  it('names the file after the id and a slugified title', () => {
    expect(storyFileName(STORY.frontmatter)).toBe('P001-S02-session-token-issuance.md')
  })

  it('strips characters that do not belong in a filename', () => {
    const named = storyFileName({ ...STORY.frontmatter, title: 'Refresh / rotate  the token!' })
    expect(named).toBe('P001-S02-refresh-rotate-the-token.md')
  })
})

describe('writePlan and readPlan', () => {
  it('round-trips a plan through disk', async () => {
    const dir = await writePlan(project.dir, PLAN)
    expect(dir).toBe(path.join(resolveLoopPaths(project.dir).plans, 'P001-user-auth'))

    const read = await readPlan(project.dir, 'P001')
    expect(read.frontmatter).toEqual(PLAN.frontmatter)
    expect(read.body).toBe(PLAN.body)
    expect(read.dir).toBe(dir)
  })

  it('throws PlanNotFoundError for an id with no directory', async () => {
    await expect(readPlan(project.dir, 'P404')).rejects.toBeInstanceOf(PlanNotFoundError)
  })

  it('finds the directory by id regardless of the slug', async () => {
    await writePlan(project.dir, PLAN)
    expect(await findPlanDir(project.dir, 'P001')).toContain('P001-user-auth')
  })
})

describe('writeStory and readStory', () => {
  it('round-trips a story through disk', async () => {
    await writePlan(project.dir, PLAN)
    const file = await writeStory(project.dir, STORY)
    expect(path.basename(file)).toBe('P001-S02-session-token-issuance.md')

    const read = await readStory(project.dir, 'P001-S02')
    expect(read.frontmatter).toEqual(STORY.frontmatter)
    expect(read.body).toBe(STORY.body)
    expect(read.file).toBe(file)
  })

  it('throws StoryNotFoundError for an id with no file', async () => {
    await writePlan(project.dir, PLAN)
    await expect(readStory(project.dir, 'P001-S99')).rejects.toBeInstanceOf(StoryNotFoundError)
  })

  it('finds a story by id even when its title changed the filename', async () => {
    await writePlan(project.dir, PLAN)
    await writeStory(project.dir, STORY)
    await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, title: 'Renamed' } })

    // Both files exist; reading by id must resolve, not collide.
    const read = await readStory(project.dir, 'P001-S02')
    expect(read.frontmatter.id).toBe('P001-S02')
  })
})

describe('listStories', () => {
  it('returns stories sorted by id', async () => {
    await writePlan(project.dir, PLAN)
    await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, id: 'P001-S03', title: 'Third' } })
    await writeStory(project.dir, { ...STORY, frontmatter: { ...STORY.frontmatter, id: 'P001-S01', title: 'First', depends_on: [] } })

    const ids = (await listStories(project.dir, 'P001')).map((story) => story.frontmatter.id)
    expect(ids).toEqual(['P001-S01', 'P001-S02', 'P001-S03'])
  })

  it('returns an empty list for a plan with no stories', async () => {
    await writePlan(project.dir, PLAN)
    expect(await listStories(project.dir, 'P001')).toEqual([])
  })

  it('skips a file that is not a valid story rather than failing whole', async () => {
    await writePlan(project.dir, PLAN)
    await writeStory(project.dir, STORY)
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'stories', 'notes.md'), '# just notes\n', 'utf8')

    const stories = await listStories(project.dir, 'P001')
    expect(stories.map((story) => story.frontmatter.id)).toEqual(['P001-S02'])
  })
})

describe('listPlanIds', () => {
  it('returns plan ids sorted, ignoring stray entries', async () => {
    await writePlan(project.dir, PLAN)
    await writePlan(project.dir, {
      ...PLAN,
      frontmatter: { ...PLAN.frontmatter, id: 'P002', slug: 'billing', title: 'Billing' },
    })
    await fs.mkdir(path.join(resolveLoopPaths(project.dir).plans, 'scratch'), { recursive: true })

    expect(await listPlanIds(project.dir)).toEqual(['P001', 'P002'])
  })

  it('returns an empty list when nothing is provisioned', async () => {
    expect(await listPlanIds(project.dir)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/store/plan-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/store/plan-store.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/store/plan-store.test.ts && npm run typecheck`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/store/plan-store.ts engine/tests/store/plan-store.test.ts
git commit -m "feat(engine): add the plan and story store"
```

---

## Task 3: Deriving the manifest

**Files:**
- Create: `engine/src/ops/manifest.ts`
- Test: `engine/tests/ops/manifest.test.ts`

**Interfaces:**
- Consumes: `readPlan`, `listStories`, `findPlanDir` (Task 2); `ManifestSchema`, `Manifest` (Task 1); `Clock` from `engine/src/store/state-store.ts`; `writeJsonAtomic` from `engine/src/store/atomic.ts`.
- Produces: `renderManifest(projectDir: string, planId: string, now?: Clock): Promise<Manifest>`; `manifestPath(planDir: string): string`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/manifest.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { manifestPath, renderManifest } from '../../src/ops/manifest.js'
import { findPlanDir, writePlan, writeStory } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:14:00.000Z')
const clock = () => NOW

let project: TmpProject

const PLAN = {
  frontmatter: { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: '2026-07-27T09:00:00.000Z' },
  body: '',
}

function story(id: string, title: string, status: 'todo' | 'doing' | 'done' | 'blocked', dependsOn: string[] = []) {
  return {
    frontmatter: { id, plan: 'P001', title, status, ui: false, depends_on: dependsOn, acceptance: [], evidence: null },
    body: '',
  }
}

beforeEach(async () => {
  project = await makeTmpProject()
  await writePlan(project.dir, PLAN)
})
afterEach(async () => { await project.cleanup() })

describe('renderManifest', () => {
  it('writes an empty manifest for a plan with no stories', async () => {
    const manifest = await renderManifest(project.dir, 'P001', clock)
    expect(manifest.stories).toEqual([])
    expect(manifest.plan).toBe('P001')
    expect(manifest.title).toBe('User authentication')
    expect(manifest.generated_at).toBe(NOW.toISOString())
  })

  it('lists stories sorted by id with their file paths relative to the plan', async () => {
    await writeStory(project.dir, story('P001-S02', 'Session token', 'todo', ['P001-S01']))
    await writeStory(project.dir, story('P001-S01', 'Login form', 'done'))

    const manifest = await renderManifest(project.dir, 'P001', clock)
    expect(manifest.stories.map((entry) => entry.id)).toEqual(['P001-S01', 'P001-S02'])
    expect(manifest.stories[0]?.file).toBe('stories/P001-S01-login-form.md')
    expect(manifest.stories[1]?.depends_on).toEqual(['P001-S01'])
    expect(manifest.stories[0]?.status).toBe('done')
  })

  it('persists the manifest to the plan directory', async () => {
    await writeStory(project.dir, story('P001-S01', 'Login form', 'todo'))
    const manifest = await renderManifest(project.dir, 'P001', clock)

    const file = manifestPath(await findPlanDir(project.dir, 'P001'))
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(manifest)
  })

  it('overwrites a hand-corrupted manifest rather than merging with it', async () => {
    await writeStory(project.dir, story('P001-S01', 'Login form', 'todo'))
    const file = manifestPath(await findPlanDir(project.dir, 'P001'))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ "schema": 1, "stories": [{"id":"GHOST"}] }', 'utf8')

    const manifest = await renderManifest(project.dir, 'P001', clock)
    expect(manifest.stories.map((entry) => entry.id)).toEqual(['P001-S01'])
    expect(JSON.stringify(await fs.readFile(file, 'utf8'))).not.toContain('GHOST')
  })

  it('is byte-identical when regenerated from unchanged input', async () => {
    await writeStory(project.dir, story('P001-S01', 'Login form', 'todo'))
    const file = manifestPath(await findPlanDir(project.dir, 'P001'))

    await renderManifest(project.dir, 'P001', clock)
    const first = await fs.readFile(file, 'utf8')
    await renderManifest(project.dir, 'P001', clock)
    expect(await fs.readFile(file, 'utf8')).toBe(first)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/manifest.ts`:

```ts
import path from 'node:path'
import { ManifestSchema, type Manifest } from '../schemas/plan.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { listStories, readPlan } from '../store/plan-store.js'
import type { Clock } from '../store/state-store.js'

export function manifestPath(planDir: string): string {
  return path.join(planDir, 'manifest.json')
}

/**
 * Rebuild `manifest.json` from the story files.
 *
 * The manifest is an index, not a record: it is regenerated whole every time
 * rather than patched, so it cannot drift from the stories it describes and a
 * corrupt one costs nothing — the next call replaces it. This is the same
 * relationship `INDEX.md` has to the manifests, one level down.
 */
export async function renderManifest(
  projectDir: string,
  planId: string,
  now: Clock = () => new Date(),
): Promise<Manifest> {
  const plan = await readPlan(projectDir, planId)
  const stories = await listStories(projectDir, planId)

  const manifest = ManifestSchema.parse({
    schema: 1,
    plan: plan.frontmatter.id,
    slug: plan.frontmatter.slug,
    title: plan.frontmatter.title,
    generated_at: now().toISOString(),
    stories: stories.map((story) => ({
      id: story.frontmatter.id,
      title: story.frontmatter.title,
      status: story.frontmatter.status,
      ui: story.frontmatter.ui,
      depends_on: story.frontmatter.depends_on,
      file: path.relative(plan.dir, story.file),
    })),
  })

  // backup:false — a derived file has nothing worth restoring, and a `.bak`
  // beside it would only invite someone to treat the stale copy as data.
  await writeJsonAtomic(manifestPath(plan.dir), manifest, { backup: false })
  return manifest
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/manifest.test.ts && npm run typecheck`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/manifest.ts engine/tests/ops/manifest.test.ts
git commit -m "feat(engine): derive the plan manifest from its story files"
```

---

## Task 4: `planCreate` and `storyAdd`

**Files:**
- Create: `engine/src/ops/plan.ts`
- Test: `engine/tests/ops/plan.test.ts`

**Interfaces:**
- Consumes: `listPlanIds`, `listStories`, `writePlan`, `writeStory`, `findPlanDir` (Task 2); `renderManifest` (Task 3); `PlanFrontmatterSchema`, `StoryFrontmatterSchema` (Task 1); `withLock` from `engine/src/store/lock.ts`; `resolveLoopPaths` from `engine/src/store/paths.ts`.
- Produces: `planCreate(projectDir, input: { slug: string; title: string; body?: string }, now?): Promise<{ id: string; dir: string; manifest: Manifest }>`; `storyAdd(projectDir, input: { plan: string; title: string; acceptance?: string[]; ui?: boolean; depends_on?: string[]; body?: string }, now?): Promise<{ id: string; file: string; manifest: Manifest }>`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/plan.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planCreate, storyAdd } from '../../src/ops/plan.js'
import { PlanNotFoundError, listPlanIds, readStory } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('planCreate', () => {
  it('allocates P001 for the first plan', async () => {
    const created = await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    expect(created.id).toBe('P001')
    expect(created.dir).toContain('P001-user-auth')
    expect(created.manifest.stories).toEqual([])
  })

  it('allocates the next id for the second plan', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    const second = await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    expect(second.id).toBe('P002')
  })

  it('does not renumber into a gap', async () => {
    await planCreate(project.dir, { slug: 'a', title: 'A' }, clock)
    await planCreate(project.dir, { slug: 'b', title: 'B' }, clock)
    await planCreate(project.dir, { slug: 'c', title: 'C' }, clock)
    expect(await listPlanIds(project.dir)).toEqual(['P001', 'P002', 'P003'])
  })

  it('does not collide when two creates overlap', async () => {
    const [first, second] = await Promise.all([
      planCreate(project.dir, { slug: 'a', title: 'A' }, clock),
      planCreate(project.dir, { slug: 'b', title: 'B' }, clock),
    ])
    expect(new Set([first.id, second.id]).size).toBe(2)
  })

  it('rejects a slug that could steer a path', async () => {
    await expect(planCreate(project.dir, { slug: '../escape', title: 'Escape' }, clock)).rejects.toThrow()
  })

  it('allows two plans to share a slug, distinguished by id', async () => {
    const first = await planCreate(project.dir, { slug: 'auth', title: 'Auth one' }, clock)
    const second = await planCreate(project.dir, { slug: 'auth', title: 'Auth two' }, clock)
    expect(first.id).not.toBe(second.id)
  })
})

describe('storyAdd', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  })

  it('allocates S01 for the first story', async () => {
    const added = await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    expect(added.id).toBe('P001-S01')
    expect(added.file).toContain('P001-S01-login-form.md')
  })

  it('allocates the next story id within the plan', async () => {
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    const second = await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    expect(second.id).toBe('P001-S02')
  })

  it('numbers stories per plan, not globally', async () => {
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    const other = await storyAdd(project.dir, { plan: 'P002', title: 'Invoices' }, clock)
    expect(other.id).toBe('P002-S01')
  })

  it('writes the acceptance criteria and defaults the rest', async () => {
    const added = await storyAdd(
      project.dir,
      { plan: 'P001', title: 'Session token', acceptance: ['Tokens expire after 24h'], ui: true },
      clock,
    )
    const story = await readStory(project.dir, added.id)
    expect(story.frontmatter.acceptance).toEqual(['Tokens expire after 24h'])
    expect(story.frontmatter.ui).toBe(true)
    expect(story.frontmatter.status).toBe('todo')
    expect(story.frontmatter.evidence).toBeNull()
    expect(story.frontmatter.depends_on).toEqual([])
  })

  it('regenerates the manifest so it lists the new story', async () => {
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    const added = await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    expect(added.manifest.stories.map((entry) => entry.id)).toEqual(['P001-S01', 'P001-S02'])
  })

  it('throws PlanNotFoundError for a plan that does not exist', async () => {
    await expect(storyAdd(project.dir, { plan: 'P404', title: 'Ghost' }, clock)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    )
  })

  it('does not collide when two adds overlap', async () => {
    const [first, second] = await Promise.all([
      storyAdd(project.dir, { plan: 'P001', title: 'One' }, clock),
      storyAdd(project.dir, { plan: 'P001', title: 'Two' }, clock),
    ])
    expect(new Set([first.id, second.id]).size).toBe(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/plan.ts`:

```ts
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
```

Note the lock: both operations take `paths.lock`, the same lock `StateStore` uses. That
is broader than strictly necessary — a plan write and a state write cannot actually
corrupt each other — but one lock is one ordering, and a second lock would be the first
step toward a deadlock between them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts && npm run typecheck`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/plan.ts engine/tests/ops/plan.test.ts
git commit -m "feat(engine): create plans and add stories with locked id allocation"
```

---

## Task 5: `storyUpdate` and dependency validation

**Files:**
- Modify: `engine/src/ops/plan.ts`
- Test: `engine/tests/ops/plan.test.ts`

**Interfaces:**
- Consumes: everything from Task 4; `readStory` (Task 2).
- Produces: `storyUpdate(projectDir, storyId, patch: { status?: StoryStatus; evidence?: string | null; acceptance?: string[]; ui?: boolean; depends_on?: string[]; title?: string }, now?): Promise<{ id: string; file: string; manifest: Manifest }>`; `DependencyError`; `assertDependenciesResolve(stories, candidate): void`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/plan.test.ts`:

```ts
describe('storyUpdate', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] }, clock)
  })

  it('changes the status and regenerates the manifest', async () => {
    const updated = await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    expect(updated.manifest.stories[0]?.status).toBe('done')
    expect((await readStory(project.dir, 'P001-S01')).frontmatter.status).toBe('done')
  })

  it('records an evidence path', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'done', evidence: '.loop/runs/2026-07-27-001--P001-S01--build' }, clock)
    expect((await readStory(project.dir, 'P001-S01')).frontmatter.evidence).toBe(
      '.loop/runs/2026-07-27-001--P001-S01--build',
    )
  })

  it('leaves untouched fields alone', async () => {
    await storyUpdate(project.dir, 'P001-S02', { status: 'doing' }, clock)
    const story = await readStory(project.dir, 'P001-S02')
    expect(story.frontmatter.depends_on).toEqual(['P001-S01'])
    expect(story.frontmatter.title).toBe('Session token')
  })

  it('throws StoryNotFoundError for a story that does not exist', async () => {
    await expect(storyUpdate(project.dir, 'P001-S99', { status: 'done' }, clock)).rejects.toBeInstanceOf(
      StoryNotFoundError,
    )
  })

  it('renames the file when the title changes, leaving one file for the story', async () => {
    await storyUpdate(project.dir, 'P001-S01', { title: 'Login screen' }, clock)
    const story = await readStory(project.dir, 'P001-S01')
    expect(story.file).toContain('P001-S01-login-screen.md')

    const manifest = (await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)).manifest
    expect(manifest.stories.filter((entry) => entry.id === 'P001-S01')).toHaveLength(1)
  })
})

describe('dependency validation', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Logout' }, clock)
  })

  it('rejects a dependency on a story that does not exist', async () => {
    await expect(
      storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S99'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })

  it('rejects a dependency on itself', async () => {
    await expect(
      storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S02'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })

  it('rejects a two-story cycle', async () => {
    await storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S01'] }, clock)
    await expect(
      storyUpdate(project.dir, 'P001-S01', { depends_on: ['P001-S02'] }, clock),
    ).rejects.toThrow(/cycle/i)
  })

  it('rejects a three-story cycle', async () => {
    await storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S01'] }, clock)
    await storyUpdate(project.dir, 'P001-S03', { depends_on: ['P001-S02'] }, clock)
    await expect(
      storyUpdate(project.dir, 'P001-S01', { depends_on: ['P001-S03'] }, clock),
    ).rejects.toThrow(/cycle/i)
  })

  it('accepts a diamond', async () => {
    await storyUpdate(project.dir, 'P001-S02', { depends_on: ['P001-S01'] }, clock)
    await storyUpdate(project.dir, 'P001-S03', { depends_on: ['P001-S01', 'P001-S02'] }, clock)
    expect((await readStory(project.dir, 'P001-S03')).frontmatter.depends_on).toEqual(['P001-S01', 'P001-S02'])
  })

  it('rejects a dangling dependency at add time too', async () => {
    await expect(
      storyAdd(project.dir, { plan: 'P001', title: 'Fourth', depends_on: ['P001-S99'] }, clock),
    ).rejects.toBeInstanceOf(DependencyError)
  })
})
```

Add `storyUpdate`, `DependencyError`, and `StoryNotFoundError` to the file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts`
Expected: FAIL — `storyUpdate` is not exported.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/plan.ts`, add the error, the validator, and the operation. Also call the
validator from `storyAdd` — insert `assertDependenciesResolve(existing, frontmatter.data)`
immediately after the frontmatter parse in `storyAdd`, before `writeStory`.

```ts
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
```

Add these imports at the top of the file: `fs` from `node:fs/promises`, and `readStory`,
`type Story` from `../store/plan-store.js`, and `type StoryFrontmatter`, `type StoryStatus`
from `../schemas/plan.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts && npm run typecheck`
Expected: PASS — 25 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/plan.ts engine/tests/ops/plan.test.ts
git commit -m "feat(engine): update stories and reject dangling or cyclic dependencies"
```

---

## Task 6: `storyGet` and `--next`

**Files:**
- Modify: `engine/src/ops/plan.ts`
- Test: `engine/tests/ops/plan.test.ts`

**Interfaces:**
- Consumes: `listStories`, `readStory`, `listPlanIds` (Task 2).
- Produces: `storyGet(projectDir, storyId): Promise<Story>`; `storyNext(projectDir, planId?): Promise<{ story: Story | null; reason: string }>`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/plan.test.ts`:

```ts
describe('storyNext', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Logout', depends_on: ['P001-S02'] }, clock)
  })

  it('picks the lowest-id todo story with no unmet dependencies', async () => {
    const next = await storyNext(project.dir)
    expect(next.story?.frontmatter.id).toBe('P001-S01')
  })

  it('skips a story whose dependency is not done', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)
    const next = await storyNext(project.dir)
    expect(next.story).toBeNull()
    expect(next.reason).toContain('P001-S02')
  })

  it('advances once the dependency is done', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    expect((await storyNext(project.dir)).story?.frontmatter.id).toBe('P001-S02')
  })

  it('returns nothing with a reason when every story is done', async () => {
    for (const id of ['P001-S01', 'P001-S02', 'P001-S03']) {
      await storyUpdate(project.dir, id, { status: 'done' }, clock)
    }
    const next = await storyNext(project.dir)
    expect(next.story).toBeNull()
    expect(next.reason).toContain('done')
  })

  it('ignores stories that are doing or blocked', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'blocked' }, clock)
    const next = await storyNext(project.dir)
    expect(next.story).toBeNull()
    expect(next.reason).toMatch(/blocked|waiting/i)
  })

  it('searches every plan when none is named', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    await storyUpdate(project.dir, 'P001-S02', { status: 'done' }, clock)
    await storyUpdate(project.dir, 'P001-S03', { status: 'done' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    await storyAdd(project.dir, { plan: 'P002', title: 'Invoices' }, clock)

    expect((await storyNext(project.dir)).story?.frontmatter.id).toBe('P002-S01')
  })

  it('restricts the search to one plan when asked', async () => {
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
    await storyAdd(project.dir, { plan: 'P002', title: 'Invoices' }, clock)

    expect((await storyNext(project.dir, 'P002')).story?.frontmatter.id).toBe('P002-S01')
  })

  it('returns nothing for a project with no plans', async () => {
    const empty = await makeTmpProject()
    try {
      const next = await storyNext(empty.dir)
      expect(next.story).toBeNull()
      expect(next.reason).toContain('no plans')
    } finally {
      await empty.cleanup()
    }
  })
})

describe('storyGet', () => {
  it('reads a story by id', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form', acceptance: ['Shows an error on bad input'] }, clock)

    const story = await storyGet(project.dir, 'P001-S01')
    expect(story.frontmatter.acceptance).toEqual(['Shows an error on bad input'])
  })

  it('throws StoryNotFoundError for an unknown id', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await expect(storyGet(project.dir, 'P001-S99')).rejects.toBeInstanceOf(StoryNotFoundError)
  })
})
```

Add `storyGet` and `storyNext` to the imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts`
Expected: FAIL — `storyNext` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `engine/src/ops/plan.ts`:

```ts
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
      waiting.push(`${story.frontmatter.id} waits on ${unmet.join(', ')}`)
    }
  }

  if (!sawAny) return { story: null, reason: 'no stories exist yet — add one first' }
  if (allDone) return { story: null, reason: 'every story is done' }
  if (waiting.length > 0) return { story: null, reason: `nothing is ready: ${waiting.join('; ')}` }
  return { story: null, reason: 'no story is todo — the remainder is doing or blocked' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts && npm run typecheck`
Expected: PASS — 35 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/plan.ts engine/tests/ops/plan.test.ts
git commit -m "feat(engine): resolve the next ready story from the dependency graph"
```

---

## Task 7: `INDEX.md`

**Files:**
- Create: `engine/src/ops/index-render.ts`
- Test: `engine/tests/ops/index-render.test.ts`

**Interfaces:**
- Consumes: `listPlanIds` (Task 2); `renderManifest` (Task 3); `resolveLoopPaths`.
- Produces: `renderIndex(projectDir, now?): Promise<string>`; `planStatus(stories: ManifestEntry[]): 'planned' | 'in-progress' | 'blocked' | 'done'`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/index-render.test.ts`:

```ts
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planStatus, renderIndex } from '../../src/ops/index-render.js'
import { planCreate, storyAdd, storyUpdate } from '../../src/ops/plan.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:14:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

function entry(id: string, status: 'todo' | 'doing' | 'done' | 'blocked') {
  return { id, title: id, status, ui: false, depends_on: [], file: `stories/${id}.md` }
}

describe('planStatus', () => {
  it('is planned when nothing has started', () => {
    expect(planStatus([entry('P001-S01', 'todo'), entry('P001-S02', 'todo')])).toBe('planned')
  })

  it('is done when every story is done', () => {
    expect(planStatus([entry('P001-S01', 'done')])).toBe('done')
  })

  it('is in-progress when some work has started', () => {
    expect(planStatus([entry('P001-S01', 'done'), entry('P001-S02', 'todo')])).toBe('in-progress')
    expect(planStatus([entry('P001-S01', 'doing'), entry('P001-S02', 'todo')])).toBe('in-progress')
  })

  it('is blocked when nothing can proceed and something is blocked', () => {
    expect(planStatus([entry('P001-S01', 'blocked'), entry('P001-S02', 'done')])).toBe('blocked')
  })

  it('is planned for a plan with no stories', () => {
    expect(planStatus([])).toBe('planned')
  })
})

describe('renderIndex', () => {
  it('writes a header and a row per plan', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Session token' }, clock)
    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)

    const markdown = await renderIndex(project.dir, clock)
    expect(markdown).toContain('do not edit')
    expect(markdown).toContain('| P001 | User authentication | 2 | 1 | in-progress |')
    expect(markdown).toContain('| P002 | Billing | 0 | 0 | planned |')

    const onDisk = await fs.readFile(resolveLoopPaths(project.dir).index, 'utf8')
    expect(onDisk).toBe(markdown)
  })

  it('says so plainly when there are no plans', async () => {
    const markdown = await renderIndex(project.dir, clock)
    expect(markdown).toContain('No plans yet')
  })

  it('is byte-identical when regenerated from unchanged input', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    expect(await renderIndex(project.dir, clock)).toBe(await renderIndex(project.dir, clock))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/index-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/index-render.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ManifestEntry } from '../schemas/plan.js'
import { resolveLoopPaths } from '../store/paths.js'
import { listPlanIds } from '../store/plan-store.js'
import type { Clock } from '../store/state-store.js'
import { renderManifest } from './manifest.js'

const HEADER = '<!-- generated by loop_index_render — do not edit -->'

/**
 * Derived, never stored: a status kept alongside the stories it summarises is
 * a status that can disagree with them.
 */
export function planStatus(stories: ManifestEntry[]): 'planned' | 'in-progress' | 'blocked' | 'done' {
  if (stories.length === 0) return 'planned'
  if (stories.every((story) => story.status === 'done')) return 'done'

  const started = stories.some((story) => story.status === 'done' || story.status === 'doing')
  const stalled = stories.every((story) => story.status === 'done' || story.status === 'blocked')
  if (stalled && stories.some((story) => story.status === 'blocked')) return 'blocked'
  return started ? 'in-progress' : 'planned'
}

export async function renderIndex(projectDir: string, now: Clock = () => new Date()): Promise<string> {
  const planIds = await listPlanIds(projectDir)
  const paths = resolveLoopPaths(projectDir)

  let markdown: string
  if (planIds.length === 0) {
    markdown = `${HEADER}\n\nNo plans yet.\n`
  } else {
    const rows: string[] = []
    for (const planId of planIds) {
      // Rendering the manifest first means the index can never be newer than
      // the manifests it summarises.
      const manifest = await renderManifest(projectDir, planId, now)
      const done = manifest.stories.filter((story) => story.status === 'done').length
      rows.push(
        `| ${manifest.plan} | ${manifest.title} | ${manifest.stories.length} | ${done} | ${planStatus(manifest.stories)} |`,
      )
    }
    markdown = [
      HEADER,
      '',
      '| Plan | Title | Stories | Done | Status |',
      '|------|-------|---------|------|--------|',
      ...rows,
      '',
    ].join('\n')
  }

  await fs.mkdir(path.dirname(paths.index), { recursive: true })
  await fs.writeFile(paths.index, markdown, 'utf8')
  return markdown
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/index-render.test.ts && npm run typecheck`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/index-render.ts engine/tests/ops/index-render.test.ts
git commit -m "feat(engine): generate INDEX.md from the plan manifests"
```

---

## Task 8: The five MCP tools and story validation at `runStart`

**Files:**
- Modify: `engine/src/mcp/server.ts`, `engine/src/ops/run.ts`
- Test: `engine/tests/mcp/server.test.ts`, `engine/tests/ops/run.test.ts`

**Interfaces:**
- Consumes: `planCreate`, `storyAdd`, `storyUpdate`, `storyGet`, `storyNext` (Tasks 4–6); `renderIndex` (Task 7); `readStory` (Task 2).
- Produces: MCP tools `loop_plan_create`, `loop_story_add`, `loop_story_update`, `loop_story_get`, `loop_index_render`; `runStart` rejects a story id that does not exist.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/ops/run.test.ts`, inside `describe('runStart', ...)`:

```ts
  it('rejects a story id that does not exist', async () => {
    await expect(
      runStart(project.dir, { track: 'build', goal: 'Build it', plan: 'P001', story: 'P001-S01' }, clock),
    ).rejects.toThrow(/P001/)
  })

  it('accepts a story id that exists', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)

    const state = await runStart(
      project.dir,
      { track: 'build', goal: 'Build the login form', plan: 'P001', story: 'P001-S01' },
      clock,
    )
    expect(state.current.story).toBe('P001-S01')
    expect(runDirName(state)).toContain('P001-S01')
  })
```

Add `planCreate` and `storyAdd` to that file's imports.

Add to `engine/tests/mcp/server.test.ts`, inside `describe('MCP surface', ...)`, replacing the tool-list assertion:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      'loop_cycle_advance',
      'loop_halt',
      'loop_index_render',
      'loop_init',
      'loop_plan_create',
      'loop_roster_set',
      'loop_run_log',
      'loop_run_start',
      'loop_state_get',
      'loop_story_add',
      'loop_story_get',
      'loop_story_update',
    ])
```

And add to `describe('tool behaviour', ...)`:

```ts
  it('drives a plan from creation to a resolved next story', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })

    const created = await client.callTool({
      name: 'loop_plan_create',
      arguments: { project_dir: project.dir, slug: 'user-auth', title: 'User authentication' },
    })
    expect(JSON.parse(textOf(created)).id).toBe('P001')

    await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form', acceptance: ['Shows an error'] },
    })
    await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] },
    })

    const next = await client.callTool({ name: 'loop_story_get', arguments: { project_dir: project.dir, next: true } })
    expect(JSON.parse(textOf(next)).story.frontmatter.id).toBe('P001-S01')

    await client.callTool({
      name: 'loop_story_update',
      arguments: { project_dir: project.dir, story: 'P001-S01', status: 'done', evidence: '.loop/runs/x' },
    })

    const after = await client.callTool({ name: 'loop_story_get', arguments: { project_dir: project.dir, next: true } })
    expect(JSON.parse(textOf(after)).story.frontmatter.id).toBe('P001-S02')

    const index = await client.callTool({ name: 'loop_index_render', arguments: { project_dir: project.dir } })
    expect(textOf(index)).toContain('User authentication')
  })

  it('returns a tool error for a story that does not exist', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'loop_story_get',
      arguments: { project_dir: project.dir, story: 'P001-S01' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/mcp/server.test.ts tests/ops/run.test.ts`
Expected: FAIL — the tool list has 7 entries and `runStart` accepts any story id.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/run.ts`, add the import and the check. Put the check before the locked
update so a bad story id never opens a run:

```ts
import { readStory } from '../store/plan-store.js'
```

```ts
  // A run named after a story that does not exist would produce a run
  // directory traceable to nothing. readStory throws StoryNotFoundError.
  if (input.story !== undefined && input.story !== null) await readStory(projectDir, input.story)
```

In `engine/src/mcp/server.ts`, add the imports and register the five tools:

```ts
import { planCreate, storyAdd, storyGet, storyNext, storyUpdate } from '../ops/plan.js'
import { renderIndex } from '../ops/index-render.js'
import { StoryStatusSchema } from '../schemas/plan.js'
```

```ts
  server.registerTool(
    'loop_plan_create',
    {
      title: 'Create a plan',
      description: 'Allocate the next plan id, create its directory with PLAN.md, and generate an empty manifest.',
      inputSchema: {
        project_dir: projectDirArg,
        slug: z.string().min(1).describe('Short filename-safe name, e.g. user-auth'),
        title: z.string().min(1),
        body: z.string().optional().describe('Prose for PLAN.md — the problem, the approach, the constraints'),
      },
    },
    async ({ project_dir, slug, title, body }) =>
      guard(async () =>
        ok(
          await planCreate(resolveProjectDir(project_dir), {
            slug,
            title,
            ...(body === undefined ? {} : { body }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_story_add',
    {
      title: 'Add a story to a plan',
      description: 'Allocate the next story id in a plan, write the story file, and regenerate the manifest.',
      inputSchema: {
        project_dir: projectDirArg,
        plan: z.string().min(1).describe('Plan id, e.g. P001'),
        title: z.string().min(1),
        acceptance: z.array(z.string().min(1)).optional().describe('Checkable conditions this story must meet'),
        ui: z.boolean().optional(),
        depends_on: z.array(z.string().min(1)).optional().describe('Story ids that must be done first'),
        body: z.string().optional(),
      },
    },
    async ({ project_dir, plan, title, acceptance, ui, depends_on, body }) =>
      guard(async () =>
        ok(
          await storyAdd(resolveProjectDir(project_dir), {
            plan,
            title,
            ...(acceptance === undefined ? {} : { acceptance }),
            ...(ui === undefined ? {} : { ui }),
            ...(depends_on === undefined ? {} : { depends_on }),
            ...(body === undefined ? {} : { body }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_story_update',
    {
      title: 'Update a story',
      description: 'Change a story status, evidence, acceptance, ui flag, dependencies, or title, then regenerate the manifest.',
      inputSchema: {
        project_dir: projectDirArg,
        story: z.string().min(1).describe('Story id, e.g. P001-S02'),
        status: StoryStatusSchema.optional(),
        evidence: z.string().min(1).nullish().describe('Run directory holding the proof this story is done'),
        acceptance: z.array(z.string().min(1)).optional(),
        ui: z.boolean().optional(),
        depends_on: z.array(z.string().min(1)).optional(),
        title: z.string().min(1).optional(),
      },
    },
    async ({ project_dir, story, status, evidence, acceptance, ui, depends_on, title }) =>
      guard(async () =>
        ok(
          await storyUpdate(resolveProjectDir(project_dir), story, {
            ...(status === undefined ? {} : { status }),
            ...(evidence === undefined ? {} : { evidence }),
            ...(acceptance === undefined ? {} : { acceptance }),
            ...(ui === undefined ? {} : { ui }),
            ...(depends_on === undefined ? {} : { depends_on }),
            ...(title === undefined ? {} : { title }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_story_get',
    {
      title: 'Read a story',
      description: 'Read one story by id, or with next=true resolve the lowest-id story that is ready to start.',
      inputSchema: {
        project_dir: projectDirArg,
        story: z.string().min(1).optional().describe('Story id. Omit and set next=true to resolve the next ready story'),
        next: z.boolean().optional(),
        plan: z.string().min(1).optional().describe('Restrict a next=true search to one plan'),
      },
    },
    async ({ project_dir, story, next, plan }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)
        if (next === true) return ok(await storyNext(dir, plan))
        if (story === undefined) {
          throw new Error('give a story id, or set next=true to resolve the next ready story')
        }
        return ok({ story: await storyGet(dir, story), reason: 'read by id' })
      }),
  )

  server.registerTool(
    'loop_index_render',
    {
      title: 'Regenerate INDEX.md',
      description: 'Rebuild .loop/INDEX.md from every plan manifest. Returns the rendered markdown.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) => guard(async () => ok(await renderIndex(resolveProjectDir(project_dir)))),
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green, typecheck clean, `dist/` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add engine/src/mcp/server.ts engine/src/ops/run.ts engine/tests
git commit -m "feat(mcp): expose the plan and story tools and validate story ids"
```

---

## Task 9: `/loop:build` argument forms and the leader

**Files:**
- Modify: `commands/build.md`, `skills/loop-leader/SKILL.md`, `README.md`, `engine/src/ops/init.ts`
- Test: no unit tests — exercised by Task 10

**Interfaces:**
- Consumes: `loop_story_get`, `loop_story_update` (Task 8).
- Produces: the three `/loop:build` forms and the leader behaviour that briefs from a story and writes evidence back.

- [ ] **Step 1: Rewrite `commands/build.md`**

```markdown
---
description: Build something through as many verified cycles as it takes
argument-hint: <what to build | P001-S02 | --next>
---

Run the `build` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, folding open findings into the next cycle, and committing
each cycle that passes.

Read the argument before anything else — it has three forms:

- **A story id** matching `P001-S02` — call `loop_story_get` with it, and run the track
  against that story's acceptance criteria.
- **`--next`** — call `loop_story_get` with `next: true`. If it returns no story, report
  the reason it gives and stop; there is nothing to build. "Every story is done" and
  "nothing is ready because S02 waits on S01" are different answers and the user needs
  the right one.
- **Anything else** — a direct goal, as before. No story is involved.

Unlike `/loop:edit`, this track does not stop after one cycle. A failing cycle produces
findings that become the next cycle's work, up to the track's cap — or until the run
stops making progress, at which point the engine halts it and writes `HALT.md`.
```

- [ ] **Step 2: Add the story sections to `skills/loop-leader/SKILL.md`**

Read the file first — it has grown across three milestones. Add this immediately after the
section that opens the run, and renumber what follows:

```markdown
### 2b. When the run is against a story

A story is not a goal with extra steps. It carries acceptance criteria, which are the
conditions the cycle is judged against — you do not restate the goal in your own words
and judge against that instead.

Call `loop_story_get` and use what it returns:

- Pass `loop_run_start` both the `plan` and the `story` id, so the run directory is named
  after the story and every artefact traces back to it.
- Put the acceptance criteria in every agent's brief, verbatim. `verifier` judges against
  them; a cycle where the suite is green but an acceptance criterion is unmet is a fail.
- Mark the story `doing` with `loop_story_update` when the run opens.

### 2c. Writing the result back

When a story run reaches `done`, call `loop_story_update` with `status: "done"` and
`evidence` set to the run directory. The story then carries the path to its own proof,
and the manifest and `INDEX.md` follow from it.

If the run halts instead, mark the story `blocked` and leave `evidence` alone — a story
with an evidence path is a story somebody proved, and a halted run proved nothing.

Never edit `manifest.json` or `INDEX.md`. Both are derived from the story files; the
`PreToolUse` hook denies writes to the manifest, and a hand-edited index is overwritten
by the next render.
```

Extend the `## What you never do` list:

```markdown
- Never judge a story run against your own restatement of the goal. The acceptance
  criteria are the contract.
- Never mark a story done without an evidence path, and never write an evidence path for
  a run that halted.
```

- [ ] **Step 3: Update the host-project registration**

In `engine/src/ops/init.ts`, replace the build line in `CLAUDE_MD_BLOCK` with:

```
- \`/loop:build <what to build | P001-S02 | --next>\` — multi-cycle build, optionally against a story
```

In `README.md`, replace the build line in the `## Use` block:

```
/loop:build <goal | P001-S02 | --next>   multi-cycle build, optionally against a story
```

and add a short section after `## How a cycle is composed`:

```markdown
## Plans and stories

A plan lives in `.loop/plans/P001-<slug>/`: `PLAN.md`, a `stories/` directory, and a
generated `manifest.json`. Each story is a markdown file that carries its own id, status,
acceptance criteria, dependencies, and — once it passes — the path to the run that proved
it.

The story file is the source of truth. `manifest.json` is derived from the story files
and `.loop/INDEX.md` is derived from the manifests, so nothing has to be kept in sync.
Write stories through the `loop_story_*` tools rather than by hand.
```

- [ ] **Step 4: Verify the surface loads**

Run: `cd engine && npx vitest run tests/ops/init.test.ts && npm run build`
Expected: PASS — the CLAUDE.md tests assert the section marker and idempotence, so
changing a line inside the block does not break them. If one asserts the exact block,
update it to match.

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: the inventory still lists 9 agents and 6 commands.

- [ ] **Step 5: Commit**

```bash
git add commands/build.md skills/loop-leader/SKILL.md README.md engine/src/ops/init.ts
git commit -m "feat(plugin): build against a story id or the next ready story"
```

---

## Task 10: Integration and E2E proof

**Files:**
- Create: `engine/tests/integration/story-build.test.ts`
- Create: `tests/e2e/run-story.sh`
- Modify: `engine/package.json` — add the `e2e:story` script

**Interfaces:**
- Consumes: every op from Tasks 1–8 and the surface from Task 9.
- Produces: proof that a story drives a build run and that every derived artefact agrees afterwards.

- [ ] **Step 1: Write the failing integration test**

`engine/tests/integration/story-build.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { renderIndex } from '../../src/ops/index-render.js'
import { runLog } from '../../src/ops/log.js'
import { manifestPath } from '../../src/ops/manifest.js'
import { planCreate, storyAdd, storyNext, storyUpdate } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirName, runDirPath, runStart } from '../../src/ops/run.js'
import { findPlanDir, readStory } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form', acceptance: ['Shows an error on bad input'] }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('a story-driven build', () => {
  it('runs the next ready story and writes its proof back', async () => {
    const next = await storyNext(project.dir)
    expect(next.story?.frontmatter.id).toBe('P001-S01')
    expect(next.story?.frontmatter.acceptance).toEqual(['Shows an error on bad input'])

    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)

    const state = await runStart(
      project.dir,
      { track: 'build', goal: 'Login form shows an error on bad input', plan: 'P001', story: 'P001-S01' },
      clock,
    )
    expect(runDirName(state)).toContain('P001-S01')

    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: { scout: 'story names the file', critic: 'single-file change' },
    })
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'The acceptance criterion is met and the suite is green.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    const closed = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)
    expect(closed.state.status).toBe('done')

    const evidence = path.relative(project.dir, runDirPath(project.dir, closed.state))
    await storyUpdate(project.dir, 'P001-S01', { status: 'done', evidence }, clock)

    // Every derived artefact agrees with the story file.
    const story = await readStory(project.dir, 'P001-S01')
    expect(story.frontmatter.status).toBe('done')
    expect(story.frontmatter.evidence).toBe(evidence)

    const manifest = JSON.parse(await fs.readFile(manifestPath(await findPlanDir(project.dir, 'P001')), 'utf8'))
    expect(manifest.stories.find((entry: { id: string }) => entry.id === 'P001-S01').status).toBe('done')

    const index = await renderIndex(project.dir, clock)
    expect(index).toContain('| P001 | User authentication | 2 | 1 | in-progress |')

    // The dependency graph has moved on.
    expect((await storyNext(project.dir)).story?.frontmatter.id).toBe('P001-S02')
  })

  it('rebuilds a deleted manifest from the story files alone', async () => {
    const file = manifestPath(await findPlanDir(project.dir, 'P001'))
    await fs.rm(file)

    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)

    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(manifest.stories.map((entry: { id: string }) => entry.id)).toEqual(['P001-S01', 'P001-S02'])
    expect(manifest.stories[0].status).toBe('doing')
  })

  it('refuses to open a run against a story that does not exist', async () => {
    await expect(
      runStart(project.dir, { track: 'build', goal: 'Ghost', plan: 'P001', story: 'P001-S99' }, clock),
    ).rejects.toThrow(/P001-S99/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/integration/story-build.test.ts`
Expected: FAIL if any of Tasks 1–8 is incomplete. If they all landed correctly this passes
on the first run. A failure here is a defect in the ops, not the test; fix the op and rerun.

- [ ] **Step 3: Write the E2E script**

`tests/e2e/run-story.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test of a story-driven build against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-story.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture"

allowed=(
  "mcp__plugin_loop_loop"
  Task Read Edit Write Grep Glob Bash
)

fail() {
  echo "FAIL: $1" >&2
  echo "work directory kept for inspection: ${workdir}" >&2
  exit 1
}

claude -p "/loop:init" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

# Write the plan and its one story through the tools, the supported path.
claude -p "Using the loop MCP tools only, create a plan with slug 'labels' titled 'Button labels', then add one story titled 'Cancel label' whose acceptance criterion is: src/button.js exports cancelLabel() returning 'Cancel', covered by a test. Then render the index. Do not write any file by hand." \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

[[ -f .loop/INDEX.md ]] || fail "INDEX.md was not generated"
grep -q "Button labels" .loop/INDEX.md || fail "the plan is missing from INDEX.md"

claude -p "/loop:build --next" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

[[ "${status}" == "done" ]] || fail "expected status done, got ${status}"
grep -q "cancelLabel" src/button.js || fail "the export was not added"
grep -rq "status: done" .loop/plans/*/stories/ || fail "the story was not marked done"
grep -rq "evidence: .loop/runs" .loop/plans/*/stories/ || fail "the story carries no evidence path"

rm -rf "${workdir}"
echo "PASS: the story drove the build and carries the proof of its own completion"
```

Run: `chmod +x tests/e2e/run-story.sh`

Add to `engine/package.json` scripts:

```json
"e2e:story": "bash ../tests/e2e/run-story.sh"
```

- [ ] **Step 4: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

Run: `bash tests/e2e/run-story.sh`
Expected: `skipped: set LOOP_E2E=1 ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add engine/tests/integration/story-build.test.ts tests/e2e/run-story.sh engine/package.json
git commit -m "test: prove a story drives a build and carries its own proof"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green, three consecutive runs with the same count
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 12 MCP tools
- [ ] Deleting a `manifest.json` and calling any story tool rebuilds it exactly
- [ ] A dependency cycle is rejected with the cycle named
- [ ] `--next` returns nothing with a reason when the remainder is blocked
- [ ] `LOOP_E2E=1 npm run e2e`, `e2e:build`, `e2e:fix` — earlier tracks still pass
- [ ] `LOOP_E2E=1 npm run e2e:story` — a story drives a build and ends with an evidence path

## Next Milestones

| Milestone | Delivers |
|---|---|
| 4b — Plan track | `planner`, `plan-critic`, `fit-checker`, `story-writer`, `story-critic`; `/loop:plan`; `loop_gate_set` and `gates.plan_approval`; `REVIEW.md` |
| 5 — Remaining guards | Repeated-error guard, autonomous `Stop` hook |
| 6 — UI and specialists | `design-system.md` extraction, `ui-designer`, `ui-critic`, `security`, `docs`, `perf` |
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
