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
