import { describe, expect, it } from 'vitest'
import { installForTest, parts, pluralKey, t, tn } from '../../src/web/public/lib/i18n.js'
import { duration, time } from '../../src/web/public/lib/fmt.js'
import { installStorage, read, write } from '../../src/web/public/lib/local.js'
import type { OpenStory } from '../../src/web/public/lib/local.js'
import { routeFrom } from '../../src/web/public/lib/router.js'
import {
  planStatus,
  ready,
  readyIn,
  sift,
  statusIndex,
  tally,
  unmet,
} from '../../src/web/public/lib/stories.js'
import { deriveEvents } from '../../src/web/public/lib/notifications.js'
import { emptySnapshot } from './helpers/page.js'
import type { Job, PlanView, StoryView } from '../../src/web/protocol.js'

/**
 * `lib/` is DOM-free so it is testable here, under the suite's existing
 * `environment: 'node'`, with no new dependency. That is the whole reason the
 * layer rule exists: the plural and bidi decisions are the ones a translator
 * will lean on, and they must be assertable without a browser.
 */

const english = {
  'a.plain': 'Nothing to fill',
  'a.hole': 'Waits on {ids}',
  'a.count': 'Cycle {n}',
  'p.one': '{count} job',
  'p.other': '{count} jobs',
}

describe('t', () => {
  it('falls back to english per key, then to the key itself', () => {
    installForTest({ code: 'ar', strings: { 'a.plain': 'لا شيء' }, fallback: english })
    expect(t('a.plain')).toBe('لا شيء')
    expect(t('a.hole', { ids: 'P001-S01' })).toBe('Waits on P001-S01')
    // A readable identifier beats a blank line, and it is what makes a
    // user-configured agent or track name safe to look up undeclared.
    expect(t('agent.some-custom-agent')).toBe('agent.some-custom-agent')
  })

  it('leaves an unfilled hole visible', () => {
    installForTest({ code: 'en', strings: english })
    expect(t('a.hole', {})).toBe('Waits on {ids}')
  })
})

describe('parts', () => {
  it('splits at the holes so each one can be isolated', () => {
    installForTest({ code: 'en', strings: english })
    expect(parts('a.hole', { ids: 'P001-S01' })).toEqual([
      { kind: 'text', value: 'Waits on ' },
      { kind: 'param', value: 'P001-S01' },
    ])
  })

  it('formats a numeric parameter for the language', () => {
    // `ar-EG` rather than `ar`, because that is where the hazard is real:
    // `Intl.NumberFormat('ar-EG')` renders Arabic-Indic digits. Prose counts,
    // and only prose counts, come through here. Ids, paths and cycle numbers go
    // through `verbatim()` — `P001-S02` must never become `P٠٠١-S٠٢`.
    installForTest({ code: 'ar-EG', strings: english, fallback: english })
    expect(parts('a.count', { n: 3 })).toEqual([
      { kind: 'text', value: 'Cycle ' },
      { kind: 'param', value: '٣' },
    ])
  })
})

describe('plurals', () => {
  it('resolves against english categories', () => {
    installForTest({ code: 'en', strings: english })
    expect(pluralKey('p', 1)).toBe('p.one')
    expect(pluralKey('p', 5)).toBe('p.other')
    expect(tn('p', 1)).toBe('1 job')
  })

  it('resolves against arabic categories', () => {
    installForTest({
      code: 'ar',
      strings: { 'p.zero': 'لا مهامّ', 'p.two': 'مهمّتان', 'p.few': '{count} مهامّ', 'p.other': '{count} مهمّة' },
      fallback: english,
    })
    expect(pluralKey('p', 0)).toBe('p.zero')
    expect(pluralKey('p', 2)).toBe('p.two')
    expect(pluralKey('p', 3)).toBe('p.few')
    expect(pluralKey('p', 100)).toBe('p.other')
  })

  it('falls back to .other for a category the language file does not carry', () => {
    installForTest({ code: 'ar', strings: { 'p.other': '{count} مهمّة' }, fallback: english })
    expect(pluralKey('p', 2)).toBe('p.other')
  })
})

describe('fmt', () => {
  it('renders a duration compactly', () => {
    expect(duration('2026-07-28T12:00:00Z', '2026-07-28T12:00:09Z')).toBe('9s')
    expect(duration('2026-07-28T12:00:00Z', '2026-07-28T12:03:12Z')).toBe('3m 12s')
    expect(duration('2026-07-28T12:00:00Z', '2026-07-28T13:04:00Z')).toBe('1h 04m')
  })

  it('returns nothing rather than Invalid Date', () => {
    // These arrive from files a person may have hand-edited.
    expect(time('not a date')).toBe('')
    expect(time(null)).toBe('')
    expect(duration(null, null)).toBe('')
    expect(duration('2026-07-28T12:03:00Z', '2026-07-28T12:00:00Z')).toBe('')
  })
})

describe('local', () => {
  it('reads back the selection it was given', () => {
    const stored = JSON.stringify({
      activePlan: 'P001',
      storyFilter: 'ready',
      openStories: [{ id: 'P001-S02', pinned: true }, { id: 'P001-S03' }],
      recentlyClosed: ['P001-S01'],
    })
    installStorage({ getItem: () => stored, setItem: () => {} })
    expect(read().activePlan).toBe('P001')
    expect(read().storyFilter).toBe('ready')
    expect(read().openStories).toEqual([
      { id: 'P001-S02', pinned: true },
      { id: 'P001-S03', pinned: false },
    ])
    expect(read().recentlyClosed).toEqual(['P001-S01'])
  })

  it('upgrades a tab list of bare ids rather than dropping it', () => {
    // The shape a page that could not yet pin a tab would have written. Losing
    // the reader's tabs on the release that adds pinning is the failure this
    // branch exists to prevent, and the whitelist drops silently.
    installStorage({ getItem: () => JSON.stringify({ openStories: ['P001-S02', 'P001-S03'] }), setItem: () => {} })
    expect(read().openStories).toEqual([
      { id: 'P001-S02', pinned: false },
      { id: 'P001-S03', pinned: false },
    ])
  })

  it('bounds and cleans the two lists that come back from storage', () => {
    installStorage({
      getItem: () =>
        JSON.stringify({
          // Duplicates, empties, and entries that are neither a string nor a
          // record: all of it is whatever was last written to this key.
          openStories: ['P001-S01', 'P001-S01', '', 7, null, { pinned: true }, ...Array.from({ length: 40 }, (_, i) => `P002-S${i}`)],
          recentlyClosed: [...Array.from({ length: 40 }, (_, i) => `P003-S${i}`), 9],
        }),
      setItem: () => {},
    })
    const open = read().openStories
    expect(open).toHaveLength(24)
    expect(open[0]).toEqual({ id: 'P001-S01', pinned: false })
    expect(open.filter((entry) => entry.id === 'P001-S01')).toHaveLength(1)
    expect(read().recentlyClosed).toHaveLength(10)
    expect(read().recentlyClosed.every((entry) => typeof entry === 'string')).toBe(true)
  })

  it('hands back defaults a caller cannot edit for everyone else', () => {
    installStorage({ getItem: () => null, setItem: () => {} })
    expect(read().openStories).toEqual([])
    expect(() => (read().openStories as OpenStory[]).push({ id: 'P001-S01', pinned: false })).toThrow()
  })

  it('survives storage that is disabled, corrupt or holding an unknown value', () => {
    installStorage({
      getItem: () => {
        throw new Error('disabled')
      },
      setItem: () => {
        throw new Error('disabled')
      },
    })
    expect(read().pane).toBe('collapsed')
    expect(write({ pane: 'full' }).pane).toBe('full')

    installStorage({ getItem: () => '{ not json', setItem: () => {} })
    expect(read().pane).toBe('collapsed')

    installStorage({ getItem: () => JSON.stringify({ pane: 'enormous', lang: 5 }), setItem: () => {} })
    expect(read().pane).toBe('collapsed')
    expect(read().lang).toBe(null)
  })
})

describe('router', () => {
  it('normalises a fragment to a known route', () => {
    expect(routeFrom('#plans', ['run', 'plans'], 'run')).toBe('plans')
    expect(routeFrom('', ['run', 'plans'], 'run')).toBe('run')
    expect(routeFrom('#nope', ['run', 'plans'], 'run')).toBe('run')
  })
})

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

describe('story derivations', () => {
  it('scopes readiness to one plan, as the engine does', () => {
    // The fix. `ops/plan.ts`'s `storyNext` computes its done-set inside one
    // plan, so a dependency naming another plan's story is never satisfied for
    // it — and the page said the opposite: it indexed every plan's stories at
    // once, marked this one Ready, tagged it `next` and offered Run, for a
    // story `/mjloop:build --next` would never pick.
    const plans = [
      plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] }),
      plan({ id: 'P002', stories: [story({ id: 'P002-S01', depends_on: ['P001-S01'] })] }),
    ]
    expect(readyIn(plans[1] as PlanView)).toEqual([])
    expect(ready(plans)).toEqual([])
    // And the two numbers that render the same claim agree with it.
    expect(tally(plans).ready).toBe(0)
  })

  it('still finds what a satisfied dependency inside the plan unblocks', () => {
    // The other direction, so the fix is not "nothing is ever ready".
    const one = plan({
      id: 'P001',
      stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02', depends_on: ['P001-S01'] })],
    })
    expect(readyIn(one).map((entry) => entry.id)).toEqual(['P001-S02'])
    expect(ready([one]).map((entry) => entry.id)).toEqual(['P001-S02'])
  })

  it('counts an id the index does not carry as unmet', () => {
    // Inside a plan that is a typo, and treating it as satisfied would turn one
    // into a build. Across plans it is an edge `assertDependenciesResolve`
    // refuses to write — same answer, different reason.
    expect(unmet(story({ id: 'P001-S02', depends_on: ['P001-S09'] }), statusIndex([]))).toEqual(['P001-S09'])
  })

  it("reads a plan's state off its stories and nothing else", () => {
    expect(planStatus(plan({ id: 'P001' }))).toBe('empty')
    expect(planStatus(plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] }))).toBe('done')
    expect(planStatus(plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] }))).toBe('todo')
    expect(planStatus(plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'doing' })] }))).toBe('doing')
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

  it('sifts by a status the story does not carry, and by a query across both fields', () => {
    // Reachable without a DOM for the first time: `ready` is a status *and* a
    // dependency check, so it is the one filter a status column cannot express.
    const stories = [
      story({ id: 'P001-S01', title: 'Wire the socket', status: 'done' }),
      story({ id: 'P001-S02', title: 'Draw the rail', depends_on: ['P001-S01'] }),
      story({ id: 'P001-S03', title: 'Draw the pane', depends_on: ['P001-S02'] }),
    ]
    const statuses = statusIndex(stories)
    expect(sift(stories, '', 'ready', statuses).map((entry) => entry.id)).toEqual(['P001-S02'])
    expect(sift(stories, '', 'done', statuses).map((entry) => entry.id)).toEqual(['P001-S01'])
    // Terms are conjunctive and match id or title, so two words narrow rather
    // than widen.
    expect(sift(stories, 'draw pane', '', statuses).map((entry) => entry.id)).toEqual(['P001-S03'])
    expect(sift(stories, 'S03', '', statuses).map((entry) => entry.id)).toEqual(['P001-S03'])
    expect(sift(stories, '', '', statuses)).toHaveLength(3)
  })
})

const job = (patch: Partial<Job> & { id: string }): Job => ({
  command: '/mjloop:build P001-S01',
  story: null,
  status: 'queued',
  reason: null,
  startedAt: null,
  endedAt: null,
  ...patch,
})

describe('notifications', () => {
  it('reports nothing on the first snapshot a session ever sees', () => {
    // Every story, plan and job on it is already however old the project is;
    // reporting all of it as "just happened" the moment a tab opens is the one
    // thing this function must never do.
    const first = emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] })] })
    expect(deriveEvents(null, first)).toEqual([])
  })

  it('reports a story turning done or blocked, and nothing for an unrelated field moving', () => {
    const before = emptySnapshot({
      plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'doing' }), story({ id: 'P001-S02' })] })],
    })
    const after = emptySnapshot({
      plans: [
        plan({
          id: 'P001',
          stories: [story({ id: 'P001-S01', status: 'done' }), story({ id: 'P001-S02', status: 'blocked' })],
        }),
      ],
    })
    expect(deriveEvents(before, after)).toEqual([
      { code: 'notice.story.done', params: { id: 'P001-S01' } },
      { code: 'notice.story.blocked', params: { id: 'P001-S02' } },
    ])
    // Nothing changed a second time: the same two snapshots compared again
    // must not refire.
    expect(deriveEvents(after, after)).toEqual([])
  })

  it('reports a plan completing once, not on every snapshot after', () => {
    const empty = emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] })
    const done = emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01', status: 'done' })] })] })
    expect(deriveEvents(empty, done)).toContainEqual({ code: 'notice.plan.done', params: { id: 'P001' } })
    expect(deriveEvents(done, done)).toEqual([])
  })

  it('never calls an empty plan complete', () => {
    // `plan.stories.every(...)` is vacuously true over an empty array — the
    // guard this test protects is `plan.stories.length > 0`, and removing it
    // turns a plan with zero stories into "done" the instant one exists on a
    // snapshot the page has already seen the plan on (so the earlier awaiting-
    // approval event, which only fires for a genuinely new plan id, cannot
    // mask the regression the way comparing two identical snapshots would).
    const before = emptySnapshot({ plans: [plan({ id: 'P001', stories: [story({ id: 'P001-S01' })] })] })
    const stillEmptyOfDoneWork = emptySnapshot({ plans: [plan({ id: 'P001', stories: [] })] })
    expect(deriveEvents(before, stillEmptyOfDoneWork)).toEqual([])

    const empty = emptySnapshot({ plans: [plan({ id: 'P001', stories: [] })] })
    expect(deriveEvents(empty, empty)).toEqual([])
  })

  it('reports a new plan awaiting a decision, once, and never for one already on record', () => {
    const before = emptySnapshot({ plans: [] })
    const arrived = emptySnapshot({ plans: [plan({ id: 'P001', approval: null })] })
    expect(deriveEvents(before, arrived)).toEqual([{ code: 'notice.plan.awaitingApproval', params: { id: 'P001' } }])
    // Already on record on both snapshots: no event, even though `approval` is
    // still null on both.
    expect(deriveEvents(arrived, arrived)).toEqual([])
    // A plan the page already knew about that later gets approved reports
    // nothing here — the decision itself is not a "needs a decision" event.
    const decided = emptySnapshot({ plans: [plan({ id: 'P001', approval: 'approved' })] })
    expect(deriveEvents(arrived, decided)).toEqual([])
  })

  it("reports a story-bound job's failure, and leaves a job with no story to the queue's own notice", () => {
    const before = emptySnapshot({ queue: [job({ id: 'j1', story: 'P001-S01', status: 'running' })] })
    const after = emptySnapshot({ queue: [job({ id: 'j1', story: 'P001-S01', status: 'failed' })] })
    expect(deriveEvents(before, after)).toEqual([{ code: 'notice.job.storyFailed', params: { id: 'P001-S01' } }])
    // Still failed on the next poll: reported once, not on every tick a
    // finished job sits in `snapshot.queue`.
    expect(deriveEvents(after, after)).toEqual([])

    const untied = emptySnapshot({ queue: [job({ id: 'j2', story: null, status: 'running' })] })
    const untiedFailed = emptySnapshot({ queue: [job({ id: 'j2', story: null, status: 'failed' })] })
    expect(deriveEvents(untied, untiedFailed)).toEqual([])
  })

  it('reports config becoming unreadable, once', () => {
    const readable = emptySnapshot()
    const broken = emptySnapshot({ state: { ...emptySnapshot().state, config_error: 'bad indentation' } })
    expect(deriveEvents(readable, broken)).toEqual([{ code: 'notice.config.missing' }])
    expect(deriveEvents(broken, broken)).toEqual([])
  })

  it('reports a cycle ending without passing, and does not repeat while the same cycle sits open', () => {
    const idle = emptySnapshot()
    const failed = emptySnapshot({ state: { ...emptySnapshot().state, last_cycle: { result: 'fail', agents: ['builder'] } } })
    expect(deriveEvents(idle, failed)).toEqual([{ code: 'notice.cycle.failed', params: { agents: 'builder' } }])
    // Same reading polled again: no repeat.
    expect(deriveEvents(failed, failed)).toEqual([])
    // A `pass` never fires this event at all.
    const passed = emptySnapshot({ state: { ...emptySnapshot().state, last_cycle: { result: 'pass', agents: ['builder'] } } })
    expect(deriveEvents(idle, passed)).toEqual([])
    // A second, distinct cycle failing behind the first fires again.
    const failedAgain = emptySnapshot({
      state: { ...emptySnapshot().state, last_cycle: { result: 'fail', agents: ['verifier'] } },
    })
    expect(deriveEvents(failed, failedAgain)).toEqual([{ code: 'notice.cycle.failed', params: { agents: 'verifier' } }])
  })

  it('reports each new verification-failure signature once', () => {
    const clean = emptySnapshot({ guards: { strikes: 0, strikesAllowed: 3, cycleErrors: [], errorArmed: null } })
    const oneError = emptySnapshot({
      guards: { strikes: 1, strikesAllowed: 3, cycleErrors: ['npm test :: N failing'], errorArmed: 'x' },
    })
    expect(deriveEvents(clean, oneError)).toEqual([
      { code: 'notice.verify.failed', params: { signature: 'npm test :: N failing' } },
    ])
    const twoErrors = emptySnapshot({
      guards: {
        strikes: 1,
        strikesAllowed: 3,
        cycleErrors: ['npm test :: N failing', 'npm run build :: exit N'],
        errorArmed: 'x',
      },
    })
    // Only the new signature is reported — the one already seen is not repeated.
    expect(deriveEvents(oneError, twoErrors)).toEqual([
      { code: 'notice.verify.failed', params: { signature: 'npm run build :: exit N' } },
    ])
  })
})
