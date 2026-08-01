/**
 * Stories — what can start now, what is left, and what is finished, for the
 * plan the reader has open.
 *
 * The split this tab exists for: a plan is read occasionally and a story is
 * watched while it runs, and one panel serving both meant the story list lived
 * three clicks inside a plan's detail. Nothing here edits a plan; nothing in
 * the Plans tab runs a story.
 *
 * The list rides the fetched plan document rather than the snapshot, because
 * `acceptance` and `evidence` live in story frontmatter and `ManifestEntry`
 * deliberately does not carry them. That document is `lib/plandoc.js`'s, shared
 * with the Plans tab and ticked from the navigation — so it stays current while
 * this panel is closed, and opening this tab costs no second fetch.
 *
 * Readiness is `lib/stories.js`'s rule, which is the engine's: the same
 * function answers the filter, the ready block, the row's disabled state and
 * the count on the navigation, so the four cannot disagree.
 */
import { attr, clone, cls, flag, label, phrase, verbatim } from '../ui/dom.js'
import { pluralKey, t } from '../lib/i18n.js'
import { feed } from '../lib/api.js'
import { runKey, storyKey } from '../lib/keys.js'
import { subscribe, value as planDoc } from '../lib/plandoc.js'
import {
  activePlan,
  activeStory,
  closeStory,
  openStories,
  openStory,
  pinStory,
  recentlyClosed,
  reopenStory,
  setStoryFilter,
  storyFilter,
} from '../lib/selection.js'
import { FILTERS, dependents, planIndex, readyIn, sift, statusIndex, unmet } from '../lib/stories.js'
import { reconcile } from '../ui/list.js'
import { mountWorktabs } from '../ui/worktabs.js'
import { draw, register } from '../ui/render.js'
import { submit } from '../ui/writes.js'

/**
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
 * @typedef {import('../../protocol.js').Job} Job
 * @typedef {import('../../read.js').PlanDetail} PlanDetail
 * @typedef {import('../../read.js').StoryDetail} StoryDetail
 * @typedef {import('../../read.js').RunSummary} RunSummary
 */

/** How many buildable stories the start block lists before it says "and n more". */
const READY_SHOWN = 6

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * The job the story pane's own control would attach to — the newest job the
 * queue holds for this story that has actually started, running or finished.
 *
 * `Job.story` survives every status a job passes through, so more than one
 * entry in one session can name the same story: a `/mjloop:build` that failed
 * and a `/mjloop:fix` that followed it both would. `JobQueue.jobs()`
 * (`engine/src/web/queue.ts:220`) returns `[...finished, ...active, ...pending]`
 * with each of those three parts oldest first, which makes the whole array a
 * rough timeline — history, then what is happening now, then what has not
 * started yet. Walking it from the end therefore answers with whichever job is
 * the newest action against this story.
 *
 * `queued` is skipped rather than treated as fair game, matching the rule
 * `panels/queue.js:181` already enforces on the identical control
 * (`flag(attach, 'hidden', group === WAITING)`): attaching to a job that has
 * not started sends `{type:'attach', jobId}` for an id `server.ts`'s
 * transcript map has no entry for, which blanks whatever the reader was
 * actually watching and, if that job is the running one's queue-mate, mislabels
 * a live run as "Reading a finished job" (`terminal.viewing`) before it has
 * produced a line.
 *
 * @param {readonly Job[]} queue
 * @param {string} storyId
 * @returns {Job | null}
 */
function jobForStory(queue, storyId) {
  // `.slice().reverse()` rather than a manual index walk: `noUncheckedIndexedAccess`
  // makes `queue[index]` an `undefined`-shadowed type the loop has to narrow
  // itself, and `queue.js`'s own `history` group already reverses this same
  // way to read newest first.
  return queue.slice().reverse().find((job) => job.story === storyId && job.status !== 'queued') ?? null
}

export function mountStories() {
  const node = pick('panel-stories')
  const none = pick('stories-none')
  const planRow = pick('stories-plan')
  const planId = pick('stories-plan-id')

  const readyBlock = pick('stories-ready')
  const readyList = pick('stories-ready-list')
  const readyMore = pick('stories-ready-more')

  const query = /** @type {HTMLInputElement} */ (document.getElementById('story-query'))
  const filterPicker = /** @type {HTMLSelectElement} */ (document.getElementById('story-filter'))
  const strip = pick('story-tabs')
  const reopenRow = pick('story-tabs-reopen')
  const openPane = pick('story-open')
  const openTitle = pick('story-open-title')
  const openStatus = pick('story-open-status')
  const openAttach = pick('story-open-attach')
  const openCommand = pick('story-open-command')
  const openMeta = pick('story-open-meta')
  const openWaits = pick('story-open-waits')
  const openFacts = pick('story-open-facts')
  const acceptDetails = pick('story-open-accept-details')
  const acceptSummary = pick('story-open-accept-summary')
  const acceptance = pick('story-open-acceptance')
  const bodyDetails = pick('story-open-body-details')
  const body = pick('story-open-body')
  const runsEmpty = pick('story-open-runs-empty')
  const runsHost = pick('story-open-runs')

  const listEmpty = pick('stories-empty')
  const host = pick('stories-list')
  const more = pick('stories-more')

  /** Uncontrolled, like every other box on this page: read on input, never written. */
  let text = ''
  let filter = storyFilter()

  for (const value of FILTERS) {
    const option = document.createElement('option')
    option.value = value
    filterPicker.append(option)
  }

  query.addEventListener('input', () => {
    text = query.value
    draw()
  })
  filterPicker.addEventListener('change', () => {
    filter = filterPicker.value
    setStoryFilter(filter)
    draw()
  })
  // Written once, at mount, for a value a person chose earlier — the case the
  // `.value=` rule is drawn around. No `update()` touches it.
  filterPicker.value = filter

  /** The open plan's own story statuses, for the dependency checks. */
  let statuses = /** @type {Map<string, string>} */ (new Map())
  /**
   * The story `--next` would pick. Held here rather than read off the row's
   * position: `update()` runs before a new row is inserted, so a row cannot ask
   * the DOM whether it is first.
   */
  let first = /** @type {string | null} */ (null)

  /**
   * Every run on disk, for the open tab's execution history.
   *
   * `RunSummary.story` is parsed out of the run *directory name*
   * (`<run_id>--<story|adhoc>--<track>`) by `readRuns` — a convention, not a
   * foreign key, which is why `drawOpen` below filters rather than joins on
   * anything the engine asserts. Fetched here rather than per open tab: one
   * feed the whole panel shares, exactly as `evidence.js` shares its own copy
   * of the same list.
   *
   * @type {import('../lib/api.js').Feed<RunSummary[]>}
   */
  const runs = feed({
    dep: (state) => `${state.revisions.runs}:${state.revisions.cycle}`,
    path: () => '/api/runs',
    onChange: () => draw(),
  })

  // The document is fetched and ticked elsewhere; this panel only reads it.
  subscribe(() => draw())

  const worktabs = mountWorktabs({
    strip,
    tabs: () => tabsFrom(planDoc()?.stories ?? []),
    active: activeStory,
    onSelect: (id) => {
      openStory(id)
      draw()
    },
  })

  register({
    id: 'stories',
    node,
    update(state) {
      runs.update(state)

      const id = activePlan()
      const view = planDoc()
      // A link to "this plan" with no plan is a control that goes nowhere.
      flag(planRow, 'hidden', id === null)
      verbatim(planId, id ?? '')

      // Read once, and defensively: the document is fetched, so between a plan
      // being chosen and its answer arriving — or if that answer is a 404 body
      // — there is no `stories` here at all.
      const stories = view?.stories ?? []

      // Two different nothings, and they read differently: no plan chosen, or a
      // plan chosen that has none.
      phrase(none, id === null ? 'story.noPlan' : 'story.planEmpty')
      flag(none, 'hidden', id !== null && stories.length > 0)

      const snapshotPlan = state.plans.find((plan) => plan.id === id) ?? null
      const buildable = snapshotPlan === null ? [] : readyIn(snapshotPlan)
      const plansOf = planIndex(state.plans)
      first = buildable[0]?.id ?? null
      flag(readyBlock, 'hidden', buildable.length === 0)
      reconcile(readyList, buildable.slice(0, READY_SHOWN), (story) => story.id, () => readyRow(plansOf))
      flag(readyMore, 'hidden', buildable.length <= READY_SHOWN)
      if (buildable.length > READY_SHOWN) {
        phrase(readyMore, 'story.readyMore', { n: buildable.length - READY_SHOWN })
      }

      // Translated here rather than at mount, so a locale switch repaints them.
      for (const option of [...filterPicker.options]) {
        phrase(option, `story.filter.${option.value === '' ? 'all' : option.value}`)
      }

      statuses = statusIndex(stories)
      const shown = sift(stories, text, filter, statuses)
      phrase(listEmpty, stories.length === 0 ? 'story.listEmpty' : 'story.noMatch')
      flag(listEmpty, 'hidden', shown.length > 0)
      const drawn = reconcile(host, shown, storyKey(id ?? ''), storyDetailRow)
      flag(more, 'hidden', drawn.shown >= drawn.total)
      if (drawn.shown < drawn.total) phrase(more, 'story.listMore', { shown: drawn.shown, total: drawn.total })

      worktabs.update()
      flag(reopenRow, 'hidden', recentlyClosed().length === 0)
      drawOpen(stories, state.queue)
    },
  })

  /**
   * The tab strip's model, from the same document the list draws.
   *
   * A tab whose story the plan no longer carries is dropped rather than drawn
   * as a stub: a story can be renamed on disk, and a tab that outlives its
   * subject is a control that opens nothing.
   *
   * @param {readonly StoryDetail[]} stories
   * @returns {import('../ui/worktabs.js').WorkTab[]}
   */
  function tabsFrom(stories) {
    const byId = new Map(stories.map((story) => [story.id, story]))
    return openStories()
      .filter((tab) => byId.has(tab.id))
      .map((tab) => {
        const story = byId.get(tab.id)
        return {
          id: tab.id,
          label: tab.id,
          pinned: tab.pinned,
          ...(story === undefined ? {} : { state: story.status }),
        }
      })
  }

  /**
   * The open tab's story, drawn from the record the page already has plus one
   * more, shared fetch: `runs` above, the same run list the Evidence tab
   * reads, filtered here to this story's own history. Beyond that, nothing is
   * shown that the engine does not already write — which is why there is
   * still no estimate, no owner and no elapsed time.
   *
   * @param {readonly StoryDetail[]} stories
   * @param {readonly Job[]} queue
   */
  function drawOpen(stories, queue) {
    const id = activeStory()
    const story = id === null ? undefined : stories.find((entry) => entry.id === id)
    flag(openPane, 'hidden', story === undefined)
    if (story === undefined) return

    verbatim(openTitle, `${story.id} — ${story.title}`)
    phrase(openStatus, `story.status.${story.status}`)
    cls(openStatus, 'status', story.status)

    // Offered only while the queue holds a job for this story that has actually
    // started — never drawn as a disabled stand-in for "nothing to show", which
    // is what turns a control into decoration, and never offered for a merely
    // `queued` job either: `jobForStory` skips those (see its own comment) for
    // the same reason `panels/queue.js:181` hides its identical control for the
    // WAITING group. Concurrency is not the question here: only one job is ever
    // the *running* one (`queue.ts:57`), but a story can still have an old
    // finished run on record, and that is worth attaching to as well.
    //
    // Deliberately a press, not a side effect of opening the tab: `job-attach`
    // sends `{type:'attach'}` and `app.js`'s handler for the reply calls
    // `showJob`, which is the one thing `followQueue` (`ui/pane.js`) treats as
    // "the reader has looked at something on purpose" — from then on a job
    // starting elsewhere leaves `shown` alone, exactly as it already does for a
    // reader who opened a finished transcript from the Queue view. Auto-attaching
    // the moment this story becomes active would make opening a tab silently
    // steal the pane from whatever the reader was actually watching; requiring
    // the press keeps that decision the reader's.
    //
    // And the honest "typing goes nowhere" note already lives on the pane
    // itself (`ui/pane.js`'s `viewing` binding, driven by `shown === running`)
    // and fires on its own the moment this attaches to anything but the live
    // job, so there is no second wording to invent here.
    const job = jobForStory(queue, story.id)
    if (job !== null) openAttach.dataset['job'] = job.id
    flag(openAttach, 'hidden', job === null)
    phrase(openAttach, 'job.view')

    // The command a press of Build actually sends — `bus.on('story-run', ...)`
    // (app.js:165-167) composes `/mjloop:build ${story}` from the same id, so
    // this is that exact string, not a guess at it. Shown unconditionally: it
    // answers "what does Run do" whether or not the story can build yet.
    verbatim(openCommand, `/mjloop:build ${story.id}`)

    // The readiness inspector. `readyIn` (`lib/stories.js`) is the rule this
    // page owes the truth to: a story builds when its own status is `todo`
    // and every dependency is `done`. So a story that cannot build right now
    // is in exactly one of four states — already done, already being built,
    // blocked, or waiting on named dependencies — and the first three reuse
    // `story.notBuildable.*`, the same wording already on the row's disabled
    // Build button, rather than a fifth. The fourth cannot be one phrase
    // honestly: each unmet dependency gets its own row below, its id through
    // `verbatim` and its own current status through `phrase`.
    const waiting = unmet(story, statuses)
    const waitingOnDeps = story.status === 'todo' && waiting.length > 0
    flag(openWaits, 'hidden', !waitingOnDeps)
    if (waitingOnDeps) {
      phrase(openMeta, 'story.waitsOn')
    } else if (story.status === 'todo') {
      phrase(openMeta, 'story.open.clear')
    } else {
      phrase(openMeta, `story.notBuildable.${story.status}`)
    }
    // Reconciled unconditionally, empty when there is nothing to wait on:
    // `reconcile` only removes a row that is missing from *this* call's list,
    // so switching from a blocked story to a ready one without this would
    // leave the previous story's rows sitting behind the `hidden` list.
    reconcile(openWaits, waitingOnDeps ? waiting : [], (id) => id, storyWaitRow)

    // Facts rather than prose, so each one is a labelled cell a reader can scan
    // and a translator can move.
    const facts = [
      { key: 'story.fact.plan', value: story.id.slice(0, 4) },
      { key: 'story.fact.dependsOn', value: story.depends_on.join(', ') || '—' },
      // The inverse of the fact above, computed rather than stored: nothing on
      // disk carries it, so it comes from `dependents()` walking this same
      // plan document rather than from a second field the engine would have
      // to keep from drifting out of step with `depends_on`.
      { key: 'story.fact.dependents', value: dependents(story.id, stories).join(', ') || '—' },
      { key: 'story.fact.ui', value: story.ui ? 'yes' : 'no' },
      { key: 'story.fact.evidence', value: story.evidence ?? '—' },
    ]
    reconcile(openFacts, facts, (fact) => fact.key, () => {
      const row = clone('tpl-fact')
      return {
        root: row.root,
        /** @param {{ key: string, value: string }} fact */
        update(fact) {
          const k = row.slots['label']
          if (k !== undefined) phrase(k, fact.key)
          const v = row.slots['value']
          if (v !== undefined) verbatim(v, fact.value)
        },
      }
    })

    flag(acceptDetails, 'hidden', story.acceptance.length === 0)
    phrase(acceptSummary, 'story.acceptance', { n: story.acceptance.length })
    reconcile(acceptance, story.acceptance, (line) => line, () => {
      const row = clone('tpl-acceptance')
      return {
        root: row.root,
        /** @param {string} line */
        update(line) {
          verbatim(row.slots['text'] ?? row.root, line)
        },
      }
    })

    // A document, not prose: `verbatim()`, exactly as `panels/plans.js` renders
    // PLAN.md — same collapsed-by-default shape, same "nothing written" tell.
    verbatim(body, story.body)
    flag(bodyDetails, 'hidden', story.body.trim().length === 0)

    // Filtered client-side against the one shared feed, on the same
    // convention-not-foreign-key `story` field the comment above `runs`
    // explains — a run whose directory names a different story, or no story
    // at all, does not belong to this list.
    const storyRuns = (runs.value() ?? []).filter((entry) => entry.story === story.id)
    phrase(runsEmpty, 'story.runs.empty')
    flag(runsEmpty, 'hidden', storyRuns.length > 0)
    reconcile(runsHost, storyRuns, (entry) => runKey(entry.id), storyRunRow)
  }

  /**
   * @param {Map<string, string>} plansOf
   * @returns {{ root: HTMLElement, update: (story: StoryView) => void }}
   */
  function readyRow(plansOf) {
    const { root, slots } = clone('tpl-ready')
    return {
      root,
      /** @param {StoryView} story */
      update(story) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, story.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, story.title)
        const plan = slots['plan']
        if (plan !== undefined) verbatim(plan, plansOf.get(story.id) ?? '')

        // The first row is what `--next` would pick, so it says so rather than
        // leaving the reader to infer an order from a list.
        const next = slots['next']
        if (next !== undefined) {
          phrase(next, 'story.nextTag')
          flag(next, 'hidden', story.id !== first)
        }

        const build = slots['build']
        if (build !== undefined) {
          build.dataset['story'] = story.id
          phrase(build, 'story.runAction')
          label(build, 'title', 'story.build')
        }
      },
    }
  }

  /**
   * @returns {{ root: HTMLElement, update: (entry: RunSummary) => void }}
   */
  function storyRunRow() {
    const { root, slots } = clone('tpl-story-run')
    return {
      root,
      /** @param {RunSummary} entry */
      update(entry) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, entry.id)
        const track = slots['track']
        if (track !== undefined) verbatim(track, entry.track ?? '—')
        const cycles = slots['cycles']
        if (cycles !== undefined) phrase(cycles, pluralKey('story.run.cycles', entry.cycles), { count: entry.cycles })

        const outcome = slots['outcome']
        if (outcome !== undefined) {
          phrase(outcome, entry.halted ? 'story.run.halted' : 'story.run.ended')
          cls(outcome, 'res', entry.halted ? 'fail' : 'pass')
        }
      },
    }
  }

  /**
   * One row of the readiness inspector: an unmet dependency's id and its own
   * current status, read off the same `statuses` index `unmet()` used to find
   * it — never a second lookup that could disagree.
   *
   * @returns {{ root: HTMLElement, update: (id: string) => void }}
   */
  function storyWaitRow() {
    const { root, slots } = clone('tpl-story-wait')
    return {
      root,
      /** @param {string} id */
      update(id) {
        const idSlot = slots['id']
        if (idSlot !== undefined) verbatim(idSlot, id)

        const statusSlot = slots['status']
        if (statusSlot !== undefined) {
          const value = statuses.get(id)
          // Absent rather than a fourth status: `unmet()`'s own doc explains
          // why an id can be missing from this plan's index — a typo, or (what
          // the engine actually refuses to let anyone write) a cross-plan
          // dependency. `story.status.*` has no member for that, so the id is
          // the only honest thing left to show.
          if (value === undefined) {
            verbatim(statusSlot, '—')
          } else {
            phrase(statusSlot, `story.status.${value}`)
            cls(statusSlot, 'status', value)
          }
        }
      },
    }
  }

  function storyDetailRow() {
    const { root, slots } = clone('tpl-story-detail')
    return {
      root,
      /** @param {StoryDetail} story */
      update(story) {
        const dot = slots['dot']
        if (dot !== undefined) cls(dot, 'status', story.status)

        const id = slots['id']
        if (id !== undefined) verbatim(id, story.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, story.title)

        // A word, not an 8px dot. The four keys for this had been in both
        // locale files since the dashboard shipped and were unreachable.
        const status = slots['status']
        if (status !== undefined) {
          phrase(status, `story.status.${story.status}`)
          cls(status, 'status', story.status)
        }

        const ui = slots['ui']
        if (ui !== undefined) {
          phrase(ui, 'story.ui')
          flag(ui, 'hidden', !story.ui)
        }

        // The way into the workspace. A word, like every other action here: the
        // id chip is a label, not a control, and a row whose only way in is
        // clicking its title is a row nobody discovers.
        const openIt = slots['open']
        if (openIt !== undefined) {
          openIt.dataset['story'] = story.id
          phrase(openIt, 'story.tab.open')
          label(openIt, 'title', 'story.tab.openTitle', { id: story.id })
        }

        const waiting = unmet(story, statuses)
        const waits = slots['waits']
        if (waits !== undefined) {
          phrase(waits, 'story.blockedBy', { ids: waiting.join(', ') })
          flag(waits, 'hidden', waiting.length === 0)
        }

        const build = slots['build']
        if (build !== undefined) {
          build.dataset['story'] = story.id
          const buildable = story.status === 'todo' && waiting.length === 0
          phrase(build, 'story.runAction')
          // Offered only where building is a thing that could happen. A `done`
          // story does not need a greyed-out Build beside it — `doing` and
          // `blocked` get Requeue, which is the action they actually have.
          flag(build, 'hidden', story.status !== 'todo')
          flag(build, 'disabled', !buildable)
          // The reason travels with the control rather than sitting in a
          // tooltip somewhere else: a disabled button with no stated cause is
          // the most common way a UI lies about what the system will accept.
          label(
            build,
            'title',
            waiting.length > 0 ? 'story.blockedBy' : buildable ? 'story.build' : `story.notBuildable.${story.status}`,
            waiting.length > 0 ? { ids: waiting.join(', ') } : undefined,
          )
        }

        // A story marked done with no evidence directory is an anomaly worth
        // saying out loud: the loop's own record of having proved it is missing.
        const anomaly = slots['anomaly']
        if (anomaly !== undefined) {
          phrase(anomaly, 'story.noEvidence')
          flag(anomaly, 'hidden', !(story.status === 'done' && story.evidence === null))
        }

        const evidence = slots['evidence']
        if (evidence !== undefined) {
          verbatim(evidence, story.evidence ?? '')
          flag(evidence, 'hidden', story.evidence === null)
        }

        // A run cancelled mid-story leaves it `doing`, which makes it invisible
        // to `--next` forever. The documented repair was a text editor.
        const requeue = slots['requeue']
        if (requeue !== undefined) {
          requeue.dataset['story'] = story.id
          requeue.dataset['from'] = story.status
          phrase(requeue, 'story.requeue')
          flag(requeue, 'hidden', story.status !== 'doing' && story.status !== 'blocked')
        }

        // Collapsed by default, and the summary counts them: acceptance criteria
        // are what you read *before* building one story, not while scanning
        // twenty-two.
        const acceptDetails = slots['acceptDetails']
        if (acceptDetails !== undefined) flag(acceptDetails, 'hidden', story.acceptance.length === 0)
        const acceptSummary = slots['acceptSummary']
        if (acceptSummary !== undefined) phrase(acceptSummary, 'story.acceptance', { n: story.acceptance.length })

        const acceptance = slots['acceptance']
        if (acceptance !== undefined) {
          reconcile(acceptance, story.acceptance, (line) => line, () => {
            const row = clone('tpl-acceptance')
            return {
              root: row.root,
              /** @param {string} line */
              update(line) {
                const cell = row.slots['text'] ?? row.root
                verbatim(cell, line)
              },
            }
          })
        }
      },
    }
  }

  return {
    /** @param {string} id */
    openTab(id) {
      openStory(id)
      draw()
    },
    /** @param {string} id */
    closeTab(id) {
      closeStory(id)
      draw()
    },
    /** @param {string} id */
    pinTab(id) {
      pinStory(id)
      draw()
    },
    reopenTab() {
      reopenStory()
      draw()
    },
    /**
     * @param {string} story
     * @param {string} from
     */
    requeue(story, from) {
      // `hidden` stops a pointer, not a programmatic activation, and a story
      // that is already `todo` has nothing to requeue. Without this a stray
      // click rewrites the story file and re-renders the manifest to say
      // exactly what they already said.
      if (from !== 'doing' && from !== 'blocked') return
      submit(
        { kind: 'story.status', story, from: /** @type {'doing' | 'blocked'} */ (from), to: 'todo' },
        // Safe to offer precisely because the undo is conditional too: one
        // arriving after the leader moved on is refused rather than clobbering.
        { undo: { kind: 'story.status', story, from: 'todo', to: /** @type {'doing'} */ (from) } },
      )
    },
  }
}
