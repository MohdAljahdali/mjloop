// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installForTest } from '../../src/web/public/lib/i18n.js'
import {
  close,
  drawNoticeFeed,
  mountNotifications,
  notify,
  open,
  toggle,
} from '../../src/web/public/ui/notifications.js'
import { mountToasts } from '../../src/web/public/ui/toasts.js'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'

/**
 * The persistent surface `ui/toasts.js` never had: a bounded log of what
 * `notify()` has shown this session, an unread count, and — through
 * `drawNoticeFeed()` — the snapshot transitions neither a toast nor a write
 * receipt was ever wired to announce on its own.
 */

const english = await readLocale('en')

function slots(): Record<string, HTMLElement> {
  return {
    toggle: document.getElementById('notice-toggle') as HTMLElement,
    count: document.getElementById('notice-count') as HTMLElement,
    panel: document.getElementById('notice-panel') as HTMLElement,
    empty: document.getElementById('notice-empty') as HTMLElement,
    list: document.getElementById('notice-list') as HTMLElement,
    more: document.getElementById('notice-more') as HTMLElement,
  }
}

beforeEach(async () => {
  await loadPage()
  installForTest({ code: 'en', strings: english })
  mountToasts(document.getElementById('toasts') as HTMLElement)
  vi.useFakeTimers()
})

const rows = (): HTMLElement[] => [...document.querySelectorAll('#notice-list .notice-row')] as HTMLElement[]

describe('notify', () => {
  it('shows the toast and logs the same entry', () => {
    mountNotifications(slots())
    notify({ code: 'job.abandoned', params: { job: '/mjloop:build P001-S02' } })
    expect(document.querySelectorAll('#toasts .toast')).toHaveLength(1)

    open()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain('/mjloop:build P001-S02')
    // The row carries a `<time>`, not only the phrase — when this fired, not
    // only what.
    expect(rows()[0]?.querySelector('time')?.textContent).not.toBe('')
  })

  it('counts an entry as unread only while the panel is closed, and names the count on the toggle', () => {
    mountNotifications(slots())
    const toggleButton = document.getElementById('notice-toggle') as HTMLElement
    notify({ code: 'write.ok.story' })
    const badge = document.getElementById('notice-count') as HTMLElement
    expect(badge.hidden).toBe(false)
    expect(badge.textContent).toBe('1')
    // The digits are `aria-hidden`; the accessible count lives on the
    // button's own `title`, the same split `app.js`'s `badge()` uses for the
    // navigation counts.
    expect(toggleButton.getAttribute('title')).toContain('1')

    // Opening reads it: the count clears and stays clear for an entry that
    // arrives while the panel is already open.
    open()
    expect(badge.hidden).toBe(true)
    expect(toggleButton.hasAttribute('title')).toBe(false)
    notify({ code: 'write.ok.story' })
    expect(badge.hidden).toBe(true)

    close()
    notify({ code: 'write.ok.story' })
    expect(badge.hidden).toBe(false)
    expect(badge.textContent).toBe('1')
  })

  it('toggles the panel open and shut', () => {
    mountNotifications(slots())
    const panel = document.getElementById('notice-panel') as HTMLElement
    const toggleButton = document.getElementById('notice-toggle') as HTMLElement
    expect(panel.hidden).toBe(true)
    toggle()
    expect(panel.hidden).toBe(false)
    expect(toggleButton.getAttribute('aria-expanded')).toBe('true')
    toggle()
    expect(panel.hidden).toBe(true)
    expect(toggleButton.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the empty state until the first entry, then hides it', () => {
    mountNotifications(slots())
    open()
    const empty = document.getElementById('notice-empty') as HTMLElement
    expect(empty.hidden).toBe(false)
    notify({ code: 'write.ok.story' })
    expect(empty.hidden).toBe(true)
  })

  it("caps the drawn list at reconcile's limit and says how many more there are", () => {
    mountNotifications(slots())
    for (let i = 0; i < 240; i += 1) notify({ code: 'write.ok.story' })
    open()
    expect(rows()).toHaveLength(200)
    const more = document.getElementById('notice-more') as HTMLElement
    expect(more.hidden).toBe(false)
    // The store itself is bounded too, well above the 200-row draw cap, so
    // the count in "more" is real rather than the fixture happening to sit
    // inside some other silent ceiling.
    expect(more.textContent).toContain('200')
  })

  it("bounds the store itself, not only what reconcile draws", () => {
    mountNotifications(slots())
    // Past `HISTORY_MAX` (300): a session that runs long enough must not grow
    // this array without limit. If the store's own cap were missing, "more"
    // would report every entry ever shown instead of the store's own ceiling.
    for (let i = 0; i < 350; i += 1) notify({ code: 'write.ok.story' })
    open()
    const more = document.getElementById('notice-more') as HTMLElement
    expect(more.textContent).toContain('300')
    expect(more.textContent).not.toContain('350')
  })
})

describe('drawNoticeFeed', () => {
  it('notifies once per snapshot transition it can honestly observe', () => {
    mountNotifications(slots())
    const first = emptySnapshot()
    drawNoticeFeed(first)
    expect(document.querySelectorAll('#toasts .toast')).toHaveLength(0)

    const next = emptySnapshot({
      state: { ...first.state, config_error: 'bad indentation' },
    })
    drawNoticeFeed(next)
    expect(document.querySelectorAll('#toasts .toast')).toHaveLength(1)
    open()
    expect(rows()[0]?.textContent).toContain('unreadable')

    // The same snapshot again must not refire.
    drawNoticeFeed(next)
    expect(rows()).toHaveLength(1)
  })
})
