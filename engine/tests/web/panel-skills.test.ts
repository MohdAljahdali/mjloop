// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import type { ProjectSkillAcceptance } from '../../src/schemas/skill-acceptance.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Skills panel — `panels/skills.js`, the four describe blocks at
 * `panels.test.ts:3032` (`skills`), `panels.test.ts:3436` (`skills library`),
 * `panels.test.ts:3533` (`the skills a project has on disk`) and
 * `panels.test.ts:3595` (`searching for a skill from the cockpit`), and the
 * `#panel-skills` section of `index.html` — ported to `Skills.vue`,
 * `lib/skills.ts` (`shortDigest`, `joinAcceptances`) and
 * `composables/useSkillSearch.ts`.
 *
 * Read-only by design: accepting a component map or a skill routes every
 * later run, which `web/writes.ts` denies the browser outright. The one live
 * round trip this panel makes is the search form, through `lib/api.ts`'s
 * `get` — never the socket.
 */

const NOW = '2026-07-28T09:00:00.000Z'

const english = await readLocale('en')

function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = routes[url.split('?')[0] ?? '']
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }),
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

  const { default: Skills } = await import('../../src/web/app/panels/Skills.vue')

  ;(FakeSocket.last as FakeSocket).deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Skills, socket: FakeSocket.last as FakeSocket }
}

const component = (patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'apps-mobile',
  root: 'apps/mobile',
  technology: 'flutter',
  verification: { test: 'cd apps/mobile && flutter test', lint: null, build: null },
  skillTags: ['flutter'],
  ...patch,
})

const profileView = (patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  revision: 2,
  acceptedAt: NOW,
  acceptedBy: 'dashboard:mohd',
  components: [component(), component({ id: 'apps-web', root: 'apps/web', technology: 'vue', skillTags: ['vue'] })],
  proposedAt: null,
  proposalDiffers: false,
  ...patch,
})

describe('Skills.vue — the accepted component map', () => {
  it('shows the accepted component map and offers no way to accept one', async () => {
    serve({ '/api/profile': profileView(), '/api/skills': { packages: [], unreadable: [], acceptances: [], onDisk: [], onDiskUnreadable: [] } })
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await vi.waitFor(() => expect(wrapper.findAll('#skills-profile-list .component')).toHaveLength(2))

    expect(wrapper.get('#skills-profile-record').text()).toContain('2')
    expect(wrapper.get('#skills-profile-record').text()).toContain('dashboard:mohd')

    const first = wrapper.get('#skills-profile-list .component')
    expect(first.get('[data-slot="id"]').text()).toBe('apps-mobile')
    expect(first.get('[data-slot="root"]').text()).toBe('apps/mobile')
    expect(first.get('[data-slot="technology"]').text()).toBe('flutter')
    expect(first.get('[data-slot="test"]').text()).toBe('cd apps/mobile && flutter test')
    // A component with no build command says so, for the same reason an
    // unset `verify.build` does: it is the slot that will not run.
    expect(first.get('[data-slot="build"]').text()).toBe(english['config.verifyUnset'])
    expect(first.get('[data-slot="tags"]').text()).toBe('flutter')

    expect(wrapper.get('#skills-profile-drift').attributes('hidden')).toBeDefined()
    expect(wrapper.get('#skills-profile-empty').attributes('hidden')).toBeDefined()

    // The whole point of the block. Accepting a component map activates
    // routing for every later run, which `web/writes.ts` denies the browser
    // outright — so there is nothing here to press.
    expect(wrapper.get('#skills-profile-block').findAll('button')).toHaveLength(0)
    expect(wrapper.get('#skills-profile-block').findAll('input, select')).toHaveLength(0)
  })

  it('says a newer scan disagrees, and never resolves the disagreement', async () => {
    serve({
      '/api/profile': profileView({ proposedAt: '2026-07-30T09:00:00.000Z', proposalDiffers: true }),
      '/api/skills': { packages: [], unreadable: [], acceptances: [], onDisk: [], onDiskUnreadable: [] },
    })
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await vi.waitFor(() => expect(wrapper.get('#skills-profile-drift').attributes('hidden')).toBeUndefined())

    // Formatted, not the raw ISO string: it sits beside dates the Features
    // tab formats.
    expect(wrapper.get('#skills-profile-drift').text()).not.toContain('2026-07-30T09:00:00.000Z')
    expect(wrapper.get('#skills-profile-drift').text()).toContain('2026')
    // Still the accepted map on screen: the proposal is what a rescan found,
    // and nothing routes off it until somebody accepts it with a command.
    expect(wrapper.findAll('#skills-profile-list .component')).toHaveLength(2)
    expect(wrapper.get('#skills-profile-block').findAll('button')).toHaveLength(0)
  })

  it('says a project has no accepted map rather than drawing an empty table', async () => {
    // `/api/profile` 404s for a project nothing has ever mapped, and a 404
    // is an answer here — not a fetch this panel should keep waiting on.
    serve({ '/api/skills': { packages: [], unreadable: [], acceptances: [], onDisk: [], onDiskUnreadable: [] } })
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await vi.waitFor(() => expect(wrapper.get('#skills-profile-empty').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#skills-profile-empty').text()).toBe(english['config.profileNone'])
    expect(wrapper.findAll('#skills-profile-list .component')).toHaveLength(0)
    expect(wrapper.get('#skills-profile-record').attributes('hidden')).toBeDefined()
  })
})

describe('lib/skills.ts — joinAcceptances', () => {
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

  it('pairs each acceptance with the package it names, and reports the one it cannot find', async () => {
    const { joinAcceptances } = await import('../../src/web/app/lib/skills.ts')
    const joined = joinAcceptances({
      packages: [pkg()],
      unreadable: [],
      acceptances: [acceptance(), acceptance({ skillId: 'gone', digest: 'c'.repeat(64) })],
      onDisk: [],
      onDiskUnreadable: [],
    })
    expect(joined[0]?.pkg?.skillName).toBe('Flutter forms')
    expect(joined[1]?.pkg).toBeNull()
  })

  it('returns nothing for a view that has not loaded', async () => {
    const { joinAcceptances } = await import('../../src/web/app/lib/skills.ts')
    expect(joinAcceptances(null)).toEqual([])
  })
})

describe('lib/skills.ts — shortDigest', () => {
  it('shows enough of a digest to recognise, and no more', async () => {
    const { shortDigest } = await import('../../src/web/app/lib/skills.ts')
    expect(shortDigest('c'.repeat(64))).toBe('c'.repeat(12))
  })
})

describe('Skills.vue — the shared library and this project\'s acceptances', () => {
  it('draws the audit verdict and names a package this machine does not hold', async () => {
    serve({
      '/api/profile': { error: { code: 'error.notFound' } },
      '/api/skills': {
        packages: [
          {
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
          },
        ],
        unreadable: [{ digest: 'd'.repeat(64), reason: 'record does not parse' }],
        acceptances: [
          {
            schema: 1,
            skillId: 'gone',
            packageId: 'flutter-forms',
            digest: 'c'.repeat(64),
            components: ['apps-mobile'],
            agents: ['builder'],
            tags: ['flutter'],
            updatePolicy: 'pinned',
            status: 'active',
            compatible: true,
            acceptedBy: 'mohd',
            acceptedAt: NOW,
          },
        ],
        onDisk: [],
        onDiskUnreadable: [],
      },
    })
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await vi.waitFor(() => expect(wrapper.findAll('#skills-library .component')).toHaveLength(1))

    expect(wrapper.get('#skills-library [data-slot="audit"]').text()).toBe(english['skills.audit.passed'])
    // The findings list carries the sandbox line: `writePackage` is only
    // ever reached from a passed audit, so there is no separate import
    // report.
    expect(wrapper.get('#skills-library [data-slot="findings"]').text()).toContain('sandbox')

    const missing = wrapper.get('#skills-acceptances [data-slot="missing"]')
    expect(missing.attributes('hidden')).toBeUndefined()
    expect(missing.text()).toContain('c'.repeat(12))

    // A damaged library entry is surfaced, not dropped.
    expect(wrapper.findAll('#skills-unreadable .grid-row')).toHaveLength(1)

    // Nothing is interactive on this panel except the search form's three
    // sanctioned controls: querying a source and drawing candidates back is
    // not a write. Built from ids rather than "outside #skills-search", so a
    // fourth control added anywhere else inside the form — not only outside
    // it — still fails this assertion instead of passing unnoticed.
    const sanctioned = new Set(
      wrapper.get('#panel-skills').findAll('#skills-search-q, #skills-search-source, #skills-search button[type="submit"]').map((n) => n.element),
    )
    const outside = (selector: string) => wrapper.get('#panel-skills').findAll(selector).filter((n) => !sanctioned.has(n.element))
    expect(outside('button')).toHaveLength(0)
    expect(outside('input')).toHaveLength(0)
    expect(outside('select')).toHaveLength(0)
  })
})

describe('Skills.vue — the skills a project has on disk', () => {
  it("draws each skill's name, description and path", async () => {
    serve({
      '/api/profile': { error: { code: 'error.notFound' } },
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [],
        onDisk: [{ name: 'brief-writer', description: 'Use when a request needs a brief.', path: '.claude/skills/brief-writer/SKILL.md' }],
        onDiskUnreadable: [],
      },
    })
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await vi.waitFor(() => expect(wrapper.findAll('#skills-ondisk .component')).toHaveLength(1))

    expect(wrapper.get('#skills-ondisk [data-slot="name"]').text()).toBe('brief-writer')
    expect(wrapper.get('#skills-ondisk [data-slot="description"]').text()).toBe('Use when a request needs a brief.')
    expect(wrapper.get('#skills-ondisk [data-slot="path"]').text()).toBe('.claude/skills/brief-writer/SKILL.md')
  })

  it('claims none only once the fetch has settled, and draws an unreadable file as a banner', async () => {
    serve({
      '/api/profile': { error: { code: 'error.notFound' } },
      '/api/skills': {
        packages: [],
        unreadable: [],
        acceptances: [],
        onDisk: [],
        onDiskUnreadable: [{ path: '.claude/skills/broken/SKILL.md', reason: 'missing frontmatter' }],
      },
    })
    const { Skills } = await boot()
    const wrapper = mount(Skills)

    // Nothing is claimed before the fetch settles.
    expect(wrapper.get('#skills-ondisk-empty').attributes('hidden')).toBeDefined()

    await vi.waitFor(() => expect(wrapper.findAll('#skills-ondisk-unreadable .banner')).toHaveLength(1))

    expect(wrapper.get('#skills-ondisk-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#skills-ondisk-unreadable [data-slot="path"]').text()).toBe('.claude/skills/broken/SKILL.md')
    expect(wrapper.get('#skills-ondisk-unreadable [data-slot="reason"]').text()).toBe('missing frontmatter')
  })
})

describe('Skills.vue — searching for a skill from the cockpit', () => {
  it('sends the query and the source, and draws each candidate', async () => {
    // Both feeds this panel also mounts answer 404, which `feed()` treats as
    // a settled "nothing" — the panel's own `joinAcceptances` would throw on
    // the `{}` a bare unmatched-route stub would otherwise hand back.
    serve({})
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await nextTick()

    const asked: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (at: string) => {
      asked.push(String(at))
      return new Response(
        JSON.stringify({
          candidates: [{ source: 'skills-sh', url: 'https://skills.sh/a/b/c', repository: 'a/b', ref: 'HEAD', skillName: 'c', description: 'Use when c.' }],
        }),
        { status: 200 },
      )
    }) as never)

    // Exercises the source select's own `v-model`, not just the query
    // input's.
    await wrapper.get('#skills-search-source').setValue('skills-sh')
    await wrapper.get('#skills-search-q').setValue('react')
    await wrapper.get('#skills-search').trigger('submit')
    await flushPromises()

    expect(asked[0]).toContain('/api/skills/search?q=react')
    expect(asked[0]).toContain('source=skills-sh')
    expect(wrapper.get('#skills-search-results').text()).toContain('a/b')
    expect(wrapper.get('#skills-search-results').text()).toContain('Use when c.')
  })

  it('shows the refusal code as a sentence, and draws no results', async () => {
    serve({})
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await nextTick()

    // 503, not the brief's 409: the route splits discovery's three refusals
    // across 403 (source not allowed), 503 (missing skills.sh token) and 501
    // (no general web search provider) — never 409.
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(JSON.stringify({ error: { code: 'error.skillsShTokenMissing' } }), { status: 503 })) as never)

    await wrapper.get('#skills-search-q').setValue('react')
    await wrapper.get('#skills-search').trigger('submit')
    await flushPromises()

    expect(wrapper.get('#skills-search-error').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#skills-search-results').element.children.length).toBe(0)
  })

  it('says no candidate matched once a query settled with none, and stays quiet before any query was asked', async () => {
    serve({})
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await nextTick()

    // Nothing is claimed before a question was asked: an empty result line
    // on first paint would answer a query nobody typed.
    expect(wrapper.get('#skills-search-empty').attributes('hidden')).toBeDefined()

    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })) as never)

    await wrapper.get('#skills-search-q').setValue('react')
    await wrapper.get('#skills-search').trigger('submit')
    await flushPromises()

    expect(wrapper.get('#skills-search-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#skills-search-empty').text()).toBe(english['skills.searchNone'])
    expect(wrapper.get('#skills-search-results').element.children.length).toBe(0)
  })

  it('asks nothing at all for a query under two characters', async () => {
    serve({})
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await nextTick()

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await wrapper.get('#skills-search-q').setValue('a')
    await wrapper.get('#skills-search').trigger('submit')
    await flushPromises()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('drops a stale answer for a search that is no longer current', async () => {
    serve({})
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await nextTick()

    const candidate = (skillName: string, url: string): unknown => ({
      source: 'github',
      url,
      repository: url.replace('https://github.com/', ''),
      ref: 'HEAD',
      skillName,
      description: `Use when ${skillName}.`,
    })

    // Each call gets its own controllable response, so the test can decide
    // which answer lands first — the case a plain mock cannot express.
    const pending: { resolve: (response: Response) => void }[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (() =>
        new Promise<Response>((resolve) => {
          pending.push({ resolve })
        })) as never,
    )

    // Two searches, fired before either answer lands — a person typing past
    // their first query before the round trip for it returns.
    await wrapper.get('#skills-search-q').setValue('first')
    const firstSubmit = wrapper.get('#skills-search').trigger('submit')
    await wrapper.get('#skills-search-q').setValue('second')
    const secondSubmit = wrapper.get('#skills-search').trigger('submit')
    await Promise.all([firstSubmit, secondSubmit])

    expect(pending).toHaveLength(2)

    // The *second* search's answer lands first, and is drawn.
    pending[1]?.resolve(new Response(JSON.stringify({ candidates: [candidate('second', 'https://github.com/x/second')] }), { status: 200 }))
    await vi.waitFor(() => expect(wrapper.get('#skills-search-results').text()).toContain('x/second'))

    // The *first* search's answer lands after it — for a query nobody is
    // waiting for any more. Without the generation guard this overwrites the
    // second search's own, newer results.
    pending[0]?.resolve(new Response(JSON.stringify({ candidates: [candidate('first', 'https://github.com/x/first')] }), { status: 200 }))
    await nextTick()

    expect(wrapper.get('#skills-search-results').text()).toContain('x/second')
    expect(wrapper.get('#skills-search-results').text()).not.toContain('x/first')
  })
})

describe('Skills.vue — structure the stylesheet selects', () => {
  it('carries `.panel`, `.block`, `.record`, `.facts`/`.fact`, `.grid-row`, `.banner.warn`, `.component`', async () => {
    serve({
      '/api/profile': profileView(),
      '/api/skills': {
        packages: [
          {
            schema: 1,
            packageId: 'flutter-forms',
            digest: 'b'.repeat(64),
            source: { kind: 'github', url: 'https://github.com/example/flutter-forms', revision: 'v1.2.0' },
            license: { spdx: 'MIT', file: 'LICENSE' },
            skillName: 'Flutter forms',
            description: 'Form patterns for Flutter.',
            tags: ['flutter'],
            dependencies: { executables: [], packages: [] },
            audit: { state: 'passed', findings: [], at: NOW },
            guidance: 'x',
            importedAt: NOW,
          },
        ],
        unreadable: [{ digest: 'd'.repeat(64), reason: 'record does not parse' }],
        acceptances: [
          {
            schema: 1,
            skillId: 'gone',
            packageId: 'flutter-forms',
            digest: 'c'.repeat(64),
            components: ['apps-mobile'],
            agents: ['builder'],
            tags: [],
            updatePolicy: 'pinned',
            status: 'active',
            compatible: true,
            acceptedBy: 'mohd',
            acceptedAt: NOW,
          },
        ],
        onDisk: [],
        onDiskUnreadable: [],
      },
    })
    const { Skills } = await boot()
    const wrapper = mount(Skills)
    await vi.waitFor(() => expect(wrapper.findAll('#skills-library .component')).toHaveLength(1))

    expect(wrapper.get('#panel-skills').classes()).toContain('panel')
    expect(wrapper.get('#skills-profile-block').classes()).toContain('block')
    expect(wrapper.get('#skills-profile-record').classes()).toContain('record')
    expect(wrapper.findAll('.facts').length).toBeGreaterThan(0)
    expect(wrapper.get('#skills-unreadable').find('.grid-row').exists()).toBe(true)
    expect(wrapper.get('#skills-acceptances [data-slot="missing"]').classes()).toEqual(expect.arrayContaining(['banner', 'warn']))
    expect(wrapper.get('#skills-library .component').exists()).toBe(true)
    expect(wrapper.get('#skills-profile-list .component').exists()).toBe(true)
  })
})
