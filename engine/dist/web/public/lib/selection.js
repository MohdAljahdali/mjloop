/**
 * What the reader is looking at: which plan, and which story filter.
 *
 * Selection used to be a `let` inside whichever panel owned the screen, which
 * made it invisible to every other module and to a reload. Two workspaces read
 * it now, so it lives here, behind `lib/local.js` — per browser, not per
 * project, which is the honest scope: the engine has no notion of an active
 * plan, and inventing one would need a write kind `web/writes.ts` denies.
 *
 * Deliberately pull, not push. `ui/render.js` skips a hidden panel and
 * `ui/tabs.js`'s `showTab` ends with a `draw()`, so a panel that was closed
 * while the selection moved re-reads it on the frame it becomes visible. There
 * is nothing to subscribe to and nothing to unsubscribe from.
 *
 * No cache: `read()` is a field access on a cache `lib/local.js` already holds,
 * and a second copy here would be one more thing a test has to reset.
 */
import { read, write } from './local.js'

/**
 * The plan whose detail is open, or null.
 *
 * Null is a real answer and not an absence: a reader who closed the detail has
 * chosen to look at the list.
 *
 * @returns {string | null}
 */
export function activePlan() {
  return read().activePlan
}

/**
 * @param {string | null} id
 * @returns {void}
 */
export function setActivePlan(id) {
  if (read().activePlan === id) return
  write({ activePlan: id })
}

/**
 * The story filter, as one of `lib/stories.js`'s `FILTERS`.
 *
 * A value this page does not know shows every story rather than none — see the
 * parse branch in `lib/local.js`.
 *
 * @returns {string}
 */
export function storyFilter() {
  return read().storyFilter
}

/**
 * @param {string} filter
 * @returns {void}
 */
export function setStoryFilter(filter) {
  if (read().storyFilter === filter) return
  write({ storyFilter: filter })
}
