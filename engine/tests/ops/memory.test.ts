import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvalidMemoryInputError, memoryAdd, memoryGet, memorySearch } from '../../src/ops/memory.js'
import { MEMORY_BODY_MAX } from '../../src/schemas/memory.js'
import { MemoryNotFoundError, listMemories, writeMemory } from '../../src/store/memory-store.js'
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

  it('does not reuse the id of an entry a hand edit broke', async () => {
    // The body of an entry is prose a person may correct, and one stray key or
    // a retyped timestamp is enough to make the frontmatter unreadable. That
    // file still owns M001: reusing it would overwrite the entry in place.
    const first = await memoryAdd(project.dir, { kind: 'decision', title: 'Why redis', body: 'ORIGINAL' }, clock)
    const raw = await fs.readFile(first.file, 'utf8')
    await fs.writeFile(first.file, raw.replace(/^at: .*$/m, 'at: 2026-07-27T15:00:00+00:00'), 'utf8')

    const second = await memoryAdd(project.dir, { kind: 'decision', title: 'Why redis', body: 'REPLACED' }, clock)
    expect(second.id).toBe('M002')
    expect(await fs.readFile(first.file, 'utf8')).toContain('ORIGINAL')
  })

  it('says memory is full rather than failing on an id the caller never gave', async () => {
    await writeMemory(project.dir, {
      frontmatter: { id: 'M999', kind: 'decision', title: 'Last', at: NOW.toISOString(), tags: [], run: null },
      body: 'x',
    })
    await expect(
      memoryAdd(project.dir, { kind: 'decision', title: 'One more', body: 'x' }, clock),
    ).rejects.toThrow(/memory is full/)
  })

  it('refuses a body past the ceiling', async () => {
    await expect(
      memoryAdd(project.dir, { kind: 'lesson', title: 'Huge', body: 'x'.repeat(MEMORY_BODY_MAX + 1) }, clock),
    ).rejects.toBeInstanceOf(InvalidMemoryInputError)
    expect(await listMemories(project.dir)).toEqual([])
  })

  it('refuses a title past the ceiling, and a title of blanks', async () => {
    await expect(
      memoryAdd(project.dir, { kind: 'lesson', title: 'x'.repeat(201), body: 'y' }, clock),
    ).rejects.toBeInstanceOf(InvalidMemoryInputError)
    await expect(memoryAdd(project.dir, { kind: 'lesson', title: '   ', body: 'y' }, clock)).rejects.toBeInstanceOf(
      InvalidMemoryInputError,
    )
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

  it('ranks a tag hit above a body hit', async () => {
    const { hits } = await memorySearch(project.dir, 'auth')
    // "auth" is a tag on the first and appears in the second's body.
    expect(hits[0]?.title).toContain('Session tokens')
  })

  it('ranks a title hit above a body that repeats the term', async () => {
    // Without a cap on the body's contribution the entry that mentions the term
    // in passing on enough lines outranks the entry the term is the subject of,
    // and it gets worse as bodies grow.
    const fresh = await makeTmpProject()
    try {
      await memoryAdd(fresh.dir, { kind: 'decision', title: 'Retry policy', body: 'Unrelated prose.' }, clock)
      await memoryAdd(
        fresh.dir,
        {
          kind: 'decision',
          title: 'Something else entirely',
          body: Array.from({ length: 20 }, (_, i) => `Line ${i} mentions retry in passing.`).join('\n'),
        },
        clock,
      )
      const { hits } = await memorySearch(fresh.dir, 'retry')
      expect(hits[0]?.title).toBe('Retry policy')
    } finally {
      await fresh.cleanup()
    }
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

  it('bounds the whole response, not only the excerpt', async () => {
    // The cap is the point of the tool: title, tags, and excerpt are all
    // bounded, so twenty hits cannot become an unbounded context tax.
    const result = await memorySearch(project.dir, 'session tokens tests error', 20)
    expect(result.hits.length).toBeGreaterThan(0)
    expect(JSON.stringify(result).length).toBeLessThan(20_000)
  })

  it('does not echo the whole query back when nothing matches', async () => {
    const { hits, reason } = await memorySearch(project.dir, 'kubernetes '.repeat(1000))
    expect(hits).toEqual([])
    expect(reason.length).toBeLessThan(200)
  })

  it('orders equal scores by recency', async () => {
    const fresh = await makeTmpProject()
    try {
      await memoryAdd(fresh.dir, { kind: 'decision', title: 'Cache older', body: 'x' }, () => new Date('2026-07-20T09:00:00.000Z'))
      await memoryAdd(fresh.dir, { kind: 'decision', title: 'Cache newer', body: 'x' }, () => new Date('2026-07-25T09:00:00.000Z'))
      const { hits } = await memorySearch(fresh.dir, 'cache')
      expect(hits.map((hit) => hit.title)).toEqual(['Cache newer', 'Cache older'])
    } finally {
      await fresh.cleanup()
    }
  })
})
