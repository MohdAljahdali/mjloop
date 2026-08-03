// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * `useFeed.ts`'s own `<KeepAlive>` fix — Important 1 of the whole-branch
 * review. `panel-memory.test.ts` already covers the panel's own behaviour
 * over a live mount; this covers only what changed: a panel deactivated by
 * `<KeepAlive>` (`App.vue:172`) must stop re-running its `watchEffect` and
 * stop re-fetching on a revision bump, and must catch back up the moment it
 * is reactivated — the same "hidden panels are skipped entirely" rule the
 * deleted page stated in `ui/render.js`'s header
 * (`git show 611119c:engine/src/web/public/ui/render.js`).
 *
 * The Memory panel is the vehicle: its own feed's `dep` is exactly one
 * revision (`state.revisions.memory`), so a fetch count is unambiguous.
 */

const english = await readLocale('en')

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 1
  listeners = new Map<string, (event: unknown) => void>()
  sent: unknown[] = []
  constructor(public url: string) {
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, fn)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  deliver(message: unknown): void {
    this.listeners.get('message')?.({ data: JSON.stringify(message) })
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
  document.documentElement.dir = 'ltr'
})

async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const local = await import('../../src/web/app/lib/local.ts')
  local.installStorage({ getItem: () => null, setItem: () => undefined })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Memory } = await import('../../src/web/app/panels/Memory.vue')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Memory, socket: FakeSocket.last as FakeSocket }
}

describe('useFeed under <KeepAlive>', () => {
  it('stops refetching once deactivated, and catches up the instant it is reactivated', async () => {
    let calls = 0
    vi.stubGlobal('fetch', (url: string) => {
      if (url.split('?')[0] === '/api/memory') calls++
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    })

    const first = emptySnapshot({ revisions: { ...emptySnapshot().revisions, memory: 'm1' } })
    const { Memory, socket } = await boot(first)

    // A host that mirrors `App.vue:172-181`: one panel under `<KeepAlive>`,
    // toggled by a boolean instead of a second real panel — the mechanism
    // under test is `onActivated`/`onDeactivated`, which fire the same way
    // regardless of what the sibling branch is.
    const shown = ref(true)
    const Dummy = defineComponent({ render: () => h('div') })
    const Host = defineComponent({
      setup() {
        return () => h(KeepAlive, () => (shown.value ? h(Memory) : h(Dummy)))
      },
    })

    const wrapper = mount(Host)
    await vi.waitFor(() => expect(calls).toBe(1))

    // Deactivate the panel — the same transition switching tabs makes.
    shown.value = false
    await nextTick()

    // Broadcasts keep arriving while the panel is in the background; none of
    // them may cost a fetch.
    socket.deliver({ type: 'snapshot', snapshot: { ...first, revisions: { ...first.revisions, memory: 'm2' } } })
    await nextTick()
    socket.deliver({ type: 'snapshot', snapshot: { ...first, revisions: { ...first.revisions, memory: 'm3' } } })
    await nextTick()
    expect(calls).toBe(1)

    // Reactivating catches it up: `feed()`'s own `update()` refetches as
    // soon as it sees a `dep` (`m3`) it has not seen before.
    shown.value = true
    await nextTick()
    await vi.waitFor(() => expect(calls).toBe(2))

    wrapper.unmount()
  })
})
