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

  it('shows #terminal-empty and hides .terminal while nothing is shown, and the reverse once a job starts', async () => {
    const { Pane, socket } = await boot()
    const wrapper = mount(Pane)

    expect(wrapper.find('#terminal-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('.terminal').attributes('hidden')).toBeDefined()

    // `followQueue`: the transition from no job to this one is what puts a
    // transcript on screen — `session.jobId` alone does not.
    const started = emptySnapshot()
    started.session = { ...started.session, jobId: 'j2' }
    socket.deliver({ type: 'snapshot', snapshot: started })
    await nextTick()

    expect(wrapper.find('#terminal-empty').attributes('hidden')).toBeDefined()
    expect(wrapper.find('.terminal').attributes('hidden')).toBeUndefined()
  })

  it('re-fits the terminal once it stops being hidden, rather than trusting a browser to notice on its own', async () => {
    // The terminal boots hidden (`shown === null`), so `onMounted` opens
    // xterm against a `display: none` box and it caches zero-size metrics.
    // A `ResizeObserver` repairs this eventually in a real browser, but that
    // is a browser behaviour no test can see; `Terminal.vue` instead watches
    // `shown` (`flush: 'post'`) and calls `fit()` explicitly once it is no
    // longer `null` — assert `fit()` actually runs, and that `.terminal` has
    // already lost its `hidden` attribute by the time it does.
    const hiddenAtFit: boolean[] = []
    ;(globalThis as any).FitAddon = {
      FitAddon: class {
        fit() {
          hiddenAtFit.push(document.querySelector('.terminal')?.hasAttribute('hidden') ?? true)
        }
      },
    }
    const { Pane, socket } = await boot()
    // `attachTo`: `document.querySelector` inside the fake `fit()` above only
    // sees `.terminal` if the wrapper is actually in `document` — `mount()`
    // otherwise renders into a detached node.
    const wrapper = mount(Pane, { attachTo: document.body })
    const callsAtMount = hiddenAtFit.length

    const started = emptySnapshot()
    started.session = { ...started.session, jobId: 'j2' }
    socket.deliver({ type: 'snapshot', snapshot: started })
    await nextTick()

    expect(hiddenAtFit.length).toBeGreaterThan(callsAtMount)
    expect(hiddenAtFit.at(-1)).toBe(false)
    wrapper.unmount()
  })

  it('keeps the same Terminal instance — same xterm, same scrollback — across a view switch', async () => {
    // `Terminal.vue` must not be remounted by a view switch: its scrollback,
    // selection and pty geometry are the one thing the server cannot replay.
    // `open()` is called once, in `onMounted`; if `Pane.vue` ever put a
    // `v-if` or a `:key` above `Terminal`, switching views would tear it down
    // and rebuild it, and this count would go to 2.
    let opens = 0
    ;(globalThis as any).Terminal = class {
      cols = 80
      rows = 24
      loadAddon() {}
      open() {
        opens += 1
      }
      onData() {}
      write() {}
      reset() {}
    }
    const { Pane } = await boot()
    const wrapper = mount(Pane)
    expect(opens).toBe(1)

    await wrapper.find('#view-queue').trigger('click')
    await wrapper.find('#view-session').trigger('click')

    expect(opens).toBe(1)
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

  it('draws a job duration and its reason', async () => {
    const snap = emptySnapshot({
      queue: [
        job({
          id: 'j1',
          status: 'failed',
          reason: { code: 'job.failed.exit', params: { code: 1 } },
          startedAt: '2026-07-28T12:00:00.000Z',
          endedAt: '2026-07-28T12:03:12.000Z',
        }),
      ],
    })
    const { Pane } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    const row = wrapper.find('#queue-history .job')
    expect(row.find('.dur').text()).toBe('3m 12s')
    expect(row.find('.reason').text()).toContain('code 1')
    expect(row.find('.st').classes()).toContain('job-failed')
  })

  it('says a job is closing rather than leaving it as running under a dead button', async () => {
    const snap = emptySnapshot({
      queue: [job({ id: 'j1', status: 'running', startedAt: '2026-07-28T12:00:00.000Z' })],
      session: { jobId: 'j1', blocked: true, pausedBy: 'stopped', closing: true, stalledSince: null },
    })
    const { Pane } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    const row = wrapper.find('#queue-now .job')
    expect(row.find('.st').text()).toBe(english['queue.closing'])
    expect(row.find('.st').classes()).toContain('job-closing')
    expect((row.find('.row-actions button').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders per-group controls that never overlap, and positions the waiting rows in run order', async () => {
    // `panels.test.ts:3142-3172`, carried across. The running row stops a
    // session (and can still open its own live transcript); a waiting row
    // only drops a command; a history row only opens a transcript. Stop and
    // Cancel used to share one `×` — the bug this exclusivity check exists
    // to keep fixed.
    const snap = emptySnapshot({
      queue: [
        job({ id: 'j1', status: 'done', startedAt: '2026-07-28T12:00:00.000Z', endedAt: '2026-07-28T12:01:00.000Z' }),
        job({ id: 'j2', status: 'running', startedAt: '2026-07-28T12:01:00.000Z' }),
        job({ id: 'j3', command: '/mjloop:fix a' }),
        job({ id: 'j4', command: '/mjloop:fix b' }),
      ],
      session: { jobId: 'j2', blocked: false, pausedBy: null, closing: false, stalledSince: null },
    })
    const { Pane } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    expect(wrapper.findAll('#queue-now .job')).toHaveLength(1)
    expect(wrapper.findAll('#queue-waiting .job')).toHaveLength(2)
    expect(wrapper.findAll('#queue-history .job')).toHaveLength(1)

    // Its place in the run order, so "mine is second" needs no counting.
    expect(wrapper.findAll('#queue-waiting .job .pos').map((node) => node.text())).toEqual(['1', '2'])

    const running = wrapper.find('#queue-now .job')
    expect(running.findAll('.row-actions button').map((b) => b.text())).toEqual([english['job.stop'], english['job.view']])

    const waiting = wrapper.find('#queue-waiting .job')
    expect(waiting.findAll('.row-actions button').map((b) => b.text())).toEqual([english['job.remove']])

    const history = wrapper.find('#queue-history .job')
    expect(history.findAll('.row-actions button').map((b) => b.text())).toEqual([english['job.view']])
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

  it('stops a running job from its own row, enabled while the session is not closing', async () => {
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

  it('attaching to a job sends attach, reveals a collapsed pane, and switches to the session view', async () => {
    const snap = emptySnapshot({
      queue: [job({ id: 'j1', status: 'done', startedAt: '2026-07-28T12:00:00.000Z', endedAt: '2026-07-28T12:01:00.000Z' })],
    })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')
    // `bootPane()` in `boot()` starts the pane collapsed, same as production.
    expect(document.body.dataset['pane']).toBe('collapsed')

    const attach = wrapper.find('#queue-history .job .row-actions button')
    await attach.trigger('click')

    expect(socket.sent).toEqual([{ type: 'attach', jobId: 'j1' }])
    expect(wrapper.find('#view-session').attributes('aria-current')).toBe('true')
    // `reveal()`'s own effect — the only part of this behaviour that can break.
    expect(document.body.dataset['pane']).toBe('docked')
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

  it('shows the pause banner and Resume, with the cause-specific sentence for a stop and for a failure, and sends resume/clear', async () => {
    const snap = emptySnapshot({
      queue: [job({ id: 'j1' })],
      session: { jobId: null, blocked: true, pausedBy: 'stopped', closing: false, stalledSince: null },
    })
    const { Pane, socket } = await boot(snap)
    const wrapper = mount(Pane)
    await wrapper.find('#view-queue').trigger('click')

    expect(wrapper.find('#queue-blocked').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('#queue-pause-text').text()).toBe(english['queue.pausedStopped'])

    // A failure asks the reader to read a transcript; a stop asks nothing —
    // different causes, different sentences (`panels.test.ts:3190-3193`).
    const failed = { ...snap, session: { ...snap.session, pausedBy: 'failure' as const } }
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: failed })
    await nextTick()
    expect(wrapper.find('#queue-pause-text').text()).toBe(english['queue.blockedBanner'])

    await wrapper.find('#queue-resume').trigger('click')
    await wrapper.find('#queue-clear').trigger('click')
    expect(socket.sent).toEqual([{ type: 'resume' }, { type: 'clear' }])
  })

  it('reads "Queue (n)" on the queue tab, on the pane head, while the session view is up', async () => {
    // `pane.js:107-112`: the count lives on the head rather than inside the
    // queue panel, because `render` skips a hidden panel and the panel is
    // hidden whenever the session view (the default) is up.
    const snap = emptySnapshot({
      queue: [job({ id: 'j1' }), job({ id: 'j2' }), job({ id: 'j3' })],
    })
    const { Pane } = await boot(snap)
    const wrapper = mount(Pane)
    expect(wrapper.find('#view-session').attributes('aria-current')).toBe('true')
    expect(wrapper.find('#view-queue').text()).toBe(english['queue.tabCount.other'].replace('{count}', '3'))
  })

  it('names the job on screen in the head, and warns only when it is not the live job', async () => {
    const { Pane, socket } = await boot()
    const wrapper = mount(Pane)

    const running = emptySnapshot({
      queue: [job({ id: 'j1', command: '/mjloop:build P001-S01', status: 'running', startedAt: '2026-07-28T12:00:00.000Z' })],
      session: { jobId: 'j1', blocked: false, pausedBy: null, closing: false, stalledSince: null },
    })
    socket.deliver({ type: 'snapshot', snapshot: running })
    await nextTick()

    // `followQueue` puts the newly-started job on screen, and it is the live
    // one, so `#job-viewing`'s warning does not apply.
    expect(wrapper.find('#job-label bdi').text()).toBe('/mjloop:build P001-S01')
    expect(wrapper.find('#job-viewing').attributes('hidden')).toBeDefined()

    // The reader opens a different, finished job's transcript instead.
    const withHistory = {
      ...running,
      queue: [
        ...running.queue,
        job({ id: 'j2', command: '/mjloop:fix a bug', status: 'done', startedAt: '2026-07-28T12:00:00.000Z', endedAt: '2026-07-28T12:01:00.000Z' }),
      ],
    }
    socket.deliver({ type: 'snapshot', snapshot: withHistory })
    await nextTick()
    await wrapper.find('#view-queue').trigger('click')
    await wrapper.find('#queue-history .job .row-actions button').trigger('click')
    // The server answers `attach` with the transcript — the same `'transcript'`
    // message `store.ts`'s `receive()` turns into a `'replace'` output frame,
    // which is what actually puts j2 on screen (`shown`, not the attach click
    // itself).
    socket.deliver({ type: 'transcript', jobId: 'j2', data: 'j2 transcript' })
    await nextTick()

    // Typing into it would reach the still-live job j1, not j2 — the head
    // says so.
    expect(wrapper.find('#job-label bdi').text()).toBe('/mjloop:fix a bug')
    expect(wrapper.find('#job-viewing').attributes('hidden')).toBeUndefined()
    expect(wrapper.find('#job-viewing').text()).toBe(english['terminal.viewing'])
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
