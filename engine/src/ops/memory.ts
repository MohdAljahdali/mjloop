import fs from 'node:fs/promises'
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
  // The lock is a directory created with a deliberately non-recursive `mkdir`,
  // so `.loop` itself must already exist. It does for every operation that
  // follows `loop init`, but the first memory can be recorded before anything
  // else has written there — exactly as the first plan can.
  await fs.mkdir(paths.root, { recursive: true })
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
