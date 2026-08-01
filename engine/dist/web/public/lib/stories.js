/**
 * What a story is waiting on, and what that makes of the plan around it.
 *
 * The rule of record is the engine's. `ops/plan.ts`'s `storyNext` resolves
 * `--next` with it — a story can proceed while it is `todo` and every id in
 * `depends_on` is `done` — and it computes that done-set **inside one plan**.
 * This module says the same thing in the same scope, so the page cannot offer
 * a Run on a story `/mjloop:build --next` would never pick.
 *
 * The engine's own function is not imported instead, because it composes an
 * English sentence for its reason, and server-authored prose is the one thing
 * this page's i18n discipline rests on there being none of.
 *
 * A dependency reaching outside its plan cannot be written:
 * `assertDependenciesResolve` (`ops/plan.ts:239-250`) refuses one with "depends
 * on X, which does not exist in this plan". So the cross-plan case here is
 * defensive, and it resolves the honest way — an id this plan does not carry is
 * unmet, exactly as a typo is.
 *
 * DOM-free and node-testable, which is the reason it is in `lib/` rather than
 * on the panel that used to own it: two panels and the navigation badge now
 * read these numbers, and three copies of a readiness rule is three answers.
 */

/**
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
 * @typedef {import('../../read.js').StoryDetail} StoryDetail
 */

/**
 * The story filters, in the order the picker offers them.
 *
 * The first four are the vocabulary the reader actually works in — everything,
 * what can start now, what is left, what is finished. `doing` and `blocked` stay
 * behind them as the two status cuts worth having: neither is derivable from the
 * other four, and both name a state somebody is about to ask about.
 *
 * Exported and asserted exhaustive against the locale family, because until now
 * nothing did: deleting a filter's key from both locale files left every test
 * green and shipped an option labelled with its own raw key.
 */
export const FILTERS = ['', 'ready', 'remaining', 'doing', 'blocked', 'done']

/**
 * The ids this story is still waiting on: dependencies the index does not
 * report as `done`.
 *
 * An id the index does not carry counts as unmet. Within a plan that is a typo,
 * and silently treating it as satisfied would turn one into a build; across
 * plans it is an edge the engine refuses to write, and the same answer is the
 * right one for a different reason.
 *
 * @param {StoryView | StoryDetail} story
 * @param {Map<string, string>} statuses
 * @returns {string[]}
 */
export function unmet(story, statuses) {
  return story.depends_on.filter((id) => statuses.get(id) !== 'done')
}

/**
 * One plan's stories, by id.
 *
 * Takes stories rather than plans deliberately: a project-wide index is what
 * made the page disagree with the engine, and a signature that cannot express
 * one makes the disagreement unwritable rather than merely fixed.
 *
 * @param {readonly (StoryView | StoryDetail)[]} stories
 * @returns {Map<string, string>}
 */
export function statusIndex(stories) {
  /** @type {Map<string, string>} */
  const index = new Map()
  for (const story of stories) index.set(story.id, story.status)
  return index
}

/**
 * Which plan each story belongs to, so a buildable story can say where it came
 * from without the reader going to find out.
 *
 * @param {readonly PlanView[]} plans
 * @returns {Map<string, string>}
 */
export function planIndex(plans) {
  /** @type {Map<string, string>} */
  const index = new Map()
  for (const plan of plans) {
    for (const story of plan.stories) index.set(story.id, plan.id)
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
 * The stories of one plan that could be built right now.
 *
 * This is the rule; everything else counts what it returns.
 *
 * @param {PlanView} plan
 * @returns {StoryView[]}
 */
export function readyIn(plan) {
  const statuses = statusIndex(plan.stories)
  return plan.stories.filter((story) => story.status === 'todo' && unmet(story, statuses).length === 0)
}

/**
 * Every story that could be built right now, across every plan.
 *
 * @param {readonly PlanView[]} plans
 * @returns {StoryView[]}
 */
export function ready(plans) {
  return plans.flatMap(readyIn)
}

/**
 * The five numbers the tally shows. Counted over stories rather than plans:
 * "three plans" tells you nothing about how much is left.
 *
 * @param {readonly PlanView[]} plans
 * @returns {{ plans: number, ready: number, doing: number, blocked: number, done: number }}
 */
export function tally(plans) {
  const stories = plans.flatMap((plan) => plan.stories)
  /**
   * @param {string} status
   * @returns {number}
   */
  const count = (status) => stories.filter((story) => story.status === status).length
  return {
    plans: plans.length,
    ready: ready(plans).length,
    doing: count('doing'),
    blocked: count('blocked'),
    done: count('done'),
  }
}

/**
 * The stories a filter and a search box leave standing.
 *
 * `ready` is not a story status — it is a status *and* a dependency check, and
 * it is the filter people actually want. Pure and exported so it is tested
 * without a DOM.
 *
 * @template {StoryView | StoryDetail} T
 * @param {readonly T[]} stories
 * @param {string} query
 * @param {string} filter One of `FILTERS`.
 * @param {Map<string, string>} statuses
 * @returns {T[]}
 */
export function sift(stories, query, filter, statuses) {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  return stories.filter((story) => {
    if (filter === 'ready' && !(story.status === 'todo' && unmet(story, statuses).length === 0)) return false
    // Remaining is "not done", once, here — so the filter, the tally and the
    // launcher's suggestions cannot each mean something slightly different by it.
    if (filter === 'remaining' && story.status === 'done') return false
    if (filter !== '' && filter !== 'ready' && filter !== 'remaining' && story.status !== filter) return false
    if (terms.length === 0) return true
    const haystack = `${story.id} ${story.title}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
