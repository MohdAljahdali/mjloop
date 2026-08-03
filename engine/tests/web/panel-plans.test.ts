// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, watch } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import type { MemoryView, RunSummary } from '../../src/web/read.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Plans panel — `panels/plans.js`, `describe('plans')` at
 * `panels.test.ts:194`, and the plans section of `index.html` — ported to
 * `Plans.vue`.
 *
 * `planRuns`/`planMemories` themselves move to `lib/plans.ts` and are tested
 * there (`lib.test.ts`'s `describe('lib/plans')`); what is under test here is
 * the DOM this panel draws from them, the plan gate (the panel's first real
 * user of the store's undo path), and the persisted plan selection.
 */

const english = await readLocale('en')

/** The same fake socket `panel-run.test.ts` and `shell.test.ts` use to drive the store. */
class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 1
  listeners = new Map<string, (event: unknown) => void>()
  sent: { id?: string }[] = []
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

/** A read api that answers the paths a test names and 404s everything else — `panels.test.ts`'s own `serve()`, ported. */
function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = routes[url.split('?')[0] ?? '']
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }),
    )
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
})

/**
 * Boots a fresh module graph, seeds storage, connects a `FakeSocket`, and
 * delivers a snapshot — the same order `App.vue`'s own `onMounted` follows.
 *
 * Also reproduces `App.vue`'s own plan-document pump (`mountPlanDoc()`
 * driven by `watch([snapshot, activePlan], …)`), since fix round 1 moved that
 * ownership out of `Plans.vue` — a panel only `subscribe()`s and reads
 * `value()` now. This has to run before `Plans.vue`'s own module graph is
 * exercised, the same ordering `plandoc.ts:47-52` requires in production.
 *
 * @param seed What `mjloop.prefs` already holds — the persisted plan
 *   selection tests need this seeded *before* `useSelection.ts`'s module
 *   graph loads, since its ref is read from it at first import.
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
  const selection = await import('../../src/web/app/composables/useSelection.ts')
  const plandoc = await import('../../src/web/app/lib/plandoc.ts')
  const { activePlan } = selection.useSelection()
  const docFeed = plandoc.mountPlanDoc()
  watch(
    [store.snapshot, activePlan],
    ([current]) => {
      if (current !== null) docFeed.update(current)
    },
    { immediate: true },
  )
  const { default: Plans } = await import('../../src/web/app/panels/Plans.vue')
  // Toasts (and the undo action they offer) live in a sibling component in
  // production (`App.vue`) — installed here the same way, so a test can press
  // an undo the way a reader actually would.
  const { default: Toasts } = await import('../../src/web/app/components/Toasts.vue')
  const { useToasts } = await import('../../src/web/app/composables/useToasts.ts')
  const toasts = useToasts()
  store.installAnnouncer(toasts.notify)
  const PlansHost = defineComponent({ setup: () => () => h('div', [h(Plans), h(Toasts)]) })
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Plans, PlansHost, local, socket: FakeSocket.last as FakeSocket }
}

const planFixture = (patch: Partial<Snapshot['plans'][number]> & { id: string }) => ({
  title: 'A plan',
  approval: null,
  stories: [],
  ...patch,
})

const storyFixture = (patch: Partial<Snapshot['plans'][number]['stories'][number]> & { id: string }) => ({
  title: 'A story',
  status: 'todo',
  ui: false,
  depends_on: [],
  ...patch,
})

const planDetail = (patch: Record<string, unknown> & { id: string }) => ({
  title: 'A plan',
  approval: null,
  body: '',
  review: null,
  stories: [],
  ...patch,
})

describe('Plans.vue', () => {
  it('opens plan detail in context, exposes the state to keyboard users, and focuses the title', async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', title: 'Large plan' }) })
    const { Plans } = await boot(emptySnapshot({ plans: [planFixture({ id: 'P001', title: 'Large plan' })] }))
    const wrapper = mount(Plans, { attachTo: document.body })
    await nextTick()

    const open = wrapper.get('.plan button')
    expect(open.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('#plan-detail').attributes('hidden')).toBeDefined()

    await open.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#plans-workspace').attributes('data-detail-open')).toBe('true')
    expect(document.activeElement).toBe(document.getElementById('plan-detail-title'))
    // The button itself flips too — not only the section it controls.
    expect(wrapper.get('.plan button').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('closes the detail from its own back button, the same as toggling the row closed', async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001' }) })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001' })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())

    await wrapper.get('.plan-back').trigger('click')
    expect(wrapper.get('#plan-detail').attributes('hidden')).toBeDefined()
    expect(wrapper.get('#plans-workspace').attributes('data-detail-open')).toBe('false')
    expect(wrapper.get('.plan button').attributes('aria-expanded')).toBe('false')
  })

  it('opens the plan the reader left open, with no click', async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', title: 'Large plan' }) })
    const { Plans } = await boot(emptySnapshot({ plans: [planFixture({ id: 'P001' })] }), JSON.stringify({ activePlan: 'P001' }))
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#plan-detail-title').text()).toContain('Large plan')
  })

  it('keeps a plan the snapshot has stopped listing rather than forgetting it', async () => {
    const { Plans, local } = await boot(emptySnapshot({ plans: [] }), JSON.stringify({ activePlan: 'P001' }))
    const wrapper = mount(Plans)
    await nextTick()
    expect(local.read().activePlan).toBe('P001')
    expect(wrapper.get('#plan-detail').attributes('hidden')).toBeDefined()
  })

  it("hides Plan Progress rather than inventing numbers when the snapshot has stopped listing the open plan", async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }) })
    const { Plans, store } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.get('#plan-progress').attributes('hidden')).toBeUndefined())

    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ plans: [] }) })
    await nextTick()
    expect(wrapper.get('#plan-progress').attributes('hidden')).toBeDefined()
  })

  it("breaks down the open plan's own stories, agreeing with the row above it", async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }) })
    const stories = [
      storyFixture({ id: 'P001-S01', status: 'done' }),
      storyFixture({ id: 'P001-S02', status: 'doing' }),
      storyFixture({ id: 'P001-S03', status: 'blocked' }),
      storyFixture({ id: 'P001-S04', depends_on: ['P001-S01'] }),
      storyFixture({ id: 'P001-S05', depends_on: ['P001-S02'] }),
    ]
    const p002Stories = [storyFixture({ id: 'P002-S01', status: 'done' }), storyFixture({ id: 'P002-S02', status: 'done' })]
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories }), planFixture({ id: 'P002', stories: p002Stories })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.get('#plan-progress').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#plan-progress-completed').text()).toBe('1')
    expect(wrapper.get('#plan-progress-doing').text()).toBe('1')
    expect(wrapper.get('#plan-progress-ready').text()).toBe('1')
    expect(wrapper.get('#plan-progress-blocked').text()).toBe('1')
    expect(wrapper.get('#plan-progress-remaining').text()).toBe('4')

    const row = wrapper.get('#plans-list .plan')
    expect(row.find('.count').text()).toBe('1/5')
    expect(row.find('.ready-note').text()).toBe(english['plans.readyHere']?.replace('{n}', '1'))
    expect(row.find('.waits').text()).toBe(english['plans.blockedHere']?.replace('{n}', '1'))
  })

  it("collects only this plan's own runs into Plan Evidence, by the run directory's story convention", async () => {
    const run = (patch: Partial<RunSummary> & { id: string }): RunSummary => ({ story: null, track: 'build', cycles: 1, halted: false, ...patch })
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }),
      '/api/runs': [
        run({ id: '2026-07-28-001--P001-S01--build', story: 'P001-S01', cycles: 2 }),
        run({ id: '2026-07-28-004--P001-S01--build', story: 'P001-S01', halted: true }),
        run({ id: '2026-07-28-002--P002-S01--build', story: 'P002-S01' }),
        run({ id: '2026-07-28-003--adhoc--edit', story: null, halted: true }),
      ],
    })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.findAll('#plan-evidence-list .run')).toHaveLength(2))

    const rows = wrapper.findAll('#plan-evidence-list .run')
    expect(rows[0]?.text()).toContain('2026-07-28-001--P001-S01--build')
    expect(rows[0]?.text()).not.toContain('P002-S01')
    expect(rows[0]?.find('.story-id').text()).toBe('P001-S01')
    expect(rows[0]?.find('[data-slot="cycles"]').text()).toBe('2 cycles')
    expect(rows[0]?.find('.chip').text()).toBe('build')
    expect(rows[0]?.text()).toContain('ended')
    expect(rows[0]?.find('.res').classes()).toContain('res-pass')

    expect(rows[1]?.text()).toContain('halted')
    expect(rows[1]?.find('.res').classes()).toContain('res-fail')
    expect(wrapper.get('#plan-evidence-empty').attributes('hidden')).toBeDefined()
  })

  it('caps Plan Evidence and says how many runs are not shown', async () => {
    const many = Array.from({ length: 240 }, (_, index) => ({
      id: `2026-07-28-${String(index).padStart(3, '0')}--P001-S01--build`,
      story: 'P001-S01',
      track: 'build',
      cycles: 1,
      halted: false,
    }))
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }), '/api/runs': many })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.findAll('#plan-evidence-list .run')).toHaveLength(200))
    expect(wrapper.get('#plan-evidence-more').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#plan-evidence-more').text()).toBe('Showing 200 of 240 runs.')
  })

  it('caps Plan Memory and says how many entries are not shown', async () => {
    const many = Array.from({ length: 240 }, (_, index) => ({
      id: `M${String(index).padStart(3, '0')}`,
      kind: 'decision',
      title: 'Something',
      tags: [],
      at: '2026-07-28T09:00:00.000Z',
      run: null,
      plan: 'P001',
      story: null,
      body: `Entry ${index}.`,
    }))
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }), '/api/memory': many })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.findAll('#plan-memory-list .memory')).toHaveLength(200))
    expect(wrapper.get('#plan-memory-more').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#plan-memory-more').text()).toBe('Showing 200 of 240 entries.')
  })

  it("joins Plan Memory on the memory's own plan/story fields, never on a prose mention or the run field", async () => {
    const memory = (patch: Partial<MemoryView> & { id: string }): MemoryView => ({
      kind: 'decision',
      title: 'Something else entirely',
      tags: [],
      at: '2026-07-28T09:00:00.000Z',
      run: null,
      plan: null,
      story: null,
      body: '',
      ...patch,
    })
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }),
      '/api/memory': [
        memory({ id: 'M001', plan: 'P001', title: 'Why P001 shipped without an SVG graph' }),
        memory({ id: 'M002', story: 'P001-S01', body: 'A lesson that came out of this story.' }),
        memory({ id: 'M003', title: 'P001-S01, allegedly', body: 'About P001 in passing.' }),
        memory({ id: 'M004', run: '2026-07-28-001--P001-S01--build' }),
        memory({ id: 'M005', plan: 'P002', title: 'A different plan entirely' }),
      ],
    })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.findAll('#plan-memory-list .memory')).toHaveLength(2))
    expect(wrapper.findAll('.memory-id').map((n) => n.text())).toEqual(['M001', 'M002'])
    expect(wrapper.get('#plan-memory-empty').attributes('hidden')).toBeDefined()
  })

  it('shows the empty tells when nothing matches, and hides them when something does', async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }), '/api/runs': [], '/api/memory': [] })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.get('#plan-evidence-empty').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#plan-evidence-empty').text()).toBe(english['plans.evidence.empty'])
    expect(wrapper.get('#plan-memory-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#plan-memory-empty').text()).toBe(english['plans.memory.empty'])
  })

  describe('the plan gate', () => {
    it('approves a plan with no prior decision on record, and offers no undo — there is no legal write back to "undecided"', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', approval: null }) })
      const { PlansHost, socket } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', approval: null })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mount(PlansHost)
      await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())

      await wrapper.get('#approve-note').setValue('Looks solid')
      const buttons = wrapper.findAll('.approve button')
      await buttons[0]?.trigger('click')

      expect(socket.sent).toEqual([
        {
          type: 'write',
          id: expect.any(String),
          write: { kind: 'gate', plan: 'P001', from: null, to: 'approved', note: 'Looks solid' },
        },
      ])
      // The note is cleared after submission — a user action, not a render.
      expect((wrapper.get('#approve-note').element as HTMLInputElement).value).toBe('')

      // Settling the write with no `undo` announces the result with nothing
      // to press — `stores/session.ts`'s own `settle()`.
      socket.deliver({ type: 'receipt', id: socket.sent[0]?.id, ok: true, code: 'write.ok' })
      await nextTick()
      expect(wrapper.find('.toast').exists()).toBe(true)
      expect(wrapper.find('.toast .toast-action').exists()).toBe(false)
    })

    it('offers an undo when replacing a decision already on record, and the undo reverses it exactly', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', approval: { decision: 'changes_requested', by: 'Mohd', at: '2026-07-28T09:00:00.000Z', note: null } }) })
      const { PlansHost, socket } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', approval: 'changes_requested' })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mount(PlansHost)
      await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())

      const buttons = wrapper.findAll('.approve button')
      await buttons[0]?.trigger('click') // Approve

      expect(socket.sent).toEqual([
        {
          type: 'write',
          id: expect.any(String),
          write: { kind: 'gate', plan: 'P001', from: 'changes_requested', to: 'approved', note: null },
        },
      ])
      const firstId = socket.sent[0]?.id

      socket.deliver({ type: 'receipt', id: firstId, ok: true, code: 'write.ok' })
      await nextTick()
      const undo = wrapper.find('.toast .toast-action')
      expect(undo.exists()).toBe(true)

      await undo.trigger('click')
      expect(socket.sent).toEqual([
        expect.anything(),
        {
          type: 'write',
          id: expect.any(String),
          write: { kind: 'gate', plan: 'P001', from: 'approved', to: 'changes_requested', note: null },
        },
      ])
      // The action is spent: pressing it dismisses the toast rather than
      // leaving a control that would resend the same write again.
      expect(wrapper.find('.toast .toast-action').exists()).toBe(false)
    })

    it('refuses a stale decision silently at the wire, and announces nothing to undo', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', approval: null }) })
      const { PlansHost, socket } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', approval: null })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mount(PlansHost)
      await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())

      const buttons = wrapper.findAll('.approve button')
      await buttons[0]?.trigger('click')
      const id = socket.sent[0]?.id
      socket.deliver({ type: 'receipt', id, ok: false, code: 'write.stale.plan' })
      await nextTick()
      expect(wrapper.find('.toast .toast-action').exists()).toBe(false)
    })

    it('disables the button matching the decision already on record', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', approval: { decision: 'approved', by: 'Mohd', at: '2026-07-28T09:00:00.000Z', note: null } }) })
      const { Plans } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', approval: 'approved' })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mount(Plans)
      await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())

      const buttons = wrapper.findAll('.approve button')
      expect((buttons[0]?.element as HTMLButtonElement).disabled).toBe(true)
      expect((buttons[1]?.element as HTMLButtonElement).disabled).toBe(false)
      expect((buttons[2]?.element as HTMLButtonElement).disabled).toBe(false)
    })

    it('shows the whole approval record, and "nobody has decided" when there is none', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', approval: null }) })
      const { Plans } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', approval: null })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mount(Plans)
      await vi.waitFor(() => expect(wrapper.get('#plan-detail').attributes('hidden')).toBeUndefined())
      expect(wrapper.get('#plan-approval-record').text()).toBe(english['plans.noDecision'])
    })
  })

  it('starts a new plan through the same execution path as everything else — compose and enqueue', async () => {
    const { Plans, socket } = await boot(emptySnapshot())
    const wrapper = mount(Plans)
    await nextTick()

    await wrapper.get('#new-plan').setValue('Ship the widgets')
    await wrapper.get('form').trigger('submit')

    expect(socket.sent).toEqual([{ type: 'enqueue', command: '/mjloop:plan Ship the widgets', story: null }])
    expect((wrapper.get('#new-plan').element as HTMLInputElement).value).toBe('')
  })

  it('sends nothing for an empty idea', async () => {
    const { Plans, socket } = await boot(emptySnapshot())
    const wrapper = mount(Plans)
    await nextTick()
    await wrapper.get('form').trigger('submit')
    expect(socket.sent).toEqual([])
  })

  it('shows the empty tell when there are no plans at all', async () => {
    const { Plans } = await boot(emptySnapshot({ plans: [] }))
    const wrapper = mount(Plans)
    await nextTick()
    expect(wrapper.get('#plans-empty').text()).toBe(english['plans.empty'])
    expect(wrapper.get('#plans-tally-block').attributes('hidden')).toBeDefined()
  })

  it('draws the project-wide tally, agreeing with the readiness rule', async () => {
    const { Plans } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            stories: [
              storyFixture({ id: 'P001-S01', status: 'done' }),
              storyFixture({ id: 'P001-S02', status: 'doing' }),
              storyFixture({ id: 'P001-S03', status: 'blocked' }),
              storyFixture({ id: 'P001-S04' }),
            ],
          }),
        ],
      }),
    )
    const wrapper = mount(Plans)
    await nextTick()
    expect(wrapper.get('#tally-plans').text()).toBe('1')
    expect(wrapper.get('#tally-ready').text()).toBe('1')
    expect(wrapper.get('#tally-doing').text()).toBe('1')
    expect(wrapper.get('#tally-blocked').text()).toBe('1')
    expect(wrapper.get('#tally-done').text()).toBe('1')
  })

  it('caps the plan list and says how many are not shown', async () => {
    const many = Array.from({ length: 210 }, (_, index) => planFixture({ id: `P${String(index).padStart(3, '0')}` }))
    const { Plans } = await boot(emptySnapshot({ plans: many }))
    const wrapper = mount(Plans)
    await nextTick()
    expect(wrapper.findAll('#plans-list .plan')).toHaveLength(200)
    expect(wrapper.get('#plans-more').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#plans-more').text()).toBe('Showing 200 of 210 plans.')
  })
})

describe('structure (60-panels.css)', () => {
  it('carries class="panel" and aria-labelledby on the panel itself, never on a wrapper', async () => {
    const { Plans } = await boot(emptySnapshot({ plans: [planFixture({ id: 'P001' })] }))
    const wrapper = mount(Plans)
    await nextTick()

    const panel = wrapper.get('#panel-plans')
    expect(panel.classes()).toContain('panel')
    expect(panel.attributes('aria-labelledby')).toBe('panel-plans-title')
    expect(wrapper.get('#panel-plans-title').element.tagName).toBe('H1')
  })

  it('gives the aside its own grid track only through `.panel-side`', async () => {
    const { Plans } = await boot(emptySnapshot({ plans: [planFixture({ id: 'P001' })] }))
    const wrapper = mount(Plans)
    await nextTick()
    expect(wrapper.find('.panel-grid > .panel-side').exists()).toBe(true)
  })

  it('gives every plan row the ".plan" class and its progress bar the "progress"/"bar" structure the stylesheet keys on', async () => {
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01', status: 'done' })] })] }),
    )
    const wrapper = mount(Plans)
    await nextTick()

    const row = wrapper.get('#plans-list .plan')
    expect(row.find('.plan-head').exists()).toBe(true)
    expect(row.get('.progress').get('.bar').attributes('style')).toContain('100%')
    expect(row.find('.plan-title').exists()).toBe(true)
  })

  it('carries the state/approval family classes 60-panels.css keys colour on', async () => {
    const { Plans } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            approval: 'changes_requested',
            stories: [storyFixture({ id: 'P001-S01', status: 'doing' })],
          }),
        ],
      }),
    )
    const wrapper = mount(Plans)
    await nextTick()

    const row = wrapper.get('#plans-list .plan')
    expect(row.get('[data-slot="state"]').classes()).toEqual(expect.arrayContaining(['tag', 'planstate-doing']))
    expect(row.get('[data-slot="approval"]').classes()).toEqual(expect.arrayContaining(['tag', 'approval-changes_requested']))
  })

  it('marks Plan Evidence rows ".run" inside a ".runs" list, and Plan Memory rows ".memory" inside a ".memories" list', async () => {
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [{ id: 'P001-S01' }] }),
      '/api/runs': [{ id: 'r1--P001-S01--build', story: 'P001-S01', track: 'build', cycles: 1, halted: false }],
      '/api/memory': [{ id: 'M1', kind: 'decision', title: 't', tags: [], at: '2026-07-28T09:00:00.000Z', run: null, plan: 'P001', story: null, body: 'b' }],
    })
    const { Plans } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mount(Plans)
    await vi.waitFor(() => expect(wrapper.find('#plan-evidence-list .run').exists()).toBe(true))

    expect(wrapper.get('#plan-evidence-list').classes()).toContain('runs')
    expect(wrapper.get('#plan-memory-list').classes()).toContain('memories')
    expect(wrapper.find('#plan-memory-list .memory').exists()).toBe(true)
  })
})
