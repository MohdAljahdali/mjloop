/**
 * One draw, coalesced to a frame.
 *
 * The poller broadcasts up to 1.25 times a second and the socket can deliver a
 * queue change on top of that, so without coalescing an active run redraws more
 * often than the screen refreshes. Hidden panels are skipped entirely: four of
 * the five tabs are not on screen at any moment, and the cheapest update is the
 * one that does not run.
 */

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 *
 * @typedef {object} Panel
 * @property {string} id
 * @property {HTMLElement} node
 * @property {(snapshot: Snapshot) => void} update
 */

/** @type {Panel[]} */
const panels = []
/** @type {Snapshot | null} */
let latest = null
let queued = false

/** @type {(fn: () => void) => void} */
let schedule = (fn) => {
  requestAnimationFrame(() => fn())
}

/**
 * Test seam: a synchronous scheduler makes "one draw per call" assertable
 * without waiting on a frame.
 *
 * @param {(fn: () => void) => void} scheduler
 */
export function installScheduler(scheduler) {
  schedule = scheduler
}

/**
 * @param {Panel} panel
 */
export function register(panel) {
  panels.push(panel)
}

/** @returns {Snapshot | null} */
export function snapshot() {
  return latest
}

/**
 * Ask for a draw. Passing a snapshot replaces the one on record; passing
 * nothing repaints what is already there, which is how a locale change reaches
 * the screen without any snapshot field having moved.
 *
 * @param {Snapshot} [next]
 */
export function draw(next) {
  if (next !== undefined) latest = next
  if (queued) return
  queued = true
  schedule(flush)
}

function flush() {
  queued = false
  const current = latest
  if (current === null) return
  for (const panel of panels) {
    if (panel.node.hidden) continue
    try {
      panel.update(current)
    } catch (error) {
      // One panel throwing must not wedge the next frame, and must not take the
      // other four with it. The diagnosis goes to the console the developer
      // opened; the user gets four working tabs instead of a blank page.
      console.error(`panel ${panel.id} failed to draw`, error)
    }
  }
}
