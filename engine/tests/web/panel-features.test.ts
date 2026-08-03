// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, watch } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import type { FeatureBrief, Decision } from '../../src/schemas/feature.js'
import type { FeatureDetail } from '../../src/web/read.js'
import type { FeatureSummary } from '../../src/store/feature-store.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Features panel — `panels/features.js`, `describe('features')` at
 * `panels.test.ts:3258`, and the features section of `index.html` — ported
 * to `Features.vue`, `FeatureApproveDialog.vue`, `lib/features.ts`
 * (`approvable`) and `lib/featuredoc.ts` (the open brief's document).
 *
 * The confirmation dialog moved out from under the panel after the halt
 * dialog's own history: it is hosted from `App.vue`, outside the panels'
 * `<KeepAlive>` — `useFeatureApprove.ts` — so its tests below mount `Features`
 * and `FeatureApproveDialog` together, the same shape `panel-run.test.ts`
 * uses for `Rail` + `HaltDialog`.
 */

const NOW = '2026-07-28T09:00:00.000Z'

const english = await readLocale('en')

/** The same fake socket every other panel test drives the store with. */
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
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }),
    )
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
})

/**
 * Boots a fresh module graph, connects a `FakeSocket`, pumps
 * `lib/featuredoc.ts` the way `App.vue`'s own `onMounted`/`watch` does, and
 * delivers a snapshot.
 */
async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })

  const featuredoc = await import('../../src/web/app/lib/featuredoc.ts')
  const featureDocFeed = featuredoc.mountFeatureDoc()
  watch(
    [store.snapshot, featuredoc.opened],
    ([current]) => {
      if (current !== null) featureDocFeed.update(current)
    },
    { immediate: true },
  )

  const { default: Features } = await import('../../src/web/app/panels/Features.vue')
  const { default: FeatureApproveDialog } = await import('../../src/web/app/components/FeatureApproveDialog.vue')
  const { useFeatureApprove } = await import('../../src/web/app/composables/useFeatureApprove.ts')
  const { default: Toasts } = await import('../../src/web/app/components/Toasts.vue')
  const { useToasts } = await import('../../src/web/app/composables/useToasts.ts')
  const toasts = useToasts()
  store.installAnnouncer(toasts.notify)

  /**
   * `Features.vue`'s approve button and `FeatureApproveDialog` are siblings
   * under `App.vue`, wired through `useFeatureApprove.ts`'s shared ref — the
   * same shape `panel-run.test.ts`'s `HaltHost` reproduces for `Rail` +
   * `HaltDialog`.
   */
  const approve = useFeatureApprove()
  const FeaturesHost = defineComponent({
    setup: () => () => h('div', [h(Features), h(FeatureApproveDialog, { open: approve.open.value, onClose: approve.closeApprove }), h(Toasts)]),
  })

  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Features, FeaturesHost, featuredoc, socket: FakeSocket.last as FakeSocket }
}

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

describe('approvable (lib/features.ts)', () => {
  it('refuses to approve a draft with no acceptance criteria, before sending anything', async () => {
    const { approvable } = await import('../../src/web/app/lib/features.ts')
    expect(approvable(detail({ brief: brief({ acceptance: [] }) })).why).toBe('features.needsAcceptance')
    expect(approvable(detail({ brief: brief({ acceptance: [] }) })).can).toBe(false)
  })

  it('offers no approval on a revision that already has one, or on nothing at all', async () => {
    const { approvable } = await import('../../src/web/app/lib/features.ts')
    expect(approvable(detail({ status: 'approved' })).can).toBe(false)
    expect(approvable(detail({ status: 'superseded' })).can).toBe(false)
    expect(approvable(null).can).toBe(false)
    expect(approvable(detail()).can).toBe(true)
  })
})

describe('Features.vue', () => {
  it('draws the feature list, and the empty state when there is none', async () => {
    serve({ '/api/features': [] })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await nextTick()
    expect(wrapper.get('#features-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#features-empty').text()).toBe(english['features.empty'])
  })

  it('opens feature detail in context, exposes the state to keyboard users, and focuses the title', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })
    const { Features } = await boot()
    const wrapper = mount(Features, { attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))

    const open = wrapper.get('.plan-open')
    expect(open.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('#feature-detail').attributes('hidden')).toBeDefined()

    await open.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#features-workspace').attributes('data-detail-open')).toBe('true')
    expect(document.activeElement).toBe(document.getElementById('feature-detail-title'))
    expect(wrapper.get('.plan-open').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('#feature-detail-title').text()).toContain('Sign-in that survives a token refresh')
    wrapper.unmount()
  })

  it('closes the detail from its own back button, the same as toggling the row closed', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    await wrapper.get('.plan-back').trigger('click')
    expect(wrapper.get('#feature-detail').attributes('hidden')).toBeDefined()
    expect(wrapper.get('#features-workspace').attributes('data-detail-open')).toBe('false')
    expect(wrapper.get('.plan-open').attributes('aria-expanded')).toBe('false')
  })

  it('draws a brief, and says which questions the interview never answered', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#feature-problem').text()).toContain('drops mid-refresh')
    const answers = wrapper.findAll('#feature-decisions [data-slot="answer"]')
    expect(answers[0]?.text()).toBe('keychain')
    // An unanswered question is an ordinary state of a draft — the interview
    // stops at one — so it is a sentence rather than a blank line.
    expect(answers[1]?.text()).toBe(english['features.unanswered'])

    // The first decision took the recommendation, so the recommendation is
    // not repeated under it.
    const recommendations = wrapper.findAll('#feature-decisions [data-slot="recommendation"]')
    expect(recommendations[0]?.attributes('hidden')).toBeDefined()
  })

  it('shows a recommendation the answer did not take, and labels it as one', async () => {
    const declined = brief({
      decisions: [{ question: 'Where does the refresh token live?', recommendation: 'the keychain', answer: 'a cookie', at: NOW }],
    })
    serve({ '/api/features': [summary()], '/api/features/F001': detail({ brief: declined }) })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    const shown = wrapper.get('#feature-decisions [data-slot="recommendation"]')
    expect(shown.attributes('hidden')).toBeUndefined()
    expect(shown.text()).toContain('the keychain')
    expect(shown.text()).toContain('Recommended')
  })

  it('shows the acceptance criteria, and the empty tell when there are none', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail({ brief: brief({ acceptance: [] }) }) })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#feature-acceptance-empty').attributes('hidden')).toBeUndefined()
    expect(wrapper.findAll('#feature-acceptance li')).toHaveLength(0)
  })

  it('shows the full revision history, and the facts about the brief', async () => {
    serve({
      '/api/features': [summary()],
      '/api/features/F001': detail({ revisions: [{ revision: 1, status: 'superseded' }, { revision: 2, status: 'approved' }] }),
    })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    const rows = wrapper.findAll('#feature-revisions .grid-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.find('[data-slot="revision"]').text()).toBe('1')
    expect(rows[0]?.find('[data-slot="status"]').text()).toBe(english['features.status.superseded'])
    expect(rows[1]?.find('[data-slot="status"]').attributes('data-status')).toBe('approved')

    expect(wrapper.get('#feature-components').text()).toBe('web')
    expect(wrapper.get('#feature-tags').text()).toBe('auth')
    expect(wrapper.get('#feature-discovery').text()).toBe(english['features.discovery.ask'])
    expect(wrapper.get('#feature-approval-block').attributes('hidden')).toBeDefined()
  })

  it('shows who approved a brief, when, and in their own words', async () => {
    const approved = brief({ status: 'approved', approval: { by: 'mohd', at: NOW, note: 'Looks solid' } })
    serve({ '/api/features': [summary({ status: 'approved' })], '/api/features/F001': detail({ brief: approved, status: 'approved' }) })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    expect(wrapper.get('#feature-approval-block').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#feature-approved-by').text()).toBe('mohd')
    expect(wrapper.get('#feature-approval-note').text()).toBe('Looks solid')
    // Approved: no re-decision, no undo — the approve control is gone
    // entirely rather than disabled, unlike the plan gate two tabs over.
    expect(wrapper.get('#feature-approve').attributes('hidden')).toBeDefined()
  })

  it('blocks approval of a draft with no acceptance criteria, and says why, before anything is sent', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail({ brief: brief({ acceptance: [] }) }) })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    expect((wrapper.get('#feature-approve').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.get('#feature-blocked').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#feature-blocked').text()).toBe(english['features.needsAcceptance'])
  })

  it('caps the list and says how many are not shown', async () => {
    const many = Array.from({ length: 240 }, (_, index) => summary({ id: `F${String(index).padStart(3, '0')}` }))
    serve({ '/api/features': many })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(200))
    expect(wrapper.get('#features-more').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#features-more').text()).toBe('Showing 200 of 240.')
  })

  it('carries the CSS contract 60-panels.css selects: `.plan`/`.plan-head`, `.plan-detail.block`, `.approve`, `.stories.detail`, `.facts`/`.fact`, `.grid-row`', async () => {
    serve({ '/api/features': [summary()], '/api/features/F001': detail() })
    const { Features } = await boot()
    const wrapper = mount(Features)
    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))

    expect(wrapper.get('#panel-features').classes()).toContain('panel')
    expect(wrapper.get('#features-workspace').classes()).toContain('plans-workspace')
    const row = wrapper.get('#features-list .plan')
    expect(row.find('.plan-head').exists()).toBe(true)
    expect(row.find('.plan-open').exists()).toBe(true)

    await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
    await wrapper.get('.plan-open').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

    const detailEl = wrapper.get('#feature-detail')
    expect(detailEl.classes()).toContain('plan-detail')
    expect(detailEl.classes()).toContain('block')
    expect(detailEl.find('.plan-detail-head').exists()).toBe(true)
    expect(wrapper.get('.approve').find('#feature-approve').exists()).toBe(true)
    expect(wrapper.get('#feature-acceptance').classes()).toEqual(expect.arrayContaining(['stories', 'detail']))
    expect(wrapper.findAll('.facts').length).toBeGreaterThan(0)
    expect(wrapper.get('#feature-revisions').find('.grid-row').exists()).toBe(true)
    expect(wrapper.get('#feature-blocked').classes()).toEqual(expect.arrayContaining(['banner', 'warn']))
    expect(wrapper.get('#feature-record').classes()).toContain('record')
  })

  describe('approving a brief', () => {
    it('opens the confirmation naming exactly what is about to become permanent, and cancelling sends nothing', async () => {
      serve({ '/api/features': [summary()], '/api/features/F001': detail() })
      const { FeaturesHost, socket } = await boot()
      const wrapper = mount(FeaturesHost, { attachTo: document.body })
      await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
      await wrapper.get('.plan-open').trigger('click')
      await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

      expect(document.getElementById('feature-dialog')?.hasAttribute('open')).toBeFalsy()
      await wrapper.get('#feature-approve').trigger('click')
      await nextTick()
      expect(document.getElementById('feature-dialog')?.hasAttribute('open')).toBe(true)
      expect(wrapper.get('#feature-dialog-subject').text()).toContain('F001')
      expect(wrapper.get('#feature-dialog-subject').text()).toContain('1')

      await wrapper.get('#feature-dialog [type="button"]').trigger('click') // Cancel
      await nextTick()
      expect(document.getElementById('feature-dialog')?.hasAttribute('open')).toBeFalsy()
      expect(socket.sent).toEqual([])
      wrapper.unmount()
    })

    it('approves what the screen showed, by content digest and not by revision alone', async () => {
      serve({ '/api/features': [summary()], '/api/features/F001': detail() })
      const { FeaturesHost, socket } = await boot()
      const wrapper = mount(FeaturesHost, { attachTo: document.body })
      await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
      await wrapper.get('.plan-open').trigger('click')
      await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

      await wrapper.get('#feature-approve').trigger('click')
      await nextTick()
      await wrapper.get('#feature-note').setValue('agreed on the call')
      await wrapper.get('#feature-form').trigger('submit')

      // A draft holds one revision number for the whole of its editable
      // life, so the digest is the only field on this frame that moves when
      // the words do — without it the compare-and-swap is vacuous.
      expect(socket.sent).toEqual([
        {
          type: 'write',
          id: expect.any(String),
          write: { kind: 'feature.approve', feature: 'F001', revision: 1, digest: 'a'.repeat(64), note: 'agreed on the call' },
        },
      ])

      // No inverse: `settle()` announces the result with nothing to press —
      // there is no legal write back from "approved".
      socket.deliver({ type: 'receipt', id: (socket.sent[0] as { id: string }).id, ok: true, code: 'write.ok' })
      await nextTick()
      expect(wrapper.find('.toast').exists()).toBe(true)
      expect(wrapper.find('.toast .toast-action').exists()).toBe(false)
      wrapper.unmount()
    })

    it('sends nothing when the brief stopped being approvable while the dialog was open', async () => {
      serve({ '/api/features': [summary()], '/api/features/F001': detail() })
      const { FeaturesHost, store, socket } = await boot()
      const wrapper = mount(FeaturesHost, { attachTo: document.body })
      await vi.waitFor(() => expect(wrapper.findAll('#features-list .plan')).toHaveLength(1))
      await wrapper.get('.plan-open').trigger('click')
      await vi.waitFor(() => expect(wrapper.get('#feature-detail').attributes('hidden')).toBeUndefined())

      await wrapper.get('#feature-approve').trigger('click')
      await nextTick()

      // Somebody else approved it while the dialog sat open — the feed
      // behind `lib/featuredoc.ts` keeps running underneath the modal.
      serve({ '/api/features': [summary()], '/api/features/F001': detail({ status: 'approved' }) })
      const current = store.snapshot.value
      if (current !== null) {
        FakeSocket.last?.deliver({
          type: 'snapshot',
          snapshot: { ...current, revisions: { ...current.revisions, features: 'moved' } },
        })
      }
      await vi.waitFor(() => expect(wrapper.get('#feature-approve').attributes('hidden')).toBeDefined())

      await wrapper.get('#feature-form').trigger('submit')
      expect(socket.sent).toEqual([])
      wrapper.unmount()
    })
  })
})
