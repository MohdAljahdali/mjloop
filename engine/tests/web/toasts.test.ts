// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installForTest } from '../../src/web/public/lib/i18n.js'
import { dismiss, mountToasts, runAction, toast } from '../../src/web/public/ui/toasts.js'
import { loadPage, readLocale } from './helpers/page.js'

/**
 * Notices and receipts.
 *
 * The interesting rule is the lifetime: a toast that only says something goes
 * away on its own, and one that offers an Undo does not. An Undo the user has
 * to notice, read and reach for inside eight seconds is an Undo that is not
 * really there — which is exactly how it behaved before this test.
 */

const english = await readLocale('en')

beforeEach(async () => {
  await loadPage()
  installForTest({ code: 'en', strings: english })
  mountToasts(document.getElementById('toasts') as HTMLElement)
  vi.useFakeTimers()
})

const shown = (): number => document.querySelectorAll('#toasts .toast').length

describe('toast', () => {
  it('renders a notice and lets it expire', () => {
    toast({ code: 'queue.blocked', params: { job: '/mjloop:build P001-S02' } })
    expect(shown()).toBe(1)
    expect(document.querySelector('#toasts .toast')?.textContent).toContain('/mjloop:build P001-S02')

    vi.advanceTimersByTime(9000)
    expect(shown()).toBe(0)
  })

  it('keeps an actionable toast until it is used', () => {
    const undo = vi.fn()
    toast({ code: 'write.ok.story' }, { code: 'write.undo', run: undo })

    vi.advanceTimersByTime(60_000)
    expect(shown()).toBe(1)

    const button = document.querySelector('#toasts [data-act="toast-action"]') as HTMLElement
    expect(button.hidden).toBe(false)
    runAction(button)
    expect(undo).toHaveBeenCalledTimes(1)
    // The offer was for one press, so the toast goes with it.
    expect(shown()).toBe(0)
  })

  it('lets an actionable toast be dismissed without acting', () => {
    const undo = vi.fn()
    toast({ code: 'write.ok.story' }, { code: 'write.undo', run: undo })
    dismiss(document.querySelector('#toasts [data-act="toast-dismiss"]') as HTMLElement)
    expect(shown()).toBe(0)
    expect(undo).not.toHaveBeenCalled()
  })

  it('hides the action button on a plain notice', () => {
    toast({ code: 'job.abandoned', params: { job: 'x' } })
    expect((document.querySelector('#toasts [data-act="toast-action"]') as HTMLElement).hidden).toBe(true)
  })
})
