// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import Rail from '../../src/web/app/components/Rail.vue'
import Banners from '../../src/web/app/components/Banners.vue'
import { emptySnapshot, readLocale } from './helpers/page.js'

const english = await readLocale('en')

beforeEach(() => {
  installForTest({ code: 'en', strings: english })
})

describe('Rail', () => {
  it('shows the run detail only once the run is running, not merely once run_id is set', () => {
    // `rail.js:36-37` — the gate on the whole detail block is `status`, not
    // `run_id`. Idle stays idle even with everything else defaulted.
    const idle = mount(Rail, { props: { snapshot: emptySnapshot({ state: { ...emptySnapshot().state, run_id: null } }) } })
    expect(idle.find('.rail-detail').exists()).toBe(false)

    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: 'run-1', track: 'build', cycle: 2 }
    const live = mount(Rail, { props: { snapshot: running } })
    expect(live.find('.rail-detail').exists()).toBe(true)
    expect(live.text()).toContain('build')
  })

  it('renders the run id verbatim, never through Intl', () => {
    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: '20260803-1' }
    const live = mount(Rail, { props: { snapshot: running } })
    // An id inside a translated sentence must be a <bdi dir=ltr>, or Arabic
    // renders it with Arabic-Indic digits and reorders the hyphen. Selected by
    // the run bit specifically — `index.html`'s own layout order (track,
    // cycle, stage, target, run, findings, strikes, gate) puts other `<bdi>`s
    // ahead of it, so "the first bdi in the DOM" is not this element.
    expect(live.find('[data-rail="run"] bdi').text()).toContain('20260803-1')
  })

  it('shows the strike counter only while a run is running, and only once strikes have been taken', () => {
    // `rail.js:84-90` — the strike bit lives inside the same `running`-gated
    // detail block as everything else; it is not a standalone indicator.
    const clean = mount(Rail, {
      props: {
        snapshot: emptySnapshot({
          state: { ...emptySnapshot().state, status: 'running', run_id: 'run-1' },
          guards: { strikes: 0, strikesAllowed: 3, cycleErrors: [], errorArmed: null },
        }),
      },
    })
    expect(clean.find('[data-test="strikes"]').exists()).toBe(false)

    const struck = mount(Rail, {
      props: {
        snapshot: emptySnapshot({
          state: { ...emptySnapshot().state, status: 'running', run_id: 'run-1' },
          guards: { strikes: 2, strikesAllowed: 3, cycleErrors: [], errorArmed: null },
        }),
      },
    })
    expect(struck.find('[data-test="strikes"]').text()).toContain('2')
  })

  it('carries a data-status attribute the status colour and pulse key off, not a class', () => {
    // `20-rail.css:221,239,246` selects `.pill[data-status="…"]`.
    const wrapper = mount(Rail, { props: { snapshot: emptySnapshot({ state: { ...emptySnapshot().state, status: 'running' } }) } })
    expect(wrapper.find('.pill').attributes('data-status')).toBe('running')
  })

  it('still renders .rail and the notice toggle with no snapshot at all — the same failure mode as the offline banner, one component over', () => {
    // `index.html:47-96` / `ui/rail.js`: `.rail`'s static markup, its pill,
    // and the notice toggle inside it exist at boot, before any snapshot has
    // arrived — `drawRail()` only ever fills in values once one is in hand.
    // Gating the whole `<Rail>` behind `snapshot !== null` (as `App.vue` used
    // to) meant a dead server or a bad token at load left the reader with no
    // rail and no way to open their notice history — finding 5's fix
    // introduced this by moving the notice toggle inside that gate.
    const wrapper = mount(Rail, { props: { snapshot: null } })
    expect(wrapper.find('.rail').exists()).toBe(true)
    const toggle = wrapper.find('#notice-toggle')
    expect(toggle.exists()).toBe(true)
    expect(toggle.element.closest('.rail')).not.toBeNull()

    // The pill exists but carries no status yet, and the detail block — which
    // needs a running snapshot — is absent.
    expect(wrapper.find('.pill').exists()).toBe(true)
    expect(wrapper.find('.pill').attributes('data-status')).toBeUndefined()
    expect(wrapper.find('.rail-detail').exists()).toBe(false)
  })
})

describe('Banners', () => {
  it('says the page is offline when the socket is down', () => {
    const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: false } })
    expect(wrapper.find('.banner.offline').exists()).toBe(true)
  })

  it('says nothing when everything is fine', () => {
    const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: true } })
    expect(wrapper.findAll('.banner')).toHaveLength(0)
  })

  it('shows the config error as a total outage, above the other banners, and names the file\'s own problem', () => {
    // Moved here from `ui/rail.js`'s `configBanner` slot, deferred by the
    // foundation plan and picked up by the Config panel task — see
    // `Banners.vue`'s own comment. `state.config_error` is a parse failure or
    // a write door the engine cannot reach; the string itself is an
    // identifier (a path or an error message) and must not be mirrored.
    const snap = emptySnapshot()
    snap.state = { ...snap.state, config_error: 'config.yaml:12: unknown key "trak"' }
    const wrapper = mount(Banners, { props: { snapshot: snap, online: true } })
    const banner = wrapper.find('.banner.error')
    expect(banner.exists()).toBe(true)
    expect(banner.find('code bdi').text()).toBe('config.yaml:12: unknown key "trak"')
    expect(banner.find('code bdi').attributes('dir')).toBe('ltr')
  })

  it('says nothing about config once the error clears', () => {
    const snap = emptySnapshot()
    snap.state = { ...snap.state, config_error: null }
    const wrapper = mount(Banners, { props: { snapshot: snap, online: true } })
    expect(wrapper.find('.banner.error').exists()).toBe(false)
  })

  it('warns when the project has no design system', () => {
    const snap = emptySnapshot()
    snap.state = { ...snap.state, design_system: false }
    const wrapper = mount(Banners, { props: { snapshot: snap, online: true } })
    expect(wrapper.find('.banner.note').exists()).toBe(true)
  })

  it('does not warn about a missing design system before the project has even initialised', () => {
    const snap = emptySnapshot()
    snap.state = { ...snap.state, initialised: false, design_system: false }
    const wrapper = mount(Banners, { props: { snapshot: snap, online: true } })
    expect(wrapper.find('.banner.note').exists()).toBe(false)
  })

  it('still shows the offline banner with no snapshot at all — the server down, a bad token, or a refused upgrade at load', () => {
    // `App.vue` used to gate the whole `<Banners>` component behind
    // `v-if="snapshot !== null"`, so this is exactly the state that made the
    // banner unreachable: no snapshot ever arrived, and the reader was left
    // looking at a bare header forever. `app.js:273`'s `onStatus` drives this
    // banner off socket status alone, independent of any snapshot.
    const wrapper = mount(Banners, { props: { snapshot: null, online: false } })
    expect(wrapper.find('.banner.offline').exists()).toBe(true)
  })

  it('shows nothing else with no snapshot, since stale and design-system both need one', () => {
    const wrapper = mount(Banners, { props: { snapshot: null, online: true } })
    expect(wrapper.findAll('.banner')).toHaveLength(0)
  })
})

describe('App', () => {
  beforeEach(() => {
    // App.vue now mounts Terminal, which touches the xterm globals `vendor/`
    // installs on `window` in production — this test's ReferenceError without
    // them is the same seam `terminal.test.ts` fills with a recording double.
    ;(globalThis as any).Terminal = class {
      cols = 80
      rows = 24
      loadAddon() {}
      open() {}
      onData() {}
      write() {}
      reset() {}
    }
    ;(globalThis as any).FitAddon = { FitAddon: class { fit() {} } }
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    // App.vue now mounts `Run.vue` too, whose feeds issue real conditional
    // GETs (`panel-run.test.ts`'s own `beforeEach` stubs this the same way).
    // There is no server here; a real request would only leave every test in
    // this block hitting `localhost:3000` for nothing.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
  })

  it('marks the pill, every tab anchor, and the nav counts with the hooks the shipped CSS keys off', async () => {
    // A fresh module graph, the same technique `store.test.ts` uses: the
    // store is a module-level singleton, so a snapshot has to be delivered to
    // *this* instance before `App.vue` (which imports the same singleton) is
    // mounted. Nothing here is visible to a unit test through markup alone —
    // that is exactly the class of bug this fix round found: `class`
    // vs. `data-status`, `badge` vs. `nav-count`, and a missing `id` are all
    // invisible to `.text()` assertions and only break the shipped CSS.
    vi.resetModules()
    const freshI18n = await import('../../src/web/app/lib/i18n.ts')
    freshI18n.installForTest({ code: 'en', strings: english })
    const store = await import('../../src/web/app/stores/session.ts')
    const { default: App } = await import('../../src/web/app/App.vue')

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
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })

    const snap = emptySnapshot()
    snap.state = { ...snap.state, status: 'running', findings: { high: 2, medium: 0, low: 0 } }
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: snap })

    const wrapper = mount(App)

    expect(wrapper.find('.pill').attributes('data-status')).toBe('running')

    for (const id of ['run', 'plans', 'stories', 'features', 'skills', 'evidence', 'memory', 'config']) {
      expect(wrapper.find(`#tab-${id}`).exists()).toBe(true)
    }

    const highBadge = wrapper.find('#tab-run .nav-count')
    expect(highBadge.exists()).toBe(true)
    expect(highBadge.classes()).toContain('warnish')
  })

  it('puts the notice toggle inside .rail, not .brand — `index.html:69-96`\'s position', async () => {
    // Finding 5: `LanguagePicker`'s `margin-inline-start: auto` pushes
    // anything after it in `.brand` to the far right, so a `.brand`-hosted
    // toggle visibly sits on a different row than the shipped page. This is
    // the structural assertion no `.text()` check could have caught.
    vi.resetModules()
    const freshI18n = await import('../../src/web/app/lib/i18n.ts')
    freshI18n.installForTest({ code: 'en', strings: english })
    const store = await import('../../src/web/app/stores/session.ts')
    const { default: App } = await import('../../src/web/app/App.vue')

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
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot() })

    const wrapper = mount(App)
    expect(wrapper.find('.rail #notice-toggle').exists()).toBe(true)
    expect(wrapper.find('.brand #notice-toggle').exists()).toBe(false)
  })

  it('keeps the halt dialog usable across a tab switch — it is a sibling of <main>, never inside the panels\' <KeepAlive>', async () => {
    // The regression this guards: `HaltDialog` used to live inside `Run.vue`,
    // itself inside `<KeepAlive>`. Opening it, switching tabs and coming back
    // detached the native `<dialog>` from the document mid-modal — it lost its
    // top-layer state, `haltOpen` stayed `true`, and nothing re-fired the
    // watcher that calls `showModal()` again. Halt was dead until reload.
    vi.resetModules()
    const freshI18n = await import('../../src/web/app/lib/i18n.ts')
    freshI18n.installForTest({ code: 'en', strings: english })
    const store = await import('../../src/web/app/stores/session.ts')
    const { default: App } = await import('../../src/web/app/App.vue')

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
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: '20260803-1' }
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: running })

    const wrapper = mount(App, { attachTo: document.body })

    await wrapper.get('.rail button.danger').trigger('click')
    const dialog = document.getElementById('halt-dialog') as HTMLDialogElement
    expect(dialog.open).toBe(true)
    expect(wrapper.find('#panel-run').exists()).toBe(true)

    // Away and back — the panel deactivates (KeepAlive, not destroyed) while
    // the dialog, outside it, is never touched.
    location.hash = '#plans'
    window.dispatchEvent(new Event('hashchange'))
    await nextTick()
    expect(wrapper.find('#panel-run').exists()).toBe(false)
    expect(dialog.open).toBe(true)
    // The load-bearing assertion: happy-dom does not model the `<dialog>` top
    // layer, so `dialog.open` alone stays `true` even if the element itself
    // is detached — `.exists()` above only proves `Run.vue` left the DOM, not
    // that the dialog was never inside it. `isConnected` catches what those
    // two together do not: it is `false` the instant `HaltDialog` moves back
    // under a `v-if`'d panel, because `<KeepAlive>` detaches that panel's
    // whole subtree, dialog included, on the very switch this test makes.
    expect(dialog.isConnected).toBe(true)
    expect(document.querySelector('#panel-run #halt-dialog')).toBeNull()

    location.hash = '#run'
    window.dispatchEvent(new Event('hashchange'))
    await nextTick()
    expect(wrapper.find('#panel-run').exists()).toBe(true)
    expect(dialog.open).toBe(true)

    // Still live: a reason submitted now still reaches the write door.
    await wrapper.get('#halt-reason').setValue('checking it survives a tab switch')
    await wrapper.get('#halt-form').trigger('submit')
    await nextTick()
    expect((FakeSocket.last as FakeSocket).sent).toEqual([
      { type: 'write', id: expect.any(String), write: { kind: 'halt', run: '20260803-1', reason: 'checking it survives a tab switch' } },
    ])
    wrapper.unmount()
  })

  it('reopens the plan the reader left open, on a mount that reproduces production import order — the module graph loaded, then storage installed', async () => {
    // Fix round 2 of the Plans panel: `main.ts`'s very first statement,
    // `import App from './App.vue'`, pulls `useSelection.ts` in through
    // App's own import graph — and ES module imports are evaluated before
    // the importing module's own body runs, so that whole graph loads
    // *before* `main.ts` reaches `installStorage(localStorage)`. A test that
    // installs storage before importing `App.vue` (as every other test in
    // this file does, for unrelated reasons) cannot see that ordering bug —
    // it is the exact inverse of production. This one imports `App.vue`
    // first and installs storage after, the only sequence that actually
    // exercises it, and would fail if `useSelection.ts`'s ref were seeded at
    // module scope again.
    vi.resetModules()
    const freshI18n = await import('../../src/web/app/lib/i18n.ts')
    freshI18n.installForTest({ code: 'en', strings: english })
    const store = await import('../../src/web/app/stores/session.ts')
    const { default: App } = await import('../../src/web/app/App.vue')
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({
      getItem: (key) => (key === 'mjloop.prefs' ? JSON.stringify({ activePlan: 'P001' }) : null),
      setItem: () => {},
    })

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
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })

    vi.stubGlobal('fetch', (url: string) => {
      const body =
        url.split('?')[0] === '/api/plans/P001'
          ? { id: 'P001', title: 'Left open before reload', approval: null, body: '', review: null, stories: [] }
          : null
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })

    const snap = emptySnapshot({
      plans: [{ id: 'P001', title: 'Left open before reload', approval: null, stories: [] }],
    })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: snap })

    const wrapper = mount(App)
    location.hash = '#plans'
    window.dispatchEvent(new Event('hashchange'))
    await vi.waitFor(() => expect(wrapper.find('#plan-detail').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#plan-detail-title').text()).toContain('Left open before reload')
    wrapper.unmount()
  })
})

describe('NoticeFeed', () => {
  // `notifications.js:130-131`: the badge counts *unread* notices and resets
  // to zero when the panel is opened — not the total feed length forever.
  async function freshWithNotices(...messages: { type: 'notice'; message: { code: string } }[]) {
    vi.resetModules()
    const freshI18n = await import('../../src/web/app/lib/i18n.ts')
    freshI18n.installForTest({ code: 'en', strings: english })
    const store = await import('../../src/web/app/stores/session.ts')
    const { default: NoticeFeed } = await import('../../src/web/app/components/NoticeFeed.vue')

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
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })

    const wrapper = mount(NoticeFeed)
    for (const message of messages) FakeSocket.last?.deliver(message)
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('badges the unread count, in digits routed through t(), not the raw feed length', async () => {
    const wrapper = await freshWithNotices(
      { type: 'notice', message: { code: 'write.ok.halt' } },
      { type: 'notice', message: { code: 'write.ok.halt' } },
    )
    const badge = wrapper.find('.nav-count')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('2')
  })

  it('resets the unread count to zero when the panel is opened', async () => {
    const wrapper = await freshWithNotices(
      { type: 'notice', message: { code: 'write.ok.halt' } },
      { type: 'notice', message: { code: 'write.ok.halt' } },
    )
    await wrapper.get('#notice-toggle').trigger('click')
    expect(wrapper.find('.nav-count').exists()).toBe(false)

    // The full feed is still there — only the unread count reset, not the log.
    expect(wrapper.findAll('.notice-row')).toHaveLength(2)
  })

  it('sets the toggle\'s title from the notice.unreadCount plural, keyed the same as tabs.readyCount and tabs.highCount', async () => {
    const wrapper = await freshWithNotices({ type: 'notice', message: { code: 'write.ok.halt' } })
    expect(wrapper.get('#notice-toggle').attributes('title')).toBe(english['notice.unreadCount.one'].replace('{count}', '1'))
  })
})
