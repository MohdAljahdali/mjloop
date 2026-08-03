// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})
