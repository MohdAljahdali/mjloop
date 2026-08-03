// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { emptySnapshot } from './helpers/page.js'

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

/** The same fake socket `shell.test.ts` uses to drive the store from a snapshot. */
class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 1
  listeners = new Map<string, (event: unknown) => void>()
  constructor(public url: string) {
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, fn)
  }
  send(): void {}
  deliver(message: unknown): void {
    this.listeners.get('message')?.({ data: JSON.stringify(message) })
  }
}

describe('Terminal', () => {
  it('drops an append for a job nothing has shown yet', async () => {
    // `app.js:285` — `if (message.jobId === shownJob()) write(...)`. `shown`
    // starts `null`, which matches no jobId, so an append with no snapshot
    // ever having named a job is not adopted.
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    mount(Terminal)
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'hello' })
    expect(written).toEqual([])
  })

  it('resets before a transcript, because it replaces the buffer, and adopts it unconditionally', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    mount(Terminal)
    store.__emitForTest({ kind: 'replace', jobId: 'j1', data: 'all of it' })
    expect(resets).toBe(1)
    expect(written).toEqual(['all of it'])
    // Now that the transcript is shown, a matching append writes straight through.
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'more' })
    expect(written).toEqual(['all of it', 'more'])
  })

  it('unsubscribes on unmount', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    const wrapper = mount(Terminal)
    store.__emitForTest({ kind: 'replace', jobId: 'j1', data: 'seed' })
    wrapper.unmount()
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'late' })
    expect(written).toEqual(['seed'])
  })

  it('follows a newly started job when nothing is shown, mirroring pane.js followQueue', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
    mount(Terminal)

    const running = emptySnapshot()
    running.session = { ...running.session, jobId: 'j1' }
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: running })
    await nextTick()

    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'hello' })
    expect(written).toEqual(['hello'])
  })

  it('does not follow a new job once the reader has opened a different finished transcript', async () => {
    // `pane.js`'s `followQueue`: `shown === previous || shown === null` is
    // the guard. Once `shown` is neither — because the reader explicitly
    // opened job C's transcript while job A was running — job B starting
    // must not yank them back onto it.
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
    mount(Terminal)

    const jobA = emptySnapshot()
    jobA.session = { ...jobA.session, jobId: 'A' }
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: jobA })
    await nextTick()

    // The reader opens a finished job's full transcript.
    store.__emitForTest({ kind: 'replace', jobId: 'C', data: 'job C transcript' })

    const jobB = emptySnapshot()
    jobB.session = { ...jobB.session, jobId: 'B' }
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: jobB })
    await nextTick()

    written.length = 0
    store.__emitForTest({ kind: 'append', jobId: 'B', data: 'from B' })
    expect(written).toEqual([])

    store.__emitForTest({ kind: 'append', jobId: 'C', data: 'from C' })
    expect(written).toEqual(['from C'])
  })
})
