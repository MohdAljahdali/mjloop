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
import { t } from '../lib/i18n.js'
import { storyKey } from '../lib/keys.js'
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
import { FILTERS, planIndex, readyIn, sift, statusIndex, unmet } from '../lib/stories.js'
import { reconcile } from '../ui/list.js'
import { mountWorktabs } from '../ui/worktabs.js'
import { draw, register } from '../ui/render.js'
import { submit } from '../ui/writes.js'

/**
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
 * @typedef {import('../../read.js').PlanDetail} PlanDetail
 * @typedef {import('../../read.js').StoryDetail} StoryDetail
 */

/** How many buildable stories the start block lists before it says "and n more". */
const READY_SHOWN = 6

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

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
  const openMeta = pick('story-open-meta')
  const openFacts = pick('story-open-facts')
  const acceptDetails = pick('story-open-accept-details')
  const acceptSummary = pick('story-open-accept-summary')
  const acceptance = pick('story-open-acceptance')

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
      drawOpen(stories)
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
   * The open tab's story, drawn from the record the page already has.
   *
   * Everything here comes off `/api/plans/:id`. Nothing is fetched a second
   * time for the tab, and nothing is shown that the engine does not already
   * write — which is why there is no estimate, no owner and no elapsed time.
   *
   * @param {readonly StoryDetail[]} stories
   */
  function drawOpen(stories) {
    const id = activeStory()
    const story = id === null ? undefined : stories.find((entry) => entry.id === id)
    flag(openPane, 'hidden', story === undefined)
    if (story === undefined) return

    verbatim(openTitle, `${story.id} — ${story.title}`)
    phrase(openStatus, `story.status.${story.status}`)
    cls(openStatus, 'status', story.status)

    const waiting = unmet(story, statuses)
    phrase(openMeta, waiting.length === 0 ? 'story.open.clear' : 'story.blockedBy', {
      ids: waiting.join(', '),
    })

    // Facts rather than prose, so each one is a labelled cell a reader can scan
    // and a translator can move.
    const facts = [
      { key: 'story.fact.plan', value: story.id.slice(0, 4) },
      { key: 'story.fact.dependsOn', value: story.depends_on.join(', ') || '—' },
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
