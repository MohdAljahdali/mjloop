# Loop — Milestone 7: Memory and Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the loop a memory it consults on purpose, and give the user a way to extend it — `/loop:add` plus the two skills that explain the system.

**Architecture:** Memory entries are authored markdown with engine-read frontmatter, in the shape stories already use. Search is keyword ranking with a hard result cap, because a tool that can return an unbounded corpus into a leader's context makes every later cycle worse. `custom_dirs` is removed rather than corrected, and stripped from old configs on read.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · yaml 2.9.0 · @modelcontextprotocol/sdk 1.29.0 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-27-loop-milestone-7-memory-and-extension-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json` or any `manifest.json`.
- **The engine does not know agent names.** Any rule naming a specific agent belongs in track config.
- **Any string that reaches the filesystem is validated** before it is interpolated into a path.
- **A guard that cannot read its inputs allows the action.**
- Every operation that stamps a timestamp takes an injectable `now: Clock` defaulting to `() => new Date()`.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/schemas/memory.ts` | **New.** Memory id, kind, and frontmatter schemas |
| `engine/src/store/memory-store.ts` | **New.** Read, write, and list memory entries |
| `engine/src/ops/memory.ts` | **New.** `memoryAdd`, `memorySearch`, `memoryGet` |
| `engine/src/schemas/config.ts` | Remove `custom_dirs` |
| `engine/src/store/config-store.ts` | Strip legacy keys before parsing |
| `engine/src/ops/summary.ts` | `config_error` |
| `engine/src/mcp/server.ts` | Three memory tools |
| `commands/add.md` | **New.** `/loop:add` |
| `skills/loop-tracks/SKILL.md`, `skills/loop-extend/SKILL.md` | **New.** |
| `skills/loop-leader/SKILL.md` | When to consult and record memory |
| `engine/tests/integration/memory.test.ts` | **New.** A run that remembers |

---

## Task 1: The memory schema and store

**Files:**
- Create: `engine/src/schemas/memory.ts`, `engine/src/store/memory-store.ts`
- Test: `engine/tests/store/memory-store.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`, `serialiseFrontmatter` from `engine/src/store/frontmatter.ts`; `resolveLoopPaths` from `engine/src/store/paths.ts`.
- Produces: `MemoryKindSchema`, `MemoryIdSchema`, `MemoryFrontmatterSchema`, types `MemoryKind` and `MemoryFrontmatter`; `Memory { frontmatter: MemoryFrontmatter; body: string; file: string }`; `MemoryNotFoundError`; `memoryFileName(frontmatter): string`; `listMemories(projectDir): Promise<Memory[]>`; `readMemory(projectDir, id): Promise<Memory>`; `writeMemory(projectDir, memory): Promise<string>`.

- [ ] **Step 1: Write the failing test**

`engine/tests/store/memory-store.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MemoryNotFoundError,
  listMemories,
  memoryFileName,
  readMemory,
  writeMemory,
} from '../../src/store/memory-store.js'
import { MemoryFrontmatterSchema, MemoryIdSchema } from '../../src/schemas/memory.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const AT = '2026-07-27T15:00:00.000Z'

function entry(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    frontmatter: {
      id,
      kind: 'decision' as const,
      title,
      at: AT,
      tags: ['auth'],
      run: null,
      ...extra,
    },
    body: 'The reasoning, at length.',
  }
}

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('MemoryIdSchema', () => {
  it('accepts a well-formed id', () => {
    expect(MemoryIdSchema.safeParse('M001').success).toBe(true)
  })

  it('rejects anything that could steer a path', () => {
    expect(MemoryIdSchema.safeParse('../../etc').success).toBe(false)
    expect(MemoryIdSchema.safeParse('M1').success).toBe(false)
  })
})

describe('MemoryFrontmatterSchema', () => {
  it('defaults tags and run', () => {
    const parsed = MemoryFrontmatterSchema.parse({ id: 'M001', kind: 'lesson', title: 'A lesson', at: AT })
    expect(parsed.tags).toEqual([])
    expect(parsed.run).toBeNull()
  })

  it('rejects a kind outside the three values', () => {
    const bad = { id: 'M001', kind: 'thought', title: 'x', at: AT }
    expect(MemoryFrontmatterSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    const bad = { id: 'M001', kind: 'lesson', title: 'x', at: AT, priority: 1 }
    expect(MemoryFrontmatterSchema.safeParse(bad).success).toBe(false)
  })
})

describe('memoryFileName', () => {
  it('names the file after the id and a slugified title', () => {
    expect(memoryFileName(entry('M001', 'Session tokens rather than server sessions').frontmatter)).toBe(
      'M001-session-tokens-rather-than-server-sessions.md',
    )
  })

  it('strips characters that do not belong in a filename', () => {
    expect(memoryFileName(entry('M002', 'Why / not  Redis?').frontmatter)).toBe('M002-why-not-redis.md')
  })
})

describe('writeMemory and readMemory', () => {
  it('round-trips an entry through disk', async () => {
    const file = await writeMemory(project.dir, entry('M001', 'Session tokens'))
    expect(file).toBe(path.join(resolveLoopPaths(project.dir).memory, 'M001-session-tokens.md'))

    const read = await readMemory(project.dir, 'M001')
    expect(read.frontmatter.title).toBe('Session tokens')
    expect(read.body).toBe('The reasoning, at length.')
    expect(read.file).toBe(file)
  })

  it('throws MemoryNotFoundError for an unknown id', async () => {
    await expect(readMemory(project.dir, 'M404')).rejects.toBeInstanceOf(MemoryNotFoundError)
  })
})

describe('listMemories', () => {
  it('returns entries sorted by id', async () => {
    await writeMemory(project.dir, entry('M002', 'Second'))
    await writeMemory(project.dir, entry('M001', 'First'))
    expect((await listMemories(project.dir)).map((m) => m.frontmatter.id)).toEqual(['M001', 'M002'])
  })

  it('returns an empty list when nothing is recorded', async () => {
    expect(await listMemories(project.dir)).toEqual([])
  })

  it('skips an unreadable entry rather than failing the corpus', async () => {
    await writeMemory(project.dir, entry('M001', 'Sound'))
    const dir = resolveLoopPaths(project.dir).memory
    await fs.writeFile(path.join(dir, 'notes.md'), '# just notes\n', 'utf8')
    await fs.writeFile(path.join(dir, 'M002-broken.md'), '---\nid: [unclosed\n---\n', 'utf8')

    expect((await listMemories(project.dir)).map((m) => m.frontmatter.id)).toEqual(['M001'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/store/memory-store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `engine/src/schemas/memory.ts`**

```ts
import * as z from 'zod'

/**
 * `decision` — a choice made and why, the thing a reader cannot reconstruct
 * from the diff. `lesson` — something learned the hard way, usually from a
 * halt. `pattern` — how this project does a recurring thing.
 */
export const MemoryKindSchema = z.enum(['decision', 'lesson', 'pattern'])

/** Reaches the filesystem: it names a file. */
export const MemoryIdSchema = z.string().regex(/^M\d{3}$/, 'a memory id looks like M001')

export const MemoryFrontmatterSchema = z.strictObject({
  id: MemoryIdSchema,
  kind: MemoryKindSchema,
  title: z.string().min(1),
  at: z.iso.datetime(),
  tags: z.array(z.string().min(1)).default([]),
  /** The run that produced it, or null when a person wrote it directly. */
  run: z.string().min(1).nullable().default(null),
})

export type MemoryKind = z.infer<typeof MemoryKindSchema>
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>
```

- [ ] **Step 4: Write `engine/src/store/memory-store.ts`**

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { MemoryFrontmatterSchema, type MemoryFrontmatter } from '../schemas/memory.js'
import { parseFrontmatter, serialiseFrontmatter } from './frontmatter.js'
import { resolveLoopPaths } from './paths.js'

export class MemoryNotFoundError extends Error {
  constructor(id: string, dir: string) {
    super(`no memory "${id}" under ${dir}`)
    this.name = 'MemoryNotFoundError'
  }
}

export interface Memory {
  frontmatter: MemoryFrontmatter
  body: string
  /** Absolute path to the entry. */
  file: string
}

/** `<id>-<slugified title>.md` — identifiable in a directory listing. */
export function memoryFileName(frontmatter: MemoryFrontmatter): string {
  const slug = frontmatter.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${frontmatter.id}-${slug}.md`
}

export async function listMemories(projectDir: string): Promise<Memory[]> {
  const dir = resolveLoopPaths(projectDir).memory
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const memories: Memory[] = []
  for (const name of entries.filter((entry) => entry.endsWith('.md'))) {
    const file = path.join(dir, name)
    // One malformed entry must not make the corpus unreadable, exactly as one
    // stray file in a plan's stories directory does not.
    try {
      const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf8'))
      const parsed = MemoryFrontmatterSchema.safeParse(data)
      if (!parsed.success) continue
      memories.push({ frontmatter: parsed.data, body, file })
    } catch {
      continue
    }
  }
  return memories.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))
}

export async function readMemory(projectDir: string, id: string): Promise<Memory> {
  const found = (await listMemories(projectDir)).find((memory) => memory.frontmatter.id === id)
  if (found === undefined) throw new MemoryNotFoundError(id, resolveLoopPaths(projectDir).memory)
  return found
}

export async function writeMemory(projectDir: string, memory: Omit<Memory, 'file'>): Promise<string> {
  const dir = resolveLoopPaths(projectDir).memory
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, memoryFileName(memory.frontmatter))
  await fs.writeFile(file, serialiseFrontmatter(memory.frontmatter, memory.body), 'utf8')
  return file
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/store/memory-store.test.ts && npm run typecheck`
Expected: PASS — 12 tests.

- [ ] **Step 6: Commit**

```bash
git add engine/src/schemas/memory.ts engine/src/store/memory-store.ts engine/tests/store/memory-store.test.ts
git commit -m "feat(engine): add the memory schema and store"
```

---

## Task 2: `memoryAdd`, `memoryGet`, and `memorySearch`

**Files:**
- Create: `engine/src/ops/memory.ts`
- Test: `engine/tests/ops/memory.test.ts`

**Interfaces:**
- Consumes: `listMemories`, `readMemory`, `writeMemory`, `Memory` (Task 1); `withLock` from `engine/src/store/lock.ts`; `resolveLoopPaths`.
- Produces: `memoryAdd(projectDir, input: { kind: MemoryKind; title: string; body: string; tags?: string[]; run?: string | null }, now?): Promise<{ id: string; file: string }>`; `memoryGet(projectDir, id): Promise<Memory>`; `SearchHit { id: string; kind: MemoryKind; title: string; tags: string[]; at: string; score: number; excerpt: string }`; `memorySearch(projectDir, query: string, limit?: number): Promise<{ hits: SearchHit[]; reason: string }>`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/memory.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryAdd, memoryGet, memorySearch } from '../../src/ops/memory.js'
import { MemoryNotFoundError } from '../../src/store/memory-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T15:00:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('memoryAdd', () => {
  it('allocates M001 for the first entry', async () => {
    const added = await memoryAdd(
      project.dir,
      { kind: 'decision', title: 'Session tokens', body: 'Stateless, no shared store.' },
      clock,
    )
    expect(added.id).toBe('M001')
    expect(added.file).toContain('M001-session-tokens.md')
  })

  it('allocates the next id', async () => {
    await memoryAdd(project.dir, { kind: 'decision', title: 'First', body: 'x' }, clock)
    const second = await memoryAdd(project.dir, { kind: 'lesson', title: 'Second', body: 'y' }, clock)
    expect(second.id).toBe('M002')
  })

  it('does not collide when two adds overlap', async () => {
    const [a, b] = await Promise.all([
      memoryAdd(project.dir, { kind: 'decision', title: 'A', body: 'x' }, clock),
      memoryAdd(project.dir, { kind: 'decision', title: 'B', body: 'y' }, clock),
    ])
    expect(new Set([a.id, b.id]).size).toBe(2)
  })

  it('records tags and the run', async () => {
    const added = await memoryAdd(
      project.dir,
      { kind: 'lesson', title: 'Timing', body: 'Needs runInBand.', tags: ['tests'], run: '2026-07-27-003' },
      clock,
    )
    const memory = await memoryGet(project.dir, added.id)
    expect(memory.frontmatter.tags).toEqual(['tests'])
    expect(memory.frontmatter.run).toBe('2026-07-27-003')
    expect(memory.frontmatter.at).toBe(NOW.toISOString())
  })
})

describe('memoryGet', () => {
  it('throws for an unknown id', async () => {
    await expect(memoryGet(project.dir, 'M404')).rejects.toBeInstanceOf(MemoryNotFoundError)
  })
})

describe('memorySearch', () => {
  beforeEach(async () => {
    await memoryAdd(
      project.dir,
      { kind: 'decision', title: 'Session tokens rather than server sessions', body: 'No shared store available.', tags: ['auth'] },
      clock,
    )
    await memoryAdd(
      project.dir,
      { kind: 'lesson', title: 'Flaky timing suite', body: 'The auth tests need runInBand to be deterministic.', tags: ['tests'] },
      clock,
    )
    await memoryAdd(
      project.dir,
      { kind: 'pattern', title: 'Error handling', body: 'Every route wraps its handler.', tags: ['api'] },
      clock,
    )
  })

  it('ranks a title hit above a body hit', async () => {
    const { hits } = await memorySearch(project.dir, 'auth')
    // "auth" is a tag on the first and appears in the second's body.
    expect(hits[0]?.title).toContain('Session tokens')
  })

  it('finds an entry by a word in its body', async () => {
    const { hits } = await memorySearch(project.dir, 'runInBand')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('Flaky timing suite')
  })

  it('is case-insensitive', async () => {
    expect((await memorySearch(project.dir, 'SESSION')).hits.length).toBeGreaterThan(0)
  })

  it('returns an excerpt rather than the whole body', async () => {
    const { hits } = await memorySearch(project.dir, 'runInBand')
    expect(hits[0]?.excerpt).toContain('runInBand')
    expect(hits[0]?.excerpt.length).toBeLessThan(400)
  })

  it('respects the limit', async () => {
    const { hits } = await memorySearch(project.dir, 'the', 1)
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  it('caps the result even when everything matches', async () => {
    const { hits } = await memorySearch(project.dir, 'e')
    expect(hits.length).toBeLessThanOrEqual(5)
  })

  it('returns nothing with a reason when no memory matches', async () => {
    const { hits, reason } = await memorySearch(project.dir, 'kubernetes')
    expect(hits).toEqual([])
    expect(reason).toContain('No memory')
  })

  it('says so when there is no memory at all', async () => {
    const empty = await makeTmpProject()
    try {
      const { hits, reason } = await memorySearch(empty.dir, 'anything')
      expect(hits).toEqual([])
      expect(reason).toContain('nothing recorded')
    } finally {
      await empty.cleanup()
    }
  })

  it('ignores a term shorter than two characters', async () => {
    const { hits } = await memorySearch(project.dir, 'a')
    expect(hits).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/memory.ts`:

```ts
import * as z from 'zod'
import { MemoryFrontmatterSchema, type MemoryKind } from '../schemas/memory.js'
import { withLock } from '../store/lock.js'
import { listMemories, readMemory, writeMemory, type Memory } from '../store/memory-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import type { Clock } from '../store/state-store.js'

export class InvalidMemoryInputError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'InvalidMemoryInputError'
  }
}

export interface MemoryAddInput {
  kind: MemoryKind
  title: string
  body: string
  tags?: string[]
  run?: string | null
}

/**
 * Allocation runs under the write lock for the same reason plan and run ids do:
 * two overlapping adds that each scanned the directory before either wrote
 * would allocate the same id, and one would overwrite the other.
 */
export async function memoryAdd(
  projectDir: string,
  input: MemoryAddInput,
  now: Clock = () => new Date(),
): Promise<{ id: string; file: string }> {
  const paths = resolveLoopPaths(projectDir)
  return withLock(paths.lock, async () => {
    const existing = await listMemories(projectDir)
    const used = existing.map((memory) => Number(memory.frontmatter.id.slice(1)))
    const next = used.length === 0 ? 1 : Math.max(...used) + 1

    const frontmatter = MemoryFrontmatterSchema.safeParse({
      id: `M${String(next).padStart(3, '0')}`,
      kind: input.kind,
      title: input.title,
      at: now().toISOString(),
      tags: input.tags ?? [],
      run: input.run ?? null,
    })
    if (!frontmatter.success) throw new InvalidMemoryInputError(z.prettifyError(frontmatter.error))

    const file = await writeMemory(projectDir, { frontmatter: frontmatter.data, body: input.body })
    return { id: frontmatter.data.id, file }
  })
}

export async function memoryGet(projectDir: string, id: string): Promise<Memory> {
  return readMemory(projectDir, id)
}

export interface SearchHit {
  id: string
  kind: MemoryKind
  title: string
  tags: string[]
  at: string
  score: number
  /** The line the best term landed on, with its neighbours. Never the whole body. */
  excerpt: string
}

/** Title and tag hits outweigh body hits: what an entry is about is stated in its title. */
const TITLE_WEIGHT = 5
const TAG_WEIGHT = 3
const BODY_WEIGHT = 1
const DEFAULT_LIMIT = 5

/**
 * Keyword ranking, deliberately not semantic search.
 *
 * The cap matters more than the ranking. Memory is only worth having if
 * consulting it costs less than not having it, and a tool that can return an
 * unbounded corpus into a leader's context makes every later cycle worse.
 */
export async function memorySearch(
  projectDir: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<{ hits: SearchHit[]; reason: string }> {
  const memories = await listMemories(projectDir)
  if (memories.length === 0) return { hits: [], reason: 'nothing recorded in memory yet' }

  // One-character terms match everything and rank nothing.
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length >= 2)
  if (terms.length === 0) return { hits: [], reason: 'the query has no term of two characters or more' }

  const scored = memories
    .map((memory) => ({ memory, ...score(memory, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.frontmatter.at.localeCompare(a.memory.frontmatter.at))

  if (scored.length === 0) {
    return { hits: [], reason: `No memory matches "${query}"` }
  }

  const hits = scored.slice(0, Math.max(1, limit)).map((entry) => ({
    id: entry.memory.frontmatter.id,
    kind: entry.memory.frontmatter.kind,
    title: entry.memory.frontmatter.title,
    tags: entry.memory.frontmatter.tags,
    at: entry.memory.frontmatter.at,
    score: entry.score,
    excerpt: entry.excerpt,
  }))

  const tail = scored.length > hits.length ? ` (${scored.length - hits.length} further matches not shown)` : ''
  return { hits, reason: `${hits.length} of ${scored.length} matches${tail}` }
}

function score(memory: Memory, terms: string[]): { score: number; excerpt: string } {
  const title = memory.frontmatter.title.toLowerCase()
  const tags = memory.frontmatter.tags.map((tag) => tag.toLowerCase())
  const lines = memory.body.split('\n')

  let total = 0
  let bestLine = 0
  let bestLineScore = 0

  for (const term of terms) {
    if (title.includes(term)) total += TITLE_WEIGHT
    if (tags.some((tag) => tag.includes(term))) total += TAG_WEIGHT

    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(term)) continue
      total += BODY_WEIGHT
      const lineScore = (lines[index] ?? '').toLowerCase().split(term).length - 1
      if (lineScore > bestLineScore) {
        bestLineScore = lineScore
        bestLine = index
      }
    }
  }

  const from = Math.max(0, bestLine - 1)
  const excerpt = lines
    .slice(from, from + 3)
    .join(' ')
    .trim()
    .slice(0, 300)
  return { score: total, excerpt }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/memory.test.ts && npm run typecheck`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/memory.ts engine/tests/ops/memory.test.ts
git commit -m "feat(engine): add memory recording and capped keyword search"
```

---

## Task 3: Remove `custom_dirs`, surface `config_error`

**Files:**
- Modify: `engine/src/schemas/config.ts`, `engine/src/store/config-store.ts`, `engine/src/ops/summary.ts`
- Test: `engine/tests/store/config-store.test.ts`, `engine/tests/ops/summary.test.ts`, `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: `ConfigSchema`, `loadConfig`.
- Produces: `ConfigSchema` without `custom_dirs`; `loadConfig` strips legacy keys; `StateSummary.config_error: string | null`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/store/config-store.test.ts`:

```ts
describe('legacy keys', () => {
  it('loads a config written before custom_dirs was removed', async () => {
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    await writeConfig(project.dir, config)

    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    await fs.writeFile(
      resolveLoopPaths(project.dir).config,
      `${raw}\ncustom_dirs:\n  agents: .loop/agents\n  skills: .loop/skills\n`,
      'utf8',
    )

    const loaded = await loadConfig(project.dir)
    expect(loaded.version).toBe(1)
    expect((loaded as unknown as Record<string, unknown>).custom_dirs).toBeUndefined()
  })

  it('still rejects an unrelated unknown key', async () => {
    const config = defaultConfig({ test: null, lint: null, build: null })
    await writeConfig(project.dir, config)

    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    await fs.writeFile(resolveLoopPaths(project.dir).config, `${raw}\nmystery: true\n`, 'utf8')

    await expect(loadConfig(project.dir)).rejects.toThrow(/mystery/)
  })

  it('does not write custom_dirs on a fresh config', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    expect(raw).not.toContain('custom_dirs')
  })
})
```

Add to `engine/tests/ops/summary.test.ts`:

```ts
describe('config_error', () => {
  it('is null for a sound config', async () => {
    await initLoop(project.dir, clock)
    expect((await stateSummary(project.dir)).config_error).toBeNull()
  })

  it('is null when there is no config at all', async () => {
    expect((await stateSummary(project.dir)).config_error).toBeNull()
  })

  it('reports a config that fails to parse', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).config, 'version: 1\ntracks: {}\nmystery: true\n', 'utf8')

    const summary = await stateSummary(project.dir)
    expect(summary.config_error).toContain('mystery')
    expect(summary.initialised).toBe(true)
  })

  it('reports unparseable yaml without throwing', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).config, 'version: [unclosed\n', 'utf8')
    expect((await stateSummary(project.dir)).config_error).not.toBeNull()
  })
})
```

Update the existing `ConfigSchema` test that asserts `custom_dirs` defaults — it must now
assert the key is absent:

```ts
    expect((parsed as unknown as Record<string, unknown>).custom_dirs).toBeUndefined()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/store/config-store.test.ts tests/ops/summary.test.ts`
Expected: FAIL — the legacy config is rejected and `config_error` is undefined.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/config.ts`, delete the `custom_dirs` field from `ConfigSchema`
entirely, and add above it:

```ts
/**
 * Keys earlier versions wrote that no longer exist. `loadConfig` drops them
 * before parsing, so a project initialised by an older milestone keeps working
 * and its next write is clean.
 *
 * `custom_dirs` pointed at `.loop/agents` and `.loop/skills`. Claude Code reads
 * project agents from `.claude/agents` and skills from `.claude/skills`, and no
 * setting anywhere redirects that — so the field's default, and every value it
 * could be given, produced files that are never loaded.
 */
export const LEGACY_CONFIG_KEYS = ['custom_dirs'] as const
```

In `engine/src/store/config-store.ts`, strip them before parsing. Keep whatever
error handling the function already has and add the strip between the YAML parse and the
schema parse:

```ts
  const document = YAML.parse(raw) as unknown
  const stripped =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? Object.fromEntries(
          Object.entries(document as Record<string, unknown>).filter(
            ([key]) => !LEGACY_CONFIG_KEYS.includes(key as (typeof LEGACY_CONFIG_KEYS)[number]),
          ),
        )
      : document
  const parsed = ConfigSchema.safeParse(stripped)
```

Import `LEGACY_CONFIG_KEYS` alongside `ConfigSchema`.

In `engine/src/ops/summary.ts`, add to the `StateSummary` interface:

```ts
  /**
   * The reason the config could not be read, or null. Every other field
   * degrades silently when config is unreadable — this is the one that says so,
   * because a user whose config has a typo currently sees nothing at all.
   */
  config_error: string | null
```

Set `config_error: null` in the uninitialised early-return object. In the main body,
capture the failure in the existing catch around `loadConfig` instead of swallowing it:

```ts
  let configError: string | null = null
```

and in that catch:

```ts
    // A missing config is not an error: a project may be mid-provisioning.
    // Anything else is worth surfacing.
    configError = error instanceof ConfigMissingError ? null : (error as Error).message
```

Add `config_error: configError` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green. If a test asserted a `custom_dirs` default, update it
to assert absence.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/config.ts engine/src/store/config-store.ts engine/src/ops/summary.ts engine/tests
git commit -m "feat(engine): drop custom_dirs and surface config errors"
```

---

## Task 4: The three memory tools

**Files:**
- Modify: `engine/src/mcp/server.ts`
- Test: `engine/tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `memoryAdd`, `memoryGet`, `memorySearch` (Task 2); `MemoryKindSchema` (Task 1).
- Produces: `loop_memory_add`, `loop_memory_search`, `loop_memory_get`.

- [ ] **Step 1: Write the failing test**

Update the tool-list assertion in `engine/tests/mcp/server.test.ts` to include the three
new names in sorted position, and add:

```ts
  it('records a memory and finds it again', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })

    const added = await client.callTool({
      name: 'loop_memory_add',
      arguments: {
        project_dir: project.dir,
        kind: 'decision',
        title: 'Session tokens rather than server sessions',
        body: 'The deployment target has no shared session store.',
        tags: ['auth'],
      },
    })
    expect(JSON.parse(textOf(added)).id).toBe('M001')

    const found = await client.callTool({
      name: 'loop_memory_search',
      arguments: { project_dir: project.dir, query: 'session store' },
    })
    const payload = JSON.parse(textOf(found))
    expect(payload.hits[0].id).toBe('M001')
    expect(payload.hits[0].excerpt).toContain('session store')

    const read = await client.callTool({
      name: 'loop_memory_get',
      arguments: { project_dir: project.dir, id: 'M001' },
    })
    expect(textOf(read)).toContain('no shared session store')
  })

  it('returns a tool error for a memory that does not exist', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'loop_memory_get',
      arguments: { project_dir: project.dir, id: 'M404' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — the tool list is short by three and the tools do not exist.

- [ ] **Step 3: Write the implementation**

In `engine/src/mcp/server.ts`, add the imports:

```ts
import { memoryAdd, memoryGet, memorySearch } from '../ops/memory.js'
import { MemoryKindSchema } from '../schemas/memory.js'
```

and register the three tools:

```ts
  server.registerTool(
    'loop_memory_add',
    {
      title: 'Record a memory',
      description:
        'Record a decision, a lesson, or a pattern this project should not have to relearn. Write one at the end of a run — a decision the diff will not explain, or a lesson from a halt. Not a diary: a memory per cycle buries the entries that matter.',
      inputSchema: {
        project_dir: projectDirArg,
        kind: MemoryKindSchema,
        title: z.string().min(1).describe('One line, specific enough to find later'),
        body: z.string().min(1).describe('The reasoning, at whatever length it needs'),
        tags: z.array(z.string().min(1)).optional(),
        run: z.string().min(1).nullish().describe('The run that produced it, when there is one'),
      },
    },
    async ({ project_dir, kind, title, body, tags, run }) =>
      guard(async () =>
        ok(
          await memoryAdd(resolveProjectDir(project_dir), {
            kind,
            title,
            body,
            ...(tags === undefined ? {} : { tags }),
            ...(run === undefined ? {} : { run }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_memory_search',
    {
      title: 'Search memory',
      description:
        'Rank recorded memories against a query and return the best few with excerpts. Consult it when composing a cycle: a hit changes how you brief the agents, and no hit costs one call. Never returns the whole corpus.',
      inputSchema: {
        project_dir: projectDirArg,
        query: z.string().min(1),
        limit: z.number().int().positive().max(20).optional().describe('Default 5'),
      },
    },
    async ({ project_dir, query, limit }) =>
      guard(async () => ok(await memorySearch(resolveProjectDir(project_dir), query, limit))),
  )

  server.registerTool(
    'loop_memory_get',
    {
      title: 'Read a memory',
      description: 'Read one memory entry in full, by id, after a search surfaced it.',
      inputSchema: { project_dir: projectDirArg, id: z.string().min(1).describe('Memory id, e.g. M001') },
    },
    async ({ project_dir, id }) => guard(async () => ok(await memoryGet(resolveProjectDir(project_dir), id))),
  )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green, 16 tools.

- [ ] **Step 5: Commit**

```bash
git add engine/src/mcp/server.ts engine/tests/mcp/server.test.ts
git commit -m "feat(mcp): expose the three memory tools"
```

---

## Task 5: `/loop:add`

**Files:**
- Create: `commands/add.md`
- Modify: `README.md`, `engine/src/ops/init.ts`, `commands/init.md`
- Test: no unit tests — exercised by Task 7

**Interfaces:**
- Consumes: `loop_state_get` and its new `config_error` (Task 3).
- Produces: `/loop:add agent|skill|track <name>`.

- [ ] **Step 1: Write `commands/add.md`**

```markdown
---
description: Scaffold a new loop agent, skill, or track
argument-hint: agent|skill|track <name>
---

Scaffold a new element for this project: $ARGUMENTS

Read the kind and the name from the argument. Reject a name that is not lowercase letters,
digits, and hyphens — all three kinds become a filename or a directory.

## `agent <name>`

Write `.claude/agents/<name>.md`. That is the directory Claude Code reads project
subagents from; nothing loads agents from anywhere else, whatever a config might suggest.

**First check the name against the agents this plugin ships.** Project agents take
precedence over plugin agents, so scaffolding one named `verifier`, `builder`, `fixer`,
`reproducer`, or any other shipped agent would silently replace it with an empty stub —
including the ones carrying the system's hardest invariants. If the name collides, refuse,
say which agent would have been shadowed, and stop.

Scaffold it with frontmatter (`name`, `description`, `tools`, `model: inherit`), a short
statement of what the agent does and what it must never do, and the full output contract
inline — copy the contract block from an existing agent in this plugin so the new one is
contract-correct on its first run rather than corrected by a retry.

Then tell the user the step the scaffold cannot do for them: **add the agent to a track's
`required` or `available` set in `.loop/config.yaml`.** An agent no track offers can never
be drafted.

## `skill <name>`

Write `.claude/skills/<name>/SKILL.md` with the frontmatter Claude Code requires: a `name`
and a `description` that says when the skill applies. No shadowing check is needed —
plugin skills are namespaced and cannot collide.

## `track <name>`

A track is data. Add it to `tracks:` in `.loop/config.yaml`:

```yaml
  <name>:
    required:  [agent-a, verifier]
    available: [agent-b]
    max_cycles: 5
```

Ask for the required and available sets rather than guessing them. Then **validate**: call
`loop_state_get` and check `config_error`. If it is not null, the edit broke the config —
report the message and fix it before saying anything succeeded.

A track may also carry a gate:

```yaml
    gate: { proven_by: agent-a, blocks: [agent-b] }
```

Both names must belong to the track, and the config refuses to parse otherwise.

## After any of the three

Claude Code picks up a new agent or skill within seconds — **unless the directory did not
exist when this session started**, which is exactly the case when you have just created
the project's first one. Say so: the user needs to restart the session, and will otherwise
wonder why the thing you just made does not exist.
```

- [ ] **Step 2: Register the command with host projects**

In `engine/src/ops/init.ts`, add to `CLAUDE_MD_BLOCK` after the design-sync line:

```
- \`/loop:add agent|skill|track <name>\` — scaffold a new element
```

In `commands/init.md`, add `/loop:add` wherever the commands are listed.

In `README.md`, add to the `## Use` block:

```
/loop:add agent|skill|track <name>       scaffold a new element
```

and replace the extensibility content — or add it if there is none — with:

```markdown
## Extending it

A track is data. Adding one is a few lines in `.loop/config.yaml`, and the leader never
changes: it does not know agent names ahead of time, it reads them from the track.

```yaml
tracks:
  refactor:
    required:  [builder, verifier]
    available: [scout, critic, perf]
    max_cycles: 5
```

`/loop:add agent|skill|track <name>` scaffolds any of the three. New agents land in
`.claude/agents/`, which is where Claude Code reads project subagents from — the scaffold
refuses a name that would shadow one this plugin ships.

The `loop-tracks` and `loop-extend` skills explain the whole system: what `required` and
`available` guarantee, the two kinds of gate, the three specialist modes, and what a new
agent must return.
```

- [ ] **Step 3: Verify the surface**

Run: `cd engine && npx vitest run tests/ops/init.test.ts && npm run build`
Expected: PASS. If an init test asserts the exact `CLAUDE_MD_BLOCK`, update it.

- [ ] **Step 4: Commit**

```bash
git add commands/add.md commands/init.md README.md engine/src/ops/init.ts
git commit -m "feat(plugin): add /loop:add for scaffolding agents, skills, and tracks"
```

---

## Task 6: The `loop-tracks` and `loop-extend` skills

**Files:**
- Create: `skills/loop-tracks/SKILL.md`, `skills/loop-extend/SKILL.md`
- Modify: `skills/loop-leader/SKILL.md`
- Test: no unit tests — exercised by Task 7

**Interfaces:**
- Consumes: the whole system as shipped.
- Produces: the two skills milestone 1 deferred, and the leader's memory rules.

- [ ] **Step 1: Write `skills/loop-tracks/SKILL.md`**

```markdown
---
name: loop-tracks
description: Use when composing a loop cycle or changing how a track behaves - explains required and available sets, the two kinds of gate, the three specialist modes, and the guards that end a run
---

# Loop Tracks

A track is data in `.loop/config.yaml`. The engine does not know agent names, so adding a
track or an agent to one changes no code.

## Required and available

```yaml
build:
  required:  [builder, verifier]
  available: [scout, critic, ui-designer, ui-critic, security, docs, perf]
  max_cycles: 5
```

**`required`** is a guarantee, not a default. `loop_roster_set` rejects a roster that
omits any of them, so a track's promise cannot erode one cycle at a time. `verifier` is
required on three tracks for exactly this reason: no success is declared without evidence.

**`available`** is what the leader may draft — and every one it drafts past needs a stated
reason in `skipped`. Silence is not an answer, and `critic` in a later cycle may challenge
an omission it thinks was unsafe.

**`max_cycles`** is a ceiling, not a target. The guards below usually end a run first.

## Two kinds of gate

A gate is an ordering constraint the engine enforces at logging, not a suggestion.

**An evidence gate** blocks agents until a designated agent proves something:

```yaml
gate: { proven_by: reproducer, blocks: [fixer] }
```

`loop_run_log` refuses a result from anything in `blocks` until `proven_by` returns
`status: "pass"` carrying command or test evidence. The `fix` track uses it so no fix is
recorded for a defect nobody demonstrated; the `plan` track uses it so no story is written
for a plan nobody checked against the code.

**A decision gate** is different in kind and lives on the artefact, not the track. The
plan approval gate is recorded on a plan by `loop_gate_set` and enforced when a story is
added. There is no evidence a person's decision could carry — the record is the thing —
which is why a tool records it here and no tool records the other.

## The three specialist modes

```yaml
specialists:
  security: always    # in every cycle; a roster omitting it is rejected
  perf: never         # a roster drafting it is rejected
  docs: auto          # the leader decides — the default
```

All three are enforced, and the keys are agent names rather than groups, because a group
would require the engine to know which agents belong to it.

A track cannot both require an agent and forbid it: the config refuses to parse, naming
both places, rather than accepting a track for which every possible roster is invalid.

## The guards that end a run

In the order `cycleAdvance` checks them:

1. **pass** — the run is done.
2. **repeated error** — the same verification failure twice running. Halts at the second
   occurrence, because an identical command failing identically is strong evidence.
3. **stagnation** — the same work remaining for N consecutive cycles, N from
   `limits.no_progress_strikes`.
4. **cycle cap** — the track's `max_cycles`.

Each writes a distinct reason into `HALT.md`, because "the loop is stuck", "the same thing
keeps failing", and "out of budget" send a reader to three different places.

## Adding a track

```yaml
tracks:
  refactor:
    required:  [builder, verifier]
    available: [scout, critic, perf]
    max_cycles: 5
```

That is the whole change. `/loop:add track <name>` writes it and validates by reading the
config back — see the **loop-extend** skill for what else a new element needs.
```

- [ ] **Step 2: Write `skills/loop-extend/SKILL.md`**

```markdown
---
name: loop-extend
description: Use when adding a new agent, skill, or track to the loop - where each lives, what a new agent must return, and why none of it requires changing the engine
---

# Extending Loop

Nothing here requires an engine change. That is a property the design pays for: the engine
never learns an agent's name, so everything you add is data or a prompt.

## Adding an agent

**Where it goes:** `.claude/agents/<name>.md`. That is the directory Claude Code reads
project subagents from. Nothing loads agents from anywhere else — an agent written
elsewhere is a file that is never read.

**What it must return.** Every loop agent returns one shape, validated before it is
recorded:

```json
{
  "status": "pass | fail | blocked",
  "summary": "One paragraph a reviewer can act on.",
  "evidence": [{ "kind": "command | file | test", "ref": "npm test", "excerpt": "12 passed" }],
  "findings": [{ "severity": "high | medium | low", "file": "src/a.ts", "line": 14, "claim": "..." }],
  "files_touched": ["src/a.ts"],
  "next_hint": "optional single suggestion, or null"
}
```

Put that block **inline in the agent's own file**, not as a reference to another skill. A
real run proved the difference: agents pointed at the contract violated it on their first
attempt and each cost a corrective retry; agents carrying it inline complied first time.

**Give it one job and a stated limit.** Every agent in this plugin says what it must never
do — the verifier never edits, the builder never verifies or commits, the critic never
fixes what it found. A limit is what makes a second opinion worth having.

**Wire it in.** Add the name to a track's `required` or `available` set. An agent no track
offers can never be drafted, whatever its file says.

**Do not shadow a shipped agent.** Project agents take precedence over plugin agents, so
an agent named `verifier` replaces the one carrying the system's hardest invariant with
whatever you wrote. `/loop:add agent` refuses such a name.

## Adding a skill

`.claude/skills/<name>/SKILL.md`, with `name` and a `description` that says when it
applies. Plugin skills are namespaced, so a project skill cannot collide with one of this
plugin's.

## Adding a track

A few lines of YAML — see the **loop-tracks** skill for the sets, the gates, and the
specialist modes. `/loop:add track <name>` writes it and validates by reading the config
back.

## The constraint that explains the design

The engine does not know agent names. Not as an implementation detail — as the rule that
makes the rest possible.

It is why a track is data. It is why the reproduction gate is a `gate` field naming
agents from config rather than a hardcoded rule about `reproducer` and `fixer`. It is why
the specialist modes are a map the engine reads without interpreting.

When you extend the loop, keep it: if something you are adding would need the engine to
learn a name, the design is telling you the rule belongs in config instead.
```

- [ ] **Step 3: Add the memory rules to `skills/loop-leader/SKILL.md`**

Read the file first — it has grown across seven milestones. Add this section near the end,
keeping every existing part:

```markdown
### Memory

The project remembers on purpose, not automatically. Nothing injects memory into a session
or a brief; you consult it and you record to it.

**Consult it when you open a run.** Call `loop_memory_search` with the goal's distinctive
terms. A hit changes how you brief the agents — a recorded decision explains why the
obvious approach was rejected before, and a recorded lesson saves a cycle rediscovering it.
No hit costs one call.

**Record at the end of a run**, and record one thing:

- a **decision** the diff will not explain — why this approach and not the obvious one
- a **lesson** from a halt — what the run learned about this project the hard way
- a **pattern** worth following next time

Not a diary. A memory per cycle buries the entries that matter, and the corpus is only
worth searching while it is worth reading.

Nothing to record is a normal outcome. A run that did the obvious thing and it worked has
taught the project nothing it did not know.
```

- [ ] **Step 4: Verify the skills are discovered**

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: five skills — `loop-contract`, `loop-leader`, `loop-state`, `loop-tracks`,
`loop-extend`. If the CLI is unavailable, count the directories in `skills/`.

- [ ] **Step 5: Commit**

```bash
git add skills/loop-tracks/SKILL.md skills/loop-extend/SKILL.md skills/loop-leader/SKILL.md
git commit -m "feat(skills): add loop-tracks and loop-extend, and the leader memory rules"
```

---

## Task 7: The integration proof and the E2E

**Files:**
- Create: `engine/tests/integration/memory.test.ts`, `tests/e2e/run-add.sh`
- Modify: `engine/package.json` — add the `e2e:add` script

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: proof that a run can record what it learned and find it next time.

- [ ] **Step 1: Write the failing integration test**

`engine/tests/integration/memory.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { memoryAdd, memoryGet, memorySearch } from '../../src/ops/memory.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T15:00:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

describe('a run that remembers', () => {
  it('records a decision and finds it while composing the next run', async () => {
    const first = await runStart(project.dir, { track: 'build', goal: 'Add session handling' }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)

    await memoryAdd(
      project.dir,
      {
        kind: 'decision',
        title: 'Session tokens rather than server sessions',
        body: 'The deployment target has no shared session store, and adding one would mean a new dependency for a single feature.',
        tags: ['auth', 'architecture'],
        run: first.run_id,
      },
      clock,
    )

    // A later run consults memory before composing.
    const { hits, reason } = await memorySearch(project.dir, 'session store dependency')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe('M001')
    expect(hits[0]?.title).toContain('Session tokens')
    expect(reason).toContain('1 of 1')

    // The excerpt is an excerpt, not the whole entry.
    expect(hits[0]?.excerpt.length).toBeLessThan(300)

    // The full entry is one call away, and carries the run that produced it.
    const full = await memoryGet(project.dir, 'M001')
    expect(full.frontmatter.run).toBe(first.run_id)
    expect(full.body).toContain('new dependency')
  })

  it('answers honestly when nothing matches', async () => {
    await memoryAdd(project.dir, { kind: 'pattern', title: 'Route wrapping', body: 'Every route wraps its handler.' }, clock)
    const { hits, reason } = await memorySearch(project.dir, 'kubernetes ingress')
    expect(hits).toEqual([])
    expect(reason).toContain('No memory')
  })

  it('leaves the summary clean on a sound config', async () => {
    expect((await stateSummary(project.dir)).config_error).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/integration/memory.test.ts`
Expected: PASS if Tasks 1–3 landed correctly. A failure here is a defect in them.

- [ ] **Step 3: Write the E2E script**

`tests/e2e/run-add.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test of /loop:add against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-add.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

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

claude -p "/loop:add agent db-reviewer" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

[[ -f .claude/agents/db-reviewer.md ]] || fail "the agent was not written to .claude/agents/"
grep -q "^name: db-reviewer" .claude/agents/db-reviewer.md || fail "no name in the frontmatter"
grep -q "files_touched" .claude/agents/db-reviewer.md || fail "the output contract is not inline"

# Shadowing a shipped agent must be refused.
claude -p "/loop:add agent verifier" --permission-mode acceptEdits --allowedTools "${allowed[@]}" \
  > shadow.log 2>&1
if [[ -f .claude/agents/verifier.md ]]; then
  fail "a shipped agent was shadowed — .claude/agents/verifier.md should not exist"
fi
grep -qi "verifier" shadow.log || fail "the refusal did not name the agent it protected"

rm -rf "${workdir}"
echo "PASS: the scaffold wrote a usable agent and refused to shadow a shipped one"
```

Run: `chmod +x tests/e2e/run-add.sh`

Add to `engine/package.json` scripts:

```json
"e2e:add": "bash ../tests/e2e/run-add.sh"
```

- [ ] **Step 4: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

Run: `bash tests/e2e/run-add.sh`
Expected: `skipped: set LOOP_E2E=1 ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add engine/tests/integration/memory.test.ts tests/e2e/run-add.sh engine/package.json
git commit -m "test: prove a run can record what it learned and find it again"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green, three consecutive runs with the same count
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 19 agents, 10 commands, 5 skills, 16 MCP tools, 3 hooks
- [ ] A config written by an earlier milestone, containing `custom_dirs`, still loads
- [ ] An unrelated unknown config key is still rejected
- [ ] `/loop:status` reports a config error instead of degrading silently
- [ ] `loop_memory_search` never returns more than its limit
- [ ] `LOOP_E2E=1 npm run e2e:add` — the scaffold writes to `.claude/agents/` and refuses to shadow

## The base spec is complete

Every element of `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` has shipped:
four tracks, nineteen agents, five skills, sixteen MCP tools, three hooks, and eight
guards. What remains is not a milestone but a judgement — running the loop on real work
and finding out which of these decisions were right.
