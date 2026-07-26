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
