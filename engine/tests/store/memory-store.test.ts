import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MemoryNotFoundError,
  listMemories,
  memoryFileName,
  readMemory,
  usedMemoryNumbers,
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
      plan: null,
      story: null,
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
  it('defaults tags, run, plan and story', () => {
    const parsed = MemoryFrontmatterSchema.parse({ id: 'M001', kind: 'lesson', title: 'A lesson', at: AT })
    expect(parsed.tags).toEqual([])
    expect(parsed.run).toBeNull()
    expect(parsed.plan).toBeNull()
    expect(parsed.story).toBeNull()
  })

  it('rejects a kind outside the three values', () => {
    const bad = { id: 'M001', kind: 'thought', title: 'x', at: AT }
    expect(MemoryFrontmatterSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    const bad = { id: 'M001', kind: 'lesson', title: 'x', at: AT, priority: 1 }
    expect(MemoryFrontmatterSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts a well-formed plan and story scope', () => {
    const parsed = MemoryFrontmatterSchema.parse({
      id: 'M001',
      kind: 'decision',
      title: 'Scoped',
      at: AT,
      plan: 'P001',
      story: 'P001-S02',
    })
    expect(parsed.plan).toBe('P001')
    expect(parsed.story).toBe('P001-S02')
  })

  it('rejects a plan or story id that could steer a query, the same shape guard the ids themselves carry', () => {
    expect(MemoryFrontmatterSchema.safeParse({ id: 'M001', kind: 'decision', title: 'x', at: AT, plan: 'nope' }).success).toBe(
      false,
    )
    expect(
      MemoryFrontmatterSchema.safeParse({ id: 'M001', kind: 'decision', title: 'x', at: AT, story: '../../etc' }).success,
    ).toBe(false)
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

  it('falls back to the kind when the title slugs to nothing', () => {
    // A CJK or punctuation-only title leaves no ascii to slug, and `M003-.md`
    // identifies nothing in a directory listing.
    expect(memoryFileName(entry('M003', '决定：不用缓存集群').frontmatter)).toBe('M003-decision.md')
    expect(memoryFileName(entry('M004', '???', { kind: 'lesson' }).frontmatter)).toBe('M004-lesson.md')
  })

  it('never ends the slug on a hyphen, however the title truncates', () => {
    const long = `${'a'.repeat(59)} and then some more words`
    expect(memoryFileName(entry('M005', long).frontmatter)).toBe(`M005-${'a'.repeat(59)}.md`)
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

  it('refuses to overwrite an entry that is already there', async () => {
    // Memory is only appended to. A second write to one path could only come
    // from an id handed out twice, and overwriting would delete the first entry.
    await writeMemory(project.dir, entry('M001', 'Session tokens'))
    await expect(writeMemory(project.dir, entry('M001', 'Session tokens'))).rejects.toThrow()
    expect((await readMemory(project.dir, 'M001')).body).toBe('The reasoning, at length.')
  })
})

describe('usedMemoryNumbers', () => {
  it('is empty before anything is recorded', async () => {
    expect(await usedMemoryNumbers(project.dir)).toEqual([])
  })

  it('counts a file whose frontmatter no longer parses', async () => {
    // The entry a person broke by hand still owns its id: listMemories skips it,
    // but allocation must not hand the number out again.
    await writeMemory(project.dir, entry('M001', 'Sound'))
    const dir = resolveLoopPaths(project.dir).memory
    await fs.writeFile(path.join(dir, 'M002-broken.md'), '---\nid: [unclosed\n---\n', 'utf8')
    await fs.writeFile(path.join(dir, 'notes.md'), '# just notes\n', 'utf8')

    expect((await listMemories(project.dir)).map((m) => m.frontmatter.id)).toEqual(['M001'])
    expect((await usedMemoryNumbers(project.dir)).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('counts an entry whose file was renamed out of the convention', async () => {
    const file = await writeMemory(project.dir, entry('M003', 'Renamed'))
    await fs.rename(file, path.join(resolveLoopPaths(project.dir).memory, 'notes-on-redis.md'))
    expect(await usedMemoryNumbers(project.dir)).toEqual([3])
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

  it('reads a memory file written before `plan` and `story` existed, defaulting both to null', async () => {
    // `MemoryFrontmatterSchema` is strict, so this is the compatibility case
    // B11 exists to protect: a required field here would fail `safeParse` for
    // every entry recorded before it, and `listMemories` would silently drop
    // each one from the corpus rather than raising anywhere.
    const dir = resolveLoopPaths(project.dir).memory
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'M001-old-shape.md'),
      '---\nid: M001\nkind: decision\ntitle: Old shape\nat: 2026-07-27T15:00:00.000Z\ntags: []\nrun: null\n---\n\nWritten before this milestone.\n',
      'utf8',
    )

    const memories = await listMemories(project.dir)
    expect(memories).toHaveLength(1)
    expect(memories[0]?.frontmatter.plan).toBeNull()
    expect(memories[0]?.frontmatter.story).toBeNull()
  })
})
