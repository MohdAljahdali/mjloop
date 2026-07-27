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
