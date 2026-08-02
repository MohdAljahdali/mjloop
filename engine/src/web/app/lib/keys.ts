/**
 * Reconciler keys.
 *
 * Every one of these is server-assigned identity — never an array index. An
 * index key makes "the third row" the thing that persists, so inserting a plan
 * at the top hands row three's DOM node, its scroll position and its open
 * `<details>` to a different plan.
 */

export function jobKey(job: { id: string }): string {
  return job.id
}

export function planKey(plan: { id: string }): string {
  return plan.id
}

/**
 * Scoped by plan even though story ids already carry theirs: the key is the
 * identity of a *row in this list*, and two lists that could ever be merged
 * must not be able to collide.
 */
export function storyKey(planId: string): (story: { id: string }) => string {
  return (story) => `${planId}/${story.id}`
}

export function runKey(run: string): string {
  return run
}
