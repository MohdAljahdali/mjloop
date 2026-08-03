// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import type { MemoryView } from '../../src/web/read.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * `lib/fmt.ts`'s `stamp()`, computed independently rather than imported: the
 * app module is dynamically re-imported per test inside `boot()`, after
 * `vi.resetModules()`, so a *statically* imported copy here would read a
 * different, never-installed `lib/i18n.ts` instance's locale.
 */
function expectedStamp(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

/**
 * The Memory panel — `panels/memory.js`, `describe('memory faceting')` at
 * `panels.test.ts:1811`, and the memory section of `index.html` — ported to
 * `Memory.vue`.
 *
 * `facet`'s own filtering rules are exercised at `lib.test.ts`'s
 * `describe('lib/memory')`, ported line for line from the old suite (plus a
 * few edge cases the old block never named — whitespace, an absent term, an
 * empty list). What is under test here is what this panel draws from it and
 * drives it with:
 *
 *  1. The empty state distinguishes "nothing recorded" (`memory.empty`) from
 *     "nothing matches the filter" (`memory.noMatch`), and is absent
 *     whenever at least one row is shown.
 *  2. The kind picker offers only the kinds actually present in the fetched
 *     list, sorted, plus "every kind"; a kind the dictionary has no word for
 *     renders as itself in both the picker and the row badge.
 *  3. The query box and the kind picker both narrow the same list, and
 *     together (`facet`'s own `kind !== ''` short-circuit).
 *  4. A row draws every slot `tpl-memory` did: id, kind, title, timestamp,
 *     tags as chips, and the body — structurally, at the ids and classes
 *     `60-panels.css` selects.
 *  5. The list caps at 200 and the "more" line names both counts, appearing
 *     only past the cap.
 *  6. The query persists through `lib/local.ts`'s `memoryQuery`: a
 *     previously remembered query seeds the box and the filter on mount, and
 *     typing writes it back to storage on every keystroke. The kind filter
 *     is never persisted — it opens on "every kind" regardless of what was
 *     last chosen.
 *  7. The feed follows `revisions.memory` alone: a snapshot that moves a
 *     different revision does not refetch `/api/memory`.
 *
 * Deferred, with reason: writing a memory is out of scope — `writeMemory`
 * (`web/writes.ts`) has no update or delete anywhere the browser can reach,
 * so there is nothing editable here to test.
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

function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const key = url.split('?')[0] ?? ''
    const known = Object.prototype.hasOwnProperty.call(routes, key)
    return Promise.resolve(
      new Response(JSON.stringify(known ? routes[key] : { error: { code: 'error.notFound' } }), { status: known ? 200 : 404 }),
    )
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
  document.documentElement.dir = 'ltr'
})

/**
 * Boots a fresh module graph, seeds storage, connects a `FakeSocket`, and
 * delivers a snapshot — `panel-evidence.test.ts`'s own `boot()`, with a
 * storage seed on top since this panel is the one that reads `memoryQuery`.
 *
 * @param seed What `mjloop.prefs` already holds, seeded *before*
 *   `useMemoryQuery.ts`'s module graph loads — its own `ref(prefs()...)` is
 *   read once, inside the composable's function body, the first time
 *   `Memory.vue`'s setup calls it.
 */
async function boot(snapshot: Snapshot = emptySnapshot(), seed?: string) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const local = await import('../../src/web/app/lib/local.ts')
  const held = new Map<string, string>()
  if (seed !== undefined) held.set('mjloop.prefs', seed)
  local.installStorage({ getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Memory } = await import('../../src/web/app/panels/Memory.vue')
  const useI18n = await import('../../src/web/app/composables/useI18n.ts')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Memory, local, held, i18n: freshI18n, useI18n, socket: FakeSocket.last as FakeSocket }
}

const memory = (patch: Partial<MemoryView> & { id: string }): MemoryView => ({
  kind: 'decision',
  title: 'A decision',
  tags: [],
  at: '2026-07-28T09:00:00.000Z',
  run: null,
  plan: null,
  story: null,
  body: '',
  ...patch,
})

describe('Memory.vue', () => {
  it('shows "nothing recorded" when the list itself is empty, and hides once a row exists', async () => {
    serve({ '/api/memory': [] })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await nextTick()

    expect(wrapper.get('#memory-empty').text()).toBe(english['memory.empty'])
    expect(wrapper.find('#memory-list .memory').exists()).toBe(false)
    expect(wrapper.find('#memory-more').exists()).toBe(false)
  })

  it('shows "no match" — not "nothing recorded" — when memories exist but the filter excludes all of them', async () => {
    serve({ '/api/memory': [memory({ id: 'M001', title: 'Cookies over tokens' })] })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.find('#memory-list .memory').exists()).toBe(true))

    await wrapper.get('#memory-query').setValue('nonexistent term')
    await nextTick()

    expect(wrapper.get('#memory-empty').text()).toBe(english['memory.noMatch'])
    expect(wrapper.find('#memory-list .memory').exists()).toBe(false)
  })

  it('draws a row with every slot tpl-memory had, at the ids and classes 60-panels.css selects', async () => {
    serve({
      '/api/memory': [
        memory({ id: 'M001', kind: 'lesson', title: 'Retry the flake', tags: ['ci', 'flaky'], body: 'Because of a race.', at: '2026-07-28T09:00:00.000Z' }),
      ],
    })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.find('#memory-list .memory').exists()).toBe(true))

    expect(wrapper.get('#memory-list').classes()).toContain('memories')
    const row = wrapper.get('#memory-list .memory')
    expect(row.get('[data-slot="id"]').text()).toBe('M001')
    expect(row.get('[data-slot="id"]').classes()).toContain('memory-id')
    expect(row.get('[data-slot="kind"]').text()).toBe(english['memory.kind.lesson'])
    expect(row.get('[data-slot="kind"]').classes()).toContain('tag')
    expect(row.get('[data-slot="title"]').text()).toBe('Retry the flake')
    expect(row.get('[data-slot="at"]').classes()).toContain('when')
    expect(row.get('[data-slot="at"]').text()).toBe(expectedStamp('2026-07-28T09:00:00.000Z'))
    const chips = row.findAll('[data-slot="tags"] .chip')
    expect(chips.map((chip) => chip.text())).toEqual(['ci', 'flaky'])
    expect(row.get('[data-slot="tags"]').classes()).toContain('chips')
    expect(row.get('[data-slot="body"]').text()).toBe('Because of a race.')
    expect(row.get('[data-slot="body"]').classes()).toContain('excerpt')
  })

  it('renders a kind the dictionary has no word for as itself, in both the badge and the picker', async () => {
    serve({ '/api/memory': [memory({ id: 'M001', kind: 'invented-kind' })] })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.find('#memory-list .memory').exists()).toBe(true))

    expect(wrapper.get('[data-slot="kind"]').text()).toBe('invented-kind')
    const options = wrapper.findAll('#memory-kind option')
    expect(options.map((option) => option.text())).toEqual([english['memory.allKinds'], 'invented-kind'])
  })

  it('isolates an unknown kind in its own bdi, so it cannot reorder inside an RTL row — a known kind gets no such wrapper', async () => {
    document.documentElement.dir = 'rtl'
    serve({
      '/api/memory': [
        memory({ id: 'M001', kind: 'invented-kind' }),
        memory({ id: 'M002', kind: 'lesson' }),
      ],
    })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.findAll('#memory-list .memory')).toHaveLength(2))

    const rows = wrapper.findAll('#memory-list .memory')
    expect(rows[0]?.get('[data-slot="kind"]').find('bdi').exists()).toBe(true)
    expect(rows[0]?.get('[data-slot="kind"] bdi').attributes('dir')).toBe('ltr')
    expect(rows[1]?.get('[data-slot="kind"]').find('bdi').exists()).toBe(false)
  })

  it('repaints the kind picker and the row badge on a locale switch — memory.js:76-86\'s own bug, guarded', async () => {
    // The old page tracked this with a five-line comment: switching locale
    // left the picker reading "Every kind" until a memory of a new kind
    // happened to arrive, because the options were built outside a row's own
    // `update()`. `useI18n`'s epoch makes every `t()`/`known()` read here a
    // reactive dependency, so nothing has to watch for it explicitly — this
    // test is what proves that structural claim rather than assuming it.
    serve({ '/api/memory': [memory({ id: 'M001', kind: 'lesson' })] })
    const { Memory, i18n, useI18n } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.find('#memory-list .memory').exists()).toBe(true))

    expect(wrapper.get('[data-slot="kind"]').text()).toBe(english['memory.kind.lesson'])
    expect(wrapper.get('#memory-kind option').text()).toBe(english['memory.allKinds'])

    i18n.installForTest({ code: 'ar', strings: { ...english, 'memory.kind.lesson': 'درس', 'memory.allKinds': 'كل الأنواع' } })
    await useI18n.applyLocale('ar')
    await nextTick()

    expect(wrapper.get('[data-slot="kind"]').text()).toBe('درس')
    expect(wrapper.get('#memory-kind option').text()).toBe('كل الأنواع')
  })

  it('offers only the kinds actually present, sorted, and keeps the query and kind filters independent', async () => {
    serve({
      '/api/memory': [
        memory({ id: 'M001', kind: 'lesson', title: 'Retry the flake', tags: ['ci'] }),
        memory({ id: 'M002', kind: 'decision', title: 'Cookies over tokens', body: 'Because of SSR.' }),
        memory({ id: 'M003', kind: 'decision', title: 'A different decision' }),
      ],
    })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.findAll('#memory-list .memory')).toHaveLength(3))

    const options = wrapper.findAll('#memory-kind option')
    // Sorted: "decision" before "lesson".
    expect(options.map((option) => option.attributes('value'))).toEqual(['', 'decision', 'lesson'])

    await wrapper.get('#memory-kind').setValue('decision')
    await nextTick()
    expect(wrapper.findAll('#memory-list .memory').map((row) => row.get('[data-slot="id"]').text())).toEqual(['M002', 'M003'])

    await wrapper.get('#memory-query').setValue('cookies ssr')
    await nextTick()
    // Both facets apply together — a query term plus a kind, `facet`'s own
    // `panels.test.ts:1827-1830` behaviour, now exercised through the DOM.
    expect(wrapper.findAll('#memory-list .memory').map((row) => row.get('[data-slot="id"]').text())).toEqual(['M002'])
  })

  it('caps the list at 200 and names both counts on the "more" line, absent under the cap', async () => {
    const many = Array.from({ length: 240 }, (_, i) => memory({ id: `M${String(i).padStart(3, '0')}` }))
    serve({ '/api/memory': many })
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.findAll('#memory-list .memory')).toHaveLength(200))

    expect(wrapper.get('#memory-more').classes()).toContain('more')
    expect(wrapper.get('#memory-more').text()).toBe('Showing 200 of 240 entries.')

    serve({ '/api/memory': [memory({ id: 'M001' })] })
    const { Memory: Small } = await boot()
    const smallWrapper = mount(Small)
    await vi.waitFor(() => expect(smallWrapper.find('#memory-list .memory').exists()).toBe(true))
    expect(smallWrapper.find('#memory-more').exists()).toBe(false)
  })

  it('seeds the query box and the filter from the remembered memoryQuery, and writes every keystroke back', async () => {
    serve({
      '/api/memory': [
        memory({ id: 'M001', title: 'Cookies over tokens' }),
        memory({ id: 'M002', title: 'Something else entirely' }),
      ],
    })
    const { Memory, held } = await boot(emptySnapshot(), JSON.stringify({ memoryQuery: 'cookies' }))
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.find('#memory-list .memory').exists()).toBe(true))

    expect((wrapper.get('#memory-query').element as HTMLInputElement).value).toBe('cookies')
    expect(wrapper.findAll('#memory-list .memory').map((row) => row.get('[data-slot="id"]').text())).toEqual(['M001'])

    await wrapper.get('#memory-query').setValue('something')
    await nextTick()
    expect(wrapper.findAll('#memory-list .memory').map((row) => row.get('[data-slot="id"]').text())).toEqual(['M002'])
    expect(JSON.parse(held.get('mjloop.prefs') ?? '{}')).toMatchObject({ memoryQuery: 'something' })
  })

  it('never persists the kind filter — it opens on "every kind" no matter what a previous visit chose', async () => {
    serve({ '/api/memory': [memory({ id: 'M001', kind: 'lesson' })] })
    // `memoryQuery` is the only field `parse()` (lib/local.ts) recognises for
    // this panel; there is no stored kind field to seed even if one were
    // invented, which is the point under test — the picker has no storage
    // path at all.
    const { Memory } = await boot()
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(wrapper.find('#memory-list .memory').exists()).toBe(true))

    expect((wrapper.get('#memory-kind').element as HTMLSelectElement).value).toBe('')
  })

  it('follows revisions.memory alone — an unrelated revision moving does not refetch', async () => {
    let calls = 0
    vi.stubGlobal('fetch', (url: string) => {
      const path = url.split('?')[0] ?? ''
      if (path === '/api/memory') calls++
      return Promise.resolve(new Response(JSON.stringify(path === '/api/memory' ? [] : { error: { code: 'error.notFound' } }), { status: 200 }))
    })

    const first = emptySnapshot({ revisions: { ...emptySnapshot().revisions, memory: 'm1' } })
    const { Memory, socket } = await boot(first)
    const wrapper = mount(Memory)
    await vi.waitFor(() => expect(calls).toBe(1))

    // `revisions.runs` moves; `revisions.memory` does not.
    socket.deliver({ type: 'snapshot', snapshot: { ...first, revisions: { ...first.revisions, runs: 'r2' } } })
    await nextTick()
    expect(calls).toBe(1)

    socket.deliver({ type: 'snapshot', snapshot: { ...first, revisions: { ...first.revisions, memory: 'm2' } } })
    await vi.waitFor(() => expect(calls).toBe(2))
    void wrapper
  })
})
