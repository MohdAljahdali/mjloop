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
    if (at === '/api/plans/P002') {
      return Promise.resolve(new Response(JSON.stringify(PLAN_WITH_STORIES), { status: 200 }))
    }
    if (at === '/api/plans/P003') {
      return Promise.resolve(new Response(JSON.stringify(PLAN_WITH_JOB), { status: 200 }))
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

const PLAN_WITH_STORIES = {
  id: 'P002',
  title: 'Has stories',
  approval: null,
  body: '',
  review: null,
  stories: [
    { id: 'P002-S01', title: 'Ready to go', status: 'todo', ui: false, depends_on: [], acceptance: [], evidence: null },
  ],
}

const PLAN_DETAIL = {
  id: 'P001',
  title: 'A plan',
  approval: null,
  body: '# A plan',
  review: null,
  stories: [],
}

/**
 * A third plan of its own, so the attach test below can open its plan detail
 * without inheriting whichever of P001/P002 an earlier test in this file left
 * open — `plans.toggle` closes an already-open id rather than reopening it, so
 * sharing a fixture with `open-plan` clicked earlier in the file would flip a
 * coin on whether this test's own click opens or closes it.
 */
const PLAN_WITH_JOB = {
  id: 'P003',
  title: 'Has a job',
  approval: null,
  body: '',
  review: null,
  stories: [
    {
      id: 'P003-S01',
      title: 'Ready to go',
      status: 'todo',
      ui: false,
      depends_on: [],
      acceptance: [],
      evidence: null,
      body: '',
    },
  ],
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

/**
 * The most recently shown toast's own text — `ui/toasts.js` appends, so the
 * last child is the newest. This file does not fake timers, so a toast an
 * earlier test in it showed is still sitting in `#toasts` eight real seconds
 * later; asserting merely that *a* toast exists would pass whether or not the
 * one this test cares about was ever shown.
 */
function lastToastText(): string | null {
  const toasts = document.querySelectorAll('#toasts .toast')
  return toasts.item(toasts.length - 1)?.textContent ?? null
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

  it('carries a real click on a story through to a real enqueue frame', async () => {
    // The Stories tab is new markup, a new panel module and two renamed
    // actions. Every one of those can be present and unwired: `bus.on` throws
    // on a duplicate but says nothing about a name nobody registered, and
    // discipline.test.ts greps for the registration rather than what it does.
    sent.length = 0
    open('plans')
    const plans = [{ id: 'P002', title: 'Has stories', approval: null, stories: [
      { id: 'P002-S01', title: 'Ready to go', status: 'todo', ui: false, depends_on: [] },
    ] }]
    poll({ plans, revisions: { ...emptySnapshot().revisions, plans: { P002: 'a' } } })
    await vi.waitFor(() => expect(document.querySelectorAll('#plans-list > *').length).toBe(1))
    click('[data-act="open-plan"]')

    // Across to the stories, the way the page offers it.
    open('stories')
    await vi.waitFor(() => expect(document.querySelectorAll('#stories-list .story').length).toBe(1))
    expect(document.getElementById('stories-plan-id')?.textContent).toBe('P002')

    // Filtered to the command frames: starting work opens the terminal pane,
    // which reports its geometry, and that resize is behaviour rather than
    // noise to assert around.
    const commands = (): unknown[] => sent.filter((frame) => (frame as { type: string }).type === 'enqueue')

    sent.length = 0
    click('#stories-list [data-act="story-run"]')
    expect(commands()).toEqual([{ type: 'enqueue', command: '/mjloop:build P002-S01', story: 'P002-S01' }])

    // The same story is offered twice on this tab — once in the start block and
    // once in its own row — and both must reach the same frame.
    sent.length = 0
    click('#stories-ready-list [data-act="story-run"]')
    expect(commands()).toEqual([{ type: 'enqueue', command: '/mjloop:build P002-S01', story: 'P002-S01' }])
  })

  it("attaches the shared terminal to a story tab's own job on a real press", async () => {
    // `ui/pane.js` and `ui/terminal.js` carry no test of their own — this file
    // stubs `Terminal` away above — so this is the only suite that can see
    // whether pressing the story pane's control actually reaches the wire.
    sent.length = 0
    open('plans')
    const plans = [
      {
        id: 'P003',
        title: 'Has a job',
        approval: null,
        stories: [{ id: 'P003-S01', title: 'Ready to go', status: 'todo', ui: false, depends_on: [] }],
      },
    ]
    poll({ plans, revisions: { ...emptySnapshot().revisions, plans: { P003: 'a' } } })
    await vi.waitFor(() => expect(document.querySelectorAll('#plans-list > *').length).toBe(1))
    click('[data-act="open-plan"]')

    open('stories')
    // Waited on the row's own id, not merely a count: `lib/plandoc.js`'s feed
    // keeps serving the previous plan's document until the new fetch resolves
    // — deliberately, so switching plans does not flash an empty list — and an
    // earlier test in this file left P002's single-story document in that seat.
    // A count-only wait would pass on that stale row while `/api/plans/P003`
    // is still in flight, and this row's story has no `body` field, so opening
    // it crashes `drawOpen`'s `story.body.trim()`.
    await vi.waitFor(() => expect(document.querySelector('#stories-list .story-id')?.textContent).toBe('P003-S01'))

    // Into a tab of its own, the way the list actually offers it. Scoped to
    // the list row rather than the bare action name: the worktab strip's own
    // buttons carry the same `data-act="story-tab"` for whichever tab an
    // earlier test in this file left open, and an unscoped query would hit
    // whichever of the two comes first in the document.
    click('#stories-list [data-act="story-tab"]')
    await vi.waitFor(() => expect(document.getElementById('story-open-title')?.textContent).toBe('P003-S01 — Ready to go'))

    // Nothing is queued yet, so the control has nothing to offer.
    expect((document.getElementById('story-open-attach') as HTMLElement).hidden).toBe(true)

    // A job naming this story lands in the queue, but only `queued` — not
    // started, and `server.ts` has no transcript entry for it yet.
    // `panels/queue.js:181` hides its identical control for exactly this
    // group (`WAITING`); `jobForStory` must agree, or this control offers to
    // attach to a job that produces a blank pane and a "finished" label for
    // work that has not begun.
    poll({
      plans,
      revisions: { ...emptySnapshot().revisions, plans: { P003: 'a' } },
      queue: [
        {
          id: 'j0',
          command: '/mjloop:build P003-S01',
          story: 'P003-S01',
          status: 'queued',
          reason: null,
          startedAt: null,
          endedAt: null,
        },
      ],
    })
    expect((document.getElementById('story-open-attach') as HTMLElement).hidden).toBe(true)

    // The same job, now running — the control appears.
    poll({
      plans,
      revisions: { ...emptySnapshot().revisions, plans: { P003: 'a' } },
      queue: [
        {
          id: 'j1',
          command: '/mjloop:build P003-S01',
          story: 'P003-S01',
          status: 'running',
          reason: null,
          startedAt: '2026-07-28T09:00:00.000Z',
          endedAt: null,
        },
      ],
      session: { jobId: 'j1', blocked: false, pausedBy: null, closing: false, stalledSince: null },
    })
    await vi.waitFor(() => expect((document.getElementById('story-open-attach') as HTMLElement).hidden).toBe(false))
    // Cutting `phrase(openAttach, 'job.view')` to a no-op would leave every
    // other assertion in this suite green — an invisible control in a flex
    // row is still "not hidden".
    expect(document.getElementById('story-open-attach')?.textContent).toBe(english['job.view'])

    sent.length = 0
    click('#story-open-attach')
    // Filtered to the attach frame itself: the pane was already docked by
    // `app.js`'s own `pane.follow()` when `session.jobId` turned into `j1`
    // above, so `pane.reveal()`'s `refit()` (`ui/pane.js`) reports the
    // terminal's geometry same as it would from any other resize — noise
    // to assert around here, not the subject.
    const attaches = sent.filter((frame) => (frame as { type: string }).type === 'attach')
    // The same frame the Queue tab's own `job-attach` sends — this reuses that
    // action rather than inventing a second one, so the wire cannot tell the
    // two controls apart.
    expect(attaches).toEqual([{ type: 'attach', jobId: 'j1' }])
  })

  it('opens the session view out of a collapsed, queue-view pane when a story tab presses attach', async () => {
    // The Queue tab's own `job-attach` (`panels/queue.js:177-182`) only ever
    // renders inside `.pane-body`, so pressing it happens with the pane
    // already open — it never has to prove this. The story tab's control
    // sits outside that subtree (`index.html:384`, inside `#story-open-head`,
    // not `.pane-body`), so it is the one press that can be made while the
    // pane is `collapsed` — the state the page opens in
    // (`40-terminal.css:170-173`) — or showing the Queue view instead of the
    // session view (`#view-session-body`) a transcript actually lands in.
    sent.length = 0
    // Reuses the P003 plan and the story tab the previous test already
    // opened: `plans.toggle` closes an already-open id rather than reopening
    // it (see the comment on `PLAN_WITH_JOB` above), so clicking
    // `open-plan` again here would close what that test opened rather than
    // reopen it.
    open('stories')
    poll({
      plans: [
        {
          id: 'P003',
          title: 'Has a job',
          approval: null,
          stories: [{ id: 'P003-S01', title: 'Ready to go', status: 'todo', ui: false, depends_on: [] }],
        },
      ],
      revisions: { ...emptySnapshot().revisions, plans: { P003: 'a' } },
      // Finished, not running: naming a job in `session.jobId` triggers
      // `app.js`'s own `pane.follow()` on the transition into it, which would
      // dock the pane before this test's press and prove nothing about the
      // press itself. `session` is left at its default (`jobId: null`).
      queue: [
        {
          id: 'j2',
          command: '/mjloop:build P003-S01',
          story: 'P003-S01',
          status: 'done',
          reason: null,
          startedAt: '2026-07-28T09:00:00.000Z',
          endedAt: '2026-07-28T09:05:00.000Z',
        },
      ],
    })
    await vi.waitFor(() =>
      expect((document.getElementById('story-open-attach') as HTMLElement).dataset['job']).toBe('j2'),
    )

    // Forced to `collapsed` and the Queue view, so the press below has to do
    // both jobs itself rather than inherit an already-open pane left behind
    // by an earlier test in this file.
    while (document.body.dataset['pane'] !== 'collapsed') click('[data-act="pane-cycle"]')
    click('[data-act="view-queue"]')
    expect((document.getElementById('view-session-body') as HTMLElement).hidden).toBe(true)

    click('#story-open-attach')
    expect(document.body.dataset['pane']).not.toBe('collapsed')
    expect((document.getElementById('view-session-body') as HTMLElement).hidden).toBe(false)
  })

  it('reaches every panel the navigation offers', () => {
    // A tab whose panel `app.js` forgot to mount is a tab that renders nothing
    // and looks like an empty project.
    for (const route of ['run', 'plans', 'stories', 'features', 'skills', 'evidence', 'memory', 'config']) {
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

  it('opens the notification panel to a real snapshot transition, closes it, and keeps the badge honest', async () => {
    // `drawNoticeFeed` diffs against whatever `poll()` last delivered in an
    // earlier test in this file — `mountNotifications` only resets at import
    // time, once, the same as every other module-level mount here. A first,
    // otherwise-empty poll pins a known baseline before the transition this
    // test is actually about, so the assertions below hold regardless of what
    // an earlier test in this file left behind.
    poll()
    poll({ state: { ...emptySnapshot().state, config_error: 'bad indentation' } })

    await vi.waitFor(() => expect(lastToastText()).toContain('unreadable'))
    const badge = document.getElementById('notice-count') as HTMLElement
    expect(badge.hidden).toBe(false)

    click('[data-act="notice-toggle"]')
    expect((document.getElementById('notice-panel') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('notice-toggle')?.getAttribute('aria-expanded')).toBe('true')
    // Opening reads the badge, and the entry the toast just showed is the same
    // one logged in the panel — one door, `ui/notifications.js`'s `notify()`,
    // for both.
    expect(badge.hidden).toBe(true)
    expect(document.querySelector('#notice-list .notice-row')?.textContent).toContain('unreadable')

    click('[data-act="notice-close"]')
    expect((document.getElementById('notice-panel') as HTMLElement).hidden).toBe(true)
    expect(document.getElementById('notice-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it("logs a write's own receipt into the notification panel, not only the toast", async () => {
    // `ui/writes.js`'s `settle()` used to call `ui/toasts.js`'s `toast()`
    // directly; it now calls `ui/notifications.js`'s `notify()` instead, which
    // does both. A real `{type:'receipt'}` frame delivered the way the server
    // actually sends one, rather than calling `settle()` in isolation, is what
    // proves the wire is still connected to the change.
    click('[data-act="notice-close"]')
    deliver({ type: 'receipt', id: 'w-does-not-matter', ok: true, code: 'write.ok.story' })
    await vi.waitFor(() => expect(lastToastText()).toContain('Story requeued'))

    click('[data-act="notice-toggle"]')
    expect(document.querySelector('#notice-list .notice-row')?.textContent).toContain('Story requeued')
  })

  it('logs a refused write too, not only an accepted one', async () => {
    click('[data-act="notice-close"]')
    deliver({ type: 'receipt', id: 'w-refused', ok: false, code: 'write.stale.story' })
    await vi.waitFor(() => expect(lastToastText()).toContain('moved on in the meantime'))

    click('[data-act="notice-toggle"]')
    expect(document.querySelector('#notice-list .notice-row')?.textContent).toContain('moved on in the meantime')
  })

  it("logs the queue's own {type:'notice'} frames the same way", async () => {
    // `job.abandoned` and `queue.blocked`/`queue.failed` are the two notices
    // `queue.ts` already sends over the wire, unrelated to a write receipt —
    // this is the other of the two existing sources `ui/notifications.js`'s
    // header names, delivered exactly as the server sends it.
    click('[data-act="notice-close"]')
    deliver({ type: 'notice', message: { code: 'job.abandoned', params: { job: '/mjloop:build P009-S01' } } })
    await vi.waitFor(() => expect(lastToastText()).toContain('P009-S01'))

    click('[data-act="notice-toggle"]')
    expect(document.querySelector('#notice-list .notice-row')?.textContent).toContain('P009-S01')
  })
})
