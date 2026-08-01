/**
 * The session's own activity feed, derived rather than sourced.
 *
 * There is no `ActivityEvent` anywhere in the engine — `state.history[]`
 * covers only the run in progress and is reset by every `runStart` — so a
 * durable, cross-run notification log would need an engine-side event record
 * that does not exist yet. What this module ships instead is honest about
 * that limit: every entry it produces is read off a `Snapshot` field the page
 * already receives on every poll, compared against the `Snapshot` before it.
 * Nothing here is invented; a category the page cannot observe this way is
 * simply not one of the entries below.
 *
 * DOM-free and node-testable, the same reason `lib/stories.js` is: this is a
 * pure diff over two plain objects, and the panel that renders its output
 * (`ui/notifications.js`) is a thin, imperative wrapper around it.
 */

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {{ code: string, params?: Record<string, string | number> }} Event
 */

/**
 * One plan's own `done`-ness: every story `done`, and at least one story to
 * be done — an empty plan is not "complete", it has simply not started.
 *
 * @param {PlanView} plan
 * @returns {boolean}
 */
function isComplete(plan) {
  return plan.stories.length > 0 && plan.stories.every((story) => story.status === 'done')
}

/**
 * Whether two `last_cycle` readings name the same cycle.
 *
 * `StateSummary.last_cycle` carries no cycle number — only `{result, agents}`
 * — so identity here is structural: the same result closed by the same agent
 * set is treated as the same cycle, which is exactly the shape the poller
 * re-reads on every tick a cycle has not moved on. Two distinct cycles with
 * the same result and the same agent set would be missed; the guard this
 * function protects prefers a rare miss over spamming a toast every 1.25
 * seconds a cycle sits open, and `guards.cycleErrors` — a real per-signature
 * set, below — is what actually recurrence-checks the failures underneath.
 *
 * @param {Snapshot['state']['last_cycle']} a
 * @param {Snapshot['state']['last_cycle']} b
 * @returns {boolean}
 */
function sameCycle(a, b) {
  if (a === null || b === null) return a === b
  return a.result === b.result && a.agents.length === b.agents.length && a.agents.every((agent, i) => agent === b.agents[i])
}

/**
 * The notable events between two snapshots.
 *
 * Returns nothing on the first snapshot a session ever sees (`previous ===
 * null`): every story, plan and job on it is already however old the project
 * is, and reporting all of it as "just happened" the moment a tab opens is
 * the one behaviour this function must not have.
 *
 * @param {Snapshot | null} previous
 * @param {Snapshot} next
 * @returns {Event[]}
 */
export function deriveEvents(previous, next) {
  /** @type {Event[]} */
  const events = []
  if (previous === null) return events

  /** @type {Map<string, string>} */
  const previousStoryStatus = new Map()
  for (const plan of previous.plans) for (const story of plan.stories) previousStoryStatus.set(story.id, story.status)

  for (const plan of next.plans) {
    for (const story of plan.stories) {
      const before = previousStoryStatus.get(story.id)
      if (before === undefined || before === story.status) continue
      if (story.status === 'done') events.push({ code: 'notice.story.done', params: { id: story.id } })
      else if (story.status === 'blocked') events.push({ code: 'notice.story.blocked', params: { id: story.id } })
    }
  }

  const previousPlans = new Map(previous.plans.map((plan) => [plan.id, plan]))
  for (const plan of next.plans) {
    const before = previousPlans.get(plan.id)
    // A plan the page has not seen before, still awaiting a decision. Fires
    // when a plan id first appears on `next.plans` relative to `previous.plans`
    // — not "once, ever": `readPlans` (`snapshot.ts:112-121`) skips a plan
    // directory it fails to parse and returns the rest, so a still-undecided
    // plan whose PLAN.md momentarily fails to parse drops out of `snapshot.plans`
    // for one poll and re-enters the next with `before === undefined`, which
    // repeats this event. `gateSet` (`ops/plan.ts:137`) only ever overwrites
    // `approval` with a parsed decision and never nulls it back out, so a plan
    // already on record never re-announces for *that* reason — only the
    // transient-parse re-entry above can repeat it.
    if (before === undefined && plan.approval === null) {
      events.push({ code: 'notice.plan.awaitingApproval', params: { id: plan.id } })
    }
    // The same re-entry repeats this one too: guarded only by `before !==
    // undefined && isComplete(before)`, so a complete plan that drops out of one
    // poll (the parse failure above) and re-enters the next with `before ===
    // undefined` announces `notice.plan.done` a second time.
    if (isComplete(plan) && !(before !== undefined && isComplete(before))) {
      events.push({ code: 'notice.plan.done', params: { id: plan.id } })
    }
  }

  /** @type {Map<string, string>} */
  const previousJobStatus = new Map(previous.queue.map((job) => [job.id, job.status]))
  for (const job of next.queue) {
    if (job.status !== 'failed' || job.story === null) continue
    if (previousJobStatus.get(job.id) === 'failed') continue
    events.push({ code: 'notice.job.storyFailed', params: { id: job.story } })
  }

  if (previous.state.config_error === null && next.state.config_error !== null) {
    events.push({ code: 'notice.config.missing' })
  }

  if (next.state.last_cycle !== null && next.state.last_cycle.result === 'fail' && !sameCycle(previous.state.last_cycle, next.state.last_cycle)) {
    events.push({ code: 'notice.cycle.failed', params: { agents: next.state.last_cycle.agents.join(', ') } })
  }

  const previousErrors = new Set(previous.guards?.cycleErrors ?? [])
  for (const signature of next.guards?.cycleErrors ?? []) {
    if (!previousErrors.has(signature)) events.push({ code: 'notice.verify.failed', params: { signature } })
  }

  return events
}
