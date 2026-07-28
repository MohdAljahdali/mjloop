/**
 * The terminal pane: its two views, its three modes, and which job it is showing.
 *
 * The terminal is a deliberate size rather than whatever is left over. Three
 * modes — collapsed, docked, fullscreen — are the whole mechanism, and the mode
 * lives in `body.dataset.pane` so CSS does the rest.
 */
import { attr, flag, phrase, verbatim } from './dom.js'
import { register } from './render.js'
import { pluralKey } from '../lib/i18n.js'
import { read as prefs } from '../lib/local.js'
import { pane, refit, setPane } from './terminal.js'

/** @typedef {import('../../protocol.js').Snapshot} Snapshot */

/** @type {'session' | 'queue'} */
let view = 'session'

/**
 * The job whose transcript is on screen. Not always the running one — a
 * finished transcript is worth reading, and the queue must not yank you out of
 * it the moment the next job starts.
 *
 * @type {string | null}
 */
let shown = null

/** @returns {string | null} */
export function shownJob() {
  return shown
}

/**
 * @param {string | null} jobId
 */
export function showJob(jobId) {
  shown = jobId
}

/**
 * Follow the queue, unless the user has deliberately opened a finished
 * transcript — in which case leave them where they are.
 *
 * @param {string | null} previous
 * @param {string | null} next
 */
export function followQueue(previous, next) {
  if (next !== null && next !== previous && (shown === previous || shown === null)) shown = next
}

export function mountPane() {
  const node = /** @type {HTMLElement} */ (document.getElementById('view-session-body'))
  const queueView = /** @type {HTMLElement} */ (document.getElementById('panel-queue'))
  const sessionTab = /** @type {HTMLElement} */ (document.getElementById('view-session'))
  const queueTab = /** @type {HTMLElement} */ (document.getElementById('view-queue'))
  const label = /** @type {HTMLElement} */ (document.getElementById('job-label'))
  const empty = /** @type {HTMLElement} */ (document.getElementById('terminal-empty'))
  const terminal = /** @type {HTMLElement} */ (document.getElementById('terminal'))
  const stop = /** @type {HTMLElement} */ (document.getElementById('pane-stop'))
  const viewing = /** @type {HTMLElement} */ (document.getElementById('job-viewing'))

  setPane(prefs().pane)
  applyView()

  /**
   * @param {'session' | 'queue'} next
   */
  function setView(next) {
    view = next
    applyView()
    // The terminal's box changes without a window resize when the queue view
    // covers it, and xterm goes on reporting stale columns to the pty until it
    // is told otherwise.
    refit()
  }

  function applyView() {
    const session = view === 'session'
    flag(node, 'hidden', !session)
    flag(queueView, 'hidden', session)
    attr(sessionTab, 'aria-current', session ? 'true' : null)
    attr(queueTab, 'aria-current', session ? null : 'true')
  }

  register({
    id: 'pane',
    // Registered against the pane's own head, which is never hidden: the job
    // label and the stop button must stay right even while the queue view is
    // covering the session view.
    node: /** @type {HTMLElement} */ (document.querySelector('.pane-head')),
    update(snapshot) {
      const running = snapshot.session.jobId
      flag(stop, 'hidden', running === null)
      flag(empty, 'hidden', shown !== null)
      flag(terminal, 'hidden', shown === null)

      // The queue's count lives on the pane head, not inside the queue panel:
      // that panel is hidden whenever the session view is up, and `render`
      // skips hidden panels — so a count drawn there would sit at whatever it
      // was when the queue was last looked at.
      const queued = snapshot.queue.filter((entry) => entry.status === 'queued').length
      phrase(queueTab, queued === 0 ? 'queue.tab' : pluralKey('queue.tabCount', queued), { count: queued })

      const job = snapshot.queue.find((entry) => entry.id === shown)
      verbatim(label, job?.command ?? '')

      // Typing into a finished transcript would reach whatever is running now,
      // which is not what the person reading it means. The note says so.
      phrase(viewing, 'terminal.viewing')
      flag(viewing, 'hidden', shown === null || shown === running)
    },
  })

  return {
    setView,
    /** @returns {'session' | 'queue'} */
    view: () => view,
    /** Collapsed → docked → fullscreen → collapsed. */
    cycle() {
      const order = /** @type {const} */ (['collapsed', 'docked', 'full'])
      const at = order.indexOf(pane())
      setPane(order[(at + 1) % order.length] ?? 'docked')
    },
    toggleFull() {
      setPane(pane() === 'full' ? 'docked' : 'full')
    },
  }
}
