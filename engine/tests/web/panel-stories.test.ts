// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, watch } from 'vue'
import { ConfigSchema, DEFAULT_TRACKS } from '../../src/schemas/config.js'
import { SkillManifestSchema } from '../../src/schemas/skill-selection.js'
import type { Snapshot } from '../../src/web/protocol.js'
import type { ProjectSkillAcceptance } from '../../src/schemas/skill-acceptance.js'
import { DEP_DEPTH_LIMIT } from '../../src/web/app/lib/stories.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Stories panel — `panels/stories.js`, `ui/worktabs.js`, `describe('stories')`
 * at `panels.test.ts:577`, and the stories section of `index.html` — ported to
 * `Stories.vue`.
 *
 * `lib/stories.ts`'s own derivations (readiness, `depTree`, `sift`, the skill
 * filters) are tested at `lib.test.ts`'s `describe('lib/stories')`; what is
 * under test here is the DOM this panel draws from them, the work-tab strip's
 * own keyboard contract, and the requeue write with its undo.
 */

const english = await readLocale('en')

/** The same fake socket every other panel test drives the store with. */
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

/**
 * `hasOwnProperty`, not `?? fallback`: a route legitimately served with a
 * literal `null` body — `/api/runs/:id/skills` for a run that pinned no
 * manifest — is nullish too, and `??` would silently swap it for the 404
 * error object, still with a `200` status, leaving `skillManifestFeed` to
 * hold `{error:{code:...}}` where a caller expected `SkillManifest | null`.
 */
function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const key = url.split('?')[0] ?? ''
    const known = Object.prototype.hasOwnProperty.call(routes, key)
    return Promise.resolve(
      new Response(JSON.stringify(known ? routes[key] : { error: { code: 'error.notFound' } }), { status: known ? 200 : 404 }),
    )
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
  document.documentElement.dir = 'ltr'
})

/**
 * Every mounted wrapper this file's tests produce, unmounted in `afterEach`.
 *
 * `vi.resetModules()` gives each test a fresh module graph, but `vue` itself
 * is imported statically at the top of this file and so is one shared
 * runtime across the whole suite. A wrapper left mounted keeps its watchers
 * live in that shared scheduler; a feed's in-flight fetch resolving after its
 * own test has already moved on then re-renders a component whose story
 * tab and served routes belong to a *later* test, which is what produced this
 * file's own reproduction of exactly that: a `pinnedManifest` read for a
 * story a later test never served the manifest route for. Unmounting here
 * is what a real page never needs (there is only ever one `Stories.vue`
 * instance) but a suite that boots a fresh instance per test does.
 */
/** Only `unmount()` is used on the tracked list — every `mount()` result, whatever component it wraps, has one. */
interface Unmountable {
  unmount(): void
}
const mounted: Unmountable[] = []
function mountTracked<T extends Parameters<typeof mount>[0]>(component: T, options?: Parameters<typeof mount>[1]) {
  const wrapper = mount(component, options as never)
  mounted.push(wrapper)
  return wrapper
}
afterEach(async () => {
  // Let any in-flight feed fetch settle while its component is still
  // mounted, rather than racing a `.then()` that fires after `unmount()`.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

/**
 * Boots a fresh module graph, seeds storage, connects a `FakeSocket`, and
 * delivers a snapshot — `App.vue`'s own boot order, reproduced the same way
 * `panel-plans.test.ts`'s `boot()` does, including the plan-document pump
 * `App.vue` owns (`mountPlanDoc()` driven by `watch([snapshot, activePlan], …)`),
 * since `Stories.vue` only `subscribe()`s and reads `value()`.
 *
 * @param seed What `mjloop.prefs` already holds — the persisted plan, story
 *   filter and open tabs all need this seeded *before* `useSelection.ts`'s
 *   module graph loads, since every ref there is read from it at first import.
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
  const { default: Stories } = await import('../../src/web/app/panels/Stories.vue')
  const { default: Toasts } = await import('../../src/web/app/components/Toasts.vue')
  const { useToasts } = await import('../../src/web/app/composables/useToasts.ts')
  const toasts = useToasts()
  store.installAnnouncer(toasts.notify)
  const StoriesHost = defineComponent({ setup: () => () => h('div', [h(Stories), h(Toasts)]) })
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Stories, StoriesHost, local, selection, socket: FakeSocket.last as FakeSocket }
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

/** A story as the read api serves it: frontmatter the manifest does not carry. */
const detailStory = (patch: Record<string, unknown> & { id: string }) => ({
  title: 'A story',
  status: 'todo',
  ui: false,
  depends_on: [],
  acceptance: [],
  evidence: null,
  body: '',
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

const NOW = '2026-07-28T09:00:00.000Z'

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

/** A plan with three stories, mounted and ready to be worked with. */
async function openThree() {
  serve({
    '/api/plans/P001': planDetail({
      id: 'P001',
      stories: [
        detailStory({ id: 'P001-S01', title: 'One', status: 'done' }),
        detailStory({ id: 'P001-S02', title: 'Two', acceptance: ['It works.'] }),
        detailStory({ id: 'P001-S03', title: 'Three', depends_on: ['P001-S02'] }),
      ],
    }),
  })
  const booted = await boot(
    emptySnapshot({
      plans: [
        planFixture({
          id: 'P001',
          stories: [
            storyFixture({ id: 'P001-S01', status: 'done' }),
            storyFixture({ id: 'P001-S02' }),
            storyFixture({ id: 'P001-S03', depends_on: ['P001-S02'] }),
          ],
        }),
      ],
    }),
    JSON.stringify({ activePlan: 'P001' }),
  )
  const wrapper = mountTracked(booted.Stories, { attachTo: document.body })
  await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(3))
  return { ...booted, wrapper }
}

const tabIds = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('#story-tabs .worktab-open').map((node) => node.attributes('data-tab'))
const selectedTab = (wrapper: ReturnType<typeof mount>) =>
  wrapper.find('#story-tabs [aria-selected="true"]').exists() ? wrapper.find('#story-tabs [aria-selected="true"]').attributes('data-tab') : undefined

describe('Stories.vue', () => {
  it('draws each story once, in the open plan, with its status as a word', async () => {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [detailStory({ id: 'P001-S01', status: 'done', evidence: '2026-07-28-001' }), detailStory({ id: 'P001-S02', depends_on: ['P001-S01'] })],
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            stories: [storyFixture({ id: 'P001-S01', status: 'done' }), storyFixture({ id: 'P001-S02', depends_on: ['P001-S01'] })],
          }),
        ],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(2))

    const rows = wrapper.findAll('#stories-list .story')
    expect(rows[0]?.find('.story-status').text()).toBe('done')
    expect(rows[1]?.find('.story-status').text()).toBe('todo')
    expect(rows[1]?.find('.waits').attributes('hidden')).toBeDefined()
    expect((rows[1]?.find('[data-act="story-run"]').element as HTMLButtonElement).disabled).toBe(false)
    expect(rows[1]?.find('[data-act="story-run"]').text()).toBe(english['story.runAction'])
  })

  it('disables the build button and says why when a dependency is unmet', async () => {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [detailStory({ id: 'P001-S01' }), detailStory({ id: 'P001-S02', depends_on: ['P001-S01'] })],
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({
        plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' }), storyFixture({ id: 'P001-S02', depends_on: ['P001-S01'] })] })],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(2))

    const second = wrapper.findAll('#stories-list .story')[1]!
    expect(second.find('.waits').attributes('hidden')).toBeUndefined()
    expect(second.find('.waits').text()).toContain('P001-S01')
    expect((second.find('[data-act="story-run"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('filters the open plan down to what the reader asked for', async () => {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [
          detailStory({ id: 'P001-S01', status: 'done', title: 'Rebaseline PROGRESS.md', evidence: 'r1' }),
          detailStory({ id: 'P001-S02', title: 'Amend DECISIONS.md' }),
        ],
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01', status: 'done' }), storyFixture({ id: 'P001-S02' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(2))

    await wrapper.get('#story-filter').setValue('ready')
    expect(wrapper.findAll('#stories-list .story .story-id').map((n) => n.text())).toEqual(['P001-S02'])

    await wrapper.get('#story-filter').setValue('')
    await wrapper.get('#story-query').setValue('progress')
    expect(wrapper.findAll('#stories-list .story .story-id').map((n) => n.text())).toEqual(['P001-S01'])

    await wrapper.get('#story-query').setValue('nothing matches this')
    expect(wrapper.findAll('#stories-list .story')).toHaveLength(0)
    expect(wrapper.get('#stories-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#stories-empty').text()).toBe(english['story.noMatch'])
  })

  it('restores the filter the reader chose, with no click', async () => {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [detailStory({ id: 'P001-S01', title: 'Done one', status: 'done' }), detailStory({ id: 'P001-S02', title: 'Todo one' })],
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01', status: 'done' }), storyFixture({ id: 'P001-S02' })] })] }),
      JSON.stringify({ activePlan: 'P001', storyFilter: 'done' }),
    )
    const wrapper = mountTracked(Stories)
    expect((wrapper.get('#story-filter').element as HTMLSelectElement).value).toBe('done')
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story .story-id').map((n) => n.text())).toEqual(['P001-S01']))
  })

  it('opens a story into a tab, and the tab shows that story', async () => {
    const { wrapper } = await openThree()
    expect(wrapper.get('#story-tabs').attributes('hidden')).toBeDefined()

    await wrapper.get('[data-slot="open"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toEqual(['P001-S02']))
    expect(selectedTab(wrapper)).toBe('P001-S02')
    expect(wrapper.get('#story-open').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#story-open-title').text()).toBe('P001-S02 — Two')
    expect(wrapper.get('#story-open-accept-summary').text()).toContain('1')
    expect(wrapper.get('#story-open-body-details').attributes('hidden')).toBeDefined()
  })

  it('renders the story body, beside the acceptance criteria', async () => {
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', title: 'One', body: 'Log in with a mailed link.' })] }),
    })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))

    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#story-open-body-details').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#story-open-body').text()).toBe('Log in with a mailed link.')
  })

  it('names what a story unblocks, the inverse edge nothing on disk stores', async () => {
    const { wrapper } = await openThree()

    await wrapper.get('[data-slot="open"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S02 — Two'))
    expect(wrapper.findAll('#story-open-facts dd')[2]?.text()).toBe('P001-S03')

    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S01 — One'))
    expect(wrapper.findAll('#story-open-facts dd')[2]?.text()).toBe('—')
  })

  it("narrows the open story's execution history to its own runs, out of the shared list", async () => {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [detailStory({ id: 'P001-S01', title: 'One' }), detailStory({ id: 'P001-S02', title: 'Two' }), detailStory({ id: 'P001-S03', title: 'Three' })],
      }),
      '/api/runs': [
        { id: '2026-07-28-001--P001-S01--build', story: 'P001-S01', track: 'build', cycles: 2, halted: false },
        { id: '2026-07-28-002--P001-S02--build', story: 'P001-S02', track: 'build', cycles: 1, halted: true },
      ],
    })
    const { Stories } = await boot(
      emptySnapshot({
        plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' }), storyFixture({ id: 'P001-S02' }), storyFixture({ id: 'P001-S03' })] })],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(3))

    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('#story-open-runs .run')).toHaveLength(1))
    const first = wrapper.find('#story-open-runs .run')
    expect(first.text()).toContain('2026-07-28-001--P001-S01--build')
    expect(first.text()).not.toContain('2026-07-28-002--P001-S02--build')
    expect(first.text()).toContain('ended')
    expect(first.find('.chip').text()).toBe('build')
    expect(first.find('[data-slot="cycles"]').text()).toBe('2 cycles')
    expect(wrapper.get('#story-open-runs-empty').attributes('hidden')).toBeDefined()

    await wrapper.get('[data-slot="open"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('#story-open-runs .run').text()).toContain('2026-07-28-002--P001-S02--build'))
    const second = wrapper.find('#story-open-runs .run')
    expect(second.text()).not.toContain('2026-07-28-001--P001-S01--build')
    expect(second.text()).toContain('halted')
    expect(wrapper.findAll('#story-open-runs .run')).toHaveLength(1)

    await wrapper.get('[data-slot="open"][data-story="P001-S03"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S03 — Three'))
    expect(wrapper.findAll('#story-open-runs .run')).toHaveLength(0)
    expect(wrapper.get('#story-open-runs-empty').attributes('hidden')).toBeUndefined()
  })

  /** Two dependencies in different non-`done` statuses, and a typo'd one. */
  async function openReadinessFixture() {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [
          detailStory({ id: 'P001-S01', title: 'One', status: 'doing' }),
          detailStory({ id: 'P001-S02', title: 'Two', status: 'blocked' }),
          detailStory({ id: 'P001-S03', title: 'Three', depends_on: ['P001-S01', 'P001-S02'] }),
          detailStory({ id: 'P001-S04', title: 'Four' }),
          detailStory({ id: 'P001-S05', title: 'Five', depends_on: ['P001-S99'] }),
        ],
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            stories: [
              storyFixture({ id: 'P001-S01', status: 'doing' }),
              storyFixture({ id: 'P001-S02', status: 'blocked' }),
              storyFixture({ id: 'P001-S03', depends_on: ['P001-S01', 'P001-S02'] }),
              storyFixture({ id: 'P001-S04' }),
              storyFixture({ id: 'P001-S05', depends_on: ['P001-S99'] }),
            ],
          }),
        ],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(5))
    return wrapper
  }

  it('reads out each unmet dependency with its own status, and previews the exact Build command', async () => {
    const wrapper = await openReadinessFixture()

    await wrapper.get('[data-slot="open"][data-story="P001-S03"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S03 — Three'))
    expect(wrapper.get('#story-open-waits').attributes('hidden')).toBeUndefined()
    const rows = wrapper.findAll('#story-open-waits .wait-row')
    expect(rows.map((row) => row.find('.story-id').text())).toEqual(['P001-S01', 'P001-S02'])
    expect(rows.map((row) => row.find('.story-status').text())).toEqual(['doing', 'blocked'])
    expect(rows[0]?.find('.story-status').classes()).toContain('status-doing')
    expect(rows[1]?.find('.story-status').classes()).toContain('status-blocked')
    expect(wrapper.get('#story-open-meta').text()).toBe(english['story.waitsOn'])
    expect(wrapper.get('#story-open-command').text()).toBe('/mjloop:build P001-S03')

    await wrapper.get('[data-slot="open"][data-story="P001-S04"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S04 — Four'))
    expect(wrapper.get('#story-open-waits').attributes('hidden')).toBeDefined()
    expect(wrapper.findAll('#story-open-waits .wait-row')).toHaveLength(0)
    expect(wrapper.get('#story-open-meta').text()).toBe(english['story.open.clear'])
    expect(wrapper.get('#story-open-command').text()).toBe('/mjloop:build P001-S04')

    await wrapper.get('[data-slot="open"][data-story="P001-S05"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S05 — Five'))
    const unresolved = wrapper.findAll('#story-open-waits .wait-row')
    expect(unresolved.map((row) => row.find('.story-id').text())).toEqual(['P001-S99'])
    expect(unresolved.map((row) => row.find('.story-status').text())).toEqual(['—'])
    expect(unresolved[0]?.find('.story-status').classes()).toContain('status-unknown')
  })

  it('says which non-dependency reason a story is not ready, reusing story.notBuildable', async () => {
    const wrapper = await openReadinessFixture()

    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S01 — One'))
    expect(wrapper.get('#story-open-meta').text()).toBe(english['story.notBuildable.doing'])
    expect(wrapper.get('#story-open-waits').attributes('hidden')).toBeDefined()

    await wrapper.get('[data-slot="open"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S02 — Two'))
    expect(wrapper.get('#story-open-meta').text()).toBe(english['story.notBuildable.blocked'])
    expect(wrapper.get('#story-open-waits').attributes('hidden')).toBeDefined()
  })

  /** A two-level chain, an unrelated story, a hand-edited cycle, and a typo'd dependency. */
  async function openDepTreeFixture() {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [
          detailStory({ id: 'P001-S01', title: 'One', status: 'done' }),
          detailStory({ id: 'P001-S02', title: 'Two', status: 'doing', depends_on: ['P001-S01'] }),
          detailStory({ id: 'P001-S03', title: 'Three', depends_on: ['P001-S02'] }),
          detailStory({ id: 'P001-S04', title: 'Four' }),
          detailStory({ id: 'P001-S05', title: 'Five', depends_on: ['P001-S06'] }),
          detailStory({ id: 'P001-S06', title: 'Six', depends_on: ['P001-S05'] }),
          detailStory({ id: 'P001-S07', title: 'Seven', depends_on: ['P001-S99'] }),
        ],
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            stories: [
              storyFixture({ id: 'P001-S01', status: 'done' }),
              storyFixture({ id: 'P001-S02', status: 'doing', depends_on: ['P001-S01'] }),
              storyFixture({ id: 'P001-S03', depends_on: ['P001-S02'] }),
              storyFixture({ id: 'P001-S04' }),
              storyFixture({ id: 'P001-S05', depends_on: ['P001-S06'] }),
              storyFixture({ id: 'P001-S06', depends_on: ['P001-S05'] }),
              storyFixture({ id: 'P001-S07', depends_on: ['P001-S99'] }),
            ],
          }),
        ],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(7))
    return wrapper
  }

  const depRows = (wrapper: ReturnType<typeof mount>) =>
    wrapper.findAll('#story-open-deps-list .dep-row').map((row) => ({
      id: row.find('.story-id').text(),
      status: row.find('.story-status').text(),
      depth: row.classes().find((name) => name.startsWith('depth-')) ?? null,
      ariaLevel: row.attributes('aria-level') ?? null,
    }))

  it('indents a two-level dependency chain, each node with its own status', async () => {
    const wrapper = await openDepTreeFixture()

    await wrapper.get('[data-slot="open"][data-story="P001-S03"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S03 — Three'))
    expect(wrapper.get('#story-open-deps-empty').attributes('hidden')).toBeDefined()
    expect(depRows(wrapper)).toEqual([
      { id: 'P001-S02', status: 'doing', depth: 'depth-0', ariaLevel: '1' },
      { id: 'P001-S01', status: 'done', depth: 'depth-1', ariaLevel: '2' },
    ])
    const cells = wrapper.findAll('#story-open-deps-list .story-status')
    expect(cells[0]?.classes()).toContain('status-doing')
    expect(cells[1]?.classes()).toContain('status-done')
    expect(wrapper.get('#story-open-deps-list').attributes('role')).toBe('tree')
    for (const row of wrapper.findAll('#story-open-deps-list .dep-row')) expect(row.attributes('role')).toBe('treeitem')
  })

  it('shows the empty phrase for a story with no dependencies', async () => {
    const wrapper = await openDepTreeFixture()
    await wrapper.get('[data-slot="open"][data-story="P001-S04"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S04 — Four'))
    expect(wrapper.get('#story-open-deps-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#story-open-deps-empty').text()).toBe(english['story.deps.empty'])
    expect(depRows(wrapper)).toEqual([])
  })

  it('walks a hand-edited cycle without hanging, and stops re-entering it', async () => {
    const wrapper = await openDepTreeFixture()
    await wrapper.get('[data-slot="open"][data-story="P001-S05"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S05 — Five'))
    expect(depRows(wrapper)).toEqual([
      { id: 'P001-S06', status: 'todo', depth: 'depth-0', ariaLevel: '1' },
      { id: 'P001-S05', status: 'todo', depth: 'depth-1', ariaLevel: '2' },
    ])
  })

  it('renders a dependency id the plan cannot resolve as a leaf, no status word to lie about', async () => {
    const wrapper = await openDepTreeFixture()
    await wrapper.get('[data-slot="open"][data-story="P001-S07"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S07 — Seven'))
    expect(depRows(wrapper)).toEqual([{ id: 'P001-S99', status: '—', depth: 'depth-0', ariaLevel: '1' }])
    expect(wrapper.get('#story-open-deps-list .story-status').classes()).toContain('status-unknown')
  })

  it('caps a genuinely acyclic chain at DEP_DEPTH_LIMIT hops', async () => {
    const ids10 = ['P001-S10', 'P001-S11', 'P001-S12', 'P001-S13', 'P001-S14', 'P001-S15', 'P001-S16']
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: ids10.map((id, i) => detailStory({ id, title: id, depends_on: i < 6 ? [ids10[i + 1]] : [] })),
      }),
    })
    const { Stories } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            stories: ids10.map((id, i) => storyFixture({ id, depends_on: i < 6 ? [ids10[i + 1] as string] : [] })),
          }),
        ],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(7))

    await wrapper.get('[data-slot="open"][data-story="P001-S10"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S10 — P001-S10'))

    const rows = depRows(wrapper)
    expect(rows).toHaveLength(DEP_DEPTH_LIMIT)
    expect(rows.map((row) => row.id)).toEqual(['P001-S11', 'P001-S12', 'P001-S13', 'P001-S14', 'P001-S15'])
    expect(rows.some((row) => row.id === 'P001-S16')).toBe(false)
  })

  it('caps the dependency list like every other list, with an explicit show-more', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `P001-S${String(i + 1).padStart(2, '0')}`)
    const depsFor = (position: number) => [position - 3, position - 2, position - 1].filter((j) => j >= 1).map((j) => ids[j - 1] as string)
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: ids.map((id, index) => detailStory({ id, title: id, depends_on: depsFor(index + 1) })) }) })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: ids.map((id, index) => storyFixture({ id, depends_on: depsFor(index + 1) })) })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(12))

    const last = ids[11] as string
    await wrapper.get(`[data-slot="open"][data-story="${last}"]`).trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe(`${last} — ${last}`))

    expect(depRows(wrapper)).toHaveLength(200)
    expect(wrapper.get('#story-open-deps-more').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#story-open-deps-more').text()).toBe((english['story.deps.more.other'] as string).replace('{count}', '111'))
  })

  it('walks the strip with the arrow keys, and the direction follows the document', async () => {
    const { wrapper } = await openThree()
    for (const id of ['P001-S01', 'P001-S02', 'P001-S03']) await wrapper.get(`[data-slot="open"][data-story="${id}"]`).trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toEqual(['P001-S01', 'P001-S02', 'P001-S03']))
    expect(selectedTab(wrapper)).toBe('P001-S03')

    const strip = wrapper.get('#story-tabs')
    const press = async (key: string) => {
      await strip.trigger('keydown', { key })
    }

    document.documentElement.dir = 'ltr'
    await press('ArrowRight')
    expect(selectedTab(wrapper)).toBe('P001-S01')
    await press('ArrowLeft')
    expect(selectedTab(wrapper)).toBe('P001-S03')
    await press('Home')
    expect(selectedTab(wrapper)).toBe('P001-S01')
    await press('End')
    expect(selectedTab(wrapper)).toBe('P001-S03')

    document.documentElement.dir = 'rtl'
    await press('Home')
    expect(selectedTab(wrapper)).toBe('P001-S01')
    await press('ArrowRight')
    expect(selectedTab(wrapper)).toBe('P001-S03')
    await press('ArrowLeft')
    expect(selectedTab(wrapper)).toBe('P001-S01')
    document.documentElement.dir = 'ltr'
  })

  it('keeps exactly one tab in the page tab order', async () => {
    const { wrapper } = await openThree()
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await wrapper.get('[data-slot="open"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toHaveLength(2))
    const order = wrapper.findAll('#story-tabs .worktab-open').map((node) => node.attributes('tabindex'))
    expect(order).toEqual(['-1', '0'])
  })

  it('closes a tab, and puts the last closed one back', async () => {
    const { wrapper } = await openThree()
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await wrapper.get('[data-slot="open"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toHaveLength(2))

    await wrapper.get('[data-slot="close"][data-story="P001-S02"]').trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toEqual(['P001-S01']))
    expect(wrapper.get('#story-tabs-reopen').attributes('hidden')).toBeUndefined()

    await wrapper.get('#story-tabs-reopen button').trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toEqual(['P001-S01', 'P001-S02']))
    expect(wrapper.get('#story-tabs-reopen').attributes('hidden')).toBeDefined()
  })

  it('a pinned tab offers no close button', async () => {
    const { wrapper } = await openThree()
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(tabIds(wrapper)).toEqual(['P001-S01']))
    expect(wrapper.get('.worktab-close').attributes('hidden')).toBeUndefined()

    await wrapper.get('[data-slot="pin"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('.worktab-close').attributes('hidden')).toBeDefined())
    expect(wrapper.get('.worktab-pin').classes()).toContain('pinned-yes')
  })

  it('drops a tab whose story the plan no longer carries', async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01' })] }) })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001', openStories: [{ id: 'P001-S99', pinned: false }] }),
    )
    const wrapper = mountTracked(Stories)
    await nextTick()
    expect(tabIds(wrapper)).toEqual([])
    expect(wrapper.get('#story-open').attributes('hidden')).toBeDefined()
  })

  it('names the buildable stories and marks the one that is next', async () => {
    const { Stories } = await boot(
      emptySnapshot({
        plans: [
          planFixture({
            id: 'P001',
            stories: [storyFixture({ id: 'P001-S01', title: 'First up' }), storyFixture({ id: 'P001-S02', title: 'Also ready' }), storyFixture({ id: 'P001-S03', depends_on: ['P001-S01'] })],
          }),
        ],
      }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await nextTick()

    const rows = wrapper.findAll('#stories-ready-list .ready-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.find('.story-title').text()).toBe('First up')
    expect(rows[0]?.find('[data-slot="plan"]').text()).toBe('P001')
    expect(rows[0]?.find('.tag.next').attributes('hidden')).toBeUndefined()
    expect(rows[1]?.find('.tag.next').attributes('hidden')).toBeDefined()
  })

  it("shows a row only for the drafted agents an acceptance's own agents field could ever name, and leaves out an off-track skill", async () => {
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', title: 'One' })] }),
      '/api/config': configView({ tracks: { build: DEFAULT_TRACKS.build } }),
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [acceptance({ skillId: 'react-forms', agents: ['builder'] }), acceptance({ skillId: 'brief-writer', agents: ['planner'] })],
      },
    })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('#story-open-skills-agents .skill-agent')).toHaveLength(3))

    expect(wrapper.findAll('#story-open-skills-agents .skill-agent h4').map((n) => n.text())).toEqual(['builder', 'verifier', 'critic'])

    const rows = wrapper.findAll('#story-open-skills-agents .skill-agent')
    const builderRow = rows.find((row) => row.find('h4').text() === 'builder')!
    const verifierRow = rows.find((row) => row.find('h4').text() === 'verifier')!

    expect(builderRow.findAll('.acceptance li').map((n) => n.text())).toEqual(['react-forms'])
    expect(builderRow.get('[data-slot="none"]').attributes('hidden')).toBeDefined()

    expect(verifierRow.findAll('.acceptance li')).toHaveLength(0)
    expect(verifierRow.get('[data-slot="none"]').attributes('hidden')).toBeUndefined()
    expect(verifierRow.get('[data-slot="none"]').text()).toBe(english['story.skills.agentNone'])

    expect(wrapper.get('#story-open-skills-agents').text()).not.toContain('brief-writer')
    expect(wrapper.get('#story-open-skills-agents').text()).not.toContain('scout')
  })

  it('flags an acceptance accepted for no agent, a disabled one, and an incompatible one — never off-track — and says so when nothing is flagged', async () => {
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', title: 'One' })] }),
      '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }),
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [
          acceptance({ skillId: 'clean-skill', agents: ['builder'] }),
          acceptance({ skillId: 'off-track-but-fine', agents: ['builder', 'planner'] }),
          acceptance({ skillId: 'no-agents-skill', agents: [] }),
          acceptance({ skillId: 'disabled-skill', agents: ['builder'], status: 'disabled' }),
          acceptance({ skillId: 'incompatible-skill', agents: ['builder'], compatible: false }),
        ],
      },
    })
    const { Stories, store } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('#story-open-skills-warnings .skill-warning')).toHaveLength(3))
    expect(wrapper.get('#story-open-skills-warnings-empty').attributes('hidden')).toBeDefined()

    const rows = wrapper.findAll('#story-open-skills-warnings .skill-warning')
    const byId = (id: string) => rows.find((row) => row.find('code').text() === id)!

    const noAgents = byId('no-agents-skill')
    expect(noAgents.get('[data-slot="noAgents"]').attributes('hidden')).toBeUndefined()
    expect(noAgents.get('[data-slot="noAgents"]').text()).toBe(english['story.skills.warnNoAgents'])
    expect(noAgents.get('[data-slot="notActive"]').attributes('hidden')).toBeDefined()

    const disabled = byId('disabled-skill')
    expect(disabled.get('[data-slot="notActive"]').attributes('hidden')).toBeUndefined()
    expect(disabled.get('[data-slot="notActive"]').text()).toBe(english['story.skills.warnDisabled'])

    const incompatible = byId('incompatible-skill')
    expect(incompatible.get('[data-slot="notCompatible"]').attributes('hidden')).toBeUndefined()

    expect(wrapper.get('#story-open-skills-warnings').text()).not.toContain('clean-skill')
    expect(wrapper.get('#story-open-skills-warnings').text()).not.toContain('off-track-but-fine')

    // Re-served with nothing left to flag, on the skills revision moving.
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', title: 'One' })] }),
      '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }),
      '/api/skills': { packages: [], unreadable: [], acceptances: [acceptance({ skillId: 'clean-skill', agents: ['builder'] })] },
    })
    store.snapshot.value &&
      FakeSocket.last?.deliver({
        type: 'snapshot',
        snapshot: { ...store.snapshot.value, revisions: { ...store.snapshot.value.revisions, skills: 'r2' } },
      })
    await vi.waitFor(() => expect(wrapper.get('#story-open-skills-warnings-empty').attributes('hidden')).toBeUndefined())
    expect(wrapper.findAll('#story-open-skills-warnings .skill-warning')).toHaveLength(0)
  })

  it("draws what the story's evidence run actually pinned, and keeps the honesty line about the pinning gap on screen", async () => {
    serve({
      '/api/plans/P001': planDetail({
        id: 'P001',
        stories: [detailStory({ id: 'P001-S01', title: 'One', status: 'done', evidence: '2026-07-28-001--P001-S01--build' })],
      }),
      '/api/runs/2026-07-28-001--P001-S01--build/skills': skillManifest(),
    })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01', status: 'done' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-skills-pinned').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#story-open-skills-no-evidence').attributes('hidden')).toBeDefined()
    expect(wrapper.get('#story-open-skills-pinned-none').attributes('hidden')).toBeDefined()
    expect(wrapper.find('#story-open-skills-hole').exists()).toBe(true)

    expect(wrapper.get('#story-open-skills-pinned-brief').text()).toBe('F001@2')
    expect(wrapper.get('#story-open-skills-pinned-profile').text()).toBe('3')
    expect(wrapper.get('#story-open-skills-pinned-concurrency').text()).toBe(english['manifest.mode.parallel'])

    const card = wrapper.get('#story-open-skills-pinned-selections .component')
    const codes = card.findAll('h4 code')
    expect(codes[0]?.text()).toBe('web')
    expect(codes[1]?.text()).toBe('builder')
    const skillRow = card.get('.rule')
    expect(skillRow.get('.rule-name').text()).toBe('react-forms')
    expect(skillRow.get('.rule-why').text()).toContain('react')
  })

  it('says there is no evidence run yet for a story that has never finished one', async () => {
    serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', title: 'One', evidence: null })] }) })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-title').text()).toBe('P001-S01 — One'))

    expect(wrapper.get('#story-open-skills-no-evidence').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#story-open-skills-no-evidence').text()).toBe(english['story.skills.pinnedNoEvidence'])
    expect(wrapper.get('#story-open-skills-pinned').attributes('hidden')).toBeDefined()
    expect(wrapper.get('#story-open-skills-pinned-none').attributes('hidden')).toBeDefined()
  })

  it('says a finished run pinned no manifest', async () => {
    serve({
      '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', title: 'One', status: 'done', evidence: 'r1' })] }),
      '/api/runs/r1/skills': null,
    })
    const { Stories } = await boot(
      emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01', status: 'done' })] })] }),
      JSON.stringify({ activePlan: 'P001' }),
    )
    const wrapper = mountTracked(Stories)
    await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))
    await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#story-open-skills-pinned-none').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#story-open-skills-pinned-none').text()).toBe(english['story.skills.pinnedNone'])
    expect(wrapper.get('#story-open-skills-no-evidence').attributes('hidden')).toBeDefined()
    expect(wrapper.get('#story-open-skills-pinned').attributes('hidden')).toBeDefined()
  })

  describe('the requeue write', () => {
    it('requeues a doing story back to todo, and offers an exact undo', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01', status: 'doing' })] }) })
      const { StoriesHost, socket } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01', status: 'doing' })] })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mountTracked(StoriesHost)
      await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))

      await wrapper.get('[data-act="story-requeue"]').trigger('click')
      expect(socket.sent).toEqual([
        { type: 'write', id: expect.any(String), write: { kind: 'story.status', story: 'P001-S01', from: 'doing', to: 'todo' } },
      ])

      socket.deliver({ type: 'receipt', id: socket.sent[0]?.id, ok: true, code: 'write.ok' })
      await nextTick()
      const undo = wrapper.find('.toast .toast-action')
      expect(undo.exists()).toBe(true)
      await undo.trigger('click')
      expect(socket.sent).toEqual([
        expect.anything(),
        { type: 'write', id: expect.any(String), write: { kind: 'story.status', story: 'P001-S01', from: 'todo', to: 'doing' } },
      ])
    })
  })

  describe('the build command', () => {
    it('enqueues /mjloop:build with the pressed story attached', async () => {
      serve({ '/api/plans/P001': planDetail({ id: 'P001', stories: [detailStory({ id: 'P001-S01' })] }) })
      const { Stories, socket } = await boot(
        emptySnapshot({ plans: [planFixture({ id: 'P001', stories: [storyFixture({ id: 'P001-S01' })] })] }),
        JSON.stringify({ activePlan: 'P001' }),
      )
      const wrapper = mountTracked(Stories)
      await vi.waitFor(() => expect(wrapper.findAll('#stories-list .story')).toHaveLength(1))

      await wrapper.get('[data-act="story-run"]').trigger('click')
      expect(socket.sent).toEqual([{ type: 'enqueue', command: '/mjloop:build P001-S01', story: 'P001-S01' }])
    })
  })

  describe('structure (60-panels.css)', () => {
    it('carries class="panel" and aria-labelledby on the panel itself, never on a wrapper', async () => {
      const { Stories } = await boot(emptySnapshot())
      const wrapper = mountTracked(Stories)
      await nextTick()
      const panel = wrapper.get('#panel-stories')
      expect(panel.classes()).toContain('panel')
      expect(panel.attributes('aria-labelledby')).toBe('panel-stories-title')
      expect(wrapper.get('#panel-stories-title').element.tagName).toBe('H1')
    })

    it('gives the work-tab strip role="tablist" and every open tab role="tab" inside .worktab', async () => {
      const { wrapper } = await openThree()
      await wrapper.get('[data-slot="open"][data-story="P001-S01"]').trigger('click')
      await vi.waitFor(() => expect(tabIds(wrapper)).toEqual(['P001-S01']))
      expect(wrapper.get('#story-tabs').attributes('role')).toBe('tablist')
      expect(wrapper.find('.worktab').exists()).toBe(true)
      expect(wrapper.get('.worktab-open').attributes('role')).toBe('tab')
    })

    it('keys the story list rows ".story.detail" inside ".stories.detail"', async () => {
      const { wrapper } = await openThree()
      expect(wrapper.get('#stories-list').classes()).toEqual(expect.arrayContaining(['stories', 'detail']))
      expect(wrapper.get('#stories-list .story').classes()).toEqual(expect.arrayContaining(['story', 'detail']))
    })

    it('keys the dependency tree ".deps > .dep-row", the readiness inspector ".story-open-waits > .wait-row"', async () => {
      const wrapper = await openReadinessFixture()
      await wrapper.get('[data-slot="open"][data-story="P001-S03"]').trigger('click')
      await vi.waitFor(() => expect(wrapper.findAll('#story-open-waits .wait-row')).toHaveLength(2))
      expect(wrapper.get('#story-open-waits').classes()).toContain('story-open-waits')
      expect(wrapper.get('.deps').element.parentElement?.className).toContain('story-open-deps')
    })
  })
})
