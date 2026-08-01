// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installForTest } from '../../src/web/public/lib/i18n.js'
import { installStorage, read as prefs } from '../../src/web/public/lib/local.js'
import { draw, installScheduler, register } from '../../src/web/public/ui/render.js'
import { mountPlanDoc } from '../../src/web/public/lib/plandoc.js'
import { drawRail, mountRail } from '../../src/web/public/ui/rail.js'
import { collectConfigChanges, mountConfig } from '../../src/web/public/panels/config.js'
import { mountEvidence } from '../../src/web/public/panels/evidence.js'
import { joinAcceptances, mountSkills, shortDigest } from '../../src/web/public/panels/skills.js'
import { approvable, mountFeatures } from '../../src/web/public/panels/features.js'
import { mountPlans } from '../../src/web/public/panels/plans.js'
import { mountStories } from '../../src/web/public/panels/stories.js'
import { mountQueue } from '../../src/web/public/panels/queue.js'
import { mountRun } from '../../src/web/public/panels/run.js'
import { facet } from '../../src/web/public/panels/memory.js'
import { suggestions } from '../../src/web/public/panels/launcher.js'
import { mountToasts, toast } from '../../src/web/public/ui/toasts.js'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import { ConfigChangeSchema } from '../../src/store/config-mutation.js'
import type { FeatureDetail, ProfileView } from '../../src/web/read.js'
import type { FeatureSummary } from '../../src/store/feature-store.js'
import type { FeatureBrief } from '../../src/schemas/feature.js'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import type { ProjectSkillAcceptance } from '../../src/schemas/skill-acceptance.js'
import type { Job, PlanView, StoryView } from '../../src/web/protocol.js'
import type { StoryDetail } from '../../src/web/read.js'

/**
 * The milestone's own claim, asserted: everything the server already sends
 * finally gets drawn. Six locale keys were written, translated into Arabic and
 * unreachable; `run_id`, `last_cycle` and `snapshot.runs` crossed the wire
 * every 800ms and landed nowhere; `{type:'notice'}` frames were parsed and
 * dropped because there was no branch for them.
 */

/**
 * The socket, captured rather than opened.
 *
 * `send` no-ops when nothing is connected, so a write would leave no trace and
 * a test asserting a button exists would pass for a control that sends an empty
 * frame. The frame *is* the behaviour under test.
 */
const sent: unknown[] = []
vi.mock('../../src/web/public/net/socket.js', () => ({
  connect: () => {},
  send: (message: unknown) => void sent.push(message),
}))

/** One timestamp for every fixture, so a diff of two records shows the field that moved. */
const NOW = '2026-07-28T09:00:00.000Z'

const english = await readLocale('en')

const story = (patch: Partial<StoryView> & { id: string }): StoryView => ({
  title: 'A story',
  status: 'todo',
  ui: false,
  depends_on: [],
  ...patch,
})

/** A story as the read api serves it: frontmatter the manifest does not carry. */
const detailStory = (patch: Partial<StoryDetail> & { id: string }): StoryDetail => ({
  title: 'A story',
  status: 'todo',
  ui: false,
  depends_on: [],
  acceptance: [],
  evidence: null,
  body: '',
  ...patch,
})

const plan = (patch: Partial<PlanView> & { id: string }): PlanView => ({
  title: 'A plan',
  approval: null,
  stories: [],
  ...patch,
})

/** @param seed What `mjloop.prefs` already holds, for the cases that are about a reload. */
const memoryStorage = (seed?: string): Pick<Storage, 'getItem' | 'setItem'> => {
  const held = new Map<string, string>()
  if (seed !== undefined) held.set('mjloop.prefs', seed)
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
  sent.length = 0
  mountDoc()
})

/**
 * What `app.js` does: the open plan's document is ticked from `.tabs`, which is
 * on screen whatever tab is open, because `ui/render.js` skips a hidden panel.
 * A suite that mounts panels directly has to wire it the same way or it is
 * testing a page nobody ships.
 */
function mountDoc(): void {
  const planDoc = mountPlanDoc()
  register({
    id: 'plandoc',
    node: document.querySelector('.tabs') as HTMLElement,
    update: (snapshot) => planDoc.update(snapshot),
  })
}

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
    revision: 'a'.repeat(64),
    parsed: ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
      ...patch,
    }),
    invalid: false,
  }
}

/**
 * What `/api/profile` serves, typed against the reader that serves it. A field
 * renamed on the engine side is a compile error here rather than a slot that
 * quietly goes blank on the Config tab.
 */
function profileView(patch: Partial<ProfileView> = {}): ProfileView {
  return {
    revision: 2,
    acceptedAt: '2026-07-28T09:00:00.000Z',
    acceptedBy: 'dashboard:mohd',
    components: [
      {
        id: 'apps-mobile',
        root: 'apps/mobile',
        technology: 'flutter',
        verification: { test: 'cd apps/mobile && flutter test', lint: null, build: null },
        skillTags: ['flutter'],
      },
      {
        id: 'web',
        root: 'web',
        technology: 'nextjs',
        verification: { test: 'cd web && npm test', lint: 'cd web && npm run lint', build: null },
        skillTags: ['nextjs'],
      },
    ],
    proposedAt: null,
    proposalDiffers: false,
    ...patch,
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

  it('opens the plan the reader left open, with no click', async () => {
    // The whole point of persisting the selection: a reload is not a reset.
    // Mount reads it, so a plan that was open before the refresh is open after.
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
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
    mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001' })] }))

    await vi.waitFor(() => expect((document.getElementById('plan-detail') as HTMLElement).hidden).toBe(false))
    expect(document.getElementById('plan-detail-title')?.textContent).toContain('Large plan')
  })

  it('keeps a plan the snapshot has stopped listing rather than forgetting it', async () => {
    // A frame that does not list the open plan hides the detail; it must not
    // write the selection away. snapshot.ts already refuses to let one
    // unreadable plan directory blank the whole panel, and a reader whose plan
    // blinked out of one frame has not asked to close it.
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    reveal('panel-plans')
    mountPlans()
    draw(emptySnapshot({ plans: [] }))
    expect(prefs().activePlan).toBe('P001')
    expect((document.getElementById('plan-detail') as HTMLElement).hidden).toBe(true)
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

describe('stories', () => {
  /** The Stories panel reads the plan the reader has open; every case here opens one. */
  function openPlan(id = 'P001'): void {
    installStorage(memoryStorage(JSON.stringify({ activePlan: id })))
    mountDoc()
    reveal('panel-stories')
    mountStories()
  }

  it('draws each story once, in the open plan, with its status as a word', async () => {
    // Once, and in a tab of their own. They used to be drawn inline under every
    // plan row as well, which is what made a plan of twenty-two unreadable, and
    // then three clicks inside a plan's detail, which is what this tab fixes.
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', status: 'done', evidence: '2026-07-28-001' }),
          detailStory({ id: 'P001-S02', depends_on: ['P001-S01'] }),
        ],
      },
    })
    openPlan()
    const snapshot = emptySnapshot({
      plans: [
        plan({
          id: 'P001',
          stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02', depends_on: ['P001-S01'] })],
        }),
      ],
    })
    draw(snapshot)

        await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(2))

    const rows = document.querySelectorAll('#stories-list .story')
    expect(rows[0]?.querySelector('.story-status')?.textContent).toBe('done')
    expect(rows[1]?.querySelector('.story-status')?.textContent).toBe('todo')
    // Its one dependency is satisfied, so it is buildable and says nothing.
    expect((rows[1]?.querySelector('.waits') as HTMLElement).hidden).toBe(true)
    expect((rows[1]?.querySelector('[data-act="story-run"]') as HTMLButtonElement).disabled).toBe(false)
    // The action is a word, not a `+`.
    expect(rows[1]?.querySelector('[data-act="story-run"]')?.textContent).toBe(english['story.runAction'])

  })

  it('disables the build button and says why when a dependency is unmet', async () => {
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01' }), detailStory({ id: 'P001-S02', depends_on: ['P001-S01'] })],
      },
    })
    openPlan()
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
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(2))

    const second = document.querySelectorAll('#stories-list .story')[1] as HTMLElement
    const waits = second.querySelector('.waits') as HTMLElement
    expect(waits.hidden).toBe(false)
    expect(waits.textContent).toContain('P001-S01')
    expect((second.querySelector('[data-act="story-run"]') as HTMLButtonElement).disabled).toBe(true)

  })

  it('filters the open plan down to what the reader asked for', async () => {
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', status: 'done', title: 'Rebaseline PROGRESS.md', evidence: 'r1' }),
          detailStory({ id: 'P001-S02', title: 'Amend DECISIONS.md' }),
        ],
      },
    })
    openPlan()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02' })],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(2))

    const picker = document.getElementById('story-filter') as HTMLSelectElement
    picker.value = 'ready'
    picker.dispatchEvent(new Event('change'))
    // `ready` is a status *and* a dependency check, which is the filter people
    // actually want and the one no status column could offer.
    expect(cells('#stories-list .story .story-id')).toEqual(['P001-S02'])

    const query = document.getElementById('story-query') as HTMLInputElement
    picker.value = ''
    picker.dispatchEvent(new Event('change'))
    query.value = 'progress'
    query.dispatchEvent(new Event('input'))
    expect(cells('#stories-list .story .story-id')).toEqual(['P001-S01'])

    query.value = 'nothing matches this'
    query.dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('#stories-list .story')).toHaveLength(0)
    expect((document.getElementById('stories-empty') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('stories-empty')?.textContent).toBe(english['story.noMatch'])

  })

  /** A plan document with three stories, and the panel mounted over it. */
  async function openThree(
    seed: Record<string, unknown> = { activePlan: 'P001' },
  ): Promise<ReturnType<typeof mountStories>> {
    installStorage(memoryStorage(JSON.stringify(seed)))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', title: 'One', status: 'done' }),
          detailStory({ id: 'P001-S02', title: 'Two', acceptance: ['It works.'] }),
          detailStory({ id: 'P001-S03', title: 'Three', depends_on: ['P001-S02'] }),
        ],
      },
    })
    mountDoc()
    reveal('panel-stories')
    const mounted = mountStories()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [
              story({ id: 'P001-S01', status: 'done' }),
              story({ id: 'P001-S02' }),
              story({ id: 'P001-S03', depends_on: ['P001-S02'] }),
            ],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(3))
    return mounted
  }

  const tabIds = (): (string | undefined)[] =>
    [...document.querySelectorAll('#story-tabs .worktab-open')].map((node) => (node as HTMLElement).dataset['tab'])

  const selected = (): string | undefined =>
    (document.querySelector('#story-tabs [aria-selected="true"]') as HTMLElement | null)?.dataset['tab']

  it('opens a story into a tab, and the tab shows that story', async () => {
    const stories = await openThree()
    expect((document.getElementById('story-tabs') as HTMLElement).hidden).toBe(true)

    stories.openTab('P001-S02')
    await vi.waitFor(() => expect(tabIds()).toEqual(['P001-S02']))
    expect(selected()).toBe('P001-S02')
    expect((document.getElementById('story-open') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S02 — Two')
    // Everything in the pane comes off the document the list already has.
    expect(document.getElementById('story-open-accept-summary')?.textContent).toContain('1')
    // A story nobody wrote a body for renders one that shows nothing —
    // collapsed and empty, not omitted.
    expect((document.getElementById('story-open-body-details') as HTMLElement).hidden).toBe(true)
  })

  it('renders the story body B4 adds to the read side, beside the acceptance criteria', async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01', title: 'One', body: 'Log in with a mailed link.' })],
      },
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(1))

    stories.openTab('P001-S01')
    await vi.waitFor(() => expect((document.getElementById('story-open') as HTMLElement).hidden).toBe(false))

    // A document, not prose: rendered through `verbatim()`, exactly as
    // `panels/plans.js` renders PLAN.md — never translated, never escaped.
    expect((document.getElementById('story-open-body-details') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('story-open-body')?.textContent).toBe('Log in with a mailed link.')
  })

  it('names what a story unblocks, the inverse edge nothing on disk stores', async () => {
    // P001-S03 is the only story that names P001-S02 in its own `depends_on`;
    // the plan document carries that edge in one direction only, so this is
    // `dependents()` walking every other story rather than a field the engine
    // ever writes.
    const stories = await openThree()

    stories.openTab('P001-S02')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S02 — Two'))
    expect(cells('#story-open-facts dd')[2]).toBe('P001-S03')

    // P001-S01 unblocks nothing — the same dash `story.fact.dependsOn` already
    // shows for a story with no dependencies of its own.
    stories.openTab('P001-S01')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S01 — One'))
    expect(cells('#story-open-facts dd')[2]).toBe('—')
  })

  it("narrows the open story's execution history to its own runs, out of the shared list", async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', title: 'One' }),
          detailStory({ id: 'P001-S02', title: 'Two' }),
          detailStory({ id: 'P001-S03', title: 'Three' }),
        ],
      },
      // Two runs, naming two different stories — the filter is only actually
      // exercised when there is another story's run for it to drop.
      '/api/runs': [
        { id: '2026-07-28-001--P001-S01--build', story: 'P001-S01', track: 'build', cycles: 2, halted: false },
        { id: '2026-07-28-002--P001-S02--build', story: 'P001-S02', track: 'build', cycles: 1, halted: true },
      ],
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [story({ id: 'P001-S01' }), story({ id: 'P001-S02' }), story({ id: 'P001-S03' })],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(3))

    stories.openTab('P001-S01')
    await vi.waitFor(() => expect(document.querySelectorAll('#story-open-runs .run')).toHaveLength(1))
    const first = document.querySelector('#story-open-runs .run') as HTMLElement
    expect(first.textContent).toContain('2026-07-28-001--P001-S01--build')
    expect(first.textContent).not.toContain('2026-07-28-002--P001-S02--build')
    expect(first.textContent).toContain('ended')
    // The track and cycles cells render data no other assertion here reads —
    // pinned so a blank chip or a frozen count would fail this test rather
    // than ship unnoticed (both columns were previously inert).
    expect(first.querySelector('.chip')?.textContent).toBe('build')
    expect(first.querySelector('[data-slot="cycles"]')?.textContent).toBe('2 cycles')
    expect((document.getElementById('story-open-runs-empty') as HTMLElement).hidden).toBe(true)

    stories.openTab('P001-S02')
    await vi.waitFor(() =>
      expect(document.querySelector('#story-open-runs .run')?.textContent).toContain('2026-07-28-002--P001-S02--build'),
    )
    const second = document.querySelector('#story-open-runs .run') as HTMLElement
    expect(second.textContent).not.toContain('2026-07-28-001--P001-S01--build')
    expect(second.textContent).toContain('halted')
    expect(second.querySelector('.chip')?.textContent).toBe('build')
    expect(second.querySelector('[data-slot="cycles"]')?.textContent).toBe('1 cycle')
    expect(document.querySelectorAll('#story-open-runs .run')).toHaveLength(1)

    // A third story the run list never names — the shared feed has entries,
    // just none for this one.
    stories.openTab('P001-S03')
    await vi.waitFor(() =>
      expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S03 — Three'),
    )
    expect(document.querySelectorAll('#story-open-runs .run')).toHaveLength(0)
    expect((document.getElementById('story-open-runs-empty') as HTMLElement).hidden).toBe(false)
  })

  /**
   * A plan built for the readiness inspector: two dependencies in different
   * non-`done` statuses, a story that waits on both, and a story with nothing
   * standing in its way. `story` (the manifest fixture) drives the readiness
   * check `unmet()` reads; `detailStory` drives the read side the pane draws.
   */
  async function openReadinessFixture(): Promise<ReturnType<typeof mountStories>> {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', title: 'One', status: 'doing' }),
          detailStory({ id: 'P001-S02', title: 'Two', status: 'blocked' }),
          detailStory({ id: 'P001-S03', title: 'Three', depends_on: ['P001-S01', 'P001-S02'] }),
          detailStory({ id: 'P001-S04', title: 'Four' }),
          // A typo'd `depends_on`: `P001-S99` names no story in this plan.
          // `assertDependenciesResolve` (ops/plan.ts:239-250) refuses this at
          // write time, but a hand-edited story file on disk is exactly the
          // case that check exists for, and `unmet()` still has to answer.
          detailStory({ id: 'P001-S05', title: 'Five', depends_on: ['P001-S99'] }),
        ],
      },
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [
              story({ id: 'P001-S01', status: 'doing' }),
              story({ id: 'P001-S02', status: 'blocked' }),
              story({ id: 'P001-S03', depends_on: ['P001-S01', 'P001-S02'] }),
              story({ id: 'P001-S04' }),
              story({ id: 'P001-S05', depends_on: ['P001-S99'] }),
            ],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(5))
    return stories
  }

  it('reads out each unmet dependency with its own status, and previews the exact Build command', async () => {
    const stories = await openReadinessFixture()

    // Blocked by two dependencies in two different statuses: the inspector
    // names both, structurally — never the composed "Waits on P001-S01,
    // P001-S02" sentence this replaced.
    stories.openTab('P001-S03')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S03 — Three'))
    expect((document.getElementById('story-open-waits') as HTMLElement).hidden).toBe(false)
    const rows = [...document.querySelectorAll('#story-open-waits .wait-row')]
    expect(rows.map((row) => row.querySelector('.story-id')?.textContent)).toEqual(['P001-S01', 'P001-S02'])
    expect(rows.map((row) => row.querySelector('.story-status')?.textContent)).toEqual(['doing', 'blocked'])
    // Colour is never the only signal for a status — a word too, always — but
    // the class is the reinforcement, and it has to name the *dependency's*
    // status, not the open story's own.
    expect(rows[0]?.querySelector('.story-status')?.classList.contains('status-doing')).toBe(true)
    expect(rows[1]?.querySelector('.story-status')?.classList.contains('status-blocked')).toBe(true)
    expect(document.getElementById('story-open-meta')?.textContent).toBe(english['story.waitsOn'])
    // What Build would actually enqueue for this story — `bus.on('story-run')`
    // (app.js) sends this exact string, character for character.
    expect(document.getElementById('story-open-command')?.textContent).toBe('/mjloop:build P001-S03')

    // Nothing standing in its way: no rows, the existing "clear" phrase, and
    // the command preview follows the id that is actually open.
    stories.openTab('P001-S04')
    await vi.waitFor(() =>
      expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S04 — Four'),
    )
    expect((document.getElementById('story-open-waits') as HTMLElement).hidden).toBe(true)
    expect(document.querySelectorAll('#story-open-waits .wait-row')).toHaveLength(0)
    expect(document.getElementById('story-open-meta')?.textContent).toBe(english['story.open.clear'])
    expect(document.getElementById('story-open-command')?.textContent).toBe('/mjloop:build P001-S04')

    // A dependency this plan's own index cannot resolve — a typo, per
    // `unmet()`'s own doc — still gets a row: the id itself, with no status
    // word to lie about.
    stories.openTab('P001-S05')
    await vi.waitFor(() =>
      expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S05 — Five'),
    )
    const unresolved = [...document.querySelectorAll('#story-open-waits .wait-row')]
    expect(unresolved.map((row) => row.querySelector('.story-id')?.textContent)).toEqual(['P001-S99'])
    expect(unresolved.map((row) => row.querySelector('.story-status')?.textContent)).toEqual(['—'])
  })

  it('says which non-dependency reason a story is not ready, reusing story.notBuildable rather than a fifth wording', async () => {
    const stories = await openReadinessFixture()

    // `doing`: already being built.
    stories.openTab('P001-S01')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S01 — One'))
    expect(document.getElementById('story-open-meta')?.textContent).toBe(english['story.notBuildable.doing'])
    expect((document.getElementById('story-open-waits') as HTMLElement).hidden).toBe(true)

    // `blocked`: the last run could not finish it.
    stories.openTab('P001-S02')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S02 — Two'))
    expect(document.getElementById('story-open-meta')?.textContent).toBe(english['story.notBuildable.blocked'])
    expect((document.getElementById('story-open-waits') as HTMLElement).hidden).toBe(true)
  })

  it('walks the strip with the arrow keys, and the direction follows the document', async () => {
    // The page's first keyboard interaction. ui/tabs.js refused role="tablist"
    // precisely because arrows have to honour text direction; this takes that on
    // rather than hardcoding a sign, so the Arabic case is its own assertion.
    const stories = await openThree()
    stories.openTab('P001-S01')
    stories.openTab('P001-S02')
    stories.openTab('P001-S03')
    await vi.waitFor(() => expect(tabIds()).toEqual(['P001-S01', 'P001-S02', 'P001-S03']))
    expect(selected()).toBe('P001-S03')

    const strip = document.getElementById('story-tabs') as HTMLElement
    const press = (key: string) => strip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

    document.documentElement.dir = 'ltr'
    press('ArrowRight')
    expect(selected()).toBe('P001-S01')
    press('ArrowLeft')
    expect(selected()).toBe('P001-S03')
    press('Home')
    expect(selected()).toBe('P001-S01')
    press('End')
    expect(selected()).toBe('P001-S03')

    // Mirrored. ArrowRight means *previous* when the document runs right to left.
    document.documentElement.dir = 'rtl'
    press('Home')
    expect(selected()).toBe('P001-S01')
    press('ArrowRight')
    expect(selected()).toBe('P001-S03')
    press('ArrowLeft')
    expect(selected()).toBe('P001-S01')
    document.documentElement.dir = 'ltr'
  })

  it('keeps exactly one tab in the page tab order', async () => {
    const stories = await openThree()
    stories.openTab('P001-S01')
    stories.openTab('P001-S02')
    await vi.waitFor(() => expect(tabIds()).toHaveLength(2))

    const order = [...document.querySelectorAll('#story-tabs .worktab-open')].map((node) =>
      node.getAttribute('tabindex'),
    )
    // Roving: a strip of twelve stories that each cost a Tab press to walk past
    // is a strip nobody keyboards through twice.
    expect(order).toEqual(['-1', '0'])
  })

  it('closes a tab, and puts the last closed one back', async () => {
    const stories = await openThree()
    stories.openTab('P001-S01')
    stories.openTab('P001-S02')
    await vi.waitFor(() => expect(tabIds()).toHaveLength(2))

    stories.closeTab('P001-S02')
    await vi.waitFor(() => expect(tabIds()).toEqual(['P001-S01']))
    expect((document.getElementById('story-tabs-reopen') as HTMLElement).hidden).toBe(false)

    stories.reopenTab()
    await vi.waitFor(() => expect(tabIds()).toEqual(['P001-S01', 'P001-S02']))
    expect((document.getElementById('story-tabs-reopen') as HTMLElement).hidden).toBe(true)
  })

  it('a pinned tab offers no close button', async () => {
    const stories = await openThree()
    stories.openTab('P001-S01')
    await vi.waitFor(() => expect(tabIds()).toEqual(['P001-S01']))
    expect((document.querySelector('#story-tabs .worktab-close') as HTMLElement).hidden).toBe(false)

    stories.pinTab('P001-S01')
    // Not a disabled one: the point of pinning is that closing is not the next
    // thing you do.
    await vi.waitFor(() =>
      expect((document.querySelector('#story-tabs .worktab-close') as HTMLElement).hidden).toBe(true),
    )
    expect(document.querySelector('#story-tabs .worktab-pin')?.classList.contains('pinned-yes')).toBe(true)
  })

  it('drops a tab whose story the plan no longer carries', async () => {
    // A story can be renamed on disk. A tab that outlives its subject is a
    // control that opens nothing.
    await openThree({ activePlan: 'P001', openStories: [{ id: 'P001-S99', pinned: false }] })
    expect(tabIds()).toEqual([])
    expect((document.getElementById('story-open') as HTMLElement).hidden).toBe(true)
  })

  it('restores the filter the reader chose, with no click', async () => {
    // The picker shows the remembered value rather than merely holding it: a
    // list filtered to `done` under a picker reading `All stories` is a page
    // arguing with itself.
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001', storyFilter: 'done' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'Large plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', title: 'Done one', status: 'done' }),
          detailStory({ id: 'P001-S02', title: 'Todo one' }),
        ],
      },
    })
    mountDoc()
    reveal('panel-stories')
    mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02' })] })] }))

    expect((document.getElementById('story-filter') as HTMLSelectElement).value).toBe('done')
    await vi.waitFor(() => expect(cells('#stories-list .story .story-id')).toEqual(['P001-S01']))
  })

  it('names the buildable stories and marks the one that is next', () => {
    openPlan()
    draw(
      emptySnapshot({
        plans: [
          plan({
            id: 'P001',
            stories: [
              story({ id: 'P001-S01', title: 'First up' }),
              story({ id: 'P001-S02', title: 'Also ready' }),
              story({ id: 'P001-S03', depends_on: ['P001-S01'] }),
            ],
          }),
        ],
      }),
    )

    const rows = document.querySelectorAll('#stories-ready-list .ready-row')
    expect(rows).toHaveLength(2)
    // The title travels with the id. A `P001-S02` chip asked the reader to hold
    // an id in their head and go and look it up.
    expect(rows[0]?.querySelector('.story-title')?.textContent).toBe('First up')
    expect(rows[0]?.querySelector('[data-slot="plan"]')?.textContent).toBe('P001')
    expect((rows[0]?.querySelector('.tag.next') as HTMLElement).hidden).toBe(false)
    expect((rows[1]?.querySelector('.tag.next') as HTMLElement).hidden).toBe(true)

  })

  it('counts the same stories the Plans tally does', () => {
    // The two live in different tabs now, which is exactly why this is asserted:
    // both go through lib/stories.js, and a second readiness rule appearing in
    // either one would show up here as two numbers that disagree.
    openPlan()
    reveal('panel-plans')
    mountPlans()
    const snapshot = emptySnapshot({
      plans: [
        plan({
          id: 'P001',
          stories: [
            story({ id: 'P001-S01', title: 'First up' }),
            story({ id: 'P001-S02', title: 'Also ready' }),
            story({ id: 'P001-S03', depends_on: ['P001-S01'] }),
          ],
        }),
      ],
    })
    draw(snapshot)

    expect(document.querySelectorAll('#stories-ready-list .ready-row')).toHaveLength(2)
    expect(document.getElementById('tally-ready')?.textContent).toBe('2')
    expect(document.getElementById('tally-done')?.textContent).toBe('0')
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
  it('seeds an editable typed form and emits only changed allowlisted fields', async () => {
    serve({
      '/api/config': configView({
        autonomous: false,
        limits: { max_parallel_agents: 4, no_progress_strikes: 2 },
        verify: { test: 'npm test', lint: null, build: 'npm run build' },
      }),
    })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    await vi.waitFor(() =>
      expect((document.getElementById('config-max-parallel-input') as HTMLInputElement).value).toBe('4'),
    )

    const form = document.getElementById('config-editor') as HTMLFormElement
    const autonomous = document.getElementById('config-autonomous-input') as HTMLInputElement
    const test = document.getElementById('config-test-input') as HTMLInputElement
    const specialists = document.getElementById('config-specialists-input') as HTMLTextAreaElement
    const tracks = document.getElementById('config-tracks-input') as HTMLTextAreaElement
    autonomous.checked = true
    test.value = 'npm run test:ci'
    specialists.value = JSON.stringify({ security: 'always' })
    const editedTracks = JSON.parse(tracks.value)
    editedTracks.build.max_cycles = 7
    tracks.value = JSON.stringify(editedTracks)

    const baseline = ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
      autonomous: false,
      limits: { max_parallel_agents: 4, no_progress_strikes: 2 },
      verify: { test: 'npm test', lint: null, build: 'npm run build' },
    })
    expect(collectConfigChanges(form, baseline)).toEqual([
      { kind: 'root', key: 'autonomous', value: true },
      { kind: 'verify.command', key: 'test', value: 'npm run test:ci' },
      { kind: 'specialist', agent: 'security', value: 'always' },
      {
        kind: 'track',
        track: 'build',
        value: {
          required: ['builder'],
          available: [],
          closing: [],
          max_cycles: 7,
        },
      },
    ])
  })

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

  it('turns every orchestration control into the change vocabulary the server accepts', async () => {
    serve({ '/api/config': configView() })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    // Waited on a *seeded* value rather than on the select, whose first option
    // is already `off` before anything has been fetched at all.
    await vi.waitFor(() =>
      expect((document.getElementById('config-question-budget-input') as HTMLInputElement).value).toBe('8'),
    )

    const form = document.getElementById('config-editor') as HTMLFormElement
    /** @see index.html — one control per orchestration leaf. */
    const control = (id: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

    // Seeded from the parsed document, which is what makes an untouched control
    // emit nothing: this is the state the schema's defaults put on screen.
    expect((control('config-question-budget-input') as HTMLInputElement).value).toBe('8')
    expect((control('config-repair-attempts-input') as HTMLInputElement).value).toBe('1')
    expect((control('config-source-github-input') as HTMLInputElement).checked).toBe(true)
    expect((control('config-source-web-input') as HTMLInputElement).checked).toBe(false)
    expect(collectConfigChanges(form, baselineConfig())).toEqual([])

    ;(control('config-auto-accept-input') as HTMLInputElement).checked = true
    // `always` before `auto-plan`: the two are one document-level rule —
    // completion `auto-plan` under discovery `off` names a start nothing ever
    // produces, and `ConfigSchema.superRefine` refuses the pair.
    control('config-discovery-mode-input').value = 'always'
    control('config-question-budget-input').value = '12'
    control('config-discovery-completion-input').value = 'auto-plan'
    control('config-after-approval-input').value = 'auto'
    control('config-concurrency-input').value = 'parallel'
    control('config-repair-attempts-input').value = '3'
    ;(control('config-plan-review-input') as HTMLInputElement).checked = true
    ;(control('config-independent-verify-input') as HTMLInputElement).checked = true
    // The other whole-document rule: a `registry` source with nothing trusted
    // admits no skill at all, so the panel can express the pair or neither.
    ;(control('config-source-registry-input') as HTMLInputElement).checked = true
    control('config-registries-input').value = 'https://skills.example.com\n\n'
    control('config-update-mode-input').value = 'pinned'

    const changes = collectConfigChanges(form, baselineConfig())
    expect(changes).toEqual([
      { kind: 'orchestration.profile.auto_accept', value: true },
      { kind: 'orchestration.discovery.mode', value: 'always' },
      { kind: 'orchestration.discovery.question_budget', value: 12 },
      { kind: 'orchestration.discovery.completion', value: 'auto-plan' },
      { kind: 'orchestration.execution.after_plan_approval', value: 'auto' },
      { kind: 'orchestration.execution.uncertain_concurrency', value: 'parallel' },
      { kind: 'orchestration.execution.repair_attempts', value: 3 },
      { kind: 'orchestration.quality', key: 'independent_plan_review', value: true },
      { kind: 'orchestration.quality', key: 'independent_verification', value: true },
      { kind: 'orchestration.skills.sources', value: ['github', 'registry'] },
      { kind: 'orchestration.skills.trusted_registries', value: ['https://skills.example.com'] },
      { kind: 'orchestration.skills.update_mode', value: 'pinned' },
    ])
    // And every one of them is a change the wire actually admits. The panel
    // shares no code with the server's schema, so this is the only place the
    // two vocabularies are checked against each other.
    for (const change of changes) {
      expect(ConfigChangeSchema.safeParse(change).success, JSON.stringify(change)).toBe(true)
    }
  })

  it('refuses a pair of orchestration settings the whole document would reject', async () => {
    serve({ '/api/config': configView() })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    await vi.waitFor(() =>
      expect((document.getElementById('config-question-budget-input') as HTMLInputElement).value).toBe('8'),
    )

    const save = document.getElementById('config-save') as HTMLButtonElement
    const state = document.getElementById('config-editor-state') as HTMLElement
    const move = (id: string, edit: (control: HTMLInputElement & HTMLSelectElement) => void): void => {
      const control = document.getElementById(id) as HTMLInputElement & HTMLSelectElement
      edit(control)
      control.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // `auto-plan` under a discovery mode of `off` names a start nothing ever
    // produces. The server refuses the patch under the project lock and is
    // right to — but it refuses it whole, so a person who moved eight settings
    // would be told only that one of them was wrong.
    move('config-discovery-completion-input', (control) => (control.value = 'auto-plan'))
    expect(save.disabled).toBe(true)
    expect(state.hidden).toBe(false)
    expect(state.textContent).toBe(english['config.problem.autoPlanOff'])

    // Switching discovery on is what makes the completion mean something, and
    // the refusal has to lift the moment it does.
    move('config-discovery-mode-input', (control) => (control.value = 'always'))
    expect(save.disabled).toBe(false)
    expect(state.hidden).toBe(true)

    // The other pair, the same way round.
    move('config-source-registry-input', (control) => (control.checked = true))
    expect(save.disabled).toBe(true)
    expect(state.textContent).toBe(english['config.problem.registryUntrusted'])

    move('config-registries-input', (control) => (control.value = 'https://skills.example.com'))
    expect(save.disabled).toBe(false)
    expect(state.hidden).toBe(true)
  })

  it('refuses a trusted registry the wire schema would drop the whole frame over', async () => {
    serve({ '/api/config': configView() })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    await vi.waitFor(() =>
      expect((document.getElementById('config-question-budget-input') as HTMLInputElement).value).toBe('8'),
    )

    const save = document.getElementById('config-save') as HTMLButtonElement
    const state = document.getElementById('config-editor-state') as HTMLElement
    const registries = document.getElementById('config-registries-input') as HTMLTextAreaElement
    const type = (value: string): void => {
      registries.value = value
      registries.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Every other orchestration control is a select, a checkbox or a number
    // input the browser itself constrains, so this textarea is the only one that
    // can express a value `ConfigChangeSchema` refuses. A refused *change* is
    // not a refused save: the server drops an unparseable frame without
    // answering it, and this panel clears `saving` only from a receipt — so the
    // save that carried it never settles and the editor is wedged until the tab
    // is reloaded, taking every other setting edited in the same press with it.
    type('http://registry.internal')
    expect(save.disabled).toBe(true)
    expect(state.hidden).toBe(false)
    expect(state.textContent).toBe(english['config.problem.registryNotHttps'])

    // One bad line among good ones is still the whole frame.
    type('https://skills.example.com\nftp://mirror.internal\n')
    expect(save.disabled).toBe(true)
    expect(state.textContent).toBe(english['config.problem.registryNotHttps'])

    type('https://skills.example.com\n\nhttps://mirror.internal\n')
    expect(save.disabled).toBe(false)
    expect(state.hidden).toBe(true)
  })

  it('will not save an orchestration edit onto a config that moved underneath it', async () => {
    let served: unknown = configView()
    vi.stubGlobal('fetch', (url: string) => {
      const config = url.startsWith('/api/config')
      return Promise.resolve(
        new Response(JSON.stringify(config ? served : { error: { code: 'error.notFound' } }), {
          status: config ? 200 : 404,
        }),
      )
    })

    reveal('panel-config')
    mountConfig()
    draw(emptySnapshot())
    // Waited on a *seeded* value rather than on the select, whose first option
    // is already `off` before anything has been fetched at all.
    await vi.waitFor(() =>
      expect((document.getElementById('config-question-budget-input') as HTMLInputElement).value).toBe('8'),
    )

    const mode = document.getElementById('config-discovery-mode-input') as HTMLSelectElement
    mode.value = 'always'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
    expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(false)

    // Somebody else wrote `config.yaml` — a `mjloop-cli config set`, or another
    // tab. The revision this editor holds is no longer the file's, so the save
    // that would overwrite their choice is refused here rather than sent and
    // refused by the mutator's compare-and-swap.
    served = { ...(configView({ orchestration: { discovery: { mode: 'ask' } } }) as object), revision: 'b'.repeat(64) }
    draw(emptySnapshot({ revisions: { ...emptySnapshot().revisions, config: 'moved' } }))
    await vi.waitFor(() =>
      expect((document.getElementById('config-editor-state') as HTMLElement).hidden).toBe(false),
    )

    expect(document.getElementById('config-editor-state')?.textContent).toBe(english['config.editorChanged'])
    expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    // The choice the other writer made is what the page now holds, not the one
    // this editor was mid-way through.
    expect((document.getElementById('config-reset') as HTMLButtonElement).disabled).toBe(false)
  })

})

/**
 * The component map moved here from Config, and it moved with its tests.
 *
 * It is a record rather than a setting, and it is the thing the acceptances
 * below it are routed by: a component's `skillTags` and an acceptance's
 * `components` are two halves of one join that used to be two tabs apart.
 */
describe('skills', () => {
  it('shows the accepted component map and offers no way to accept one', async () => {
    serve({ '/api/profile': profileView() })

    reveal('panel-skills')
    mountSkills()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#skills-profile-list .component')).toHaveLength(2))

    const record = document.getElementById('skills-profile-record') as HTMLElement
    expect(record.textContent).toContain('2')
    expect(record.textContent).toContain('dashboard:mohd')

    const first = document.querySelector('#skills-profile-list .component') as HTMLElement
    expect(first.querySelector('[data-slot="id"]')?.textContent).toBe('apps-mobile')
    expect(first.querySelector('[data-slot="root"]')?.textContent).toBe('apps/mobile')
    expect(first.querySelector('[data-slot="technology"]')?.textContent).toBe('flutter')
    expect(first.querySelector('[data-slot="test"]')?.textContent).toBe('cd apps/mobile && flutter test')
    // A component with no build command says so, for the same reason an unset
    // `verify.build` does: it is the slot that will not run.
    expect(first.querySelector('[data-slot="build"]')?.textContent).toBe(english['config.verifyUnset'])
    expect(first.querySelector('[data-slot="tags"]')?.textContent).toBe('flutter')

    expect((document.getElementById('skills-profile-drift') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('skills-profile-empty') as HTMLElement).hidden).toBe(true)

    // The whole point of the block. Accepting a component map activates routing
    // for every later run, which `web/writes.ts` denies the browser outright —
    // so there is nothing here to press.
    expect(document.querySelectorAll('#skills-profile-block button')).toHaveLength(0)
    expect(document.querySelectorAll('#skills-profile-block [data-act]')).toHaveLength(0)
    expect(document.querySelectorAll('#skills-profile-block input, #skills-profile-block select')).toHaveLength(0)
  })

  it('says a newer scan disagrees, and never resolves the disagreement', async () => {
    serve({ '/api/profile': profileView({ proposedAt: '2026-07-30T09:00:00.000Z', proposalDiffers: true }) })

    reveal('panel-skills')
    mountSkills()
    draw(emptySnapshot())
    await vi.waitFor(() => expect((document.getElementById('skills-profile-drift') as HTMLElement).hidden).toBe(false))

    // Formatted, not the raw ISO string it carried while this block lived in
    // Config: it now sits beside dates the Features tab formats.
    expect(document.getElementById('skills-profile-drift')?.textContent).not.toContain('2026-07-30T09:00:00.000Z')
    expect(document.getElementById('skills-profile-drift')?.textContent).toContain('2026')
    // Still the accepted map on screen: the proposal is what a rescan found,
    // and nothing routes off it until somebody accepts it with a command.
    expect(document.querySelectorAll('#skills-profile-list .component')).toHaveLength(2)
    expect(document.querySelectorAll('#skills-profile-block button')).toHaveLength(0)
  })

  it('says a project has no accepted map rather than drawing an empty table', async () => {
    // `/api/profile` 404s for a project nothing has ever mapped, and a 404 is
    // an answer here — not a fetch this panel should keep waiting on.
    serve({})

    reveal('panel-skills')
    mountSkills()
    draw(emptySnapshot())
    await vi.waitFor(() => expect((document.getElementById('skills-profile-empty') as HTMLElement).hidden).toBe(false))

    expect(document.getElementById('skills-profile-empty')?.textContent).toBe(english['config.profileNone'])
    expect(document.querySelectorAll('#skills-profile-list .component')).toHaveLength(0)
    expect((document.getElementById('skills-profile-record') as HTMLElement).hidden).toBe(true)
  })
})

/** The document `configView()` serves, as `collectConfigChanges` compares against. */
function baselineConfig(): ReturnType<typeof ConfigSchema.parse> {
  return ConfigSchema.parse({
    version: 1,
    tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
  })
}

describe('queue', () => {
  const job = (patch: Partial<Job> & { id: string }): Job => ({
    command: '/mjloop:build P001-S02',
    story: 'P001-S02',
    status: 'queued',
    reason: null,
    startedAt: null,
    endedAt: null,
    ...patch,
  })

  it('draws a job duration and its reason', () => {
    reveal('panel-queue')
    mountQueue()
    draw(
      emptySnapshot({
        queue: [
          job({
            id: 'j1',
            status: 'failed',
            reason: { code: 'job.failed.exit', params: { code: 1 } },
            startedAt: '2026-07-28T12:00:00.000Z',
            endedAt: '2026-07-28T12:03:12.000Z',
          }),
        ],
      }),
    )

    const row = document.querySelector('#queue-history .job') as HTMLElement
    expect(row.querySelector('.dur')?.textContent).toBe('3m 12s')
    expect(row.querySelector('.reason')?.textContent).toContain('code 1')
    expect(row.querySelector('.st')?.classList.contains('job-failed')).toBe(true)
  })

  it('separates what is running from what is waiting from what is over', () => {
    reveal('panel-queue')
    mountQueue()
    draw(
      emptySnapshot({
        queue: [
          job({ id: 'j1', status: 'done', startedAt: '2026-07-28T12:00:00.000Z', endedAt: '2026-07-28T12:01:00.000Z' }),
          job({ id: 'j2', status: 'running', startedAt: '2026-07-28T12:01:00.000Z' }),
          job({ id: 'j3', command: '/mjloop:fix a' }),
          job({ id: 'j4', command: '/mjloop:fix b' }),
        ],
        session: { jobId: 'j2', blocked: false, pausedBy: null, closing: false, stalledSince: null },
      }),
    )

    expect(document.querySelectorAll('#queue-now .job')).toHaveLength(1)
    expect(document.querySelectorAll('#queue-waiting .job')).toHaveLength(2)
    expect(document.querySelectorAll('#queue-history .job')).toHaveLength(1)

    // Its place in the run order, so "mine is second" needs no counting.
    expect(cells('#queue-waiting .job .pos')).toEqual(['1', '2'])

    // One control per row, and the two that are not the same act do not look
    // alike: the running row stops a session, a waiting row drops a command.
    const running = document.querySelector('#queue-now .job') as HTMLElement
    expect((running.querySelector('[data-slot="stop"]') as HTMLElement).hidden).toBe(false)
    expect((running.querySelector('[data-slot="cancel"]') as HTMLElement).hidden).toBe(true)
    const waiting = document.querySelector('#queue-waiting .job') as HTMLElement
    expect((waiting.querySelector('[data-slot="stop"]') as HTMLElement).hidden).toBe(true)
    expect((waiting.querySelector('[data-slot="cancel"]') as HTMLElement).hidden).toBe(false)
    expect((waiting.querySelector('[data-slot="attach"]') as HTMLElement).hidden).toBe(true)
  })

  it('shows the pause, why it is there, and the way out of it', () => {
    reveal('panel-queue')
    mountQueue()
    const stopped = emptySnapshot({
      queue: [job({ id: 'j1', command: '/mjloop:fix a' })],
      session: { jobId: null, blocked: true, pausedBy: 'stopped', closing: false, stalledSince: null },
    })
    draw(stopped)

    expect((document.getElementById('queue-blocked') as HTMLElement).hidden).toBe(false)
    // Resume is never hidden while the queue is holding. It used to be, whenever
    // the pause happened to arrive before the next job did.
    expect((document.getElementById('queue-resume') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('queue-pause-text')?.textContent).toBe(english['queue.pausedStopped'])

    draw({ ...stopped, session: { ...stopped.session, pausedBy: 'failure' } })
    // A failure asks you to read a transcript; a stop asks nothing. Different
    // causes, different sentences.
    expect(document.getElementById('queue-pause-text')?.textContent).toBe(english['queue.blockedBanner'])
  })

  it('says a job is closing rather than leaving it as running under a dead button', () => {
    reveal('panel-queue')
    mountQueue()
    draw(
      emptySnapshot({
        queue: [job({ id: 'j1', status: 'running', startedAt: '2026-07-28T12:00:00.000Z' })],
        session: { jobId: 'j1', blocked: true, pausedBy: 'stopped', closing: true, stalledSince: null },
      }),
    )

    const row = document.querySelector('#queue-now .job') as HTMLElement
    expect(row.querySelector('.st')?.textContent).toBe(english['queue.closing'])
    expect(row.querySelector('.st')?.classList.contains('job-closing')).toBe(true)
    expect((row.querySelector('[data-slot="stop"]') as HTMLButtonElement).disabled).toBe(true)
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

/**
 * Feature briefs, and the one write the browser is permitted.
 *
 * The assertions that matter are the two the execution report records as having
 * shipped wrong once already: the approval carries the *content digest* rather
 * than the revision number alone, and a capability nothing exposes is not a
 * capability. So the frame is inspected rather than the button's existence.
 */
describe('features', () => {
  const brief = (patch: Partial<FeatureBrief> = {}): FeatureBrief => ({
    schema: 1,
    id: 'F001',
    revision: 1,
    title: 'Sign-in that survives a token refresh',
    status: 'draft',
    problem: 'The session drops mid-refresh.',
    decisions: [
      { question: 'Which store holds the refresh token?', recommendation: 'keychain', answer: 'keychain', at: NOW },
      { question: 'Does logout revoke server-side?', recommendation: null, answer: null, at: NOW },
    ],
    acceptance: ['A refresh mid-request does not sign the user out.'],
    affectedComponents: ['web'],
    tags: ['auth'],
    discovery: { mode: 'ask', questionBudget: 8, completedAt: NOW },
    approval: null,
    supersedes: null,
    createdAt: NOW,
    ...patch,
  })

  const detail = (patch: Partial<FeatureDetail> = {}): FeatureDetail => ({
    brief: brief(),
    status: 'draft',
    revisions: [{ revision: 1, status: 'draft' }],
    digest: 'a'.repeat(64),
    ...patch,
  })

  const summary = (patch: Partial<FeatureSummary> = {}): FeatureSummary => ({
    id: 'F001',
    title: 'Sign-in that survives a token refresh',
    status: 'draft',
    latestRevision: 1,
    approvedRevision: null,
    revisions: [1],
    createdAt: NOW,
    ...patch,
  })

  it('refuses to approve a draft with no acceptance criteria, before sending anything', () => {
    // The server's refusal for this case has no code of its own — it falls to
    // `write.failed` with the diagnosis on the server's terminal — so the page
    // cannot explain it afterwards and must not let it happen.
    expect(approvable(detail({ brief: brief({ acceptance: [] }) })).why).toBe('features.needsAcceptance')
    expect(approvable(detail({ brief: brief({ acceptance: [] }) })).can).toBe(false)
  })

  it('offers no approval on a revision that already has one', () => {
    expect(approvable(detail({ status: 'approved' })).can).toBe(false)
    expect(approvable(detail({ status: 'superseded' })).can).toBe(false)
    expect(approvable(null).can).toBe(false)
    expect(approvable(detail()).can).toBe(true)
  })

  it('draws a brief, and says which questions the interview never answered', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })

    reveal('panel-features')
    const features = mountFeatures()
    // `opened` is module state, as it is in `plans.js`, so it outlives a test.
    // Reset explicitly: `toggle` on an already-open feature *closes* it, and a
    // test that inherited one would be asserting against a shut panel.
    features.close()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#features-list .plan')).toHaveLength(1))

    features.toggle('F001')
    await vi.waitFor(() => expect((document.getElementById('feature-detail') as HTMLElement).hidden).toBe(false))

    expect(document.getElementById('feature-problem')?.textContent).toContain('drops mid-refresh')
    const answers = [...document.querySelectorAll('#feature-decisions [data-slot="answer"]')]
    expect(answers[0]?.textContent).toBe('keychain')
    // An unanswered question is an ordinary state of a draft — the interview
    // stops at one — so it is a sentence rather than a blank line.
    expect(answers[1]?.textContent).toBe(english['features.unanswered'])

    // The first decision took the recommendation, so the recommendation is not
    // repeated under it — that renders as the answer stated twice with nothing
    // saying which line is which.
    const recommendations = [...document.querySelectorAll('#feature-decisions [data-slot="recommendation"]')]
    expect((recommendations[0] as HTMLElement).hidden).toBe(true)
  })

  it('shows a recommendation the answer did not take, and labels it as one', async () => {
    const declined = brief({
      decisions: [
        { question: 'Where does the refresh token live?', recommendation: 'the keychain', answer: 'a cookie', at: NOW },
      ],
    })
    serve({ '/api/features': [summary()], '/api/features/F001': detail({ brief: declined }) })

    reveal('panel-features')
    const features = mountFeatures()
    features.close()
    draw(emptySnapshot())
    features.toggle('F001')
    await vi.waitFor(() => expect((document.getElementById('feature-detail') as HTMLElement).hidden).toBe(false))

    const shown = document.querySelector('#feature-decisions [data-slot="recommendation"]') as HTMLElement
    expect(shown.hidden).toBe(false)
    expect(shown.textContent).toContain('the keychain')
    // Labelled, because an unlabelled sentence under an answer reads as more
    // of the answer.
    expect(shown.textContent).toContain('Recommended')
  })

  it('approves what the screen showed, by content digest and not by revision alone', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })

    reveal('panel-features')
    const features = mountFeatures()
    // `opened` is module state, as it is in `plans.js`, so it outlives a test.
    // Reset explicitly: `toggle` on an already-open feature *closes* it, and a
    // test that inherited one would be asserting against a shut panel.
    features.close()
    draw(emptySnapshot())
    features.toggle('F001')
    await vi.waitFor(() => expect((document.getElementById('feature-detail') as HTMLElement).hidden).toBe(false))

    features.ask()
    ;(document.getElementById('feature-note') as HTMLInputElement).value = 'agreed on the call'
    features.confirm()

    // A draft holds one revision number for the whole of its editable life, so
    // the digest is the only field on this frame that moves when the words do.
    // Without it the compare-and-swap is vacuous — which is exactly how it
    // shipped the first time.
    expect(sent).toEqual([
      {
        type: 'write',
        id: expect.any(String),
        write: {
          kind: 'feature.approve',
          feature: 'F001',
          revision: 1,
          digest: 'a'.repeat(64),
          note: 'agreed on the call',
        },
      },
    ])
  })

  it('sends nothing when the brief stopped being approvable while the dialog was open', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })

    reveal('panel-features')
    const features = mountFeatures()
    // `opened` is module state, as it is in `plans.js`, so it outlives a test.
    // Reset explicitly: `toggle` on an already-open feature *closes* it, and a
    // test that inherited one would be asserting against a shut panel.
    features.close()
    draw(emptySnapshot())
    features.toggle('F001')
    await vi.waitFor(() => expect((document.getElementById('feature-detail') as HTMLElement).hidden).toBe(false))

    features.ask()
    // The feed keeps running behind the modal. Somebody else approved it.
    serve({ '/api/features': [summary()], '/api/features/F001': detail({ status: 'approved' }) })
    draw(emptySnapshot({ revisions: { ...emptySnapshot().revisions, features: 'moved' } }))
    await vi.waitFor(() =>
      expect((document.getElementById('feature-approve') as HTMLButtonElement).hidden).toBe(true),
    )

    features.confirm()
    expect(sent).toEqual([])
  })
})

/**
 * The library, the acceptances, and the join between them.
 *
 * The join's *failure* is the case worth a test: an acceptance stores a digest
 * and never a path, precisely so a project's record survives being cloned onto
 * another machine — and the cost of that is a repository naming a package the
 * library here has never imported. Neither list read alone shows it.
 */
describe('skills library', () => {
  const pkg = (patch: Partial<SkillPackage> = {}): SkillPackage => ({
    schema: 1,
    packageId: 'flutter-forms',
    digest: 'b'.repeat(64),
    source: { kind: 'github', url: 'https://github.com/example/flutter-forms', revision: 'v1.2.0' },
    license: { spdx: 'MIT', file: 'LICENSE' },
    skillName: 'Flutter forms',
    description: 'Form patterns for Flutter.',
    tags: ['flutter'],
    dependencies: { executables: [], packages: [] },
    audit: { state: 'passed', findings: ['sandbox: no network access attempted'], at: NOW },
    guidance: 'Prefer FormField over manual controllers.',
    importedAt: NOW,
    ...patch,
  })

  const acceptance = (patch: Partial<ProjectSkillAcceptance> = {}): ProjectSkillAcceptance => ({
    schema: 1,
    skillId: 'flutter-forms',
    packageId: 'flutter-forms',
    digest: 'b'.repeat(64),
    components: ['apps-mobile'],
    agents: ['builder'],
    tags: ['flutter'],
    updatePolicy: 'pinned',
    status: 'active',
    compatible: true,
    acceptedBy: 'mohd',
    acceptedAt: NOW,
    ...patch,
  })

  it('pairs each acceptance with the package it names, and reports the one it cannot find', () => {
    const joined = joinAcceptances({
      packages: [pkg()],
      unreadable: [],
      acceptances: [acceptance(), acceptance({ skillId: 'gone', digest: 'c'.repeat(64) })],
    })

    expect(joined[0]?.pkg?.skillName).toBe('Flutter forms')
    expect(joined[1]?.pkg).toBeNull()
  })

  it('draws the audit verdict and names a package this machine does not hold', async () => {
    serve({
      '/api/skills': {
        packages: [pkg()],
        unreadable: [{ digest: 'd'.repeat(64), reason: 'record does not parse' }],
        acceptances: [acceptance({ skillId: 'gone', digest: 'c'.repeat(64) })],
      },
    })

    reveal('panel-skills')
    mountSkills()
    draw(emptySnapshot())
    await vi.waitFor(() => expect(document.querySelectorAll('#skills-library .component')).toHaveLength(1))

    expect(document.querySelector('#skills-library [data-slot="audit"]')?.textContent).toBe(
      english['skills.audit.passed'],
    )
    // The findings list carries the sandbox line: `writePackage` is only ever
    // reached from a passed audit, so there is no separate import report.
    expect(document.querySelector('#skills-library [data-slot="findings"]')?.textContent).toContain('sandbox')

    const missing = document.querySelector('#skills-acceptances [data-slot="missing"]') as HTMLElement
    expect(missing.hidden).toBe(false)
    expect(missing.textContent).toContain(shortDigest('c'.repeat(64)))

    // A damaged library entry is surfaced, not dropped: on a machine where
    // `skills import` can write, it is as likely to be an interrupted import.
    expect(document.querySelectorAll('#skills-unreadable .grid-row')).toHaveLength(1)

    // Activation is a command. There is nothing on this panel to press.
    expect(document.querySelectorAll('#panel-skills [data-act]')).toHaveLength(0)
    expect(document.querySelectorAll('#panel-skills button, #panel-skills input')).toHaveLength(0)
  })
})
