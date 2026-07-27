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

/**
 * The slug is bounded because the whole basename is, and it is stripped after
 * the slice rather than before so a truncation cannot leave a trailing hyphen —
 * the same order `storyFileName` uses.
 */
const SLUG_MAX = 60

/** `<id>-<slugified title>.md` — identifiable in a directory listing. */
export function memoryFileName(frontmatter: MemoryFrontmatter): string {
  const slug = frontmatter.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  // A title carrying no ascii letter or digit — a CJK title, or punctuation —
  // slugs to nothing, and `M001-.md` identifies nothing. The kind is the next
  // most useful thing a directory listing can say about the entry.
  return `${frontmatter.id}-${slug === '' ? frontmatter.kind : slug}.md`
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
}

export async function listMemories(projectDir: string): Promise<Memory[]> {
  const dir = resolveLoopPaths(projectDir).memory
  const entries = await listFiles(dir)

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

/**
 * Memory numbers already spoken for, read from the filenames rather than from
 * the parsed entries.
 *
 * `listMemories` skips a file whose frontmatter no longer parses — one stray key
 * is enough, and these files are prose a person is invited to correct — but that
 * file still owns its id. Allocation therefore reads the directory, which cannot
 * be talked out of an id by a bad edit.
 */
export async function usedMemoryNumbers(projectDir: string): Promise<number[]> {
  const numbers = new Set<number>()
  for (const entry of await listFiles(resolveLoopPaths(projectDir).memory)) {
    const match = /^M(\d{3})(?:[-.]|$)/.exec(entry)
    if (match?.[1] !== undefined) numbers.add(Number(match[1]))
  }
  // An entry whose file was renamed out of the convention is still an entry:
  // its frontmatter id counts too.
  for (const memory of await listMemories(projectDir)) {
    numbers.add(Number(memory.frontmatter.id.slice(1)))
  }
  return [...numbers]
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
  // `wx`: memory is only ever appended to, so a file already at this path means
  // an id was handed out twice. Refusing is the only safe answer — a plain write
  // would delete a recorded entry with no error and no backup.
  await fs.writeFile(file, serialiseFrontmatter(memory.frontmatter, memory.body), { encoding: 'utf8', flag: 'wx' })
  return file
}
