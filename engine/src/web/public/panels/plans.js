/**
 * Plans — every plan, every story, and what is actually buildable.
 *
 * Readiness is computed **on the page**, by the same rule as
 * `index-render.ts:23-28`: a story is ready when it is `todo` and every id in
 * `depends_on` is `done`. The engine's own `storyNext` composes an English
 * sentence for its reason, and importing that would put server-authored prose
 * on a page whose whole i18n discipline rests on there being none.
 *
 * The list rides the snapshot. The open plan's body, its review, and its
 * stories' acceptance criteria and evidence are documents, so they are fetched
 * — and they have to be: `acceptance` and `evidence` live in story frontmatter
 * and are deliberately absent from `ManifestEntry`.
 */
import { clone, cls, flag, label, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { stamp } from '../lib/fmt.js'
import { t } from '../lib/i18n.js'
import { planKey, storyKey } from '../lib/keys.js'
import { reconcile } from '../ui/list.js'
import { draw, register, snapshot as latest } from '../ui/render.js'
import { submit } from '../ui/writes.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
 * @typedef {import('../../read.js').PlanDetail} PlanDetail
 * @typedef {import('../../read.js').StoryDetail} StoryDetail
 */

/**
 * The ids this story is still waiting on: dependencies that are not `done`.
 *
 * A dependency naming a story that does not exist counts as unmet. Silently
 * treating an unknown id as satisfied would turn a typo into a build.
 *
 * @param {StoryView} story
 * @param {Map<string, string>} statuses
 * @returns {string[]}
 */
export function unmet(story, statuses) {
  return story.depends_on.filter((id) => statuses.get(id) !== 'done')
}

/**
 * @param {readonly PlanView[]} plans
 * @returns {Map<string, string>}
 */
export function statusIndex(plans) {
  /** @type {Map<string, string>} */
  const index = new Map()
  for (const plan of plans) {
    for (const story of plan.stories) index.set(story.id, story.status)
  }
  return index
}

/**
 * A plan's derived state — a pure function over exactly the stories the
 * snapshot holds, so it never needs a field the engine does not already write.
 *
 * @param {PlanView} plan
 * @returns {'empty' | 'done' | 'blocked' | 'doing' | 'todo'}
 */
export function planStatus(plan) {
  if (plan.stories.length === 0) return 'empty'
  if (plan.stories.every((story) => story.status === 'done')) return 'done'
  if (plan.stories.some((story) => story.status === 'blocked')) return 'blocked'
  if (plan.stories.some((story) => story.status === 'doing')) return 'doing'
  return 'todo'
}

/**
 * Every story that could be built right now, across every plan.
 *
 * @param {readonly PlanView[]} plans
 * @returns {StoryView[]}
 */
export function ready(plans) {
  const statuses = statusIndex(plans)
  return plans.flatMap((plan) =>
    plan.stories.filter((story) => story.status === 'todo' && unmet(story, statuses).length === 0),
  )
}

/** The plan whose detail is open, or null. */
let opened = /** @type {string | null} */ (null)

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountPlans() {
  const node = pick('panel-plans')
  const empty = pick('plans-empty')
  const host = pick('plans-list')
  const more = pick('plans-more')

  const readyBlock = pick('plans-ready')
  const readyList = pick('plans-ready-list')

  const detail = pick('plan-detail')
  const detailTitle = pick('plan-detail-title')
  const record = pick('plan-approval-record')
  const bodyDetails = pick('plan-body-details')
  const body = pick('plan-body')
  const reviewDetails = pick('plan-review-details')
  const review = pick('plan-review')
  const detailStories = pick('plan-detail-stories')
  const note = /** @type {HTMLInputElement} */ (document.getElementById('approve-note'))

  /** @type {import('../lib/api.js').Feed<PlanDetail>} */
  const plan = feed({
    // Only the open plan is fetched, and only while it is open. One feed rather
    // than one per row: a project with forty plans would otherwise issue forty
    // conditional GETs a second to draw four visible lines of prose.
    dep: (state) => (opened === null ? null : `${opened}:${state.revisions.plans}`),
    path: () => `/api/plans/${encodeURIComponent(opened ?? '')}`,
    onChange: () => draw(),
  })

  register({
    id: 'plans',
    node,
    update(state) {
      plan.update(state)

      const plans = state.plans
      phrase(empty, 'plans.empty')
      flag(empty, 'hidden', plans.length > 0)

      const statuses = statusIndex(plans)
      const { shown, total } = reconcile(host, plans, planKey, () => planRow(statuses))
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'plans.more', { shown, total })

      const buildable = ready(plans)
      flag(readyBlock, 'hidden', buildable.length === 0)
      reconcile(readyList, buildable, (story) => story.id, readyRow)

      drawDetail(plan.value())
    },
  })

  /**
   * @param {Map<string, string>} statuses
   * @returns {{ root: HTMLElement, update: (plan: PlanView) => void }}
   */
  function planRow(statuses) {
    const { root, slots } = clone('tpl-plan')
    return {
      root,
      update(view) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, view.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, view.title)

        const state = slots['state']
        if (state !== undefined) {
          phrase(state, `plans.state.${planStatus(view)}`)
          cls(state, 'planstate', planStatus(view))
        }

        const approval = slots['approval']
        if (approval !== undefined) {
          phrase(approval, `plans.approval.${view.approval ?? 'none'}`)
          cls(approval, 'approval', view.approval ?? 'none')
        }

        const done = view.stories.filter((story) => story.status === 'done').length
        const count = slots['count']
        // A done/total count is two identifiers side by side, not a prose
        // count: `3/8` must not become `٣/٨`.
        if (count !== undefined) verbatim(count, `${done}/${view.stories.length}`)

        const open = slots['open']
        if (open !== undefined) {
          open.dataset['plan'] = view.id
          phrase(open, opened === view.id ? 'plans.close' : 'plans.open')
        }

        const noStories = slots['empty']
        if (noStories !== undefined) {
          phrase(noStories, 'plans.storiesEmpty')
          flag(noStories, 'hidden', view.stories.length > 0)
        }

        const stories = slots['stories']
        if (stories !== undefined) reconcile(stories, view.stories, storyKey(view.id), () => storyRow(statuses))
      },
    }
  }

  /**
   * @param {Map<string, string>} statuses
   * @returns {{ root: HTMLElement, update: (story: StoryView) => void }}
   */
  function storyRow(statuses) {
    const { root, slots } = clone('tpl-story')
    return {
      root,
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
      },
    }
  }

  function readyRow() {
    const { root, slots } = clone('tpl-ready')
    return {
      root,
      /** @param {StoryView} story */
      update(story) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, story.id)
        const build = slots['build']
        if (build !== undefined) {
          build.dataset['story'] = story.id
          label(build, 'title', 'story.build')
        }
      },
    }
  }

  /** @param {PlanDetail | null} view */
  function drawDetail(view) {
    flag(detail, 'hidden', opened === null || view === null)
    if (view === null) return

    verbatim(detailTitle, `${view.id} — ${view.title}`)

    // The whole approval record, where the list shows only the decision. An
    // approval is auditable or it is a flag.
    const approval = view.approval
    if (approval === null) {
      phrase(record, 'plans.noDecision')
    } else {
      phrase(record, 'plans.decidedBy', {
        // The decision is an engine enum with a translated word for every
        // member — asserted exhaustive against `ApprovalDecisionSchema` — so it
        // renders as that word rather than as `changes_requested`.
        decision: t(`plans.approval.${approval.decision}`),
        by: approval.by,
        at: stamp(approval.at),
        note: approval.note ?? '—',
      })
    }

    verbatim(body, view.body)
    flag(bodyDetails, 'hidden', view.body.trim().length === 0)
    verbatim(review, view.review ?? '')
    // Nothing in `engine/src` reads REVIEW.md at all, so this is the only place
    // the plan-critic's verdict is ever seen again.
    flag(reviewDetails, 'hidden', view.review === null)

    reconcile(detailStories, view.stories, (story) => story.id, storyDetailRow)
  }

  function storyDetailRow() {
    const { root, slots } = clone('tpl-story-detail')
    return {
      root,
      /** @param {StoryDetail} story */
      update(story) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, story.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, story.title)
        const status = slots['status']
        if (status !== undefined) {
          phrase(status, `story.status.${story.status}`)
          cls(status, 'status', story.status)
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

        const acceptance = slots['acceptance']
        if (acceptance !== undefined) {
          reconcile(acceptance, story.acceptance, (line) => line, () => {
            const row = clone('tpl-acceptance')
            return {
              root: row.root,
              /** @param {string} line */
              update(line) {
                const text = row.slots['text'] ?? row.root
                verbatim(text, line)
              },
            }
          })
        }
      },
    }
  }

  return {
    /** @param {string} id */
    toggle(id) {
      opened = opened === id ? null : id
      draw()
    },
    /** @param {'approved' | 'rejected' | 'changes_requested'} decision */
    decide(decision) {
      const current = latest()?.plans.find((view) => view.id === opened)
      if (opened === null || current === undefined) return
      const text = note.value.trim()
      submit({
        kind: 'gate',
        plan: opened,
        // What was on record when the button was pressed. A stale click is
        // refused rather than obeyed, which is why this needs no dialog.
        from: /** @type {'approved' | 'rejected' | 'changes_requested' | null} */ (current.approval),
        to: decision,
        note: text.length === 0 ? null : text,
      })
      // A user action, not a render.
      note.value = ''
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
