// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clone, cls, flag, phrase, text, verbatim } from '../../src/web/public/ui/dom.js'
import { installForTest } from '../../src/web/public/lib/i18n.js'
import { draw, installScheduler, register } from '../../src/web/public/ui/render.js'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'

/**
 * Everything the cockpit keeps in the DOM — focus, caret, scroll, selection, an
 * open `<details>`, a live region a screen reader is already watching — exists
 * only because the node holding it is never replaced. These are the tests that
 * fail the day somebody reintroduces a rebuild.
 *
 * They load the real `index.html`, so they consume the templates that ship.
 */

const english = await readLocale('en')

beforeEach(async () => {
  await loadPage()
  installForTest({ code: 'en', strings: english })
  installScheduler((fn) => fn())
})

describe('text', () => {
  it('reuses the same text node', () => {
    const node = document.createElement('span')
    text(node, 'x')
    const first = node.firstChild
    text(node, 'x')
    text(node, 'y')
    // Selection preservation depends on exactly this: a browser drops a
    // selection that spans a node it no longer has.
    expect(node.firstChild).toBe(first)
    expect(node.textContent).toBe('y')
  })
})

describe('cls', () => {
  it('leaves exactly one member of a family on the node', () => {
    const node = document.createElement('span')
    cls(node, 'status', 'todo')
    cls(node, 'status', 'doing')
    cls(node, 'status', 'done')
    const held = [...node.classList].filter((name) => name.startsWith('status-'))
    expect(held).toEqual(['status-done'])
  })
})

describe('verbatim', () => {
  it('pins direction on identifiers', () => {
    const node = document.createElement('span')
    verbatim(node, 'P001-S02')
    // `Intl` would render this `P٠٠١-S٠٢` in Arabic, and an unisolated Latin
    // run inside an Arabic sentence drags the punctuation around it.
    expect(node.firstElementChild?.tagName).toBe('BDI')
    expect(node.firstElementChild?.getAttribute('dir')).toBe('ltr')
    expect(node.textContent).toBe('P001-S02')
    // The container keeps the page's own direction, or a right-aligned value
    // would jump to the far left of its column in Arabic.
    expect(node.hasAttribute('dir')).toBe(false)
  })

  it('reuses its wrapper across redraws', () => {
    const node = document.createElement('span')
    verbatim(node, 'P001-S01')
    const held = node.firstElementChild
    verbatim(node, 'P001-S02')
    expect(node.firstElementChild).toBe(held)
    expect(node.textContent).toBe('P001-S02')
  })
})

describe('phrase', () => {
  it('wraps every parameter in a bdi', () => {
    const node = document.createElement('span')
    phrase(node, 'story.blockedBy', { ids: 'P001-S01' })
    expect(node.querySelector('bdi')?.textContent).toBe('P001-S01')
  })

  it('repaints when the locale changes even though nothing else did', () => {
    const node = document.createElement('span')
    phrase(node, 'story.status.done')
    expect(node.textContent).toBe('done')

    installForTest({ code: 'ar', strings: { 'story.status.done': 'تمّت' }, fallback: english })
    phrase(node, 'story.status.done')
    // The test that forbids reintroducing a memo above the leaf. A locale
    // switch mutates no snapshot field, so a memo higher up would repaint
    // nothing and leave a half-translated page.
    expect(node.textContent).toBe('تمّت')
  })
})

describe('templates', () => {
  it('clones a shipped row and indexes its slots', () => {
    const { root, slots } = clone('tpl-story-detail')
    expect(root.classList.contains('story')).toBe(true)
    expect(Object.keys(slots).sort()).toEqual([
      'acceptDetails',
      'acceptSummary',
      'acceptance',
      'anomaly',
      'build',
      'dot',
      'evidence',
      'id',
      'requeue',
      'status',
      'title',
      'ui',
      'waits',
    ])
  })

  it('refuses a template that does not exist', () => {
    expect(() => clone('tpl-nope')).toThrow()
  })
})

describe('draw', () => {
  it('skips hidden panels', () => {
    const visible = document.createElement('div')
    const hidden = document.createElement('div')
    hidden.hidden = true
    const seen = vi.fn()
    const skipped = vi.fn()
    register({ id: 'visible', node: visible, update: seen })
    register({ id: 'hidden', node: hidden, update: skipped })

    draw(emptySnapshot())
    expect(seen).toHaveBeenCalledTimes(1)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('does not let a throwing panel wedge the next frame', () => {
    const angry = document.createElement('div')
    const calm = document.createElement('div')
    const after = vi.fn()
    register({
      id: 'angry',
      node: angry,
      update: () => {
        throw new Error('boom')
      },
    })
    register({ id: 'calm', node: calm, update: after })

    const console_ = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw(emptySnapshot())
    draw(emptySnapshot())
    console_.mockRestore()

    expect(after).toHaveBeenCalledTimes(2)
  })

  it('coalesces several requests into one pass', () => {
    /** @type {(() => void)[]} */
    const pending: (() => void)[] = []
    installScheduler((fn) => void pending.push(fn))
    const node = document.createElement('div')
    const update = vi.fn()
    register({ id: 'coalesced', node, update })

    draw(emptySnapshot())
    draw(emptySnapshot())
    draw(emptySnapshot())
    expect(pending).toHaveLength(1)
    pending[0]?.()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('the things a rebuild would destroy', () => {
  it('keeps focus and caret across three draws', () => {
    const input = document.getElementById('command') as HTMLInputElement
    input.value = '/mjloop:fix the log'
    input.focus()
    input.setSelectionRange(9, 9)

    const node = document.querySelector('.command') as HTMLElement
    register({ id: 'launcher-ish', node, update: () => phrase(node.querySelector('button') as HTMLElement, 'command.run') })
    draw(emptySnapshot())
    draw(emptySnapshot())
    draw(emptySnapshot())

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(9)
    // Rule 3: no renderer ever assigns to `.value`, so an 800ms tick cannot eat
    // a half-typed command.
    expect(input.value).toBe('/mjloop:fix the log')
  })

  it('keeps scroll across a hidden flip', () => {
    const panel = document.getElementById('panel-plans') as HTMLElement
    panel.scrollTop = 42
    flag(panel, 'hidden', true)
    flag(panel, 'hidden', false)
    expect(panel.scrollTop).toBe(42)
  })
})
