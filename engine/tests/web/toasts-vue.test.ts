// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import { useToasts } from '../../src/web/app/composables/useToasts.ts'
import Toasts from '../../src/web/app/components/Toasts.vue'
import { readLocale } from './helpers/page.js'

const english = await readLocale('en')

beforeEach(() => {
  installForTest({ code: 'en', strings: english })
  const { toasts, dismiss } = useToasts()
  for (const toast of [...toasts.value]) dismiss(toast.id)
})

describe('Toasts', () => {
  it('shows a notice as its translated code', () => {
    const { notify } = useToasts()
    notify({ code: 'write.ok.halt' })
    const wrapper = mount(Toasts)
    expect(wrapper.get('.toast > span').text()).toBe(english['write.ok.halt'])
  })

  it('runs an offered action and then clears the toast', async () => {
    const run = vi.fn()
    const { notify } = useToasts()
    notify({ code: 'write.ok.gate' }, { code: 'write.undo', run })
    const wrapper = mount(Toasts)
    await wrapper.get('button.toast-action').trigger('click')
    expect(run).toHaveBeenCalledOnce()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  it('dismisses without running anything', async () => {
    const run = vi.fn()
    const { notify } = useToasts()
    notify({ code: 'write.ok.gate' }, { code: 'write.undo', run })
    const wrapper = mount(Toasts)
    await wrapper.get('button.toast-dismiss').trigger('click')
    expect(run).not.toHaveBeenCalled()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  describe('the eight-second lifetime', () => {
    // `public/ui/toasts.js:16,56`: `LIFETIME_MS = 8000`, and only an
    // *actionless* toast self-removes after it — an Undo the reader has to
    // notice, read and reach for in eight seconds is not really an Undo.
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('expires an actionless toast after 8000ms', async () => {
      const { notify, toasts } = useToasts()
      notify({ code: 'write.ok.halt' })
      expect(toasts.value).toHaveLength(1)

      vi.advanceTimersByTime(7999)
      expect(toasts.value).toHaveLength(1)

      vi.advanceTimersByTime(1)
      expect(toasts.value).toHaveLength(0)
    })

    it('never expires a toast that carries an action', () => {
      const { notify, toasts } = useToasts()
      notify({ code: 'write.ok.gate' }, { code: 'write.undo', run: () => {} })
      vi.advanceTimersByTime(60_000)
      expect(toasts.value).toHaveLength(1)
    })

    it('cancels the pending timer when a toast is dismissed manually, so it does not leave a stray timer behind', () => {
      const { notify, dismiss, toasts } = useToasts()
      notify({ code: 'write.ok.halt' })
      const id = toasts.value[0]?.id as number
      dismiss(id)
      expect(toasts.value).toHaveLength(0)
      // The real assertion: no timer survives a manual dismiss. A version of
      // this test once asserted `toasts.value` had length 0 after advancing
      // 8000ms — but a *second* toast notified in between would also reach
      // length 0 on its own natural expiry, so that assertion passed whether
      // or not the first toast's timer was actually cancelled. `getTimerCount`
      // reads the fake-timer queue directly: if `remove()` merely filtered the
      // array without calling `clearTimeout`, this is 1, not 0.
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
