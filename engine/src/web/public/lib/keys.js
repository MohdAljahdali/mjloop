/**
 * Reconciler keys.
 *
 * Every one of these is server-assigned identity — never an array index. An
 * index key makes "the third row" the thing that persists, so inserting a plan
 * at the top hands row three's DOM node, its scroll position and its open
 * `<details>` to a different plan.
 */

/**
 * @param {{ id: string }} job
 * @returns {string}
 */
export function jobKey(job) {
  return job.id
}

/**
 * @param {{ id: string }} plan
 * @returns {string}
 */
export function planKey(plan) {
  return plan.id
}

/**
 * Scoped by plan even though story ids already carry theirs: the key is the
 * identity of a *row in this list*, and two lists that could ever be merged
 * must not be able to collide.
 *
 * @param {string} planId
 * @returns {(story: { id: string }) => string}
 */
export function storyKey(planId) {
  return (story) => `${planId}/${story.id}`
}

/**
 * @param {string} run
 * @returns {string}
 */
export function runKey(run) {
  return run
}
