// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { ConfigSchema } from '../../src/schemas/config.js'
import type { Snapshot } from '../../src/web/protocol.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Run panel — `panels/run.js`, `describe('run')` at `panels.test.ts:1835`,
 * and the run section of `index.html` — ported to `Run.vue`.
 *
 * The halt dialog and the stalled banner/nudge (in `Banners.vue`) were first
 * built here, then relocated after fix round 1: halt is `Rail.vue` +
 * `HaltDialog.vue` (hosted in `App.vue`, outside the panels' `<KeepAlive>` —
 * see `useHalt.ts`) because `ui/rail.js:106` shows it on every tab a run is
 * running on, not only this one. Their tests below now mount `Rail` and
 * `HaltDialog` together rather than `Run`; `shell.test.ts` additionally
 * covers the dialog surviving a tab switch, the defect that placement fixes.
 */

const english = await readLocale('en')

/** The same fake socket `pane-surface.test.ts` and `shell.test.ts` use to drive the store. */
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

/**
 * A read api that answers the paths a test names and 404s everything else —
 * `panels.test.ts`'s own `serve()`, ported.
 */
function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = routes[url.split('?')[0] ?? '']
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), {
        status: body === undefined ? 404 : 200,
      }),
    )
  })
}

function configView(patch: Record<string, unknown> = {}): unknown {
  return {
    raw: 'version: 1\n',
    revision: 'a'.repeat(64),
    parsed: ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
      ...patch,
    }),
    invalid: false,
  }
}

beforeEach(() => {
  vi.resetModules()
  // No route named: a successful `null` body — the same answer
  // `readSkillManifest` gives for a run that pinned no manifest, and safe
  // for every other feed too, since each reads its body through `?.`. A test
  // that cares what a feed actually holds calls `serve()` itself.
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
})

/**
 * Boots a fresh module graph, connects a `FakeSocket`, and delivers a
 * snapshot — the same order `App.vue`'s own `onMounted` follows.
 */
async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Run } = await import('../../src/web/app/panels/Run.vue')
  const { default: Banners } = await import('../../src/web/app/components/Banners.vue')
  const { default: Rail } = await import('../../src/web/app/components/Rail.vue')
  const { default: HaltDialog } = await import('../../src/web/app/components/HaltDialog.vue')
  const { useHalt } = await import('../../src/web/app/composables/useHalt.ts')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()

  /**
   * `Rail`'s halt button and `HaltDialog` are siblings under `App.vue`, wired
   * through `useHalt.ts`'s shared ref rather than through each other — the
   * same shape `App.vue` itself uses. This host reproduces exactly that
   * wiring, from the same fresh module graph `Rail`/`HaltDialog` were loaded
   * from, so `openHalt()` called inside `Rail`'s click handler is the same
   * ref `HaltDialog`'s `open` prop reads here.
   */
  const halt = useHalt()
  const HaltHost = defineComponent({
    props: { snapshot: { type: Object, required: true }, runId: { type: String, default: null } },
    setup: (props) => () =>
      h('div', [h(Rail, { snapshot: props.snapshot }), h(HaltDialog, { open: halt.open.value, runId: props.runId, onClose: halt.closeHalt })]),
  })

  return { store, Run, Banners, Rail, HaltDialog, HaltHost, halt, socket: FakeSocket.last as FakeSocket }
}

const runningState = (patch: Record<string, unknown> = {}) => ({
  initialised: true,
  recovered: false,
  status: 'running',
  track: 'build',
  run_id: '20260728T120000Z',
  cycle: 2,
  max_cycles: 5,
  plan: 'P001',
  story: 'P001-S02',
  stage: 'execute',
  goal: 'Ship the Run panel',
  findings: { high: 1, medium: 2, low: 0 },
  last_cycle: { result: 'fail', agents: ['builder', 'verifier'] },
  halt_reason: null,
  reproduction: null,
  design_system: true,
  config_error: null,
  ...patch,
})

describe('Run.vue', () => {
  it('says the project has no loop at all, distinctly from an idle one', async () => {
    const { Run } = await boot(emptySnapshot({ state: { ...emptySnapshot().state, initialised: false, status: 'uninitialised' } }))
    const wrapper = mount(Run)
    expect(wrapper.find('.empty').text()).toBe(english['run.uninitialised'])
    expect(wrapper.find('#run-body').exists()).toBe(false)
  })

  it('draws run_id and the last cycle, which nothing drew before (panels.test.ts:1836)', async () => {
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await nextTick()

    expect(wrapper.get('#run-runid-fact').text()).toContain('20260728T120000Z')
    expect(wrapper.get('#run-last-result').text()).toBe(english['cycle.result.fail'])
    expect(wrapper.findAll('#run-last-agents .chip').map((node) => node.text())).toEqual(['builder', 'verifier'])
  })

  it('estimates the run nobody has started yet, and says when it has no basis (panels.test.ts:1861)', async () => {
    serve({
      '/api/config': configView(),
      '/api/preflight/build': {
        track: 'build',
        max_cycles: 5,
        roster: { required: ['builder', 'verifier'], available: ['security'], forced: [], forbidden: [], closing: ['docs'] },
        dispatches_per_cycle: 3,
        ceiling: { cycles: 5, dispatches: 16 },
        comparable: null,
      },
    })
    const { Run } = await boot(emptySnapshot())
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-preflight').exists()).toBe(true))

    expect((wrapper.get('#preflight-track').element as HTMLSelectElement).value).toBe('build')
    expect(wrapper.findAll('#preflight-facts dt').map((n) => n.text())).toEqual([
      english['preflight.maxCycles'],
      english['preflight.perCycle'],
      english['preflight.ceiling'],
      english['preflight.required'],
      english['preflight.available'],
      english['preflight.closing'],
    ])
    expect(wrapper.findAll('#preflight-facts dd').map((n) => n.text())).toEqual(['5', '3', '16', 'builder, verifier', 'security', 'docs'])
    // No comparable run is an answer. An invented range would not be.
    expect(wrapper.get('#preflight-basis').text()).toBe(english['preflight.noBasis'])
    expect(wrapper.findAll('#preflight-past .fact')).toHaveLength(0)
  })

  it('reports comparable runs with a range, and the bare number when they agree', async () => {
    serve({
      '/api/config': configView(),
      '/api/preflight/build': {
        track: 'build',
        max_cycles: 5,
        roster: { required: ['builder'], available: [], forced: [], forbidden: [], closing: [] },
        dispatches_per_cycle: 1,
        ceiling: { cycles: 5, dispatches: 5 },
        comparable: {
          runs: 3,
          cycles: { median: 2, min: 2, max: 2 },
          dispatches: { median: 3, min: 2, max: 5 },
          minutes: null,
        },
      },
    })
    const { Run } = await boot(emptySnapshot())
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#preflight-basis').text()).not.toBe(''))

    expect(wrapper.get('#preflight-basis').text()).toBe(english['preflight.basis.other'].replace('{count}', '3'))
    expect(wrapper.findAll('#preflight-past dt').map((n) => n.text())).toEqual([
      english['preflight.pastCycles'],
      english['preflight.pastDispatches'],
    ])
    expect(wrapper.findAll('#preflight-past dd').map((n) => n.text())).toEqual(['2', '3 (2–5)'])
    // No minutes on a run nothing has timed: the row is absent, not "—".
    expect(wrapper.text()).not.toContain(english['preflight.pastMinutes'])
  })

  it('picks the track the state already ran, over the config order', async () => {
    serve({
      '/api/config': configView({ tracks: { edit: { required: ['builder'], max_cycles: 2 }, build: { required: ['builder'], max_cycles: 5 } } }),
      '/api/preflight/edit': {
        track: 'edit',
        max_cycles: 2,
        roster: { required: ['builder'], available: [], forced: [], forbidden: [], closing: [] },
        dispatches_per_cycle: 1,
        ceiling: { cycles: 2, dispatches: 2 },
        comparable: null,
      },
    })
    const { Run } = await boot(emptySnapshot({ state: { ...emptySnapshot().state, status: 'idle', track: 'edit' } }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect((wrapper.get('#preflight-track').element as HTMLSelectElement).options.length).toBeGreaterThan(0))
    expect((wrapper.get('#preflight-track').element as HTMLSelectElement).value).toBe('edit')
  })

  it('refetches the estimate when a person picks a different track (run.js:119-122)', async () => {
    serve({
      '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } } }),
      '/api/preflight/build': {
        track: 'build',
        max_cycles: 5,
        roster: { required: ['builder'], available: [], forced: [], forbidden: [], closing: [] },
        dispatches_per_cycle: 1,
        ceiling: { cycles: 5, dispatches: 5 },
        comparable: null,
      },
      '/api/preflight/edit': {
        track: 'edit',
        max_cycles: 2,
        roster: { required: ['builder', 'verifier'], available: [], forced: [], forbidden: [], closing: [] },
        dispatches_per_cycle: 2,
        ceiling: { cycles: 2, dispatches: 4 },
        comparable: null,
      },
    })
    const { Run } = await boot(emptySnapshot())
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.findAll('#preflight-facts dd').map((n) => n.text())).toEqual(['5', '1', '5', 'builder']))

    const select = wrapper.get('#preflight-track')
    await select.setValue('edit')
    await vi.waitFor(() => expect(wrapper.findAll('#preflight-facts dd').map((n) => n.text())).toEqual(['2', '2', '4', 'builder, verifier']))
  })

  it('draws the findings table, with the severity a screen reader hears and the CSS keys on', async () => {
    serve({
      '/api/state': {
        state: {
          findings: [{ severity: 'high', file: 'a.ts', line: 10, claim: 'Unbounded input' }],
          reproduction: null,
          history: [],
        },
      },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-findings-block').exists()).toBe(true))

    const row = wrapper.get('.grid-findings .finding')
    expect(row.find('.sev').classes()).toContain('sev-high')
    expect(row.find('.sev').text()).toBe(english['findings.severity.high'])
    expect(row.findAll('[role="cell"]')[1]?.text()).toBe('a.ts:10')
    expect(row.text()).toContain('Unbounded input')
  })

  it('says the gate is shut until a reproduction proves it, then names who and where', async () => {
    serve({
      '/api/state': {
        state: {
          findings: [],
          reproduction: { agent: 'reproducer', cycle: 2, ref: 'npm test -- repro.spec.ts', excerpt: 'AssertionError: expected true' },
          history: [],
        },
      },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState({ reproduction: { proven: true, ref: null } }) }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-gate-block').exists()).toBe(true))

    expect(wrapper.get('#run-gate-state').text()).toBe(
      english['run.gateState.provenBy'].replace('{agent}', 'reproducer').replace('{cycle}', '2'),
    )
    expect(wrapper.get('#run-gate-ref').text()).toBe('npm test -- repro.spec.ts')
    expect(wrapper.get('#run-gate-excerpt').text()).toBe('AssertionError: expected true')
  })

  it('hides the excerpt when it is empty, and the ref/excerpt entirely when nothing is proven', async () => {
    serve({ '/api/state': { state: { findings: [], reproduction: null, history: [] } } })
    const { Run } = await boot(emptySnapshot({ state: runningState({ reproduction: { proven: false, ref: null } }) }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-gate-block').exists()).toBe(true))

    expect(wrapper.get('#run-gate-state').text()).toBe(english['run.gateState.shut'])
    expect(wrapper.find('#run-gate-ref').exists()).toBe(false)
    expect(wrapper.find('#run-gate-excerpt').exists()).toBe(false)
  })

  it('draws the cycle timeline with a result class the stylesheet keys on', async () => {
    serve({
      '/api/state': {
        state: {
          findings: [],
          reproduction: null,
          history: [{ cycle: 1, agents: ['builder'], result: 'pass', ref: 'cycle-1/builder.json' }],
        },
      },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-timeline').exists()).toBe(true))

    const row = wrapper.get('.grid-cycles .cycle')
    expect(row.find('.res').classes()).toContain('res-pass')
    expect(row.text()).toContain('builder')
    expect(row.text()).toContain('cycle-1/builder.json')
  })

  it('draws HALT.md verbatim, and only when the run actually halted', async () => {
    serve({ '/api/runs/20260728T120000Z--P001-S02--build': { id: '20260728T120000Z--P001-S02--build', halt: '# Halted\n\nStagnation.', cycles: [1] } })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-haltreport').exists()).toBe(true))
    expect(wrapper.get('#run-halt-report').text()).toBe('# Halted\n\nStagnation.')
  })

  it('does not draw the halt report block when the run has no HALT.md', async () => {
    serve({ '/api/runs/20260728T120000Z--P001-S02--build': { id: '20260728T120000Z--P001-S02--build', halt: null, cycles: [1] } })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await nextTick()
    expect(wrapper.find('#run-haltreport').exists()).toBe(false)
  })

  it('says what routed this run, and passes the reason through untranslated while the mode is a phrase', async () => {
    serve({
      '/api/runs/20260728T120000Z--P001-S02--build/skills': {
        generatedAt: '2026-07-28T09:00:00.000Z',
        sourceBrief: { id: 'F001', revision: 2 },
        profileRevision: 3,
        selections: [{ component: 'web', agent: 'builder', skillIds: ['flutter-forms'], reasons: ['tag match'], sourceBrief: { id: 'F001', revision: 2 } }],
        guidance: { 'flutter-forms': 'Use the shared form kit.' },
        concurrency: { mode: 'sequential', reason: 'the gate forces one dispatch at a time' },
      },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-manifest').exists()).toBe(true))

    expect(wrapper.get('#run-manifest').text()).toContain('F001@2')
    expect(wrapper.get('#run-manifest').text()).toContain(english['manifest.mode.sequential'])
    expect(wrapper.get('#run-manifest').text()).toContain('the gate forces one dispatch at a time')
    expect(wrapper.find('#manifest-empty').exists()).toBe(false)
    expect(wrapper.get('#manifest-selections').text()).toContain('flutter-forms')
    expect(wrapper.get('#manifest-selections').text()).toContain('tag match')
    expect(wrapper.get('#manifest-selections').find('details').text()).toContain('Use the shared form kit.')
  })

  it('says a manifest selected nothing, as a fact distinct from no manifest at all', async () => {
    serve({
      '/api/runs/20260728T120000Z--P001-S02--build/skills': {
        generatedAt: '2026-07-28T09:00:00.000Z',
        sourceBrief: { id: 'F001', revision: 1 },
        profileRevision: 1,
        selections: [],
        guidance: {},
        concurrency: { mode: 'parallel', reason: 'no gate on this track' },
      },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-manifest').exists()).toBe(true))
    expect(wrapper.get('#manifest-empty').text()).toBe(english['manifest.empty'])
  })

  it('marks a drafted agent landed once its cycle result exists, and only that one', async () => {
    const { Run } = await boot(
      emptySnapshot({ state: runningState(), roster: { cycle: 2, selected: ['builder', 'verifier'], landed: ['builder'] } }),
    )
    const wrapper = mount(Run)
    await nextTick()

    const chips = wrapper.findAll('#run-roster-agents .chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.classes()).toContain('landed-yes')
    expect(chips[1]?.classes()).toContain('landed-no')
  })

  it('shows the strikes as an n/m identifier and arms the one signature that would halt the run', async () => {
    const { Run } = await boot(
      emptySnapshot({
        state: runningState(),
        guards: { strikes: 1, strikesAllowed: 2, cycleErrors: ['ETIMEDOUT', 'ECONNRESET'], errorArmed: 'ETIMEDOUT' },
      }),
    )
    const wrapper = mount(Run)
    await nextTick()

    expect(wrapper.get('#run-strikes').text()).toBe('1/2')
    const chips = wrapper.findAll('#run-cycle-errors .chip')
    expect(chips[0]?.classes()).toContain('armed-yes')
    expect(chips[1]?.classes()).toContain('armed-no')
  })

  describe('the halt dialog (Rail.vue + HaltDialog.vue, wired through useHalt.ts)', () => {
    it('opens on the rail\'s halt button, and is not offered when nothing is running', async () => {
      const { HaltHost } = await boot(emptySnapshot({ state: { ...emptySnapshot().state, status: 'idle' } }))
      const wrapper = mount(HaltHost, { props: { snapshot: emptySnapshot({ state: { ...emptySnapshot().state, status: 'idle' } }), runId: null } })
      await nextTick()
      expect(wrapper.find('.rail button.danger').exists()).toBe(false)
    })

    it('writes a halt for the run on screen, and never as an optimistic render', async () => {
      const running = runningState()
      const { HaltHost, socket } = await boot(emptySnapshot({ state: running }))
      const wrapper = mount(HaltHost, { props: { snapshot: emptySnapshot({ state: running }), runId: running.run_id }, attachTo: document.body })
      await nextTick()

      await wrapper.get('.rail button.danger').trigger('click')
      const dialog = document.getElementById('halt-dialog') as HTMLDialogElement
      expect(dialog.open).toBe(true)
      expect(socket.sent).toEqual([])

      const input = wrapper.get('#halt-reason')
      await input.setValue('stagnating on the same error')
      await wrapper.get('#halt-form').trigger('submit')
      await nextTick()
      await nextTick()

      expect(socket.sent).toEqual([
        {
          type: 'write',
          id: expect.any(String),
          write: { kind: 'halt', run: '20260728T120000Z', reason: 'stagnating on the same error' },
        },
      ])
      expect(dialog.open).toBe(false)
      wrapper.unmount()
    })

    it('sends nothing for an empty reason, and nothing on cancel', async () => {
      const running = runningState()
      const { HaltHost, socket } = await boot(emptySnapshot({ state: running }))
      const wrapper = mount(HaltHost, { props: { snapshot: emptySnapshot({ state: running }), runId: running.run_id }, attachTo: document.body })
      await nextTick()

      await wrapper.get('.rail button.danger').trigger('click')
      await wrapper.get('#halt-form').trigger('submit')
      expect(socket.sent).toEqual([])

      await wrapper.get('.rail button.danger').trigger('click')
      await wrapper.get('#halt-reason').setValue('a reason')
      await wrapper.find('.dialog-actions button[type="button"]').trigger('click')
      expect(socket.sent).toEqual([])
      wrapper.unmount()
    })

    it('focuses the reason field on open, for a keyboard user', async () => {
      const running = runningState()
      const { HaltHost } = await boot(emptySnapshot({ state: running }))
      const wrapper = mount(HaltHost, { props: { snapshot: emptySnapshot({ state: running }), runId: running.run_id }, attachTo: document.body })
      await nextTick()

      await wrapper.get('.rail button.danger').trigger('click')
      expect(document.activeElement).toBe(document.getElementById('halt-reason'))
      wrapper.unmount()
    })
  })

  describe('the stalled banner (Banners.vue)', () => {
    it('is silent while the session is not stalled', async () => {
      const { Banners } = await boot()
      const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: true } })
      expect(wrapper.text()).not.toContain(english['session.nudge'])
    })

    it('names when the session went quiet, and nudges it without naming a run', async () => {
      const { Banners, socket } = await boot()
      const snapshot = emptySnapshot({ session: { jobId: 'j1', blocked: false, pausedBy: null, closing: false, stalledSince: '2026-07-28T09:00:00.000Z' } })
      const wrapper = mount(Banners, { props: { snapshot, online: true } })

      const banner = wrapper.get('.banner.warn')
      expect(banner.text()).toContain(english['session.stalledHint'])
      await banner.get('button').trigger('click')
      expect(socket.sent).toEqual([{ type: 'nudge' }])
    })
  })
})

describe('structure (60-panels.css)', () => {
  it('gives the aside its own grid track only through `.panel-side`, and never a per-panel id', async () => {
    const { Run } = await boot(emptySnapshot({ state: runningState(), roster: { cycle: 1, selected: [], landed: [] } }))
    const wrapper = mount(Run)
    await nextTick()

    expect(wrapper.get('#run-body').classes()).toContain('panel-grid')
    expect(wrapper.get('#run-body > aside').classes()).toContain('panel-side')
  })

  it('marks the findings and cycle grids so `.grid-head, .grid-body, .grid-row { display: contents }` reaches them', async () => {
    serve({
      '/api/state': {
        state: {
          findings: [{ severity: 'low', file: 'x.ts', line: 1, claim: 'c' }],
          reproduction: null,
          history: [{ cycle: 1, agents: ['builder'], result: 'blocked', ref: 'r' }],
        },
      },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState() }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('.grid-cycles').exists()).toBe(true))

    const findingsGrid = wrapper.get('.grid-findings')
    expect(findingsGrid.attributes('role')).toBe('table')
    expect(findingsGrid.get('.grid-head').attributes('role')).toBe('row')
    expect(findingsGrid.get('.grid-body').attributes('role')).toBe('rowgroup')
    expect(findingsGrid.get('.grid-row').attributes('role')).toBe('row')
    expect(findingsGrid.find('.scroller').exists()).toBe(false) // the scroller is the grid's parent, not itself

    const cyclesGrid = wrapper.get('.grid-cycles')
    expect(cyclesGrid.get('.res').classes()).toContain('res-blocked')
    expect(wrapper.find('.grid-findings').element.parentElement?.classList.contains('scroller')).toBe(true)
    expect(wrapper.find('.grid-cycles').element.parentElement?.classList.contains('scroller')).toBe(true)
  })

  it('gives a halt report and a gate excerpt the `.excerpt` class the stylesheet keys on', async () => {
    serve({
      '/api/state': { state: { findings: [], reproduction: { agent: 'a', cycle: 1, ref: 'r', excerpt: 'e' }, history: [] } },
      '/api/runs/20260728T120000Z--P001-S02--build': { id: '20260728T120000Z--P001-S02--build', halt: 'h', cycles: [1] },
    })
    const { Run } = await boot(emptySnapshot({ state: runningState({ reproduction: { proven: true, ref: null } }) }))
    const wrapper = mount(Run)
    await vi.waitFor(() => expect(wrapper.find('#run-halt-report').exists()).toBe(true))

    expect(wrapper.get('#run-halt-report').classes()).toContain('excerpt')
    expect(wrapper.get('#run-gate-excerpt').classes()).toContain('excerpt')
  })
})
