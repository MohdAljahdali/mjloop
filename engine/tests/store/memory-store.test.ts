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
