// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installForTest } from '../../src/web/public/lib/i18n.js'
import { installStorage } from '../../src/web/public/lib/local.js'
import { draw, installScheduler } from '../../src/web/public/ui/render.js'
import { drawRail, mountRail } from '../../src/web/public/ui/rail.js'
import { mountConfig } from '../../src/web/public/panels/config.js'
import { mountEvidence } from '../../src/web/public/panels/evidence.js'
import { mountPlans, planStatus, ready, statusIndex, unmet } from '../../src/web/public/panels/plans.js'
import { mountQueue } from '../../src/web/public/panels/queue.js'
import { mountRun } from '../../src/web/public/panels/run.js'
import { facet } from '../../src/web/public/panels/memory.js'
import { suggestions } from '../../src/web/public/panels/launcher.js'
import { mountToasts, toast } from '../../src/web/public/ui/toasts.js'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import type { PlanView, StoryView } from '../../src/web/protocol.js'

/**
 * The milestone's own claim, asserted: everything the server already sends
 * finally gets drawn. Six locale keys were written, translated into Arabic and
 * unreachable; `run_id`, `last_cycle` and `snapshot.runs` crossed the wire
 * every 800ms and landed nowhere; `{type:'notice'}` frames were parsed and
 * dropped because there was no branch for them.
 */

const english = await readLocale('en')

const story = (patch: Partial<StoryView> & { id: string }): StoryView => ({
  title: 'A story',
  status: 'todo',
  ui: false,
  depends_on: [],
  ...patch,
})

const plan = (patch: Partial<PlanView> & { id: string }): PlanView => ({
  title: 'A plan',
  approval: null,
  stories: [],
  ...patch,
})

const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const held = new Map<string, string>()
  return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) }
}

beforeEach(async () => {
  // The Run panel's feeds issue conditional GETs. There is no server here, and
  // a real request would only add a torn-down-fetch warning to every run; the
  // read api has its own suite.
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })))
  await loadPage()
  installForTest({ code: 'en', strings: english })
  installStorage(memoryStorage())
  installScheduler((fn) => fn())
})

/** Panels register against nodes; drawing a hidden one is a no-op by design. */
function reveal(id: string): HTMLElement {
  const node = document.getElementById(id) as HTMLElement
  node.hidden = false
  return node
}

/**
 * A read api that answers the paths a test names and 404s everything else.
 *
 * Routed rather than a single body: a panel that fetches two documents and
 * draws them into one block is exactly where an unrouted stub passes for the
 * wrong reason — every feed gets the same object and every assertion holds.
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

/** A parsed config, through the engine's own schema so every default is real. */
function configView(patch: Record<string, unknown> = {}): unknown {
  return {
    raw: 'version: 1\n',
    parsed: ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
      ...patch,
    }),
    invalid: false,
  }
}

const cells = (selector: string): (string | null)[] =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent)

describe('plans', () => {
  it('opens plan detail in context and exposes the state to keyboard users', async () => {
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'Large plan',
        approval: null,
        body: '# Large plan',
        review: null,
        stories: [],
      },
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            title: 'Large plan',
            stories: Array.from({ length: 22 }, (_, index) =>
              story({ id: `P001-S${String(index + 1).padStart(2, '0')}` }),
            ),
          }),
        ],
      }),
    )

    const open = document.querySelector('[data-act="open-plan"]') as HTMLButtonElement
    expect(open.getAttribute('aria-expanded')).toBe('false')

    mounted.toggle('P001')
    await vi.waitFor(() => expect((document.getElementById('plan-detail') as HTMLElement).hidden).toBe(false))

    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(open.getAttribute('aria-controls')).toBe('plan-detail')
    expect(document.activeElement).toBe(document.getElementById('plan-detail-title'))
    expect(document.getElementById('plans-workspace')?.dataset['detailOpen']).toBe('true')

    mounted.toggle('P001')
  })

  it('draws the status as a word and names what a story waits on', () => {
    reveal('panel-plans')
    mountPlans()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02', depends_on: ['P001-S01'] })],
          }),
        ],
      }),
    )

    const rows = document.querySelectorAll('#plans-list .story')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector('.story-status')?.textContent).toBe('done')
    expect(rows[1]?.querySelector('.story-status')?.textContent).toBe('todo')
    // Its one dependency is satisfied, so it is buildable and says nothing.
    expect((rows[1]?.querySelector('.waits') as HTMLElement).hidden).toBe(true)
    expect((rows[1]?.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables the build button and says why when a dependency is unmet', () => {
    reveal('panel-plans')
    mountPlans()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [story({ id: 'P001-S01' }), story({ id: 'P001-S02', depends_on: ['P001-S01'] })],
          }),
        ],
      }),
    )

    const second = document.querySelectorAll('#plans-list .story')[1] as HTMLElement
    const waits = second.querySelector('.waits') as HTMLElement
    expect(waits.hidden).toBe(false)
    expect(waits.textContent).toContain('P001-S01')
    expect((second.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('counts an unknown dependency as unmet', () => {
    // Treating an id nobody wrote as satisfied would turn a typo into a build.
    expect(unmet(story({ id: 'P001-S02', depends_on: ['P001-S09'] }), statusIndex([]))).toEqual(['P001-S09'])
  })

  it('suggests only the stories that are actually ready', () => {
    const snapshot = emptySnapshot({
      plans: [
        plan({
          id: 'P001',
          stories: [
            story({ id: 'P001-S01', status: 'done' }),
            story({ id: 'P001-S02', depends_on: ['P001-S01'] }),
            story({ id: 'P001-S03', depends_on: ['P001-S02'] }),
            story({ id: 'P001-S04', status: 'doing' }),
          ],
        }),
      ],
    })
    expect(suggestions(snapshot)).toEqual(['/mjloop:build P001-S02'])
  })
})

describe('derived state', () => {
  it("reads a plan's state off its stories and nothing else", () => {
    expect(planStatus(plan({ id: 'P001' }))).toBe('empty')
    expect(planStatus(plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] }))).toBe('done')
    expect(planStatus(plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] }))).toBe('todo')
    expect(
      planStatus(plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'doing' })] })),
    ).toBe('doing')
    // Blocked outranks doing: one blocked story is the thing worth saying.
    expect(
      planStatus(
        plan({
          id: 'P001',
          stories: [story({ id: 'P001-S01', status: 'doing' }), story({ id: 'P001-S02', status: 'blocked' })],
        }),
      ),
    ).toBe('blocked')
  })

  it('finds what is ready across every plan', () => {
    const plans = [
      plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02', depends_on: ['P001-S01'] })] }),
      plan({ id: 'P002', stories: [story({ id: 'P002-S01', depends_on: ['P001-S02'] })] }),
    ]
    // A dependency reaching across plans is still a dependency.
    expect(ready(plans).map((entry) => entry.id)).toEqual(['P001-S02'])
  })
})

describe('memory faceting', () => {
  const entry = (patch: { id: string; kind?: string; title?: string; tags?: string[]; body?: string }) => ({
    id: patch.id,
    kind: patch.kind ?? 'decision',
    title: patch.title ?? 'A decision',
    tags: patch.tags ?? [],
    at: '2026-07-28T09:00:00.000Z',
    run: null,
    body: patch.body ?? '',
  })

  it('matches every term across id, title, tags and body', () => {
    const all = [
      entry({ id: 'M001', title: 'Cookies over tokens', body: 'Because of SSR.' }),
      entry({ id: 'M002', kind: 'lesson', title: 'Retry the flake', tags: ['ci'] }),
    ]
    expect(facet(all, 'cookies ssr', '').map((memory) => memory.id)).toEqual(['M001'])
    expect(facet(all, 'ci', '').map((memory) => memory.id)).toEqual(['M002'])
    expect(facet(all, '', 'lesson').map((memory) => memory.id)).toEqual(['M002'])
    expect(facet(all, 'cookies', 'lesson')).toEqual([])
    expect(facet(all, '', '')).toHaveLength(2)
  })
})

describe('run', () => {
  it('draws run_id and the last cycle, which nothing drew before', () => {
    reveal('panel-run')
    mountRun()
    draw(
      emptySnapshot({
        state: {
          ...emptySnapshot().state,
          status: 'running',
          track: 'build',
          run_id: '20260728T120000Z--P001-S02--build',
          plan: 'P001',
          story: 'P001-S02',
          last_cycle: { result: 'fail', agents: ['builder', 'verifier'] },
        },
      }),
    )

    expect(document.getElementById('run-runid')?.textContent).toBe('20260728T120000Z--P001-S02--build')
    expect(document.getElementById('run-last-result')?.textContent).toBe('failed')
    expect([...document.querySelectorAll('#run-last-agents .chip')].map((node) => node.textContent)).toEqual([
      'builder',
      'verifier',
    ])
  })

  it('estimates the run nobody has started yet, and says when it has no basis', async () => {
    // The idle branch is the only moment the estimate can still change a
    // decision, and an idle state names no track — so the page names one, from
    // the config, and the engine answers for that track.
    serve({
      '/api/config': configView(),
      '/api/preflight/build': {
        track: 'build',
        max_cycles: 5,
        roster: {
          required: ['builder', 'verifier'],
          available: ['security'],
          forced: [],
          forbidden: [],
          closing: ['docs'],
        },
        dispatches_per_cycle: 3,
        ceiling: { cycles: 5, dispatches: 16 },
        comparable: null,
      },
    })

    reveal('panel-run')
    mountRun()
    draw(emptySnapshot())
    await vi.waitFor(() => expect((document.getElementById('run-preflight') as HTMLElement).hidden).toBe(false))

    expect((document.getElementById('preflight-track') as HTMLSelectElement).value).toBe('build')
    expect(cells('#preflight-facts dt')).toEqual([
      english['preflight.maxCycles'],
      english['preflight.perCycle'],
      english['preflight.ceiling'],
      english['preflight.required'],
      english['preflight.available'],
      english['preflight.closing'],
    ])
    expect(cells('#preflight-facts dd')).toEqual(['5', '3', '16', 'builder, verifier', 'security', 'docs'])
    // No comparable run is an answer. An invented range would not be.
    expect(document.getElementById('preflight-basis')?.textContent).toBe(english['preflight.noBasis'])
    expect(document.querySelectorAll('#preflight-past .fact')).toHaveLength(0)
  })
})

describe('evidence', () => {
  it('draws the run list with its outcomes', async () => {
    // The run list is a body, not a key: it names each run's story, track,
    // cycle count and whether it halted, none of which is in the snapshot.
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        new Response(
          url.startsWith('/api/runs?')
            ? JSON.stringify([
                { id: '2026-07-28-001--P001-S01--build', story: 'P001-S01', track: 'build', cycles: 2, halted: true },
              ])
            : '{}',
          { status: 200 },
        ),
      ),
    )

    reveal('panel-evidence')
    mountEvidence()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#evidence-list .run')).toHaveLength(1))

    const row = document.querySelector('#evidence-list .run') as HTMLElement
    expect(row.textContent).toContain('P001-S01')
    expect(row.textContent).toContain('halted')
    expect((document.getElementById('evidence-empty') as HTMLElement).hidden).toBe(true)
  })

  it('shows what the engine executed, including a queued command and the drift beside it', async () => {
    // The ledger is the only record that the suite behind a verdict actually
    // ran. A queued row means *nothing ran* — another command in this project
    // held the verify lock — and `live_command` means `config.yaml` moved
    // under the run, which the run reports and never obeys.
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
        ],
        verify_total: 9,
        handoff: '# Cycle 1\n\nbuilder: pass — the parser now reads the header.',
        handoff_truncated: false,
      },
    })

    reveal('panel-evidence')
    const evidence = mountEvidence()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#evidence-list .run')).toHaveLength(1))

    evidence.toggle(id)
    await vi.waitFor(() => expect(document.querySelectorAll('.grid-verify .grid-row')).toHaveLength(2))

    const rows = [...document.querySelectorAll('.grid-verify .grid-row')] as HTMLElement[]
    expect(rows[0]?.querySelector('[data-slot="command"]')?.textContent).toBe('npm test')
    expect(rows[0]?.querySelector('[data-slot="phase"]')?.textContent).toBe(english['evidence.verify.complete'])
    expect(rows[0]?.querySelector('[data-slot="exit"]')?.textContent).toBe('1')
    expect(rows[0]?.querySelector('[data-slot="duration"]')?.textContent).toBe('1.8s')
    // The command that is in the file now, beside the one that ran.
    expect(rows[0]?.querySelector('[data-slot="drift"]')?.textContent).toBe('npm test -- --coverage')
    expect(rows[1]?.querySelector('[data-slot="phase"]')?.textContent).toBe(english['evidence.verify.queued'])
    expect(rows[1]?.querySelector('[data-slot="exit"]')?.textContent).toBe('—')

    // Headings inside a cloned block are the row's own job — `translateStatic`
    // cannot reach into `<template>` content.
    expect(document.querySelector('.grid-verify [data-slot="vh-slot"]')?.textContent).toBe(
      english['evidence.verify.slot'],
    )

    // The reader caps the rows it serves; a cap nobody mentions reads as a
    // complete record with invocations missing from it.
    const more = document.querySelector('[data-slot="verifyMore"]') as HTMLElement
    expect(more.hidden).toBe(false)
    expect(more.textContent).toContain('9')

    const handoff = document.querySelector('.cycle-block details') as HTMLDetailsElement
    expect(handoff.hidden).toBe(false)
    expect(handoff.querySelector('[data-slot="handoff"]')?.textContent).toContain('the parser now reads the header')
    expect((handoff.querySelector('[data-slot="handoffCut"]') as HTMLElement).hidden).toBe(true)

    // Left as it was found: `opened` is module state, and a run left open here
    // would have the next test in this file fetching its cycles.
    evidence.toggle(id)
  })
})

describe('config', () => {
  it('renders one row per verify command, and the rest of the block as policy', async () => {
    // `verify:` is not a map of commands. It also carries `timeout_ms`,
    // `lock_timeout_ms` and `failure_patterns`, so a row per
    // `Object.entries(verify)` told an operator the engine executes a number —
    // under the heading "Verify commands", which is where they are told what
    // it does execute.
    serve({
      '/api/config': configView({
        verify: { test: 'npm test', build: 'npm run build', failure_patterns: { test: ['^FAIL'] } },
      }),
    })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#config-verify .fact')).toHaveLength(3))

    expect(cells('#config-verify dt')).toEqual(['verify.test', 'verify.lint', 'verify.build'])
    expect(cells('#config-verify dd')).toEqual(['npm test', english['config.verifyUnset'], 'npm run build'])

    expect(cells('#config-verify-policy dt')).toEqual([
      'verify.timeout_ms',
      'verify.lock_timeout_ms',
      'verify.failure_patterns.test',
    ])
    expect(cells('#config-verify-policy dd')).toEqual(['900000', '1800000', '^FAIL'])
    // What the entries walk actually put on screen for `failure_patterns`.
    expect(document.getElementById('panel-config')?.textContent).not.toContain('[object Object]')
  })

  it('reports what each specialist returned, and says so when there is nothing to report', async () => {
    serve({
      '/api/config': configView(),
      '/api/telemetry': {
        runs: 3,
        cycles: 7,
        specialists: [
          {
            agent: 'security',
            mode: 'auto',
            drafted: 6,
            skipped: 1,
            landed: 5,
            results: { pass: 4, fail: 1, blocked: 0 },
            findings: { high: 0, medium: 0, low: 2 },
            runs: 3,
            last_seen: '2026-07-28-002--adhoc--build',
          },
        ],
        truncated: 2,
        flagged: ['security'],
      },
    })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#telemetry-list .grid-row')).toHaveLength(1))

    const row = document.querySelector('#telemetry-list .grid-row') as HTMLElement
    expect(row.querySelector('[data-slot="agent"]')?.textContent).toBe('security')
    expect(row.querySelector('[data-slot="mode"]')?.textContent).toBe('auto')
    // Counts read against their heading, and never through `Intl`: `4/1/0`
    // must not arrive as `٤/١/٠` beside a Latin agent name.
    expect(row.querySelector('[data-slot="results"]')?.textContent).toBe('4/1/0')
    expect(row.querySelector('[data-slot="findings"]')?.textContent).toBe('0/0/2')
    expect((document.getElementById('telemetry-empty') as HTMLElement).hidden).toBe(true)
    expect(document.getElementById('telemetry-more')?.textContent).toContain('2')
    // Drafted six times with nothing high or medium to show for it.
    expect(document.getElementById('telemetry-flagged')?.textContent).toContain('security')
  })
})

describe('queue', () => {
  it('draws a job duration and its reason', () => {
    reveal('panel-queue')
    mountQueue()
    draw(
      emptySnapshot({
        queue: [
          {
            id: 'j1',
            command: '/mjloop:build P001-S02',
            status: 'failed',
            reason: { code: 'job.failed.exit', params: { code: 1 } },
            startedAt: '2026-07-28T12:00:00.000Z',
            endedAt: '2026-07-28T12:03:12.000Z',
          },
        ],
      }),
    )

    const row = document.querySelector('#queue-list .job') as HTMLElement
    expect(row.querySelector('.dur')?.textContent).toBe('3m 12s')
    expect(row.querySelector('.reason')?.textContent).toContain('code 1')
    expect(row.querySelector('.st')?.classList.contains('job-failed')).toBe(true)
  })
})

describe('rail', () => {
  it('promotes a config error out of a row and into a banner', () => {
    mountRail(railSlots())
    drawRail(emptySnapshot({ state: { ...emptySnapshot().state, config_error: 'bad indent at line 4' } }))

    const banner = document.querySelector('[data-rail="configBanner"]') as HTMLElement
    expect(banner.hidden).toBe(false)
    // The YAML renders as a sibling verbatim node rather than inside the
    // sentence: the server sends `{ code }` and never prose.
    expect(document.querySelector('[data-rail="configError"]')?.textContent).toBe('bad indent at line 4')
  })

  it('says so when the state came from the backup', () => {
    mountRail(railSlots())
    drawRail(emptySnapshot({ state: { ...emptySnapshot().state, recovered: true } }))
    expect((document.querySelector('[data-rail="staleBanner"]') as HTMLElement).hidden).toBe(false)
  })
})

describe('toasts', () => {
  it('renders a notice the page used to drop on the floor', () => {
    mountToasts(document.getElementById('toasts') as HTMLElement)
    toast({ code: 'queue.blocked', params: { job: '/mjloop:build P001-S02' } })
    const shown = document.querySelector('#toasts .toast')
    expect(shown?.textContent).toContain('/mjloop:build P001-S02')
  })
})

function railSlots(): Record<string, HTMLElement> {
  const slots: Record<string, HTMLElement> = {}
  for (const node of document.querySelectorAll('[data-rail]')) {
    const name = (node as HTMLElement).dataset['rail']
    if (name !== undefined) slots[name] = node as HTMLElement
  }
  return slots
}
