// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { emptySnapshot, loadPage, readLocale } from './helpers/page.js'
import { installScheduler } from '../../src/web/public/ui/render.js'
import type { ServerMessage } from '../../src/web/protocol.js'

/**
 * The wire, end to end: a real click on the shipped markup reaching a real
 * write frame.
 *
 * Every other suite mounts one panel and calls its handle directly. That leaves
 * one thing untested and it is precisely the thing the S01–S07 execution report
 * names as its most expensive recurring defect: a capability that exists, is
 * tested, and that no user can reach. Cutting `bus.on('feature-confirm', …)`
 * down to `() => {}` left all 145 of those tests green.
 *
 * `discipline.test.ts` cannot close this. It greps `bus.on('name'` out of the
 * source, so an action registered to an empty function satisfies it exactly as
 * well as one wired to a panel.
 *
 * So this boots `app.js` itself — the file whose entire job is that wiring —
 * against the real `index.html`, and presses a button.
 */

const english = await readLocale('en')

/** Every frame `app.js` tried to put on the socket. */
const sent: unknown[] = []

/**
 * The page draws nothing until a snapshot arrives, so the mock keeps the
 * handler `app.js` registers and this file plays server.
 */
let deliver: (message: ServerMessage) => void = () => {}

vi.mock('../../src/web/public/net/socket.js', () => ({
  connect: (ports: { onMessage: (message: ServerMessage) => void }) => void (deliver = ports.onMessage),
  send: (message: unknown) => void sent.push(message),
}))

/**
 * `app.js` boots on import: it reads `location`, fills the language picker,
 * mounts every panel and awaits the fallback locale. Everything it reaches for
 * over the network is answered here.
 */
beforeAll(async () => {
  await loadPage()

  // `index.html` loads xterm from a vendored `<script>`, and `loadPage` strips
  // every script tag — it exists to test the markup, not to fetch bundles. The
  // terminal is not the subject here, so it is stubbed down to the surface
  // `ui/terminal.js` touches on the way past.
  vi.stubGlobal(
    'Terminal',
    class {
      loadAddon(): void {}
      open(): void {}
      onData(): void {}
      write(): void {}
      clear(): void {}
      reset(): void {}
      get rows(): number {
        return 24
      }
      get cols(): number {
        return 80
      }
    },
  )
  vi.stubGlobal('FitAddon', { FitAddon: class { fit(): void {} } })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )

  vi.stubGlobal('fetch', (url: string) => {
    const at = String(url).split('?')[0] ?? ''
    if (at.endsWith('locales/en.json')) return Promise.resolve(new Response(JSON.stringify(english), { status: 200 }))
    if (at.endsWith('locales/ar.json')) return Promise.resolve(new Response(JSON.stringify(english), { status: 200 }))
    if (at === '/api/features') {
      return Promise.resolve(new Response(JSON.stringify([FEATURE_SUMMARY]), { status: 200 }))
    }
    if (at === '/api/features/F001') {
      return Promise.resolve(new Response(JSON.stringify(FEATURE_DETAIL), { status: 200 }))
    }
    if (at === '/api/skills') return Promise.resolve(new Response(JSON.stringify(SKILLS_VIEW), { status: 200 }))
    if (at === '/api/plans/P001') {
      planFetches += 1
      return Promise.resolve(new Response(JSON.stringify(PLAN_DETAIL), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ error: { code: 'error.notFound' } }), { status: 404 }))
  })

  await import('../../src/web/public/app.js')

  // `ui/render.js` is a singleton, so this reaches the scheduler `app.js` is
  // already drawing through. Synchronous, as every other suite runs it.
  installScheduler((fn) => fn())
})

/** One tick from the poller. */
function poll(patch: Parameters<typeof emptySnapshot>[0] = {}): void {
  deliver({ type: 'snapshot', snapshot: emptySnapshot(patch) })
}

const DIGEST = 'a'.repeat(64)

/** How many times the page has asked for P001's document. */
let planFetches = 0

const PLAN_DETAIL = {
  id: 'P001',
  title: 'A plan',
  approval: null,
  body: '# A plan',
  review: null,
  stories: [],
}

const FEATURE_SUMMARY = {
  id: 'F001',
  title: 'Sign-in that survives a token refresh',
  status: 'draft',
  latestRevision: 1,
  approvedRevision: null,
  revisions: [1],
  createdAt: '2026-07-28T09:00:00.000Z',
}

const FEATURE_DETAIL = {
  brief: {
    schema: 1,
    id: 'F001',
    revision: 1,
    title: 'Sign-in that survives a token refresh',
    status: 'draft',
    problem: 'The session drops mid-refresh.',
    decisions: [],
    acceptance: ['A refresh mid-request does not sign the user out.'],
    affectedComponents: [],
    tags: [],
    discovery: { mode: 'ask', questionBudget: 8, completedAt: '2026-07-28T09:00:00.000Z' },
    approval: null,
    supersedes: null,
    createdAt: '2026-07-28T09:00:00.000Z',
  },
  status: 'draft',
  revisions: [{ revision: 1, status: 'draft' }],
  digest: DIGEST,
}

const SKILLS_VIEW = {
  packages: [],
  unreadable: [],
  acceptances: [
    {
      schema: 1,
      skillId: 'flutter-forms',
      packageId: 'flutter-forms',
      digest: 'b'.repeat(64),
      components: [],
      agents: ['builder'],
      tags: [],
      updatePolicy: 'pinned',
      status: 'active',
      compatible: true,
      acceptedBy: 'mohd',
      acceptedAt: '2026-07-28T09:00:00.000Z',
    },
  ],
}

/** Open a tab the way the navigation does — the router owns which panel is drawn. */
function open(route: string): void {
  location.hash = `#${route}`
  dispatchEvent(new Event('hashchange'))
}

/** Click through the delegated handler `bus.install(document)` attached. */
function click(selector: string): void {
  const node = document.querySelector(selector) as HTMLElement
  expect(node, selector).not.toBeNull()
  node.dispatchEvent(new Event('click', { bubbles: true }))
}

describe('boot', () => {
  it('keeps the open plan current while its own panel is closed', async () => {
    // `ui/render.js` skips a hidden panel, so a document ticked from a panel's
    // own `update()` stops the moment that panel closes. After the split the
    // Plans panel is closed most of the time while another surface reads the
    // same document, so the tick is registered against `.tabs` — and only a
    // suite that boots `app.js` can tell whether it actually is.
    open('plans')
    const plans = [{ id: 'P001', title: 'A plan', approval: null, stories: [] }]
    const at = (key: string) => ({ ...emptySnapshot().revisions, plans: { P001: key } })

    poll({ plans, revisions: at('a') })
    await vi.waitFor(() => expect(document.querySelectorAll('#plans-list > *').length).toBe(1))
    click('[data-act="open-plan"]')
    await vi.waitFor(() => expect(planFetches).toBe(1))

    // Away from Plans entirely: `#panel-plans` is hidden and does not draw.
    open('memory')
    expect((document.getElementById('panel-plans') as HTMLElement).hidden).toBe(true)

    poll({ plans, revisions: at('b') })
    await vi.waitFor(() => expect(planFetches).toBe(2))
  })

  it('reaches every panel the navigation offers', () => {
    // A tab whose panel `app.js` forgot to mount is a tab that renders nothing
    // and looks like an empty project.
    for (const route of ['run', 'plans', 'features', 'skills', 'evidence', 'memory', 'config']) {
      expect(document.getElementById(`panel-${route}`), route).not.toBeNull()
      expect(document.getElementById(`tab-${route}`), route).not.toBeNull()
    }
  })

  it('draws the Skills tab from the read api, rather than merely declaring it', async () => {
    // The panel existing in `index.html` proves nothing: an unmounted panel is
    // an empty tab, and an empty tab is indistinguishable from a project that
    // has accepted no skill. So this asserts content that could only have come
    // through a mounted feed.
    open('skills')
    poll()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#skills-acceptances .component').length).toBe(1),
    )
    expect(document.querySelector('#skills-acceptances [data-slot="skillId"]')?.textContent).toBe('flutter-forms')
  })

  it('carries a real click on a brief through to a real approval frame', async () => {
    sent.length = 0
    // The router opens `#run`; nothing else is drawn while it is hidden.
    open('features')
    poll()

    // The list arrives from the stubbed read api, drawn by the panel `app.js`
    // mounted — not by one this test constructed.
    await vi.waitFor(() => expect(document.querySelectorAll('#features-list .plan').length).toBe(1))

    click('[data-act="open-feature"]')
    await vi.waitFor(() => expect((document.getElementById('feature-detail') as HTMLElement).hidden).toBe(false))

    click('[data-act="feature-approve"]')
    // The confirmation is not decoration: an approved revision can never be
    // edited and can never be un-approved, so the button must reach the dialog
    // rather than the write.
    const dialog = document.getElementById('feature-dialog') as HTMLDialogElement
    expect(dialog.open).toBe(true)
    expect(document.getElementById('feature-dialog-subject')?.textContent).toContain('F001')
    expect(sent).toEqual([])

    ;(document.getElementById('feature-note') as HTMLInputElement).value = 'agreed'

    // A form acts on submit and only on submit — `ui/bus.js` says so, and a
    // click on the submit button would otherwise fire the action twice.
    document.getElementById('feature-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    expect(sent).toEqual([
      {
        type: 'write',
        id: expect.any(String),
        write: {
          kind: 'feature.approve',
          feature: 'F001',
          revision: 1,
          digest: DIGEST,
          note: 'agreed',
        },
      },
    ])

    // And back out again. A detail with no way to close it is a master list
    // nobody can return to.
    click('[data-act="close-feature"]')
    await vi.waitFor(() => expect((document.getElementById('feature-detail') as HTMLElement).hidden).toBe(true))
  })
})
