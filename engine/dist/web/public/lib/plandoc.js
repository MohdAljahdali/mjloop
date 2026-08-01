/**
 * The open plan's document, fetched once for whoever is reading it.
 *
 * `PLAN.md`, `REVIEW.md` and the stories' acceptance and evidence are not on
 * the snapshot — they are documents, and `ManifestEntry` deliberately does not
 * carry them. One `/api/plans/:id` answers all of it, and after the split more
 * than one surface wants that answer: the plan detail, the story list, and
 * every open story tab.
 *
 * So the feed lives here rather than inside a panel. Two panels each owning one
 * would double a conditional-GET rate the design deliberately spends once, over
 * a transport with no working revalidation — `lib/api.js`'s `get()` sends no
 * `if-none-match` and the api answers `cache-control: no-store`.
 *
 * It follows **one plan's** revision key, not the whole `plans` fingerprint, so
 * a story edited in another plan no longer re-fetches this one.
 *
 * Who pumps it is the caller's problem, and it matters: `ui/render.js` skips a
 * hidden panel, so a feed ticked from a panel's `update()` goes stale exactly
 * while that panel is closed.
 */
import { feed } from './api.js'
import { activePlan } from './selection.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../read.js').PlanDetail} PlanDetail
 */

/** @type {import('./api.js').Feed<PlanDetail> | null} */
let held = null
/** @type {(() => void)[]} */
const listeners = []

/**
 * @param {() => void} onChange Called when the document or its error moved.
 * @returns {void}
 */
export function subscribe(onChange) {
  listeners.push(onChange)
}

function announce() {
  for (const listener of listeners) listener()
}

/**
 * Called once, by whoever owns the always-visible node that ticks it.
 *
 * @returns {{ update: (snapshot: Snapshot) => void }}
 */
export function mountPlanDoc() {
  // Install, so it clears: a second mount is a second page, and a listener from
  // the first one would keep drawing into DOM nobody is looking at.
  //
  // Which is why this must run BEFORE the panels that subscribe. Mounting it
  // after them unsubscribes every one, and nothing says so — the first frame
  // still draws, and the list simply stops moving.
  listeners.length = 0
  held = feed({
    dep: (state) => {
      const id = activePlan()
      if (id === null) return null
      // `?? '-'` rather than falling back to the whole fingerprint: a plan the
      // snapshot has stopped listing has no key, and following every plan's
      // instead would re-fetch a 404 on every unrelated edit.
      return `${id}:${state.revisions.plans[id] ?? '-'}`
    },
    path: () => `/api/plans/${encodeURIComponent(activePlan() ?? '')}`,
    onChange: announce,
  })
  return { update: (snapshot) => held?.update(snapshot) }
}

/**
 * The document, or null while nothing is open or the fetch is in flight.
 *
 * @returns {PlanDetail | null}
 */
export function value() {
  return held?.value() ?? null
}
