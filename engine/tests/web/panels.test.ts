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
import { mountPlans, planMemories, planRuns } from '../../src/web/public/panels/plans.js'
import { mountStories } from '../../src/web/public/panels/stories.js'
import { mountQueue } from '../../src/web/public/panels/queue.js'
import { mountRun } from '../../src/web/public/panels/run.js'
import { facet } from '../../src/web/public/panels/memory.js'
import { suggestions } from '../../src/web/public/panels/launcher.js'
import { mountToasts, toast } from '../../src/web/public/ui/toasts.js'
import { DEP_DEPTH_LIMIT } from '../../src/web/public/lib/stories.js'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'
import { ConfigSchema, DEFAULT_TRACKS } from '../../src/schemas/config.js'
import { SkillManifestSchema } from '../../src/schemas/skill-selection.js'
import { ConfigChangeSchema } from '../../src/store/config-mutation.js'
import type { FeatureDetail, ProfileView } from '../../src/web/read.js'
import type { FeatureSummary } from '../../src/store/feature-store.js'
import type { FeatureBrief } from '../../src/schemas/feature.js'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import type { ProjectSkillAcceptance } from '../../src/schemas/skill-acceptance.js'
import type { Job, PlanView, StoryView } from '../../src/web/protocol.js'
import type { MemoryView, RunSummary, StoryDetail } from '../../src/web/read.js'

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

  it("hides Plan Progress rather than inventing numbers when the snapshot has stopped listing the open plan", async () => {
    // The cached document can still say the plan exists — `plan-detail` itself
    // stays open, per the test above — but Plan Progress reads `state.plans`,
    // not the document, and there is no row there to agree with any more.
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': { id: 'P001', title: 'A plan', approval: null, body: '', review: null, stories: [] },
    })
    reveal('panel-plans')
    mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    await vi.waitFor(() => expect((document.getElementById('plan-progress') as HTMLElement).hidden).toBe(false))

    draw(emptySnapshot({ plans: [] }))
    expect((document.getElementById('plan-progress') as HTMLElement).hidden).toBe(true)
  })

  it("breaks down the open plan's own stories, agreeing with the row above it and the tally beside it", async () => {
    serve({
      '/api/plans/P001': { id: 'P001', title: 'A plan', approval: null, body: '', review: null, stories: [] },
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    const stories = [
      story({ id: 'P001-S01', status: 'done' }),
      story({ id: 'P001-S02', status: 'doing' }),
      story({ id: 'P001-S03', status: 'blocked' }),
      // Ready: `todo` with its one dependency already `done`.
      story({ id: 'P001-S04', depends_on: ['P001-S01'] }),
      // Not ready: `todo`, but its dependency is not done — this is the case
      // that would make `remaining` and `ready` disagree if `remaining` were
      // computed as anything other than "not done".
      story({ id: 'P001-S05', depends_on: ['P001-S02'] }),
    ]
    // A second plan with a deliberately different breakdown, both done, so
    // the five counts below can only pass if `drawDetail` picked P001's own
    // row out of `state.plans` rather than the first one in the array — the
    // exact wrong-plan-numbers bug the block's own comment (`plans.js:225-228`)
    // argues it is avoiding.
    const p002Stories = [story({ id: 'P002-S01', status: 'done' }), story({ id: 'P002-S02', status: 'done' })]
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories }), plan({ id: 'P002', stories: p002Stories })] }))
    mounted.toggle('P001')
    await vi.waitFor(() => expect((document.getElementById('plan-progress') as HTMLElement).hidden).toBe(false))

    // completed 1, doing 1, ready 1 (S04 only — S05 is blocked on a
    // non-done dependency), blocked 1, remaining 4 (everything but S01).
    expect(document.getElementById('plan-progress-completed')?.textContent).toBe('1')
    expect(document.getElementById('plan-progress-doing')?.textContent).toBe('1')
    expect(document.getElementById('plan-progress-ready')?.textContent).toBe('1')
    expect(document.getElementById('plan-progress-blocked')?.textContent).toBe('1')
    expect(document.getElementById('plan-progress-remaining')?.textContent).toBe('4')

    // The row above it, in the plan list, reads the identical `planProgress`
    // call — proof the two cannot disagree is that they are the same call,
    // not two arithmetic expressions that happen to match today.
    const row = document.querySelector('#plans-list .plan') as HTMLElement
    expect(row.querySelector('[data-slot="count"]')?.textContent).toBe('1/5')
    // `plans.readyHere`/`plans.blockedHere` are both `"{n} …"` with no other
    // hole, so substituting the one count by hand is exact rather than
    // approximate.
    expect(row.querySelector('[data-slot="ready"]')?.textContent).toBe(english['plans.readyHere']?.replace('{n}', '1'))
    expect(row.querySelector('[data-slot="blocked"]')?.textContent).toBe(
      english['plans.blockedHere']?.replace('{n}', '1'),
    )
  })

  it("collects only this plan's own runs into Plan Evidence, by the run directory's story convention", async () => {
    const run = (patch: Partial<RunSummary> & { id: string }): RunSummary => ({
      story: null,
      track: 'build',
      cycles: 1,
      halted: false,
      ...patch,
    })
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01' })],
      },
      '/api/runs': [
        run({ id: '2026-07-28-001--P001-S01--build', story: 'P001-S01', cycles: 2 }),
        // A second run against this plan's own story, halted, so both
        // branches of the outcome ternary in `planRunRow` actually render —
        // the sibling `tpl-story-run` row pins both (`toContain('ended')` and
        // `toContain('halted')` at tests/web/panels.test.ts:781/795); this row
        // previously had no fixture that reached the halted branch at all.
        run({ id: '2026-07-28-004--P001-S01--build', story: 'P001-S01', halted: true }),
        // Another plan's own story: present in the shared feed, and the case
        // that actually exercises the filter rather than a fixture it would
        // pass vacuously.
        run({ id: '2026-07-28-002--P002-S01--build', story: 'P002-S01' }),
        // An ad-hoc run: no story in its directory name at all, so `readRuns`
        // gives it `story: null` — never attributable to any plan, which is
        // a fact about the directory name and not a gap in this filter.
        run({ id: '2026-07-28-003--adhoc--edit', story: null, halted: true }),
      ],
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    mounted.toggle('P001')

    await vi.waitFor(() => expect(document.querySelectorAll('#plan-evidence-list .run')).toHaveLength(2))
    const rows = document.querySelectorAll('#plan-evidence-list .run')
    const row = rows[0] as HTMLElement
    expect(row.textContent).toContain('2026-07-28-001--P001-S01--build')
    expect(row.textContent).not.toContain('2026-07-28-002--P002-S01--build')
    expect(row.textContent).not.toContain('2026-07-28-003--adhoc--edit')
    expect(row.querySelector('.story-id')?.textContent).toBe('P001-S01')
    expect(row.querySelector('[data-slot="cycles"]')?.textContent).toBe('2 cycles')
    // The track chip and the outcome word/class render data no other
    // assertion here reads — pinned so a blank chip or a silent, colourless
    // outcome cell would fail this test rather than ship unnoticed, the same
    // shape as `tpl-story-run`'s own pin at tests/web/panels.test.ts:785.
    expect(row.querySelector('.chip')?.textContent).toBe('build')
    expect(row.textContent).toContain('ended')
    expect(row.querySelector('.res')?.classList.contains('res-pass')).toBe(true)

    const halted = rows[1] as HTMLElement
    expect(halted.textContent).toContain('2026-07-28-004--P001-S01--build')
    expect(halted.textContent).toContain('halted')
    expect(halted.querySelector('.res')?.classList.contains('res-fail')).toBe(true)
    expect((document.getElementById('plan-evidence-empty') as HTMLElement).hidden).toBe(true)

    // The pure filter, unit-tested directly: `planRuns` is what the DOM test
    // above is wiring, and this is the case that proves the filter itself
    // (not the DOM plumbing around it) does the excluding.
    const runs = [
      run({ id: 'a', story: 'P001-S01' }),
      run({ id: 'b', story: 'P002-S01' }),
      run({ id: 'c', story: null }),
    ]
    expect(planRuns(runs, { stories: [{ id: 'P001-S01' }] }).map((entry) => entry.id)).toEqual(['a'])
  })

  it('caps Plan Evidence and says how many runs are not shown', async () => {
    const many = Array.from({ length: 240 }, (_, index) => ({
      id: `2026-07-28-${String(index).padStart(3, '0')}--P001-S01--build`,
      story: 'P001-S01',
      track: 'build',
      cycles: 1,
      halted: false,
    }))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01' })],
      },
      '/api/runs': many,
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    mounted.toggle('P001')

    await vi.waitFor(() => expect(document.querySelectorAll('#plan-evidence-list .run')).toHaveLength(200))
    expect((document.getElementById('plan-evidence-more') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('plan-evidence-more')?.textContent).toBe('Showing 200 of 240 runs.')
  })

  it('caps Plan Memory and says how many entries are not shown', async () => {
    // The same shape as "caps Plan Evidence" above: no fixture anywhere else
    // in this file pushes Plan Memory past `reconcile`'s 200-row cap, so
    // `#plan-memory-more` was rendered by no test at all.
    const many = Array.from({ length: 240 }, (_, index) => ({
      id: `M${String(index).padStart(3, '0')}`,
      kind: 'decision',
      title: 'Something',
      tags: [],
      at: NOW,
      run: null,
      // `plan` is the join key now, not a mention in the body — a fixture
      // that only mentioned P001 in prose would match nothing after
      // `planMemories` became a real join.
      plan: 'P001',
      story: null,
      body: `Entry ${index}.`,
    }))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01' })],
      },
      '/api/memory': many,
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    mounted.toggle('P001')

    await vi.waitFor(() => expect(document.querySelectorAll('#plan-memory-list .memory')).toHaveLength(200))
    expect((document.getElementById('plan-memory-more') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('plan-memory-more')?.textContent).toBe('Showing 200 of 240 entries.')
  })

  it("joins Plan Memory on the memory's own `plan`/`story` fields, never on a prose mention or the `run` field", async () => {
    const memory = (patch: Partial<MemoryView> & { id: string }): MemoryView => ({
      kind: 'decision',
      title: 'Something else entirely',
      tags: [],
      at: NOW,
      run: null,
      plan: null,
      story: null,
      body: '',
      ...patch,
    })
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01' })],
      },
      '/api/memory': [
        memory({ id: 'M001', plan: 'P001', title: 'Why P001 shipped without an SVG graph' }),
        memory({ id: 'M002', story: 'P001-S01', body: 'A lesson that came out of this story.' }),
        // Mentions the plan and the story in its own prose, but carries no
        // `plan`/`story` field. If this showed up, the join would have
        // regressed to the text match it replaced.
        memory({ id: 'M003', title: 'P001-S01, allegedly', body: 'About P001 in passing.' }),
        // Its `run` field happens to name a run that *did* belong to this
        // plan. `run` is not the join key.
        memory({ id: 'M004', run: '2026-07-28-001--P001-S01--build' }),
        // Scoped to a different plan entirely.
        memory({ id: 'M005', plan: 'P002', title: 'A different plan entirely' }),
      ],
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    mounted.toggle('P001')

    await vi.waitFor(() => expect(document.querySelectorAll('#plan-memory-list .memory')).toHaveLength(2))
    expect(cells('#plan-memory-list .memory-id')).toEqual(['M001', 'M002'])
    expect((document.getElementById('plan-memory-empty') as HTMLElement).hidden).toBe(true)

    // The pure match, unit-tested directly for the cases the DOM fixture
    // above only demonstrates indirectly.
    const plainPlan = { id: 'P001', stories: [{ id: 'P001-S01' }] }
    expect(planMemories([memory({ id: 'M003', title: 'P001-S01, allegedly', body: 'About P001' })], plainPlan)).toEqual([])
    expect(planMemories([memory({ id: 'M004', run: '2026-07-28-001--P001-S01--build' })], plainPlan)).toEqual([])
    expect(planMemories([memory({ id: 'M005', plan: 'P002' })], plainPlan)).toEqual([])
    expect(planMemories([memory({ id: 'M001', plan: 'P001' })], plainPlan)).toEqual([memory({ id: 'M001', plan: 'P001' })])
    expect(planMemories([memory({ id: 'M002', story: 'P001-S01' })], plainPlan)).toEqual([
      memory({ id: 'M002', story: 'P001-S01' }),
    ])
  })

  it('shows the empty tells when nothing matches, and hides them when something does', async () => {
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01' })],
      },
      '/api/runs': [],
      '/api/memory': [],
    })
    reveal('panel-plans')
    const mounted = mountPlans()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    mounted.toggle('P001')

    await vi.waitFor(() => expect((document.getElementById('plan-evidence-empty') as HTMLElement).hidden).toBe(false))
    expect(document.getElementById('plan-evidence-empty')?.textContent).toBe(english['plans.evidence.empty'])
    expect((document.getElementById('plan-memory-empty') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('plan-memory-empty')?.textContent).toBe(english['plans.memory.empty'])
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
    // The word "—" carries a class too, out of the same bounded family a real
    // status uses — never left holding whatever class the row wore before, per
    // the next test.
    expect(unresolved[0]?.querySelector('.story-status')?.classList.contains('status-unknown')).toBe(true)
  })

  it('never lets a status colour outlive the word it replaces', async () => {
    // Reproduces the exact case a review caught before this phase: a
    // dependency's row is keyed by id, `reconcile` retains it across draws,
    // and `cls()` (ui/dom.js:139-151) can only swap one class in a family for
    // another — it has no clear path. A write that only happened when the
    // status resolved left a stale `status-doing` behind on the very draw the
    // word flipped to "—".
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
          detailStory({ id: 'P001-S02', title: 'Two', depends_on: ['P001-S01'] }),
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
            stories: [story({ id: 'P001-S01', status: 'doing' }), story({ id: 'P001-S02', depends_on: ['P001-S01'] })],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(2))

    stories.openTab('P001-S02')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S02 — Two'))
    const status = () => document.querySelector('#story-open-waits .wait-row .story-status') as HTMLElement
    expect(status().textContent).toBe('doing')
    expect(status().classList.contains('status-doing')).toBe(true)

    // P001-S01 removed from the plan on disk — a hand edit, not a status
    // change. `unmet()` still returns it (an id absent from the index is
    // unmet, `lib/stories.js:58-60`), so the row keeps its key and is
    // reconciled in place rather than replaced.
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S02', title: 'Two', depends_on: ['P001-S01'] })],
      },
    })
    draw(
      emptySnapshot({
        plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S02', depends_on: ['P001-S01'] })] })],
        revisions: { ...emptySnapshot().revisions, plans: { P001: 'r2' } },
      }),
    )

    await vi.waitFor(() => expect(status().textContent).toBe('—'))
    expect(status().classList.contains('status-doing')).toBe(false)
    expect(status().classList.contains('status-unknown')).toBe(true)
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

  /**
   * A plan built for the dependency view (B9): a two-level chain
   * (`P001-S03` → `P001-S02` → `P001-S01`), a story with no dependencies of
   * its own (`P001-S04`), two stories that depend on each other
   * (`P001-S05` ⇄ `P001-S06`) — a cycle `assertDependenciesResolve`
   * (`ops/plan.ts:239-250`) refuses to let anyone *write*, but a hand-edited
   * plan file bypasses that check, same as `openReadinessFixture`'s
   * `P001-S99` typo does for `unmet()` — and a story with a typo'd dependency
   * of its own (`P001-S07`), for the identical case in the dependency view.
   */
  async function openDepTreeFixture(): Promise<ReturnType<typeof mountStories>> {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', title: 'One', status: 'done' }),
          detailStory({ id: 'P001-S02', title: 'Two', status: 'doing', depends_on: ['P001-S01'] }),
          detailStory({ id: 'P001-S03', title: 'Three', depends_on: ['P001-S02'] }),
          detailStory({ id: 'P001-S04', title: 'Four' }),
          detailStory({ id: 'P001-S05', title: 'Five', depends_on: ['P001-S06'] }),
          detailStory({ id: 'P001-S06', title: 'Six', depends_on: ['P001-S05'] }),
          detailStory({ id: 'P001-S07', title: 'Seven', depends_on: ['P001-S99'] }),
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
              story({ id: 'P001-S01', status: 'done' }),
              story({ id: 'P001-S02', status: 'doing', depends_on: ['P001-S01'] }),
              story({ id: 'P001-S03', depends_on: ['P001-S02'] }),
              story({ id: 'P001-S04' }),
              story({ id: 'P001-S05', depends_on: ['P001-S06'] }),
              story({ id: 'P001-S06', depends_on: ['P001-S05'] }),
              story({ id: 'P001-S07', depends_on: ['P001-S99'] }),
            ],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(7))
    return stories
  }

  const depRows = (): {
    id: string | null | undefined
    status: string | null | undefined
    depth: string | null
    ariaLevel: string | null
  }[] =>
    [...document.querySelectorAll('#story-open-deps-list .dep-row')].map((row) => ({
      id: row.querySelector('.story-id')?.textContent,
      status: row.querySelector('.story-status')?.textContent,
      depth: [...row.classList].find((name) => name.startsWith('depth-')) ?? null,
      ariaLevel: row.getAttribute('aria-level'),
    }))

  it('indents a two-level dependency chain, each node with its own status', async () => {
    const stories = await openDepTreeFixture()

    stories.openTab('P001-S03')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S03 — Three'))
    expect((document.getElementById('story-open-deps-empty') as HTMLElement).hidden).toBe(true)
    expect(depRows()).toEqual([
      { id: 'P001-S02', status: 'doing', depth: 'depth-0', ariaLevel: '1' },
      { id: 'P001-S01', status: 'done', depth: 'depth-1', ariaLevel: '2' },
    ])
    // Colour is never the only signal: the class names the dependency's own
    // status, at its own depth, not the open story's.
    const cells = [...document.querySelectorAll('#story-open-deps-list .story-status')]
    expect(cells[0]?.classList.contains('status-doing')).toBe(true)
    expect(cells[1]?.classList.contains('status-done')).toBe(true)
    // The tree shape is not only visual: a screen reader needs `role` and
    // `aria-level` to tell a direct dependency from a transitive one, which
    // `padding-inline-start` alone cannot convey.
    expect(document.getElementById('story-open-deps-list')?.getAttribute('role')).toBe('tree')
    for (const row of document.querySelectorAll('#story-open-deps-list .dep-row')) {
      expect(row.getAttribute('role')).toBe('treeitem')
    }
  })

  it('shows the empty phrase for a story with no dependencies', async () => {
    const stories = await openDepTreeFixture()

    stories.openTab('P001-S04')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S04 — Four'))
    expect((document.getElementById('story-open-deps-empty') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('story-open-deps-empty')?.textContent).toBe(english['story.deps.empty'])
    expect(depRows()).toEqual([])
  })

  it('walks a hand-edited cycle without hanging, and stops re-entering it', async () => {
    const stories = await openDepTreeFixture()

    // `assertDependenciesResolve` refuses to *write* P001-S05 ⇄ P001-S06, but
    // the fixture serves it anyway — the case only a hand-edited file reaches.
    // A recursive walk that trusted the engine here would hang the test (and
    // the page); this instead terminates at exactly two rows: P001-S06 at
    // depth 0, and P001-S05 again at depth 1 — pushed once, as a leaf, because
    // it is already on the path back to the root and is never re-entered.
    stories.openTab('P001-S05')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S05 — Five'))
    expect(depRows()).toEqual([
      { id: 'P001-S06', status: 'todo', depth: 'depth-0', ariaLevel: '1' },
      { id: 'P001-S05', status: 'todo', depth: 'depth-1', ariaLevel: '2' },
    ])
  })

  it('renders a dependency id the plan cannot resolve as a leaf, no status word to lie about', async () => {
    // `depTree`'s `byId` is this plan's own stories only — an id it does not
    // carry is a typo within the plan or the cross-plan edge
    // `assertDependenciesResolve` refuses to write, same as `unmet()`'s
    // identical case above. The row still renders (it *is* a real edge on
    // disk), with the id and no status word, and never walked into.
    const stories = await openDepTreeFixture()

    stories.openTab('P001-S07')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S07 — Seven'))
    expect(depRows()).toEqual([{ id: 'P001-S99', status: '—', depth: 'depth-0', ariaLevel: '1' }])
    const cell = document.querySelector('#story-open-deps-list .story-status') as HTMLElement
    // The same neutral class the readiness inspector's identical case wears —
    // never a stray real-status class left over from another row this one's
    // key happens to reuse.
    expect(cell.classList.contains('status-unknown')).toBe(true)
  })

  it('caps a genuinely acyclic chain at DEP_DEPTH_LIMIT hops — the case the cycle guard does not cover', async () => {
    // A hand-edited plan can chain `depends_on` past any depth without ever
    // repeating an id, so the cycle guard (`path.includes`) never fires. This
    // fixture is exactly that: seven stories, each depending on the next, no
    // repeats anywhere. `DEP_DEPTH_LIMIT` is imported rather than hardcoded —
    // 5 here — so raising the constant moves this assertion with it instead
    // of leaving it silently proving nothing, which is what shipped in 1cd3489.
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S10', title: 'Ten', depends_on: ['P001-S11'] }),
          detailStory({ id: 'P001-S11', title: 'Eleven', depends_on: ['P001-S12'] }),
          detailStory({ id: 'P001-S12', title: 'Twelve', depends_on: ['P001-S13'] }),
          detailStory({ id: 'P001-S13', title: 'Thirteen', depends_on: ['P001-S14'] }),
          detailStory({ id: 'P001-S14', title: 'Fourteen', depends_on: ['P001-S15'] }),
          detailStory({ id: 'P001-S15', title: 'Fifteen', depends_on: ['P001-S16'] }),
          detailStory({ id: 'P001-S16', title: 'Sixteen' }),
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
              story({ id: 'P001-S10', depends_on: ['P001-S11'] }),
              story({ id: 'P001-S11', depends_on: ['P001-S12'] }),
              story({ id: 'P001-S12', depends_on: ['P001-S13'] }),
              story({ id: 'P001-S13', depends_on: ['P001-S14'] }),
              story({ id: 'P001-S14', depends_on: ['P001-S15'] }),
              story({ id: 'P001-S15', depends_on: ['P001-S16'] }),
              story({ id: 'P001-S16' }),
            ],
          }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(7))

    stories.openTab('P001-S10')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S10 — Ten'))

    const rows = depRows()
    expect(rows).toHaveLength(DEP_DEPTH_LIMIT)
    expect(rows.map((row) => row.id)).toEqual(['P001-S11', 'P001-S12', 'P001-S13', 'P001-S14', 'P001-S15'])
    expect(rows.map((row) => row.depth)).toEqual(['depth-0', 'depth-1', 'depth-2', 'depth-3', 'depth-4'])
    // The sixth id in the chain never appears: past `DEP_DEPTH_LIMIT` hops the
    // walk stops recursing before it reaches it.
    expect(rows.some((row) => row.id === 'P001-S16')).toBe(false)
  })

  it('caps the dependency list like every other list, with an explicit show-more', async () => {
    // `reconcile`'s own header (`ui/list.js`) states the rule: long lists cap
    // instead of hanging, with an explicit "show more" — `#stories-more` and
    // `#stories-ready-more` already follow it. A diamond-shaped dependency
    // graph re-expands a shared ancestor once per path it is reachable by, so
    // the row count is exponential in depth, not linear in story count: this
    // twelve-story plan, where each story depends on its three predecessors,
    // produces 311 rows from twelve stories — comfortably past the default
    // 200-row cap, which previously dropped the remaining 111 with no tell.
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    const ids = Array.from({ length: 12 }, (_, i) => `P001-S${String(i + 1).padStart(2, '0')}`)
    const depsFor = (position: number): string[] =>
      [position - 3, position - 2, position - 1].filter((j) => j >= 1).map((j) => ids[j - 1] as string)
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: ids.map((id, index) => detailStory({ id, title: id, depends_on: depsFor(index + 1) })),
      },
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(
      emptySnapshot({
        plans: [
          plan({ id: 'P001', stories: ids.map((id, index) => story({ id, depends_on: depsFor(index + 1) })) }),
        ],
      }),
    )
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(12))

    const last = ids[11] as string
    stories.openTab(last)
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe(`${last} — ${last}`))

    expect(depRows()).toHaveLength(200)
    expect((document.getElementById('story-open-deps-more') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('story-open-deps-more')?.textContent).toBe(
      (english['story.deps.more.other'] as string).replace('{count}', '111'),
    )
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

  /**
   * C7: per-agent skill inspection, and the pinned-manifest read that goes
   * with it. `acceptance()` mirrors the fixture `describe('skills library')`
   * already uses (below), duplicated rather than shared across two
   * `describe` closures for the same reason every other fixture in this file
   * stays local to its own block.
   */
  const acceptance = (patch: Partial<ProjectSkillAcceptance> & { skillId: string }): ProjectSkillAcceptance => ({
    schema: 1,
    packageId: 'p',
    digest: 'b'.repeat(64),
    components: [],
    agents: ['builder'],
    tags: [],
    updatePolicy: 'auto',
    status: 'active',
    compatible: true,
    acceptedBy: 'mohd',
    acceptedAt: NOW,
    ...patch,
  })

  const skillManifest = (patch: Record<string, unknown> = {}): unknown =>
    SkillManifestSchema.parse({
      schema: 1,
      generatedAt: NOW,
      sourceBrief: { id: 'F001', revision: 2 },
      profileRevision: 3,
      selections: [
        {
          component: 'web',
          agent: 'builder',
          skillIds: ['react-forms'],
          reasons: ['tag "react" matched component skillTags'],
          sourceBrief: { id: 'F001', revision: 2 },
        },
      ],
      guidance: { 'react-forms': 'Prefer controlled inputs over refs.' },
      concurrency: { mode: 'parallel', reason: 'components do not overlap' },
      ...patch,
    })

  it("shows a row only for the drafted agents an acceptance's own `agents` field could ever name, including one with no accepted skill, and leaves out a skill accepted only for an off-track role", async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01', title: 'One' })],
      },
      // The project's real default `build` track (`DEFAULT_TRACKS.build`,
      // `schemas/config.ts:815-823`), not a hand-narrowed fixture: its
      // `required`/`available` also draft `scout`, `ui-designer`,
      // `ui-critic`, `security` and `perf`, none of which `acceptSkill` will
      // ever let an `agents` entry name (`UnknownAcceptanceAgentError`,
      // `store/skill-acceptance-store.ts:263-266`) — every C7 fixture used a
      // trimmed track, which is why five permanently empty rows for those
      // five went unnoticed.
      '/api/config': configView({ tracks: { build: DEFAULT_TRACKS.build } }),
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [
          acceptance({ skillId: 'react-forms', agents: ['builder'] }),
          // `planner` is a real, valid role — dynamic skill selection routes
          // to it from a feature brief — but the `build` track's own
          // `required`/`available` never lists it, so this has nothing to do
          // with this story's track and must appear under neither agent.
          acceptance({ skillId: 'brief-writer', agents: ['planner'] }),
        ],
      },
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(1))

    stories.openTab('P001-S01')
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#story-open-skills-agents .skill-agent')).toHaveLength(3),
    )

    // Exactly the three roles among this track's drafted agents an
    // acceptance could ever name — `scout`, `ui-designer`, `ui-critic`,
    // `security` and `perf` draw no row at all, a structural impossibility
    // rather than merely an empty list.
    expect(cells('#story-open-skills-agents .skill-agent h4')).toEqual(['builder', 'verifier', 'critic'])

    const rows = [...document.querySelectorAll('#story-open-skills-agents .skill-agent')]
    const builderRow = rows.find((row) => row.querySelector('h4')?.textContent === 'builder') as HTMLElement
    const verifierRow = rows.find((row) => row.querySelector('h4')?.textContent === 'verifier') as HTMLElement
    expect(builderRow).toBeDefined()
    expect(verifierRow).toBeDefined()

    expect([...builderRow.querySelectorAll('.acceptance li')].map((node) => node.textContent)).toEqual([
      'react-forms',
    ])
    expect((builderRow.querySelector('[data-slot="none"]') as HTMLElement).hidden).toBe(true)

    // `verifier` is drafted (`required`) but this project has accepted
    // nothing that names it — the empty tell, not a silently blank list.
    expect(verifierRow.querySelectorAll('.acceptance li')).toHaveLength(0)
    expect((verifierRow.querySelector('[data-slot="none"]') as HTMLElement).hidden).toBe(false)
    expect(verifierRow.querySelector('[data-slot="none"]')?.textContent).toBe(english['story.skills.agentNone'])

    expect(document.querySelector('#story-open-skills-agents')?.textContent).not.toContain('brief-writer')
    expect(document.querySelector('#story-open-skills-agents')?.textContent).not.toContain('scout')
  })

  it('flags an acceptance accepted for no agent, a disabled acceptance and an incompatible one — never an invented "off-track" reason — and says so when nothing is flagged', async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01', title: 'One' })],
      },
      '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }),
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [
          acceptance({ skillId: 'clean-skill', agents: ['builder'] }),
          // Accepted for a role this track never drafts (`planner`) *and*
          // one it does (`builder`). Skill routing never reads
          // `config.tracks` at all (`ops/run.ts:210`,
          // `ops/skill-selection.ts:103`), so this behaves exactly as
          // intended for whichever track drafts `planner` — there is
          // nothing here to warn about.
          acceptance({ skillId: 'off-track-but-fine', agents: ['builder', 'planner'] }),
          // `acceptSkill` with no `--agents` writes `agents: []`
          // (`cli/index.ts:1070`) — the one acceptance that is actually,
          // provably dead: `selectSkills` (`ops/skill-selection.ts:103`)
          // matches `agents.includes(agent)` against it for no agent, ever.
          acceptance({ skillId: 'no-agents-skill', agents: [] }),
          acceptance({ skillId: 'disabled-skill', agents: ['builder'], status: 'disabled' }),
          acceptance({ skillId: 'incompatible-skill', agents: ['builder'], compatible: false }),
        ],
      },
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(1))

    stories.openTab('P001-S01')
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#story-open-skills-warnings .skill-warning')).toHaveLength(3),
    )
    expect((document.getElementById('story-open-skills-warnings-empty') as HTMLElement).hidden).toBe(true)

    const rows = [...document.querySelectorAll('#story-open-skills-warnings .skill-warning')]
    const byId = (id: string): HTMLElement =>
      rows.find((row) => row.querySelector('code')?.textContent === id) as HTMLElement

    const noAgents = byId('no-agents-skill')
    expect((noAgents.querySelector('[data-slot="noAgents"]') as HTMLElement).hidden).toBe(false)
    expect(noAgents.querySelector('[data-slot="noAgents"]')?.textContent).toBe(english['story.skills.warnNoAgents'])
    expect((noAgents.querySelector('[data-slot="notActive"]') as HTMLElement).hidden).toBe(true)
    expect((noAgents.querySelector('[data-slot="notCompatible"]') as HTMLElement).hidden).toBe(true)

    const disabled = byId('disabled-skill')
    expect((disabled.querySelector('[data-slot="notActive"]') as HTMLElement).hidden).toBe(false)
    expect(disabled.querySelector('[data-slot="notActive"]')?.textContent).toBe(english['story.skills.warnDisabled'])
    expect((disabled.querySelector('[data-slot="noAgents"]') as HTMLElement).hidden).toBe(true)

    const incompatible = byId('incompatible-skill')
    expect((incompatible.querySelector('[data-slot="notCompatible"]') as HTMLElement).hidden).toBe(false)
    expect(incompatible.querySelector('[data-slot="notCompatible"]')?.textContent).toBe(
      english['story.skills.warnIncompatible'],
    )

    // The clean acceptance, and the one accepted for an off-track role
    // alongside an on-track one, never appear in the warnings list at all.
    expect(document.querySelector('#story-open-skills-warnings')?.textContent).not.toContain('clean-skill')
    expect(document.querySelector('#story-open-skills-warnings')?.textContent).not.toContain('off-track-but-fine')

    // The same story, now with nothing left to flag: the empty tell, not a
    // list that just looks done loading. Warnings are project-wide (every
    // drafted agent against this project's whole acceptance table), not
    // per-story, so re-serving `/api/skills` and bumping its own revision —
    // never `revisions.plans` — is what this project's own transport rule
    // says has to move it (`web/revision.ts:84`).
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01', title: 'One' })],
      },
      '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }),
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [acceptance({ skillId: 'clean-skill', agents: ['builder'] })],
      },
    })
    draw(
      emptySnapshot({
        plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })],
        revisions: { ...emptySnapshot().revisions, skills: 'r2' },
      }),
    )
    await vi.waitFor(() =>
      expect((document.getElementById('story-open-skills-warnings-empty') as HTMLElement).hidden).toBe(false),
    )
    expect(document.getElementById('story-open-skills-warnings-empty')?.textContent).toBe(
      english['story.skills.warningsNone'],
    )
    expect(document.querySelectorAll('#story-open-skills-warnings .skill-warning')).toHaveLength(0)
  })

  it("draws what the story's evidence run actually pinned, and keeps the honesty line about the pinning gap on screen", async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [
          detailStory({ id: 'P001-S01', title: 'One', status: 'done', evidence: '2026-07-28-001--P001-S01--build' }),
        ],
      },
      '/api/runs/2026-07-28-001--P001-S01--build/skills': skillManifest(),
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] })] }))
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(1))

    stories.openTab('P001-S01')
    await vi.waitFor(() =>
      expect((document.getElementById('story-open-skills-pinned') as HTMLElement).hidden).toBe(false),
    )

    expect((document.getElementById('story-open-skills-no-evidence') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('story-open-skills-pinned-none') as HTMLElement).hidden).toBe(true)
    // Always on screen, whether or not this particular run pinned anything —
    // it explains why the block is usually empty, not that this one is.
    expect(document.getElementById('story-open-skills-hole')).not.toBeNull()

    expect(document.getElementById('story-open-skills-pinned-brief')?.textContent).toBe('F001@2')
    expect(document.getElementById('story-open-skills-pinned-profile')?.textContent).toBe('3')
    expect(document.getElementById('story-open-skills-pinned-concurrency')?.textContent).toBe(
      english['manifest.mode.parallel'],
    )

    const card = document.querySelector('#story-open-skills-pinned-selections .component') as HTMLElement
    expect(card.querySelector('[data-slot="component"]')?.textContent).toBe('web')
    expect(card.querySelector('[data-slot="agent"]')?.textContent).toBe('builder')
    const skillRow = card.querySelector('.rule') as HTMLElement
    expect(skillRow.querySelector('[data-slot="skillId"]')?.textContent).toBe('react-forms')
    expect(skillRow.querySelector('[data-slot="reason"]')?.textContent).toContain('react')
  })

  it('says there is no evidence run yet for a story that has never finished one', async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01', title: 'One', evidence: null })],
      },
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] }))
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(1))

    stories.openTab('P001-S01')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P001-S01 — One'))

    expect((document.getElementById('story-open-skills-no-evidence') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('story-open-skills-no-evidence')?.textContent).toBe(
      english['story.skills.pinnedNoEvidence'],
    )
    expect((document.getElementById('story-open-skills-pinned') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('story-open-skills-pinned-none') as HTMLElement).hidden).toBe(true)
    expect(document.getElementById('story-open-skills-hole')).not.toBeNull()
  })

  it("says a finished run pinned no manifest — the ordinary case for a story build, since /mjloop:build names a story rather than a feature", async () => {
    installStorage(memoryStorage(JSON.stringify({ activePlan: 'P001' })))
    serve({
      '/api/plans/P001': {
        id: 'P001',
        title: 'A plan',
        approval: null,
        body: '',
        review: null,
        stories: [detailStory({ id: 'P001-S01', title: 'One', status: 'done', evidence: 'r1' })],
      },
      '/api/runs/r1/skills': null,
    })
    mountDoc()
    reveal('panel-stories')
    const stories = mountStories()
    draw(emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] })] }))
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story')).toHaveLength(1))

    stories.openTab('P001-S01')
    await vi.waitFor(() =>
      expect((document.getElementById('story-open-skills-pinned-none') as HTMLElement).hidden).toBe(false),
    )
    expect(document.getElementById('story-open-skills-pinned-none')?.textContent).toBe(
      english['story.skills.pinnedNone'],
    )
    expect((document.getElementById('story-open-skills-no-evidence') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('story-open-skills-pinned') as HTMLElement).hidden).toBe(true)
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
          // C1 (engine/src/schemas/config.ts): TrackSchema's new `order` field
          // defaults to `[]` and, since `Track` is the output type, appears on
          // every parsed track — including this test's `baseline`, which the
          // form is seeded from and diffed against. Nothing in the browser
          // changed to produce this key; the schema it parses through did.
          order: [],
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

  describe('order edges', () => {
    /** The `+` for one required/available agent's own row in the order graph. */
    const edgeAddButton = (track: string, agent: string): HTMLElement =>
      document.querySelector(`[data-act="edge-add"][data-track="${track}"][data-agent="${agent}"]`) as HTMLElement
    /** One chip's own × inside `required`/`available`/`closing`/`blocks`. */
    const agentRemoveButton = (track: string, list: string, agent: string): HTMLElement =>
      document.querySelector(
        `[data-act="agent-remove"][data-track="${track}"][data-list="${list}"][data-agent="${agent}"]`,
      ) as HTMLElement
    /** The `+` beside one of the four plain agent lists. */
    const agentAddButton = (track: string, list: string): HTMLElement =>
      document.querySelector(`[data-act="agent-add"][data-track="${track}"][data-list="${list}"]`) as HTMLElement

    it("adds and removes a predecessor through an agent's own row, and carries it into the change set", async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['builder', 'verifier'], available: ['ui-designer'], max_cycles: 5 } },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const add = edgeAddButton('build', 'verifier')
      expect(add, 'no order row for verifier').not.toBeNull()
      const box = add.parentElement?.querySelector('input') as HTMLInputElement
      box.value = 'builder'
      config.edgeAdd(add)

      const row = add.closest('.track-order-agent') as HTMLElement
      expect(row.querySelector('.chips')?.textContent).toContain('builder')
      // Cleared the way every other add box on this card clears itself, once
      // the edge it named has actually landed in the draft.
      expect(box.value).toBe('')

      const form = document.getElementById('config-editor') as HTMLFormElement
      const baseline = ConfigSchema.parse({
        version: 1,
        tracks: { build: { required: ['builder', 'verifier'], available: ['ui-designer'], max_cycles: 5 } },
      })
      expect(collectConfigChanges(form, baseline)).toEqual([
        {
          kind: 'track',
          track: 'build',
          value: {
            required: ['builder', 'verifier'],
            available: ['ui-designer'],
            closing: [],
            order: [{ agent: 'verifier', after: ['builder'] }],
            max_cycles: 5,
          },
        },
      ])

      // The predecessor's own chip, removed the way a chip on any other list
      // removes itself — down to the last one, which drops the whole edge
      // rather than leaving `after: []` behind (`OrderEdgeSchema.after` is
      // `.min(1)`, schemas/config.ts:62).
      const remove = row.querySelector('[data-act="edge-remove"]') as HTMLElement
      expect(remove.dataset['track']).toBe('build')
      expect(remove.dataset['agent']).toBe('verifier')
      expect(remove.dataset['pred']).toBe('builder')
      config.edgeRemove(remove)

      expect(row.querySelector('.chips')?.textContent?.trim()).toBe('')
      expect((row.querySelector('.track-list-empty') as HTMLElement).hidden).toBe(false)
      expect(collectConfigChanges(form, baseline)).toEqual([])
    })

    it("adds a predecessor when Enter is pressed in the box, instead of falling through to the form's Save", async () => {
      // The failure this guards: without a same-file keydown handler, Enter in
      // this box performs the form's implicit submission — `config-save`
      // (index.html:756) is `<form id="config-editor">`'s only submit button —
      // and the typed name, which carries no `name` attribute, is discarded
      // rather than added as an edge.
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['builder', 'verifier'], available: ['ui-designer'], max_cycles: 5 } },
        }),
      })

      reveal('panel-config')
      mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const add = edgeAddButton('build', 'verifier')
      const box = add.parentElement?.querySelector('input') as HTMLInputElement
      box.value = 'builder'
      box.dispatchEvent(new Event('input', { bubbles: true }))

      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      box.dispatchEvent(enter)

      // The keydown's own default (implicit submission) was cancelled, and
      // the edge landed the way pressing the `+` button would have.
      expect(enter.defaultPrevented).toBe(true)
      const row = add.closest('.track-order-agent') as HTMLElement
      expect(row.querySelector('.chips')?.textContent).toContain('builder')
      expect(box.value).toBe('')
    })

    it('shows and edits the union of predecessors when two edges name the same agent, matching what the engine enforces', async () => {
      // The engine deliberately supports this plural shape: `findOrderViolation`
      // (ops/log.ts:598-611) filters `track.order` for every edge naming an
      // agent and loops all of them, and `dispatchWaves` (schemas/config.ts:
      // 767-773) iterates every edge — a `.find` here would show and edit only
      // the first, silently hiding the second predecessor from the operator.
      serve({
        '/api/config': configView({
          tracks: {
            mine: {
              required: ['alpha', 'beta', 'gamma'],
              max_cycles: 3,
              order: [
                { agent: 'alpha', after: ['beta'] },
                { agent: 'alpha', after: ['gamma'] },
              ],
            },
          },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const row = edgeAddButton('mine', 'alpha').closest('.track-order-agent') as HTMLElement
      expect(row.querySelector('.chips')?.textContent).toContain('beta')
      expect(row.querySelector('.chips')?.textContent).toContain('gamma')

      const form = document.getElementById('config-editor') as HTMLFormElement
      const baseline = ConfigSchema.parse({
        version: 1,
        tracks: {
          mine: {
            required: ['alpha', 'beta', 'gamma'],
            max_cycles: 3,
            order: [
              { agent: 'alpha', after: ['beta'] },
              { agent: 'alpha', after: ['gamma'] },
            ],
          },
        },
      })

      // A name already present in the *second* edge is still a duplicate,
      // even though `.find` would only ever see the first — checked against
      // the draft itself, not the rendered chip count: a render-side dedup
      // could keep the chip count at two even if the add silently pushed a
      // second copy of `gamma` into the *first* edge underneath.
      const add = edgeAddButton('mine', 'alpha')
      ;(add.parentElement?.querySelector('input') as HTMLInputElement).value = 'gamma'
      config.edgeAdd(add)
      expect(row.querySelectorAll('.chips .chip-agent')).toHaveLength(2)
      expect(collectConfigChanges(form, baseline)).toEqual([])

      // Removing gamma's chip clears it from the edge that actually names it
      // — the second one — leaving beta, and the first edge, untouched.
      const removeGamma = row.querySelector('[data-act="edge-remove"][data-pred="gamma"]') as HTMLElement
      config.edgeRemove(removeGamma)
      expect(row.querySelector('.chips')?.textContent).toContain('beta')
      expect(row.querySelector('.chips')?.textContent).not.toContain('gamma')

      // The now-empty second edge is dropped entirely, the same way the
      // single-edge case drops its last predecessor.
      expect(collectConfigChanges(form, baseline)).toEqual([
        {
          kind: 'track',
          track: 'mine',
          value: {
            required: ['alpha', 'beta', 'gamma'],
            available: [],
            closing: [],
            order: [{ agent: 'alpha', after: ['beta'] }],
            max_cycles: 3,
          },
        },
      ])
    })

    /** The fill-in-the-blanks a locale string's `{param}` holes actually render as. */
    const fill = (key: string, params: Record<string, string>): string =>
      Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), english[key] ?? key)

    it("flags an edge that waits on an agent the track never runs, the way TrackSchema's own check would", async () => {
      serve({ '/api/config': configView({ tracks: { mine: { required: ['alpha'], max_cycles: 3 } } }) })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const add = edgeAddButton('mine', 'alpha')
      const box = add.parentElement?.querySelector('input') as HTMLInputElement
      box.value = 'ghost'
      config.edgeAdd(add)

      // The chip lands regardless — a name's *shape* is all `validAgent`
      // checks, the same as every other list on this card — and the problem
      // list is what says a name this track never runs is not enough.
      expect(add.closest('.track-order-agent')?.querySelector('.chips')?.textContent).toContain('ghost')
      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderPredUnknown', { agent: 'ghost' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })

    it('flags an edge that waits on a closing agent, which could never log a result inside a cycle', async () => {
      serve({
        '/api/config': configView({
          tracks: { mine: { required: ['alpha'], closing: ['docs'], max_cycles: 3 } },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const add = edgeAddButton('mine', 'alpha')
      const box = add.parentElement?.querySelector('input') as HTMLInputElement
      box.value = 'docs'
      config.edgeAdd(add)

      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderPredClosing', { agent: 'docs' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })

    it("flags an edge that inverts the track's own gate", async () => {
      serve({
        '/api/config': configView({
          tracks: {
            mine: {
              required: ['prover', 'blocked'],
              max_cycles: 3,
              gate: { proven_by: 'prover', blocks: ['blocked'] },
            },
          },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      // The gate already makes `prover`'s pass the precondition `blocked`
      // waits on; ordering `prover` after `blocked` demands the opposite.
      const add = edgeAddButton('mine', 'prover')
      const box = add.parentElement?.querySelector('input') as HTMLInputElement
      box.value = 'blocked'
      config.edgeAdd(add)

      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderInvertsGate', { agent: 'prover' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })

    it('flags a cycle two edges close between them, the same graph `findOrderCycle` walks on the server', async () => {
      serve({
        '/api/config': configView({ tracks: { mine: { required: ['alpha', 'beta'], max_cycles: 3 } } }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const alphaAdd = edgeAddButton('mine', 'alpha')
      ;(alphaAdd.parentElement?.querySelector('input') as HTMLInputElement).value = 'beta'
      config.edgeAdd(alphaAdd)

      const betaAdd = edgeAddButton('mine', 'beta')
      ;(betaAdd.parentElement?.querySelector('input') as HTMLInputElement).value = 'alpha'
      config.edgeAdd(betaAdd)

      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderCycle', { path: 'alpha → beta → alpha' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })

    it('flags an edge whose own agent was removed from the track, and keeps the row reachable so it can be undone', async () => {
      // Starts from a *valid* config carrying an order edge, then reaches the
      // agent-side refusal the same way an operator would: through
      // `agentRemove` on the chip, not by hand-editing the draft.
      serve({
        '/api/config': configView({
          tracks: {
            mine: { required: ['alpha', 'beta'], max_cycles: 3, order: [{ agent: 'alpha', after: ['beta'] }] },
          },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))
      expect(edgeAddButton('mine', 'alpha'), 'no order row for alpha before removal').not.toBeNull()

      const remove = agentRemoveButton('mine', 'required', 'alpha')
      expect(remove, 'no chip to remove alpha from required').not.toBeNull()
      config.agentRemove(remove)

      // The row survives: `draftable` no longer names `alpha`, but its edge
      // is still in the draft, and the row is the union of `draftable` and
      // every `edge.agent` already in `track.order` — so the chip, and the ×
      // that clears it, are both still reachable without a Reset.
      const row = edgeAddButton('mine', 'alpha')
      expect(row, 'the orphaned edge lost its row').not.toBeNull()
      expect(row.closest('.track-order-agent')?.querySelector('.chips')?.textContent).toContain('beta')

      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderAgentUnknown', { agent: 'alpha' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })

    it('flags an edge whose own agent moved into closing, which could never log a result inside a cycle', async () => {
      serve({
        '/api/config': configView({
          tracks: {
            mine: { required: ['alpha', 'beta'], max_cycles: 3, order: [{ agent: 'alpha', after: ['beta'] }] },
          },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      config.agentRemove(agentRemoveButton('mine', 'required', 'alpha'))
      const closingAdd = agentAddButton('mine', 'closing')
      ;(closingAdd.parentElement?.querySelector('input') as HTMLInputElement).value = 'alpha'
      config.agentAdd(closingAdd)

      // `alpha` is `known` again (it is in `closing` now), so this is the
      // closing-agent refusal rather than the unknown-agent one above.
      const row = edgeAddButton('mine', 'alpha')
      expect(row, 'the orphaned edge lost its row').not.toBeNull()

      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderAgentClosing', { agent: 'alpha' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })

    it("folds the gate's own precondition into the cycle check, catching a deadlock one hop past the direct edge", async () => {
      // The direct check (`orderInvertsGate`, asserted above) only sees
      // `edge.agent === gate.proven_by` with a `gate.blocks` name in that same
      // edge's own `after`. This is one hop further: `verifier after planner`,
      // `planner after builder`, with `gate: {proven_by: verifier, blocks:
      // [builder]}` — no edge here names `builder` waiting on `verifier`
      // directly, but the gate already makes `verifier`'s pass the
      // precondition `builder` waits on, so folding `builder after verifier`
      // in as an edge (`schemas/config.ts:244-247`, `config.js`'s own
      // `gateEdges`) is what closes the loop: `verifier -> builder -> planner
      // -> verifier`. Without the fold there is no cycle at all — `builder ->
      // planner -> verifier` alone is an acyclic chain.
      serve({
        '/api/config': configView({
          tracks: {
            mine: {
              required: ['verifier', 'builder', 'planner'],
              max_cycles: 3,
              gate: { proven_by: 'verifier', blocks: ['builder'] },
            },
          },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      const verifierAdd = edgeAddButton('mine', 'verifier')
      ;(verifierAdd.parentElement?.querySelector('input') as HTMLInputElement).value = 'planner'
      config.edgeAdd(verifierAdd)

      const plannerAdd = edgeAddButton('mine', 'planner')
      ;(plannerAdd.parentElement?.querySelector('input') as HTMLInputElement).value = 'builder'
      config.edgeAdd(plannerAdd)

      const problems = document.querySelectorAll('[data-track="mine"] .track-problem')
      expect([...problems].map((node) => node.textContent)).toContain(
        fill('config.problem.orderCycle', { path: 'verifier → builder → planner → verifier' }),
      )
      expect((document.getElementById('config-save') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  describe('change preview (C6)', () => {
    /** One track card's preview list — field changes and named order edges alike. */
    const previewItems = (track: string): string[] =>
      [...document.querySelectorAll(`[data-track="${track}"] .track-preview-item`)].map(
        (node) => node.textContent ?? '',
      )
    const fill = (key: string, params: Record<string, string>): string =>
      Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), english[key] ?? key)

    it('names each order edge Save would add and remove, and nothing else', async () => {
      // `config.patch`'s `track` variant sends the whole subtree
      // (store/config-mutation.ts:220-222) under a compare-and-swap over the
      // whole file (:161) — this is the one place a reader sees, before
      // pressing Save, which edges that write actually carries.
      serve({
        '/api/config': configView({
          tracks: {
            build: { required: ['alpha', 'beta', 'gamma'], max_cycles: 5, order: [{ agent: 'alpha', after: ['beta'] }] },
          },
        }),
      })

      reveal('panel-config')
      const config = mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      expect(previewItems('build'), 'nothing pending yet').toEqual([])

      // Adds `alpha after gamma` and removes `alpha after beta`.
      const add = document.querySelector('[data-act="edge-add"][data-track="build"][data-agent="alpha"]') as HTMLElement
      ;(add.parentElement?.querySelector('input') as HTMLInputElement).value = 'gamma'
      config.edgeAdd(add)
      const removeBeta = document.querySelector(
        '[data-act="edge-remove"][data-track="build"][data-agent="alpha"][data-pred="beta"]',
      ) as HTMLElement
      config.edgeRemove(removeBeta)

      const items = previewItems('build')
      expect(items).toContain(fill('config.preview.orderAdded', { agent: 'alpha', pred: 'gamma' }))
      expect(items).toContain(fill('config.preview.orderRemoved', { agent: 'alpha', pred: 'beta' }))
      // Nothing else on this track moved — `required`, `available`, `closing`,
      // `max_cycles`, `gate` and `map` are all still what the baseline holds.
      expect(items).toHaveLength(2)
    })

    it('says nothing will change while the draft still matches the baseline', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['alpha'], max_cycles: 5 } } }) })

      reveal('panel-config')
      mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      expect(previewItems('build')).toEqual([])
      // `.track-list-empty` is shared with the four agent lists, so the
      // preview's own is found by its text rather than its class alone —
      // `available` and `closing` are empty here too and show
      // `config.noAgents` ("none").
      const previewEmpty = [...document.querySelectorAll('[data-track="build"] .track-list-empty')].find(
        (node) => node.textContent === english['config.preview.noChanges'],
      )
      expect(previewEmpty, 'no "nothing will change" message found').not.toBeUndefined()
      expect((previewEmpty as HTMLElement).hidden).toBe(false)
      expect(document.querySelector('[data-track="build"] .track-preview-comments')?.hasAttribute('hidden')).toBe(
        true,
      )
    })

    it("counts the comment lines a pending save would drop from a track's own block, and only once the track is actually part of the save", async () => {
      // Hand-built rather than through `configView()`, which always serves
      // `raw: 'version: 1\n'` — this test is the one place `raw` has to carry
      // real content for `trackCommentLoss` to walk.
      const raw = [
        'version: 1',
        'tracks:',
        '  build:',
        "    # Three agents, so one busy day doesn't stall this track.",
        '    required:',
        '      - alpha',
        '      - beta',
        '      - gamma',
        "    # Lower until the verifier's own suite gets faster.",
        '    max_cycles: 5',
        '  edit:',
        '    required:',
        '      - builder',
        '    max_cycles: 2',
        '',
      ].join('\n')
      serve({
        '/api/config': {
          raw,
          revision: 'a'.repeat(64),
          parsed: ConfigSchema.parse({
            version: 1,
            tracks: {
              build: { required: ['alpha', 'beta', 'gamma'], max_cycles: 5 },
              edit: { required: ['builder'], max_cycles: 2 },
            },
          }),
          invalid: false,
        },
      })

      reveal('panel-config')
      mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(2))

      // Untouched: nothing pending for `build`, so nothing this save would
      // discard either — the count is not shown before there is a save to
      // warn about.
      expect(document.querySelector('[data-track="build"] .track-preview-comments')?.hasAttribute('hidden')).toBe(
        true,
      )

      // Turning the gate on is a real field change (`gate` goes from absent
      // to present), which is what puts this track's whole subtree — and the
      // two comment lines inside it — on the next Save.
      const gate = document.querySelector('[data-track="build"] [data-field="gate-enabled"]') as HTMLInputElement
      gate.checked = true
      gate.dispatchEvent(new Event('change', { bubbles: true }))

      const comments = document.querySelector('[data-track="build"] .track-preview-comments') as HTMLElement
      expect(comments.hasAttribute('hidden')).toBe(false)
      expect(comments.textContent).toBe(fill('config.preview.commentsLost.other', { count: '2' }))

      // `edit`'s own block carries no comment at all, and nothing is pending
      // for it either — both are reasons its own line stays hidden.
      expect(document.querySelector('[data-track="edit"] .track-preview-comments')?.hasAttribute('hidden')).toBe(
        true,
      )
    })

    it('still shows the comment count when a toggle round-trips a field back to its baseline value', async () => {
      // The review's probe for the converse of the comment above this block:
      // turning `map` off and back on restores `map`'s own *value* (still
      // `{drafted_by: 'alpha'}`), so `trackFieldChanges`'s per-field
      // `differs` check on `map` comes back equal and `items` names nothing —
      // but `onField`'s `map-enabled` case (:356-364) `delete`s `entry.map`
      // and then reassigns it, which moves the key to the end of the track
      // object. `collectConfigChanges`'s own whole-object compare (:1185:
      // `JSON.stringify(baseline.tracks[track] ?? null) !== JSON.stringify
      // (next)`) still differs on that key order, so Save still sends this
      // track's subtree and the comment inside it is still lost. An `items`
      // count of zero must not be read as "nothing pending".
      const raw = [
        'version: 1',
        'tracks:',
        '  build:',
        '    # one comment',
        '    # two comment',
        '    required:',
        '      - alpha',
        '    max_cycles: 5',
        '    map:',
        '      drafted_by: alpha',
        '',
      ].join('\n')
      serve({
        '/api/config': {
          raw,
          revision: 'a'.repeat(64),
          parsed: ConfigSchema.parse({
            version: 1,
            tracks: { build: { required: ['alpha'], max_cycles: 5, map: { drafted_by: 'alpha' } } },
          }),
          invalid: false,
        },
      })

      reveal('panel-config')
      mountConfig()
      draw(emptySnapshot())
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      expect(previewItems('build'), 'nothing pending yet').toEqual([])
      expect(document.querySelector('[data-track="build"] .track-preview-comments')?.hasAttribute('hidden')).toBe(
        true,
      )

      const map = document.querySelector('[data-track="build"] [data-field="map-enabled"]') as HTMLInputElement
      map.checked = false
      map.dispatchEvent(new Event('change', { bubbles: true }))
      map.checked = true
      map.dispatchEvent(new Event('change', { bubbles: true }))

      // Every named field is back at the value the baseline holds — `items`
      // still names nothing — but the round trip still moved `map` to the
      // end of the track object, so the whole-object compare `pending` reads
      // still differs and this save is still queued.
      expect(previewItems('build'), 'no single field moved').toEqual([])
      const previewEmpty = [...document.querySelectorAll('[data-track="build"] .track-list-empty')].find(
        (node) => node.textContent === english['config.preview.noChanges'],
      )
      expect(
        (previewEmpty as HTMLElement).hidden,
        '"saving now would change nothing" must not show once a save is queued',
      ).toBe(true)
      const comments = document.querySelector('[data-track="build"] .track-preview-comments') as HTMLElement
      expect(comments.hasAttribute('hidden'), 'the comment this save would drop must still be named').toBe(false)
      expect(comments.textContent).toBe(fill('config.preview.commentsLost.other', { count: '2' }))
    })

    it('keeps the comment count in step with a new revision that lands while the draft is dirty, not the raw text it replaced', async () => {
      // Probe for the review's second defect: `updateEditor`'s conflict
      // branch (:604 before this fix, now hoisted above the branch) is the
      // one place `rawText` can move independently of `baseline` — this test
      // dirties the draft, then serves a second `/api/config` with a
      // different revision *and* a different `raw`, and asserts the
      // comment-loss count reads the NEW raw rather than the one the editor
      // was seeded from.
      const rawA = ['version: 1', 'tracks:', '  build:', '    # one', '    required:', '      - alpha', '    max_cycles: 5', ''].join(
        '\n',
      )
      const rawB = [
        'version: 1',
        'tracks:',
        '  build:',
        '    # one',
        '    # two',
        '    # three',
        '    required:',
        '      - alpha',
        '    max_cycles: 5',
        '',
      ].join('\n')
      const trackConfig = { version: 1, tracks: { build: { required: ['alpha'], max_cycles: 5 } } }

      let served: unknown = { raw: rawA, revision: 'a'.repeat(64), parsed: ConfigSchema.parse(trackConfig), invalid: false }
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
      await vi.waitFor(() => expect(document.querySelectorAll('.track-editor')).toHaveLength(1))

      // Dirty the draft against `build`, so it is still pending once the
      // conflicting revision lands and does not get reseeded away. (An empty
      // `gate.blocks` also makes `trackProblems` flag `noBlocks` and disables
      // Save — irrelevant here: `markDirty` sets `dirty` regardless of
      // validity, and `dirty` is the only thing this test's conflict branch
      // depends on.)
      const gate = document.querySelector('[data-track="build"] [data-field="gate-enabled"]') as HTMLInputElement
      gate.checked = true
      gate.dispatchEvent(new Event('change', { bubbles: true }))
      expect((document.getElementById('config-reset') as HTMLButtonElement).disabled, 'draft is dirty').toBe(false)

      served = { raw: rawB, revision: 'b'.repeat(64), parsed: ConfigSchema.parse(trackConfig), invalid: false }
      draw(emptySnapshot({ revisions: { ...emptySnapshot().revisions, config: 'moved' } }))
      await vi.waitFor(() =>
        expect(document.getElementById('config-editor-state')?.textContent).toBe(english['config.editorChanged']),
      )

      // The conflict branch does not reseed the draft, so the gate toggle —
      // and with it, the pending save on `build` — survives. The comment
      // count it shows must be `rawB`'s (3), never `rawA`'s (1).
      const comments = document.querySelector('[data-track="build"] .track-preview-comments') as HTMLElement
      expect(comments.hasAttribute('hidden'), 'the gate toggle survived the conflict and is still pending').toBe(
        false,
      )
      expect(comments.textContent).toBe(fill('config.preview.commentsLost.other', { count: '3' }))
    })
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
