// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

/**
 * xterm is a global from `vendor/`, not an import, so the test installs a
 * recording double in its place — the same shape `page-globals.d.ts` declares.
 */
const written: string[] = []
let resets = 0

beforeEach(() => {
  written.length = 0
  resets = 0
  vi.resetModules()
  ;(globalThis as any).Terminal = class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() {}
    write(data: string) {
      written.push(data)
    }
    reset() {
      resets += 1
    }
  }
  ;(globalThis as any).FitAddon = { FitAddon: class { fit() {} } }
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
})

describe('Terminal', () => {
  it('writes an append frame straight through', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    mount(Terminal)
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'hello' })
    expect(written).toEqual(['hello'])
  })

  it('resets before a transcript, because it replaces the buffer', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    mount(Terminal)
    store.__emitForTest({ kind: 'replace', jobId: 'j1', data: 'all of it' })
    expect(resets).toBe(1)
    expect(written).toEqual(['all of it'])
  })

  it('unsubscribes on unmount', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    const wrapper = mount(Terminal)
    wrapper.unmount()
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'late' })
    expect(written).toEqual([])
  })
})
