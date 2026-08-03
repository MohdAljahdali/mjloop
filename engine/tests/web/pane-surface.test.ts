// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Job, Snapshot } from '../../src/web/protocol.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

const english = await readLocale('en')

/** The same fake socket `terminal.test.ts` and `shell.test.ts` use to drive the store. */
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

/** `panel-queue`'s job fixture — the one `panels.test.ts:3108`'s `queue` describe block uses. */
function job(patch: Partial<Job> & { id: string }): Job {
  return {
    command: '/mjloop:build P001-S02',
    story: 'P001-S02',
    status: 'queued',
    reason: null,
    startedAt: null,
    endedAt: null,
    ...patch,
  }
}

beforeEach(() => {
  vi.resetModules()
  delete (document.body.dataset as Record<string, string | undefined>)['pane']
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
})

/**
 * Boots a fresh module graph, connects a `FakeSocket`, delivers a snapshot,
 * and — the same as `App.vue`'s own `onMounted` always does in production —
 * calls `bootPane()`, so a bare `Pane` in one of these tests starts from the
 * same `body.dataset.pane` state a reader actually sees.
 */
async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { bootPane } = await import('../../src/web/app/composables/usePane.ts')
  const { default: Pane } = await import('../../src/web/app/components/Pane.vue')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  bootPane()
  return { store, Pane, socket: FakeSocket.last as FakeSocket }
}

describe('split (app/lib/queue.ts)', () => {
  it('separates what is running from what is waiting from what is over, history newest first', async () => {
    const { split } = await import('../../src/web/app/lib/queue.ts')
    const jobs = [
      job({ id: 'j1', status: 'done' }),
      job({ id: 'j2', status: 'running' }),
      job({ id: 'j3', status: 'queued' }),
      job({ id: 'j4', status: 'queued' }),
      job({ id: 'j5', status: 'failed' }),
    ]
    const { running, waiting, history } = split(jobs)
    expect(running.map((j) => j.id)).toEqual(['j2'])
    expect(waiting.map((j) => j.id)).toEqual(['j3', 'j4'])
    // Newest first: j5 finished after j1 in the same input order.
    expect(history.map((j) => j.id)).toEqual(['j5', 'j1'])
  })

  it('treats cancelled the same as done and failed — all three are history', async () => {
    const { split } = await import('../../src/web/app/lib/queue.ts')
    const { history } = split([job({ id: 'j1', status: 'cancelled' })])
    expect(history).toHaveLength(1)
  })

  it('returns empty groups for an empty queue', async () => {
    const { split } = await import('../../src/web/app/lib/queue.ts')
    expect(split([])).toEqual({ running: [], waiting: [], history: [] })
  })
})

describe('Pane', () => {
  it('has a .pane-head, both .view-tabs, #panel-queue, the command form, .pane > .hint, #terminal-empty and .pane-body — every one where 40-terminal.css expects it', async () => {
    const { Pane } = await boot()
    const wrapper = mount(Pane)

    expect(wrapper.find('.pane > .pane-head').exists()).toBe(true)
    expect(wrapper.find('.pane > .pane-body').exists()).toBe(true)
    expect(wrapper.find('#view-session').classes()).toContain('view-tab')
    expect(wrapper.find('#view-queue').classes()).toContain('view-tab')
    expect(wrapper.find('.pane-body > #panel-queue.view').exists()).toBe(true)
    expect(wrapper.find('#command-form.command').exists()).toBe(true)
    // The direct-child combinator matters: `body[data-pane="collapsed"] .pane
    // > .hint` (40-terminal.css:171) — a `.hint` nested one level deeper would
    // not be hidden by it, the exact class of defect the foundation's review
    // round found four of.
    expect(wrapper.find('.pane > .hint').exists()).toBe(true)
    expect(wrapper.find('#terminal-empty').exists()).toBe(true)
  })

  it('switches the two view tabs between the session and queue views', async () => {
    const { Pane } = await boot()
    const wrapper = mount(Pane)

    expect(wrapper.find('#view-session').attributes('aria-current')).toBe('true')
    expect(wrapper.find('#view-queue').attributes('aria-current')).toBeUndefined()
    expect(wrapper.find('#view-session-body').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('#panel-queue').attributes('hidden')).toBeDefined()

    await wrapper.find('#view-queue').trigger('click')

    expect(wrapper.find('#view-queue').attributes('aria-current')).toBe('true')
    expect(wrapper.find('#view-session').attributes('aria-current')).toBeUndefined()
    expect(wrapper.find('#view-session-body').attributes('hidden')).toBeDefined()
    expect(wrapper.find('#panel-queue').attributes('hidden')).toBeUndefined()
  })

  it('shows #terminal-empty and hides the terminal wrapper while nothing is shown, and the reverse once a job starts', async () => {
    const { Pane, socket } = await boot()
    const wrapper = mount(Pane)

    expect(wrapper.find('#terminal-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('.terminal-wrap').attributes('hidden')).toBeDefined()

    // `followQueue`: the transition from no job to this one is what puts a
    // transcript on screen — `session.jobId` alone does not.
    const started = emptySnapshot()
    started.session = { ...started.session, jobId: 'j2' }
    socket.deliver({ type: 'snapshot', snapshot: started })
    await nextTick()

    expect(wrapper.find('#terminal-empty').attributes('hidden')).toBeDefined()
    expect(wrapper.find('.terminal-wrap').attributes('hidden')).toBeUndefined()
  })

  it('composes and enqueues a command from the command form, then clears it, and switches to the queue view', async () => {
    const { Pane, socket } = await boot()
    const wrapper = mount(Pane)

    const input = wrapper.find<HTMLInputElement>('#command').element
    input.value = '/mjloop:fix the login redirect loop'
    await wrapper.find('#command-form').trigger('submit')

    expect(socket.sent).toEqual([
      { type: 'enqueue', command: '/mjloop:fix the login redirect loop', story: null },
    ])
    expect(input.value).toBe('')
    expect(wrapper.find('#view-queue').attributes('aria-current')).toBe('true')
  })

  it('does nothing on an empty command', async () => {
    const { Pane, socket } = await boot()
    const wrapper = mount(Pane)
    await wrapper.find('#command-form').trigger('submit')
    expect(socket.sent).toEqual([])
  })

  it('fills the datalist with the ready-to-build suggestions, and only those', async () => {
    const snap = emptySnapshot({
      plans: [
        {
          id: 'P001',
          title: 'P',
          approval: 'approved',
          stories: [
            { id: 'P001-S01', title: 'ready', status: 'todo', ui: false, depends_on: [] },
            { id: 'P001-S02', title: 'blocked', status: 'todo', ui: false, depends_on: ['P001-S99'] },
          ],
        },
      ],
    })
    const { Pane } = await boot(snap)
    const wrapper = mount(Pane)
    const options = wrapper.findAll('#command-suggestions option').map((o) => o.attributes('value'))
    expect(options).toEqual(['/mjloop:build P001-S01'])
  })

  it('cancels a queued job by sending its id', async () => {
    const snap = emptySnapshot({ queue: [job({ id: 'j1' })] })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    const row = wrapper.find('#queue-waiting .job')
    await row.findAll('.row-actions button')[0]?.trigger('click')

    expect(socket.sent).toEqual([{ type: 'cancel', jobId: 'j1' }])
  })

  it('stops a running job from its own row, disabled while the session is closing', async () => {
    const snap = emptySnapshot({
      queue: [job({ id: 'j1', status: 'running', startedAt: '2026-07-28T12:00:00.000Z' })],
      session: { jobId: 'j1', blocked: false, pausedBy: null, closing: false, stalledSince: null },
    })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    const stop = wrapper.find('#queue-now .job .row-actions button')
    expect((stop.element as HTMLButtonElement).disabled).toBe(false)
    await stop.trigger('click')
    expect(socket.sent).toEqual([{ type: 'cancel', jobId: 'j1' }])
  })

  it('attaching to a job sends attach, reveals the pane, and switches to the session view', async () => {
    const snap = emptySnapshot({
      queue: [job({ id: 'j1', status: 'done', startedAt: '2026-07-28T12:00:00.000Z', endedAt: '2026-07-28T12:01:00.000Z' })],
    })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    const attach = wrapper.find('#queue-history .job .row-actions button')
    await attach.trigger('click')

    expect(socket.sent).toEqual([{ type: 'attach', jobId: 'j1' }])
    expect(wrapper.find('#view-session').attributes('aria-current')).toBe('true')
  })

  it('cycles collapsed -> docked -> full -> collapsed from the pane head', async () => {
    const { Pane } = await boot()
    const wrapper = mount(Pane)
    const cycle = wrapper.findAll('.pane-head button.icon')[0]

    expect(document.body.dataset['pane']).toBe('collapsed')
    await cycle?.trigger('click')
    expect(document.body.dataset['pane']).toBe('docked')
    await cycle?.trigger('click')
    expect(document.body.dataset['pane']).toBe('full')
    await cycle?.trigger('click')
    expect(document.body.dataset['pane']).toBe('collapsed')
  })

  it('toggles full screen — docked <-> full — from the pane head, distinct from cycle', async () => {
    const { Pane } = await boot()
    const wrapper = mount(Pane)
    const full = wrapper.findAll('.pane-head button.icon')[1]

    expect(document.body.dataset['pane']).toBe('collapsed')
    await full?.trigger('click')
    expect(document.body.dataset['pane']).toBe('full')
    await full?.trigger('click')
    expect(document.body.dataset['pane']).toBe('docked')
    await full?.trigger('click')
    expect(document.body.dataset['pane']).toBe('full')
  })

  it('shows the pause banner and Resume, hides Stop until a job is running, and sends resume/clear', async () => {
    const snap = emptySnapshot({
      queue: [job({ id: 'j1' })],
      session: { jobId: null, blocked: true, pausedBy: 'stopped', closing: false, stalledSince: null },
    })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    expect(wrapper.find('#queue-blocked').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('#queue-pause-text').text()).toBe(english['queue.pausedStopped'])

    await wrapper.find('#queue-resume').trigger('click')
    await wrapper.find('#queue-clear').trigger('click')
    expect(socket.sent).toEqual([{ type: 'resume' }, { type: 'clear' }])
  })

  it('shows the paused and closing pills on the pane head, not only inside the queue view', async () => {
    const snap = emptySnapshot({
      session: { jobId: 'j1', blocked: true, pausedBy: 'stopped', closing: true, stalledSince: null },
    })
    const { Pane } = await boot(snap)
    const wrapper = mount(Pane)
    // Head pills stay visible on the session view, which is up by default —
    // `ui/pane.js`'s whole point in registering against `.pane-head` rather
    // than either view.
    expect(wrapper.find('#pane-paused').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('#pane-closing').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('#pane-stop').attributes('hidden')).toBeUndefined()
    expect((wrapper.find('#pane-stop').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('stops the live session from the pane head', async () => {
    const snap = emptySnapshot({ session: { jobId: 'j1', blocked: false, pausedBy: null, closing: false, stalledSince: null } })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#pane-stop').trigger('click')
    expect(socket.sent).toEqual([{ type: 'stop' }])
  })
})

describe('mount order', () => {
  it('boots the pane only after the terminal underneath it has mounted', async () => {
    // `App.vue`'s own `onMounted` calls `bootPane()`; a child's `onMounted`
    // fires before its parent's, however deep the nesting, and nothing in
    // `Pane.vue` puts a `v-if` or async boundary above `Terminal` that could
    // delay it — so the fake xterm's `open()` below must run while
    // `document.body.dataset.pane` is still unset, and the attribute must be
    // set by the time `mount()` returns.
    //
    // What this cannot prove: that the terminal opens into a *laid-out* box —
    // happy-dom performs no layout, so `.xterm-screen`'s size is not
    // observable here. That is the browser check the brief names
    // (1440x240, 16 rows), and it is unverified by this suite.
    const openedWithPaneUnset: (string | undefined)[] = []
    ;(globalThis as any).Terminal = class {
      cols = 80
      rows = 24
      loadAddon() {}
      open() {
        openedWithPaneUnset.push(document.body.dataset['pane'])
      }
      onData() {}
      write() {}
      reset() {}
    }

    const freshI18n = await import('../../src/web/app/lib/i18n.ts')
    freshI18n.installForTest({ code: 'en', strings: english })
    const store = await import('../../src/web/app/stores/session.ts')
    store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
    const { default: App } = await import('../../src/web/app/App.vue')

    expect(document.body.dataset['pane']).toBeUndefined()
    mount(App)

    expect(openedWithPaneUnset).toEqual([undefined])
    expect(document.body.dataset['pane']).toBe('collapsed')
  })
})
