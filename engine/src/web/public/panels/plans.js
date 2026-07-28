/**
 * Plans — every plan, every story, and what is actually buildable.
 *
 * Readiness is computed **on the page**, by the same rule as
 * `index-render.ts:23-28`: a story is ready when it is `todo` and every id in
 * `depends_on` is `done`. The engine's own `storyNext` composes an English
 * sentence for its reason, and importing that would put server-authored prose
 * on a page whose whole i18n discipline rests on there being none.
 */
import { clone, cls, flag, label, phrase, verbatim } from '../ui/dom.js'
import { planKey, storyKey } from '../lib/keys.js'
import { reconcile } from '../ui/list.js'
import { register } from '../ui/render.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
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

export function mountPlans() {
  const node = /** @type {HTMLElement} */ (document.getElementById('panel-plans'))
  const empty = /** @type {HTMLElement} */ (document.getElementById('plans-empty'))
  const host = /** @type {HTMLElement} */ (document.getElementById('plans-list'))
  const more = /** @type {HTMLElement} */ (document.getElementById('plans-more'))

  register({
    id: 'plans',
    node,
    update(snapshot) {
      const plans = snapshot.plans
      phrase(empty, 'plans.empty')
      flag(empty, 'hidden', plans.length > 0)

      const statuses = statusIndex(plans)
      const { shown, total } = reconcile(host, plans, planKey, () => planRow(statuses))
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'plans.more', { shown, total })
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
      update(plan) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, plan.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, plan.title)

        const approval = slots['approval']
        if (approval !== undefined) {
          phrase(approval, `plans.approval.${plan.approval ?? 'none'}`)
          cls(approval, 'approval', plan.approval ?? 'none')
        }

        const done = plan.stories.filter((story) => story.status === 'done').length
        const count = slots['count']
        // A done/total count is two identifiers side by side, not a prose
        // count: `3/8` must not become `٣/٨`.
        if (count !== undefined) verbatim(count, `${done}/${plan.stories.length}`)

        const noStories = slots['empty']
        if (noStories !== undefined) {
          phrase(noStories, 'plans.storiesEmpty')
          flag(noStories, 'hidden', plan.stories.length > 0)
        }

        const stories = slots['stories']
        if (stories !== undefined) reconcile(stories, plan.stories, storyKey(plan.id), () => storyRow(statuses))
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

        // A word, not an 8px dot. The four keys for this have been in both
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
}
