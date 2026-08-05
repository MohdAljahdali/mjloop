import { describe, expect, it } from 'vitest'
import { installForTest, parts, pluralKey, t, tn } from '../../src/web/app/lib/i18n.ts'
import { duration, time } from '../../src/web/app/lib/fmt.ts'
import { installStorage, read, write } from '../../src/web/app/lib/local.ts'
import type { OpenStory } from '../../src/web/app/lib/local.ts'
import { routeFrom } from '../../src/web/app/lib/router.ts'
import {
  acceptancesFor,
  draftedAgents,
  planStatus,
  ready,
  readyIn,
  relevantAcceptances,
  routableAgents,
  sift,
  skillWarnings,
  statusIndex,
  tally,
  unmet,
} from '../../src/web/app/lib/stories.ts'
import { deriveEvents } from '../../src/web/app/lib/notifications.ts'
import { planMemories, planRuns } from '../../src/web/app/lib/plans.ts'
import { facet } from '../../src/web/app/lib/memory.ts'
import {
  broken,
  collectSettingsChanges,
  collectTrackChanges,
  commandRows,
  edgeAfter,
  findOrderCycle,
  knownAgents,
  orchestrationProblem,
  orderEdgeChanges,
  policyRows,
  seedDraft,
  seedFormValues,
  trackCommentLoss,
  trackFieldChanges,
  trackPending,
  trackProblems,
  validAgent,
} from '../../src/web/app/lib/config.ts'
import { emptySnapshot } from './helpers/page.js'
import type { Job, PlanView, StoryView } from '../../src/web/protocol.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import type { Config, Track } from '../../src/schemas/config.js'
import { ConfigChangeSchema } from '../../src/store/config-mutation.js'
import type { ProjectSkillAcceptance } from '../../src/schemas/skill-acceptance.js'
import type { MemoryView, RunSummary } from '../../src/web/read.js'

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

const track = (patch: Partial<Track> = {}): Track => ({
  required: ['builder', 'verifier'],
  available: ['scout', 'critic'],
  closing: ['docs'],
  order: [],
  max_cycles: 5,
  ...patch,
})

const acceptance = (patch: Partial<ProjectSkillAcceptance> & { skillId: string }): ProjectSkillAcceptance => ({
  schema: 1,
  packageId: 'p',
  digest: 'a'.repeat(64),
  components: [],
  agents: ['builder'],
  tags: [],
  updatePolicy: 'auto',
  status: 'active',
  compatible: true,
  acceptedBy: 'dashboard:mohd',
  acceptedAt: '2026-07-28T09:00:00.000Z',
  ...patch,
})

describe('skill inspection (C7)', () => {
  it("drafts required and available, never closing, deduplicated and required-first — the same distinction schemas/config.ts:71-80 draws for a working cycle", () => {
    expect(draftedAgents(track())).toEqual(['builder', 'verifier', 'scout', 'critic'])
    // `docs` is `closing`: it runs once after the run passes, never inside a
    // working cycle, so it must never appear here.
    expect(draftedAgents(track())).not.toContain('docs')
    // An absent track — deleted from config.yaml, or not fetched yet — drafts
    // nobody rather than throwing.
    expect(draftedAgents(undefined)).toEqual([])
    // A name in both `required` and `available` (not asserted disjoint by
    // `TrackSchema`) still drafts once.
    expect(draftedAgents(track({ required: ['builder'], available: ['builder', 'scout'] }))).toEqual([
      'builder',
      'scout',
    ])
  })

  it("narrows drafted agents to the agents an acceptance's own `agents` field can ever name, project-wide rather than to the old fixed four", () => {
    // `track()` mirrors the project's real default `build` track shape
    // (required builder/verifier, available scout/critic, closing docs) — not
    // a hand-narrowed fixture, which is how C7 shipped this unnoticed.
    //
    // `scout` is drafted (`available`) and used to be dropped no matter what,
    // because the old rule was a fixed four regardless of what any track
    // named. It is routable now: this track is itself one of `config.yaml`'s
    // own tracks, so anything it drafts (or closes with) is named by *some*
    // track — exactly `store/skill-acceptance-store.ts`'s `routableAgents`.
    expect(routableAgents(track(), { build: track() })).toEqual(['builder', 'verifier', 'scout', 'critic'])

    // The floor still applies when the config names no tracks at all — the
    // one case `store/skill-acceptance-store.ts`'s `routableAgents` falls
    // back to `SKILL_ACCEPTANCE_AGENTS` for, and `scout` is not one of the
    // fixed four.
    expect(routableAgents(track(), {})).toEqual(['builder', 'verifier', 'critic'])
    expect(routableAgents(track(), {})).not.toContain('scout')

    expect(routableAgents(undefined, { build: track() })).toEqual([])
  })

  it('keeps only the acceptances that name a drafted agent, plus every acceptance that names none at all', () => {
    const drafted = draftedAgents(track())
    const acceptances = [
      acceptance({ skillId: 's1', agents: ['builder'] }),
      // `planner` is a real, valid role — dynamic skill selection routes to
      // it from a feature brief — but no track's `required`/`available` this
      // page reads ever lists it, so an acceptance naming only `planner` has
      // nothing to do with this story's track and must be left out.
      acceptance({ skillId: 's2', agents: ['planner'] }),
      acceptance({ skillId: 's3', agents: ['verifier', 'planner'] }),
      // `acceptSkill` with no `--agents` writes `agents: []`
      // (`cli/index.ts:1070`) — dead on every track at once, not merely
      // unrelated to this one, so it is kept regardless of `drafted` for
      // `skillWarnings`' `noAgents` flag to catch below.
      acceptance({ skillId: 's4', agents: [] }),
    ]
    const relevant = relevantAcceptances(acceptances, drafted)
    expect(relevant.map((entry) => entry.skillId)).toEqual(['s1', 's3', 's4'])

    // The agent-to-skill filter, including the case an agent has none —
    // `scout` is drafted but no acceptance in this project names it.
    expect(acceptancesFor(relevant, 'builder').map((entry) => entry.skillId)).toEqual(['s1'])
    expect(acceptancesFor(relevant, 'verifier').map((entry) => entry.skillId)).toEqual(['s3'])
    expect(acceptancesFor(relevant, 'scout')).toEqual([])
    // `agents.includes(agent)` is false for every agent when `agents` is
    // `[]`, so `s4` never lands under any agent's own row — it only ever
    // shows up in the warnings list.
    expect(acceptancesFor(relevant, 'builder').map((entry) => entry.skillId)).not.toContain('s4')
  })

  it('supports exactly three pre-run warnings, each off one field the acceptance record actually carries', () => {
    // Clean: none of the three conditions fire.
    expect(skillWarnings(acceptance({ skillId: 's1' }))).toEqual({
      noAgents: false,
      notActive: false,
      notCompatible: false,
    })

    expect(skillWarnings(acceptance({ skillId: 's2', agents: [] })).noAgents).toBe(true)
    expect(skillWarnings(acceptance({ skillId: 's3', status: 'disabled' })).notActive).toBe(true)
    expect(skillWarnings(acceptance({ skillId: 's4', compatible: false })).notCompatible).toBe(true)

    // All three can fire on the same acceptance at once.
    const worst = skillWarnings(acceptance({ skillId: 's5', agents: [], status: 'disabled', compatible: false }))
    expect(worst).toEqual({ noAgents: true, notActive: true, notCompatible: true })
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
    // A plan arriving for the first time already carrying a decision must
    // announce nothing. Every other case above shares its plan id between the
    // two snapshots compared, so `before !== undefined` was doing all the
    // suppressing and `plan.approval === null` was never the condition under
    // test — this is the one case that isolates it.
    const freshlyApproved = emptySnapshot({ plans: [plan({ id: 'P001', approval: 'approved' })] })
    expect(deriveEvents(before, freshlyApproved)).toEqual([])
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

describe('lib/plans', () => {
  const run = (patch: Partial<RunSummary> & { id: string }): RunSummary => ({
    story: null,
    track: 'build',
    cycles: 1,
    halted: false,
    ...patch,
  })
  const memory = (patch: Partial<MemoryView> & { id: string }): MemoryView => ({
    kind: 'decision',
    title: 'Something',
    tags: [],
    at: '2026-07-28T09:00:00.000Z',
    run: null,
    plan: null,
    story: null,
    body: '',
    ...patch,
  })

  describe('planRuns', () => {
    it('keeps only the runs whose directory names one of this plan\'s own stories', () => {
      const runs = [run({ id: 'a', story: 'P001-S01' }), run({ id: 'b', story: 'P002-S01' }), run({ id: 'c', story: null })]
      expect(planRuns(runs, { stories: [{ id: 'P001-S01' }] }).map((entry) => entry.id)).toEqual(['a'])
    })

    it('matches an ad-hoc run to no plan, ever', () => {
      // `readRuns` maps a directory with no story segment to `story: null` —
      // never attributable to any plan, which is a fact about the directory
      // name and not a gap in this filter.
      const runs = [run({ id: 'adhoc', story: null })]
      expect(planRuns(runs, { stories: [{ id: 'P001-S01' }] })).toEqual([])
    })
  })

  describe('planMemories', () => {
    const plainPlan = { id: 'P001', stories: [{ id: 'P001-S01' }] }

    it("joins on the memory's own `plan` field", () => {
      expect(planMemories([memory({ id: 'M001', plan: 'P001' })], plainPlan)).toEqual([memory({ id: 'M001', plan: 'P001' })])
    })

    it("joins on the memory's own `story` field, scoped to this plan's stories", () => {
      expect(planMemories([memory({ id: 'M002', story: 'P001-S01' })], plainPlan)).toEqual([
        memory({ id: 'M002', story: 'P001-S01' }),
      ])
    })

    it('never matches a prose mention in the title or body', () => {
      expect(planMemories([memory({ id: 'M003', title: 'P001-S01, allegedly', body: 'About P001' })], plainPlan)).toEqual([])
    })

    it('never matches on the `run` field', () => {
      expect(planMemories([memory({ id: 'M004', run: '2026-07-28-001--P001-S01--build' })], plainPlan)).toEqual([])
    })

    it('excludes a memory scoped to a different plan entirely', () => {
      expect(planMemories([memory({ id: 'M005', plan: 'P002' })], plainPlan)).toEqual([])
    })
  })
})

describe('lib/memory', () => {
  // `describe('memory faceting')`, `panels.test.ts:1811`, ported verbatim.
  const entry = (patch: { id: string; kind?: string; title?: string; tags?: string[]; body?: string }): MemoryView => ({
    id: patch.id,
    kind: patch.kind ?? 'decision',
    title: patch.title ?? 'A decision',
    tags: patch.tags ?? [],
    at: '2026-07-28T09:00:00.000Z',
    run: null,
    plan: null,
    story: null,
    body: patch.body ?? '',
  })

  describe('facet', () => {
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

    it('matches on the id field too, not only title/tags/body', () => {
      const all = [entry({ id: 'M001', title: 'Cookies over tokens' }), entry({ id: 'M002', title: 'Something else' })]
      expect(facet(all, 'm002', '').map((memory) => memory.id)).toEqual(['M002'])
    })

    it('is case-insensitive and ignores extra whitespace between terms', () => {
      const all = [entry({ id: 'M001', title: 'Cookies Over Tokens' })]
      expect(facet(all, '  COOKIES   tokens  ', '').map((memory) => memory.id)).toEqual(['M001'])
    })

    it('matches nothing when a term is absent, even if every other term matches', () => {
      const all = [entry({ id: 'M001', title: 'Cookies over tokens' })]
      expect(facet(all, 'cookies nonexistent', '')).toEqual([])
    })

    it('an empty memory list stays empty regardless of the filters', () => {
      expect(facet([], 'anything', 'decision')).toEqual([])
    })
  })
})

/**
 * `Config.vue`'s and `Tracks.vue`'s shared pure half — ported from
 * `panels/config.js`'s own `collectConfigChanges`, `trackProblems`,
 * `findOrderCycle` and the C6 change-impact preview, with
 * `panels.test.ts:2023`'s `describe('config')` as the requirements list.
 * `collectConfigChanges` itself later split into `collectSettingsChanges`
 * (the plain fields `Config.vue` now owns) and `collectTrackChanges` (the
 * structured `specialists:`/`tracks:` maps `Tracks.vue` now owns) — see
 * `lib/config.ts`'s own header. What is under test here is the diff and the
 * refusal logic; the DOM this drives (the editor banner, disabled buttons,
 * the draft-only-until-Save invariant) is `panel-config.test.ts`'s and
 * `panel-tracks.test.ts`'s own.
 */
describe('lib/config', () => {
  const baseline = (patch: Record<string, unknown> = {}): Config =>
    ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
      ...patch,
    })

  describe('seedFormValues / collectSettingsChanges / collectTrackChanges', () => {
    it('emits nothing for a form and draft seeded straight from the baseline', () => {
      const config = baseline()
      const form = seedFormValues(config)
      const draft = seedDraft(config)
      expect(collectSettingsChanges(form, config)).toEqual([])
      expect(collectTrackChanges(draft, config)).toEqual([])
    })

    it('splits the change list at the tracks boundary', () => {
      const config = baseline()
      const form = seedFormValues(config)
      form.autonomous = !config.autonomous
      const draft = seedDraft(config)
      const build = draft.tracks['build']
      if (build !== undefined) build.max_cycles = 9

      const settings = collectSettingsChanges(form, config)
      const tracks = collectTrackChanges(draft, config)

      // Neither half reaches into the other's keys.
      expect(settings.every((change) => change.kind !== 'track')).toBe(true)
      expect(tracks.every((change) => change.kind === 'track')).toBe(true)
      // And together they are still the whole change set.
      expect(settings.length + tracks.length).toBe(2)
    })

    it('emits only the plain fields and the structured maps that actually moved', () => {
      const config = baseline({
        autonomous: false,
        limits: { max_parallel_agents: 4, no_progress_strikes: 2 },
        verify: { test: 'npm test', lint: null, build: 'npm run build' },
      })
      const form = seedFormValues(config)
      const draft = seedDraft(config)

      form.autonomous = true
      form.verifyTest = 'npm run test:ci'
      draft.specialists['security'] = 'always'
      const build = draft.tracks['build']
      if (build !== undefined) build.max_cycles = 7

      expect(collectSettingsChanges(form, config)).toEqual([
        { kind: 'root', key: 'autonomous', value: true },
        { kind: 'verify.command', key: 'test', value: 'npm run test:ci' },
      ])
      expect(collectTrackChanges(draft, config)).toEqual([
        { kind: 'specialist', agent: 'security', value: 'always' },
        {
          kind: 'track',
          track: 'build',
          // `Track` is the output type of `TrackSchema`, so `order` defaults
          // to `[]` on every parsed track — including this diff's own
          // baseline — even though nothing in the draft touched it.
          value: { required: ['builder'], available: [], closing: [], order: [], max_cycles: 7 },
        },
      ])
    })

    it('turns every orchestration control into the change vocabulary the server accepts, and every change is wire-legal', () => {
      const config = baseline()
      const form = seedFormValues(config)
      expect(form.orchDiscoveryQuestionBudget).toBe(8)
      expect(collectSettingsChanges(form, config)).toEqual([])

      form.orchProfileAutoAccept = true
      // `always` before `auto-plan`: the pair is one document-level rule, and
      // `orchestrationProblem` below is what catches the half that would be
      // refused alone.
      form.orchDiscoveryMode = 'always'
      form.orchDiscoveryQuestionBudget = 12
      form.orchDiscoveryCompletion = 'auto-plan'
      form.orchExecutionAfterPlanApproval = 'auto'
      form.orchExecutionUncertainConcurrency = 'parallel'
      form.orchExecutionRepairAttempts = 3
      form.orchQualityMode = 'strict'
      form.orchSkillsSourceRegistry = true
      form.orchSkillsTrustedRegistries = 'https://skills.example.com\n\n'
      form.orchSkillsUpdateMode = 'pinned'

      const changes = collectSettingsChanges(form, config)
      expect(changes).toEqual([
        { kind: 'orchestration.profile.auto_accept', value: true },
        { kind: 'orchestration.discovery.mode', value: 'always' },
        { kind: 'orchestration.discovery.question_budget', value: 12 },
        { kind: 'orchestration.discovery.completion', value: 'auto-plan' },
        { kind: 'orchestration.execution.after_plan_approval', value: 'auto' },
        { kind: 'orchestration.execution.uncertain_concurrency', value: 'parallel' },
        { kind: 'orchestration.execution.repair_attempts', value: 3 },
        { kind: 'orchestration.quality.mode', value: 'strict' },
        { kind: 'orchestration.skills.sources', value: ['github', 'registry'] },
        { kind: 'orchestration.skills.trusted_registries', value: ['https://skills.example.com'] },
        { kind: 'orchestration.skills.update_mode', value: 'pinned' },
      ])
      // The panel shares no code with the server's schema; this is the only
      // place the two vocabularies are checked against each other.
      for (const change of changes) {
        expect(ConfigChangeSchema.safeParse(change).success, JSON.stringify(change)).toBe(true)
      }
    })

    it('seeds the quality mode the project has pinned, and never substitutes the recommended one', () => {
      // The recommendation is a label this page draws, not a value it writes:
      // only `/mjloop:init` picks `adaptive`, and only for a new project.
      const config = baseline({ orchestration: { quality: { mode: 'strict' } } })
      const form = seedFormValues(config)
      expect(form.orchQualityMode).toBe('strict')
      expect(collectSettingsChanges(form, config)).toEqual([])

      form.orchQualityMode = 'economy'
      expect(collectSettingsChanges(form, config)).toEqual([
        { kind: 'orchestration.quality.mode', value: 'economy' },
      ])
    })

    it('compares skill sources as a set, never rewriting the order a document already holds', () => {
      const config = baseline({ orchestration: { skills: { sources: ['web', 'github'] } } })
      const form = seedFormValues(config)
      expect(collectSettingsChanges(form, config)).toEqual([])
    })

    it("carries an order edge added through an agent's own row into the change set, and drops it once its last predecessor is removed", () => {
      const config = baseline({
        tracks: { build: { required: ['builder', 'verifier'], available: ['ui-designer'], max_cycles: 5 } },
      })
      const draft = seedDraft(config)
      const track = draft.tracks['build']
      if (track === undefined) throw new Error('fixture')
      track.order = [{ agent: 'verifier', after: ['builder'] }]

      expect(collectTrackChanges(draft, config)).toEqual([
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

      track.order = []
      expect(collectTrackChanges(draft, config)).toEqual([])
    })
  })

  describe('orchestrationProblem', () => {
    it('refuses auto-plan completion under a discovery mode of off, and lifts once discovery is on', () => {
      const config = baseline()
      const form = seedFormValues(config)
      form.orchDiscoveryCompletion = 'auto-plan'
      expect(orchestrationProblem(form)).toBe('config.problem.autoPlanOff')
      form.orchDiscoveryMode = 'always'
      expect(orchestrationProblem(form)).toBeNull()
    })

    it('refuses a registry source with nothing trusted, and a trusted registry that is not https', () => {
      const config = baseline()
      const form = seedFormValues(config)
      form.orchSkillsSourceRegistry = true
      expect(orchestrationProblem(form)).toBe('config.problem.registryUntrusted')

      form.orchSkillsTrustedRegistries = 'http://registry.internal'
      expect(orchestrationProblem(form)).toBe('config.problem.registryNotHttps')

      // One bad line among good ones is still the whole frame.
      form.orchSkillsTrustedRegistries = 'https://skills.example.com\nftp://mirror.internal\n'
      expect(orchestrationProblem(form)).toBe('config.problem.registryNotHttps')

      form.orchSkillsTrustedRegistries = 'https://skills.example.com\n\nhttps://mirror.internal\n'
      expect(orchestrationProblem(form)).toBeNull()
    })
  })

  // `trackProblems` reads a plain `Draft` — never `ConfigSchema.parse`d —
  // because it exists to describe exactly the shapes the schema would
  // refuse. `mkDraft` builds that shape directly rather than routing an
  // invalid document through `baseline()`, which would throw first.
  const mkDraft = (tracks: Record<string, Track>, specialists: Record<string, string> = {}) => ({ specialists, tracks })

  describe('trackProblems / broken', () => {
    it('flags a track with no required agent', () => {
      const draft = mkDraft({ mine: { required: [], available: [], closing: [], order: [], max_cycles: 3 } })
      expect(trackProblems(draft, 'mine').map((problem) => problem.key)).toContain('config.problem.noRequired')
      expect(broken(draft)).toBe(true)
    })

    it('flags a gate whose prover or blocks name an agent the track never runs, blocks itself, or is empty', () => {
      const track: Track = {
        required: ['alpha', 'beta'],
        available: [],
        closing: [],
        order: [],
        max_cycles: 3,
        gate: { proven_by: 'ghost', blocks: ['alpha'] },
      }
      expect(trackProblems(mkDraft({ mine: track }), 'mine').map((p) => p.key)).toContain('config.problem.gateUnknown')

      track.gate = { proven_by: 'alpha', blocks: ['ghost'] }
      expect(trackProblems(mkDraft({ mine: track }), 'mine').map((p) => p.key)).toContain('config.problem.blockUnknown')

      track.gate = { proven_by: 'alpha', blocks: ['alpha'] }
      expect(trackProblems(mkDraft({ mine: track }), 'mine').map((p) => p.key)).toContain('config.problem.gateSelfBlock')

      track.gate = { proven_by: 'alpha', blocks: [] }
      expect(trackProblems(mkDraft({ mine: track }), 'mine').map((p) => p.key)).toContain('config.problem.noBlocks')
    })

    it('flags an agent specialists: marks never, wherever the track would run it', () => {
      const track: Track = {
        required: ['alpha', 'beta'],
        available: [],
        closing: [],
        order: [],
        max_cycles: 3,
        gate: { proven_by: 'alpha', blocks: ['beta'] },
      }
      const draft = mkDraft({ mine: track }, { alpha: 'never' })
      expect(trackProblems(draft, 'mine').map((p) => p.key)).toContain('config.problem.forbidden')
    })

    it('flags a map drafted by an agent the track cannot draft, and lifts once it names one that can', () => {
      const track: Track = {
        required: ['alpha'],
        available: [],
        closing: ['docs'],
        order: [],
        max_cycles: 3,
        map: { drafted_by: 'docs' },
      }
      const draft = mkDraft({ mine: track })
      expect(trackProblems(draft, 'mine').map((p) => p.key)).toContain('config.problem.mapUnknown')
      track.map = { drafted_by: 'alpha' }
      expect(trackProblems(draft, 'mine')).toEqual([])
    })

    it('flags every one of the four order-edge refusals TrackSchema.superRefine applies', () => {
      // Unknown predecessor.
      expect(
        trackProblems(
          mkDraft({ mine: { required: ['alpha'], available: [], closing: [], max_cycles: 3, order: [{ agent: 'alpha', after: ['ghost'] }] } }),
          'mine',
        ).map((p) => p.key),
      ).toContain('config.problem.orderPredUnknown')

      // Predecessor is a closing agent, which never logs a result inside a cycle.
      expect(
        trackProblems(
          mkDraft({
            mine: { required: ['alpha'], available: [], closing: ['docs'], max_cycles: 3, order: [{ agent: 'alpha', after: ['docs'] }] },
          }),
          'mine',
        ).map((p) => p.key),
      ).toContain('config.problem.orderPredClosing')

      // The edge's own agent moved out of required/available (orphaned, but
      // still known) and then into closing.
      const orphaned: Track = {
        required: ['beta'],
        available: [],
        closing: [],
        max_cycles: 3,
        order: [{ agent: 'alpha', after: ['beta'] }],
      }
      const draft = mkDraft({ mine: orphaned })
      expect(trackProblems(draft, 'mine').map((p) => p.key)).toContain('config.problem.orderAgentUnknown')
      orphaned.closing = ['alpha']
      expect(trackProblems(draft, 'mine').map((p) => p.key)).toContain('config.problem.orderAgentClosing')

      // An edge inverting the track's own gate.
      expect(
        trackProblems(
          mkDraft({
            mine: {
              required: ['prover', 'blocked'],
              available: [],
              closing: [],
              max_cycles: 3,
              gate: { proven_by: 'prover', blocks: ['blocked'] },
              order: [{ agent: 'prover', after: ['blocked'] }],
            },
          }),
          'mine',
        ).map((p) => p.key),
      ).toContain('config.problem.orderInvertsGate')
    })

    it('flags a cycle two edges close between them', () => {
      const draft = mkDraft({
        mine: {
          required: ['alpha', 'beta'],
          available: [],
          closing: [],
          max_cycles: 3,
          order: [
            { agent: 'alpha', after: ['beta'] },
            { agent: 'beta', after: ['alpha'] },
          ],
        },
      })
      const problem = trackProblems(draft, 'mine').find((p) => p.key === 'config.problem.orderCycle')
      expect(problem?.params['path']).toBe('alpha → beta → alpha')
    })

    it("folds the gate's own precondition into the cycle check, catching a deadlock one hop past the direct edge", () => {
      // `verifier after planner`, `planner after builder`, plus the gate's own
      // fold (`builder after verifier`, since `blocks: ['builder']` waits on
      // `proven_by: 'verifier'`) — no edge here names `builder` waiting on
      // `verifier` directly; only the fold closes the loop.
      const draft = mkDraft({
        mine: {
          required: ['verifier', 'builder', 'planner'],
          available: [],
          closing: [],
          max_cycles: 3,
          gate: { proven_by: 'verifier', blocks: ['builder'] },
          order: [
            { agent: 'verifier', after: ['planner'] },
            { agent: 'planner', after: ['builder'] },
          ],
        },
      })
      const problem = trackProblems(draft, 'mine').find((p) => p.key === 'config.problem.orderCycle')
      expect(problem?.params['path']).toBe('verifier → builder → planner → verifier')
    })

    it('returns nothing for a track this model does not have, and nothing for a null model', () => {
      const draft = seedDraft(baseline())
      expect(trackProblems(draft, 'ghost')).toEqual([])
      expect(trackProblems(null, 'build')).toEqual([])
      expect(broken(null)).toBe(false)
    })
  })

  describe('edgeAfter', () => {
    it('unions every edge naming the same agent, not just the first', () => {
      const order = [
        { agent: 'alpha', after: ['beta'] },
        { agent: 'alpha', after: ['gamma'] },
      ]
      expect(edgeAfter(order, 'alpha')).toEqual(['beta', 'gamma'])
      expect(edgeAfter(order, 'ghost')).toEqual([])
    })
  })

  describe('findOrderCycle', () => {
    it('finds no cycle in an acyclic graph', () => {
      expect(findOrderCycle([{ agent: 'b', after: ['a'] }])).toBeNull()
    })

    it('names the closing path of a direct two-node cycle', () => {
      expect(
        findOrderCycle([
          { agent: 'a', after: ['b'] },
          { agent: 'b', after: ['a'] },
        ]),
      ).toEqual(['a', 'b', 'a'])
    })
  })

  describe('knownAgents', () => {
    it('collects every agent named anywhere in the draft, deduplicated and sorted, dropping an empty name', () => {
      const draft = seedDraft(
        baseline({
          specialists: { zeta: 'auto' },
          tracks: {
            mine: {
              required: ['alpha'],
              available: ['beta'],
              closing: ['gamma'],
              max_cycles: 3,
              gate: { proven_by: 'alpha', blocks: ['beta'] },
              map: { drafted_by: 'alpha' },
            },
          },
        }),
      )
      expect(knownAgents(draft)).toEqual(['alpha', 'beta', 'gamma', 'zeta'])
    })
  })

  describe('validAgent', () => {
    it('accepts the id pattern and rejects a double hyphen or a reserved name', () => {
      expect(validAgent('builder')).toBe(true)
      expect(validAgent('ui-designer')).toBe(true)
      expect(validAgent('a--b')).toBe(false)
      expect(validAgent('findings')).toBe(false)
      expect(validAgent('has space')).toBe(false)
      expect(validAgent('')).toBe(false)
    })
  })

  describe('C6: trackFieldChanges / orderEdgeChanges / trackPending', () => {
    it('names a brand-new track rather than diffing it against nothing', () => {
      const draftTrack: Track = { required: ['alpha'], available: [], closing: [], order: [], max_cycles: 3 }
      expect(trackFieldChanges(undefined, draftTrack)).toEqual([{ id: 'new', key: 'config.preview.newTrack', params: {} }])
    })

    it('names each field that differs from the baseline, and nothing that did not move', () => {
      const before: Track = { required: ['alpha'], available: [], closing: [], order: [], max_cycles: 5 }
      const after: Track = { ...before, max_cycles: 7, gate: { proven_by: 'alpha', blocks: ['beta'] } }
      expect(trackFieldChanges(before, after).map((item) => item.params['field'])).toEqual(['max_cycles', 'gate'])
    })

    it('names each order edge added and removed, as {agent, pred} pairs', () => {
      const before = { order: [{ agent: 'alpha', after: ['beta'] }] }
      const after = { order: [{ agent: 'alpha', after: ['gamma'] }] }
      const items = orderEdgeChanges(before, after)
      expect(items).toContainEqual({ id: 'add:alpha:gamma', key: 'config.preview.orderAdded', params: { agent: 'alpha', pred: 'gamma' } })
      expect(items).toContainEqual({ id: 'remove:alpha:beta', key: 'config.preview.orderRemoved', params: { agent: 'alpha', pred: 'beta' } })
      expect(items).toHaveLength(2)
    })

    it('is false only when the whole-object compare agrees, and false against itself', () => {
      const before: Track = { required: ['alpha'], available: [], closing: [], order: [], max_cycles: 5, map: { drafted_by: 'alpha' } }
      expect(trackPending(before, before)).toBe(false)
      expect(trackPending(before, { ...before, max_cycles: 6 })).toBe(true)
    })

    it("stays true across a toggle that round-trips a field's own value — `onField`'s map-enabled case deletes and reassigns `entry.map`, which moves it to the end of the track object even though every named field reads equal", () => {
      const before: Track = { required: ['alpha'], available: [], closing: [], order: [], max_cycles: 5, map: { drafted_by: 'alpha' } }
      // Same fields, same values, `map` inserted before `order`/`max_cycles`
      // instead of after — exactly what `delete entry.map; entry.map = …`
      // produces the *first* time (moved to the end), and what a second
      // round trip reaching a different position would produce here: either
      // way, insertion order — not field values — is what this test moves.
      const after: Track = { required: ['alpha'], available: [], map: { drafted_by: 'alpha' }, closing: [], order: [], max_cycles: 5 }

      expect(trackFieldChanges(before, after)).toEqual([])
      expect(trackPending(before, after)).toBe(true)
    })
  })

  describe('trackCommentLoss', () => {
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

    it("counts only the whole-line comments inside one track's own block", () => {
      expect(trackCommentLoss(raw, 'build')).toBe(2)
      expect(trackCommentLoss(raw, 'edit')).toBe(0)
    })

    it('returns null when the raw text is null, has no tracks: block, or names no such track', () => {
      expect(trackCommentLoss(null, 'build')).toBeNull()
      expect(trackCommentLoss('version: 1\n', 'build')).toBeNull()
      expect(trackCommentLoss(raw, 'ghost')).toBeNull()
    })
  })

  describe('commandRows / policyRows', () => {
    it('splits verify: into the commands it runs and everything else', () => {
      const config = baseline({ verify: { test: 'npm test', build: 'npm run build', failure_patterns: { test: ['^FAIL'] } } })
      expect(commandRows(config.verify)).toEqual([
        { key: 'verify.test', value: 'npm test' },
        { key: 'verify.lint', value: null },
        { key: 'verify.build', value: 'npm run build' },
      ])
      const policy = policyRows(config.verify)
      expect(policy.map((row) => row.key)).toEqual(['verify.timeout_ms', 'verify.lock_timeout_ms', 'verify.failure_patterns.test'])
      expect(policy.find((row) => row.key === 'verify.failure_patterns.test')?.value).toBe('^FAIL')
    })
  })
})
