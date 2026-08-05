// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import { emptySnapshot, readLocale } from './helpers/page.js'
import { pendingRequest, qualityView } from './helpers/quality.js'

/**
 * The Evidence panel — `panels/evidence.js`, `describe('evidence')` at
 * `panels.test.ts:1904`, and the evidence section of `index.html` — ported
 * to `Evidence.vue`.
 *
 * Behaviours from the three artefacts, each covered below:
 *  1. The run list draws every run's story, track, cycle count (verbatim,
 *     not pluralised prose) and outcome, from `/api/runs` alone.
 *  2. The empty state shows only when the run list is empty, and hides once
 *     a run exists.
 *  3. Opening a run (`open-run` toggle) fetches `/api/runs/<id>` and flips
 *     the row's own control from "Open" to "Close"; closing hides the detail
 *     section entirely.
 *  4. Opening a run fetches every cycle it names, one request per cycle.
 *  5. The verify ledger renders one row per entry: slot, command, phase
 *     (translated + classed), exit code (or "killed at the ceiling" for a
 *     timeout, colour-coded by exit code alone), duration (`1.8s`, one
 *     decimal, never localised), source, drift (`live_command`), and the
 *     cached-from-cycle marker.
 *  6. The verify table is absent entirely when a cycle's ledger is empty.
 *  7. The verify "more" line appears only when `verify_total` exceeds the
 *     rows served, and names both counts.
 *  8. Cycle headers are translated (`vh-*` slots), not left as dead text —
 *     the reason `panels/evidence.js` translated them itself in the old page.
 *  9. The handoff is collapsed by default, shown verbatim, and its own "cut"
 *     notice appears only when `handoff_truncated` is true; the whole
 *     `<details>` is absent when there is no handoff at all.
 *  10. The roster is drawn as chips; skipped agents are drawn with the
 *      leader's own stated reason; each landed agent's own result (status,
 *      summary, files touched, evidence cards) is drawn, tolerant of a
 *      missing/malformed result the way the old page's optional chains were.
 *  11. A halt report (`HALT.md`) is shown, verbatim, only when the run
 *      actually halted.
 *  12. The run list's own "more" line appears only past the 200-row cap
 *      `ui/list.js`'s `reconcile()` used, and is otherwise absent.
 *  13. The revision-driven refetch — the stated point of this task. The
 *      *live* cycle (the open run's last cycle, while that run is the
 *      project's current one) refetches when `revisions.cycle` moves; an
 *      earlier, inert cycle does not — it follows `revisions.runs` instead,
 *      so it is fetched once and left alone for as long as only the cycle
 *      revision advances.
 *  14. Switching the open run tears down the previous run's `CycleFeed`
 *      instances rather than leaving them fetching in the background —
 *      `CycleFeed.vue`'s whole reason for being one component per cycle
 *      instead of a hand-rolled `Map`.
 *
 * Deferred, with reason: the 200-row cap on the run list itself (behaviour
 * 12's boundary) is not separately exercised — it is a `slice()` of the same
 * shape `reconcile()` already used, ported line for line, and a 201-entry
 * fixture would test `Array.prototype.slice` rather than this component.
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
    const body = routes[url.split('?')[0] ?? '']
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), {
        status: body === undefined ? 404 : 200,
      }),
    )
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
})

async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Evidence } = await import('../../src/web/app/panels/Evidence.vue')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Evidence, socket: FakeSocket.last as FakeSocket }
}

describe('Evidence.vue', () => {
  it('draws the run list with its outcomes, and the empty state when there is none', async () => {
    // Cycles verbatim, not `tn()`'s prose: `panels/evidence.js`'s own row
    // wrote `verbatim(count, entry.cycles)`, unlike `StoryRunRow`. A second,
    // adhoc run with no story or track — the "—" fallback, and both
    // outcomes' own colour.
    serve({
      '/api/runs': [
        { id: '2026-07-28-001--P001-S01--build', story: 'P001-S01', track: 'build', cycles: 2, halted: true },
        { id: '2026-07-28-000--adhoc--edit', story: null, track: null, cycles: 1, halted: false },
      ],
    })
    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(2))

    const rows = wrapper.findAll('#evidence-list .run')
    expect(rows[0]?.get('[data-slot="id"]').text()).toBe('2026-07-28-001--P001-S01--build')
    expect(rows[0]?.get('[data-slot="story"]').text()).toBe('P001-S01')
    expect(rows[0]?.get('[data-slot="track"]').text()).toBe('build')
    expect(rows[0]?.get('[data-slot="cycles"]').text()).toBe('2')
    expect(rows[0]?.get('[data-slot="outcome"]').text()).toBe(english['evidence.halted'])
    expect(rows[0]?.get('[data-slot="outcome"]').classes()).toContain('res-fail')

    expect(rows[1]?.get('[data-slot="story"]').text()).toBe('—')
    expect(rows[1]?.get('[data-slot="track"]').text()).toBe('—')
    expect(rows[1]?.get('[data-slot="outcome"]').text()).toBe(english['evidence.ended'])
    expect(rows[1]?.get('[data-slot="outcome"]').classes()).toContain('res-pass')

    expect(wrapper.find('#evidence-empty').exists()).toBe(false)
    // Two runs, nowhere near the 200-row cap.
    expect(wrapper.find('#evidence-more').exists()).toBe(false)
  })

  it('shows the empty state with no runs, and the run list none of it', async () => {
    serve({ '/api/runs': [] })
    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.find('#evidence-empty').exists()).toBe(true))

    expect(wrapper.get('#evidence-empty').text()).toBe(english['evidence.empty'])
    expect(wrapper.findAll('#evidence-list .run')).toHaveLength(0)
  })

  it('shows what the engine executed, including a queued command and the drift beside it, and toggles the open control', async () => {
    const id = '2026-07-28-002--adhoc--build'
    serve({
      '/api/runs': [{ id, story: null, track: 'build', cycles: 1, halted: false }],
      [`/api/runs/${id}`]: { id, halt: null, cycles: [1] },
      [`/api/runs/${id}/1`]: {
        cycle: 1,
        roster: { selected: ['builder'], skipped: [] },
        findings: [],
        agents: [],
        verify: [
          {
            slot: 'test',
            command: 'npm test',
            source: 'pinned',
            live_command: 'npm test -- --coverage',
            log: 'test-01.log',
            phase: 'complete',
            exit_code: 1,
            timed_out: false,
            fingerprint: null,
            cached_from_cycle: null,
            duration_ms: 1800,
            at: '2026-07-28T12:00:00.000Z',
          },
          {
            slot: 'lint',
            command: 'npm run lint',
            source: 'pinned',
            live_command: null,
            log: '',
            phase: 'queued',
            exit_code: null,
            timed_out: false,
            fingerprint: null,
            cached_from_cycle: null,
            duration_ms: null,
            at: '2026-07-28T12:00:01.000Z',
          },
          {
            slot: 'build',
            command: 'npm run build',
            // A run that started under one `config.yaml` and finished under
            // another — nothing pinned it, so it ran the file as it stood.
            source: 'live',
            live_command: null,
            log: 'build-01.log',
            phase: 'complete',
            exit_code: 0,
            timed_out: false,
            fingerprint: null,
            cached_from_cycle: null,
            duration_ms: 400,
            at: '2026-07-28T12:00:02.000Z',
          },
        ],
        verify_total: 9,
        handoff: '# Cycle 1\n\nbuilder: pass — the parser now reads the header.',
        handoff_truncated: false,
      },
    })

    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(1))

    const openButton = wrapper.get('[data-act="open-run"]')
    expect(openButton.text()).toBe(english['evidence.open'])
    expect(openButton.attributes('data-run')).toBe(id)
    await openButton.trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.grid-verify .grid-row')).toHaveLength(3))

    // The row's own control flips once the run is open.
    expect(wrapper.get('[data-act="open-run"]').text()).toBe(english['evidence.close'])

    const rows = wrapper.findAll('.grid-verify .grid-row')
    expect(rows[0]?.get('[data-slot="command"]').text()).toBe('npm test')
    expect(rows[0]?.get('[data-slot="phase"]').text()).toBe(english['evidence.verify.complete'])
    expect(rows[0]?.get('[data-slot="phase"]').classes()).toContain('phase-complete')
    expect(rows[0]?.get('[data-slot="exit"]').text()).toBe('1')
    expect(rows[0]?.get('[data-slot="exit"]').classes()).toContain('exit-nonzero')
    expect(rows[0]?.get('[data-slot="duration"]').text()).toBe('1.8s')
    expect(rows[0]?.get('[data-slot="source"]').text()).toBe(english['evidence.verify.pinned'])
    // The command that is in `config.yaml` now, beside the one that ran.
    expect(rows[0]?.get('[data-slot="drift"]').text()).toBe('npm test -- --coverage')
    expect(rows[1]?.get('[data-slot="phase"]').text()).toBe(english['evidence.verify.queued'])
    expect(rows[1]?.get('[data-slot="exit"]').text()).toBe('—')
    expect(rows[1]?.get('[data-slot="exit"]').classes()).toContain('exit-none')
    expect(rows[2]?.get('[data-slot="exit"]').text()).toBe('0')
    expect(rows[2]?.get('[data-slot="exit"]').classes()).toContain('exit-zero')
    expect(rows[2]?.get('[data-slot="source"]').text()).toBe(english['evidence.verify.live'])

    // Headers inside the cycle block are translated, not dead text.
    expect(wrapper.get('.grid-verify [data-slot="vh-slot"]').text()).toBe(english['evidence.verify.slot'])
    expect(wrapper.get('.grid-verify [data-slot="vh-command"]').text()).toBe(english['evidence.verify.command'])

    // The reader caps the rows it serves; a cap nobody mentions reads as a
    // complete record with invocations missing from it.
    const more = wrapper.get('[data-slot="verifyMore"]')
    expect(more.text()).toContain('9')
    expect(more.text()).toContain('3')

    const handoff = wrapper.get('[data-slot="handoffDetails"]')
    expect(handoff.find('[data-slot="handoff"]').text()).toContain('the parser now reads the header')
    expect(handoff.find('[data-slot="handoffCut"]').exists()).toBe(false)

    // Closing drops the detail section entirely.
    await wrapper.get('[data-act="open-run"]').trigger('click')
    await nextTick()
    expect(wrapper.find('#run-open').exists()).toBe(false)
  })

  it('shows a timed-out invocation distinctly from a failing one, and cuts a long handoff', async () => {
    const id = '2026-07-28-003--adhoc--build'
    serve({
      '/api/runs': [{ id, story: null, track: 'build', cycles: 1, halted: false }],
      [`/api/runs/${id}`]: { id, halt: null, cycles: [1] },
      [`/api/runs/${id}/1`]: {
        cycle: 1,
        roster: { selected: ['builder', 'security'], skipped: [{ agent: 'docs', reason: 'nothing to document yet' }] },
        findings: [],
        agents: [
          {
            agent: 'builder',
            result: {
              status: 'pass',
              summary: 'Landed the fix.',
              evidence: [{ kind: 'file', ref: 'src/a.ts', excerpt: 'const x = 1' }],
              findings: [],
              files_touched: ['src/a.ts'],
              next_hint: null,
              skills_used: [],
            },
          },
          // No `result` at all — an agent whose write failed, or the
          // directory listing predates the ledger. Every field the row
          // reads is optional-chained for exactly this case.
          { agent: 'security', result: null },
        ],
        verify: [
          {
            slot: 'build',
            command: 'npm run build',
            source: 'live',
            live_command: null,
            log: '',
            phase: 'complete',
            exit_code: null,
            timed_out: true,
            fingerprint: null,
            cached_from_cycle: 3,
            duration_ms: null,
            at: '2026-07-28T12:00:02.000Z',
          },
        ],
        verify_total: 1,
        handoff: 'a very long handoff',
        handoff_truncated: true,
      },
    })

    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(1))

    await wrapper.get('[data-act="open-run"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.grid-verify .grid-row')).toHaveLength(1))

    const row = wrapper.get('.grid-verify .grid-row')
    expect(row.get('[data-slot="exit"]').text()).toBe(english['evidence.verify.timedOut'])
    expect(row.get('[data-slot="cached"]').text()).toBe('3')
    // No `verifyMore`: `verify_total` matches what was served.
    expect(wrapper.find('[data-slot="verifyMore"]').exists()).toBe(false)

    // The roster, the skip reason and both agent rows.
    expect(wrapper.findAll('#run-open-cycles .chips .chip').map((n) => n.text())).toEqual(['builder', 'security'])
    const skipped = wrapper.get('.skipped li')
    expect(skipped.get('[data-slot="agent"]').text()).toBe('docs')
    expect(skipped.get('[data-slot="reason"]').text()).toBe('nothing to document yet')

    const agents = wrapper.findAll('.agent')
    expect(agents[0]?.get('[data-slot="status"]').text()).toBe(english['cycle.result.pass'])
    expect(agents[0]?.get('[data-slot="summary"]').text()).toBe('Landed the fix.')
    expect(agents[0]?.find('[data-slot="files"]').text()).toBe('src/a.ts')
    expect(agents[0]?.get('.evidence-cards li [data-slot="ref"]').text()).toBe('file: src/a.ts')
    // Missing `result` reads as `blocked`, the same fallback the old page's
    // `entry.result?.status ?? 'blocked'` used.
    expect(agents[1]?.get('[data-slot="status"]').text()).toBe(english['cycle.result.blocked'])
    expect(agents[1]?.find('[data-slot="files"]').exists()).toBe(false)

    expect(wrapper.get('[data-slot="handoffCut"]').text()).toBe(english['evidence.handoffCut'])
  })

  it('shows a halt report only for a run that actually halted', async () => {
    const halted = '2026-07-28-004--adhoc--build'
    serve({
      '/api/runs': [{ id: halted, story: null, track: 'build', cycles: 1, halted: true }],
      [`/api/runs/${halted}`]: { id: halted, halt: 'Blocked on a missing secret.', cycles: [] },
    })
    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(1))

    await wrapper.get('[data-act="open-run"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('#run-open-haltbody').exists()).toBe(true))
    expect(wrapper.get('#run-open-haltbody').text()).toBe('Blocked on a missing secret.')
    expect(wrapper.get('#run-open-title').text()).toBe(halted)
  })

  it('has no verify block at all for a cycle with an empty ledger', async () => {
    const id = '2026-07-28-005--adhoc--build'
    serve({
      '/api/runs': [{ id, story: null, track: 'build', cycles: 1, halted: false }],
      [`/api/runs/${id}`]: { id, halt: null, cycles: [1] },
      [`/api/runs/${id}/1`]: {
        cycle: 1,
        roster: { selected: ['builder'], skipped: [] },
        findings: [],
        agents: [],
        verify: [],
        verify_total: 0,
        handoff: null,
        handoff_truncated: false,
      },
    })
    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(1))

    await wrapper.get('[data-act="open-run"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('#run-open-cycles .cycle-block').exists()).toBe(true))

    expect(wrapper.find('[data-slot="verifyBlock"]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="handoffDetails"]').exists()).toBe(false)
    expect(wrapper.get('[data-slot="title"]').text()).toBe((english['evidence.cycle'] ?? '').replace('{cycle}', '1'))
  })

  it('fetches one cycle per entry the open run names', async () => {
    const id = '2026-07-28-006--adhoc--build'
    const fetched: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url.split('?')[0] ?? '')
      const path = url.split('?')[0]
      const routes: Record<string, unknown> = {
        '/api/runs': [{ id, story: null, track: 'build', cycles: 2, halted: false }],
        [`/api/runs/${id}`]: { id, halt: null, cycles: [1, 2] },
        [`/api/runs/${id}/1`]: { cycle: 1, roster: null, findings: [], agents: [], verify: [], verify_total: 0, handoff: null, handoff_truncated: false },
        [`/api/runs/${id}/2`]: { cycle: 2, roster: null, findings: [], agents: [], verify: [], verify_total: 0, handoff: null, handoff_truncated: false },
      }
      const body = path !== undefined ? routes[path] : undefined
      return Promise.resolve(new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }))
    })

    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(1))

    await wrapper.get('[data-act="open-run"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('#run-open-cycles .cycle-block')).toHaveLength(2))

    expect(fetched).toContain(`/api/runs/${id}/1`)
    expect(fetched).toContain(`/api/runs/${id}/2`)
  })

  it('refetches the live cycle when revisions.cycle moves, and leaves an inert cycle alone — the point of this task', async () => {
    const runId = '20260729T100000Z'
    const id = `${runId}--adhoc--build`
    const fetched: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      const path = url.split('?')[0] ?? ''
      fetched.push(path)
      const routes: Record<string, unknown> = {
        '/api/runs': [{ id, story: null, track: 'build', cycles: 2, halted: false }],
        [`/api/runs/${id}`]: { id, halt: null, cycles: [1, 2] },
        [`/api/runs/${id}/1`]: { cycle: 1, roster: null, findings: [], agents: [], verify: [], verify_total: 0, handoff: null, handoff_truncated: false },
        [`/api/runs/${id}/2`]: { cycle: 2, roster: null, findings: [], agents: [], verify: [], verify_total: 0, handoff: null, handoff_truncated: false },
      }
      const body = routes[path]
      return Promise.resolve(new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }))
    })

    // `run_id` names this run as the live one, so its own last cycle (2) is
    // the live cycle — cycle 1 is inert.
    const first = emptySnapshot({
      state: { ...emptySnapshot().state, status: 'running', run_id: runId, cycle: 2 },
      revisions: { ...emptySnapshot().revisions, runs: 'r1', cycle: 'c1' },
    })
    const { Evidence, socket } = await boot(first)
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(1))

    await wrapper.get('[data-act="open-run"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('#run-open-cycles .cycle-block')).toHaveLength(2))

    const count = (path: string): number => fetched.filter((entry) => entry === path).length
    expect(count(`/api/runs/${id}/1`)).toBe(1)
    expect(count(`/api/runs/${id}/2`)).toBe(1)

    // Only `revisions.cycle` moves; `revisions.runs` does not.
    socket.deliver({ type: 'snapshot', snapshot: { ...first, revisions: { ...first.revisions, cycle: 'c2' } } })
    await vi.waitFor(() => expect(count(`/api/runs/${id}/2`)).toBe(2))
    // The inert cycle follows `revisions.runs` and stayed put.
    expect(count(`/api/runs/${id}/1`)).toBe(1)
  })

  it('tears down a closed run\'s cycle feeds on switching runs, rather than leaving them fetching', async () => {
    const idA = '20260729T110000Z--adhoc--build'
    const idB = '20260729T120000Z--adhoc--edit'
    const fetched: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      const path = url.split('?')[0] ?? ''
      fetched.push(path)
      const routes: Record<string, unknown> = {
        '/api/runs': [
          { id: idA, story: null, track: 'build', cycles: 1, halted: false },
          { id: idB, story: null, track: 'edit', cycles: 1, halted: false },
        ],
        [`/api/runs/${idA}`]: { id: idA, halt: null, cycles: [1] },
        [`/api/runs/${idA}/1`]: { cycle: 1, roster: null, findings: [], agents: [], verify: [], verify_total: 0, handoff: null, handoff_truncated: false },
        [`/api/runs/${idB}`]: { id: idB, halt: null, cycles: [1] },
        [`/api/runs/${idB}/1`]: { cycle: 1, roster: null, findings: [], agents: [], verify: [], verify_total: 0, handoff: null, handoff_truncated: false },
      }
      const body = routes[path]
      return Promise.resolve(new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }))
    })

    const { Evidence, socket } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('#evidence-list .run')).toHaveLength(2))

    const count = (path: string): number => fetched.filter((entry) => entry === path).length
    const buttons = (): ReturnType<typeof wrapper.findAll> => wrapper.findAll('[data-act="open-run"]')
    await buttons()[0]?.trigger('click')
    await vi.waitFor(() => expect(count(`/api/runs/${idA}/1`)).toBe(1))

    // A single toggle: opening run B's own control moves `opened` straight
    // from A to B, unmounting run A's `CycleFeed` in the same tick `openRun`
    // itself moves.
    await buttons()[1]?.trigger('click')
    await vi.waitFor(() => expect(count(`/api/runs/${idB}/1`)).toBe(1))

    // A broadcast after the switch must not resurrect run A's own feed — it
    // was unmounted, not merely hidden, which is the whole point of one
    // `CycleFeed` component per cycle over a hand-rolled `Map`.
    socket.deliver({ type: 'snapshot', snapshot: emptySnapshot({ revisions: { ...emptySnapshot().revisions, cycle: 'moved' } }) })
    await nextTick()
    expect(count(`/api/runs/${idA}/1`)).toBe(1)
  })
})

/* ── the quality record of a finished run, read-only ──────────────────────── */

describe('the run\'s quality record (Evidence.vue)', () => {
  const id = '2026-07-28-002--adhoc--build'

  async function mountEvidence(view: unknown) {
    serve({
      '/api/runs': [{ id, story: null, track: 'build', cycles: 0, halted: false }],
      [`/api/runs/${id}`]: { id, halt: null, cycles: [] },
      [`/api/runs/${id}/quality`]: view,
    })
    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.find('[data-act="open-run"]').exists()).toBe(true))
    await wrapper.get('[data-act="open-run"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('#run-open-quality').exists()).toBe(true))
    return wrapper
  }

  it('renders unavailable cost honestly and gives every verdict a text label', async () => {
    const wrapper = await mountEvidence(qualityView())
    expect(wrapper.text()).toContain(english['quality.costUnavailable'])
    expect(wrapper.get('[data-dimension="security"]').text()).toContain(english['quality.verdict.pass'])
  })

  it('never draws one run\'s quality record under another run\'s heading', async () => {
    // `feed()` keeps the last good body through a failed fetch, which is right
    // for a blip and wrong for a 404: most runs on disk pinned no policy at
    // all, and the body still held is the *previous* run's.
    const other = '2026-07-28-003--adhoc--build'
    serve({
      '/api/runs': [
        { id, story: null, track: 'build', cycles: 0, halted: false },
        { id: other, story: null, track: 'build', cycles: 0, halted: false },
      ],
      [`/api/runs/${id}`]: { id, halt: null, cycles: [] },
      [`/api/runs/${other}`]: { id: other, halt: null, cycles: [] },
      [`/api/runs/${id}/quality`]: qualityView(),
    })
    const { Evidence } = await boot()
    const wrapper = mount(Evidence)
    await vi.waitFor(() => expect(wrapper.findAll('[data-act="open-run"]')).toHaveLength(2))
    await wrapper.findAll('[data-act="open-run"]')[0]?.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('#run-open-quality').exists()).toBe(true))

    await wrapper.findAll('[data-act="open-run"]')[1]?.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#run-open-title').text()).toBe(other))
    expect(wrapper.find('#run-open-quality').exists()).toBe(false)
  })

  it('is a record and never a control — the two operator doors are not on this panel', async () => {
    // The same document the Run panel draws, with a decision still waiting on
    // a person. Evidence reports what happened; approving a destructive
    // operation is a decision about the *open* run, and it belongs to the one
    // panel that knows a run is open.
    const wrapper = await mountEvidence(qualityView({ pendingRequest: pendingRequest() }))
    expect(wrapper.find('#run-quality-decide').exists()).toBe(false)
    expect(wrapper.find('#run-quality-amend').exists()).toBe(false)
    expect(wrapper.get('#run-open-quality').text()).toContain('DROP TABLE users')
  })
})
