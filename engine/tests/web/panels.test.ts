// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { installForTest } from '../../src/web/public/lib/i18n.js'
import { installStorage } from '../../src/web/public/lib/local.js'
import { draw, installScheduler } from '../../src/web/public/ui/render.js'
import { drawRail, mountRail } from '../../src/web/public/ui/rail.js'
import { mountEvidence } from '../../src/web/public/panels/evidence.js'
import { mountPlans, statusIndex, unmet } from '../../src/web/public/panels/plans.js'
import { mountQueue } from '../../src/web/public/panels/queue.js'
import { mountRun } from '../../src/web/public/panels/run.js'
import { suggestions } from '../../src/web/public/panels/launcher.js'
import { mountToasts, toast } from '../../src/web/public/ui/toasts.js'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'
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

describe('plans', () => {
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
})

describe('evidence', () => {
  it('draws the run list', () => {
    reveal('panel-evidence')
    mountEvidence()
    draw(emptySnapshot({ runs: ['20260728T120000Z--adhoc--edit'] }))
    expect(document.querySelectorAll('#evidence-list .run')).toHaveLength(1)
    expect((document.getElementById('evidence-empty') as HTMLElement).hidden).toBe(true)
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
