/**
 * Queue — a second view inside the terminal pane, one click away.
 *
 * It gets no tab of its own on purpose: a queue and a plan compete for exactly
 * the same column, and the queue always loses that fight in a project with more
 * than two plans. Living beside the terminal it belongs to, it never has to.
 *
 * Three groups rather than one reversed stream. "What is running", "what is
 * waiting" and "what already happened" are three different questions, and the
 * single list this replaces answered them by making the reader compare status
 * words down a column. Each group also has exactly one set of controls, which is
 * what removes the old ambiguity between removing a queued job and stopping a
 * running one.
 */
import { clone, cls, flag, label, phrase, verbatim } from '../ui/dom.js'
import { duration } from '../lib/fmt.js'
import { pluralKey } from '../lib/i18n.js'
import { jobKey } from '../lib/keys.js'
import { reconcile } from '../ui/list.js'
import { register } from '../ui/render.js'

/**
 * @typedef {import('../../protocol.js').Job} Job
 * @typedef {import('../../protocol.js').SessionView} SessionView
 */

/** Which group a job belongs in. */
export const RUNNING = 'running'
export const WAITING = 'waiting'
export const HISTORY = 'history'

/**
 * Split the queue the way the panel reads it.
 *
 * History is newest first — the last thing that happened is the thing being
 * looked for. Waiting keeps the order it will actually run in, which is the
 * whole point of showing a position next to it.
 *
 * @param {readonly Job[]} jobs
 * @returns {{ running: Job[], waiting: Job[], history: Job[] }}
 */
export function split(jobs) {
  return {
    running: jobs.filter((job) => job.status === 'running'),
    waiting: jobs.filter((job) => job.status === 'queued'),
    history: jobs
      .filter((job) => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
      .slice()
      .reverse(),
  }
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountQueue() {
  const node = pick('panel-queue')
  const pause = pick('queue-blocked')
  const pauseText = pick('queue-pause-text')
  const empty = pick('queue-empty')
  const more = pick('queue-more')
  const resume = pick('queue-resume')
  const clear = pick('queue-clear')

  const groups = {
    running: { block: pick('queue-now-group'), host: pick('queue-now') },
    waiting: { block: pick('queue-waiting-group'), host: pick('queue-waiting'), title: pick('queue-waiting-title') },
    history: { block: pick('queue-history-group'), host: pick('queue-history') },
  }

  /** The live session, for the row that is running: it is what says "closing". */
  let session = /** @type {SessionView} */ ({ jobId: null, blocked: false, pausedBy: null, closing: false, stalledSince: null })
  /**
   * Where each waiting job sits in the run order. Held here rather than read off
   * the DOM: `update()` runs before the reconciler inserts a new row, so a row
   * asking its own parent for its index would answer `-1` on its first draw.
   *
   * @type {Map<string, number>}
   */
  let positions = new Map()

  register({
    id: 'queue',
    node,
    update(snapshot) {
      session = snapshot.session
      const { running, waiting, history } = split(snapshot.queue)

      flag(empty, 'hidden', snapshot.queue.length > 0)

      // The pause, and why. A stop and a failure need different sentences: one
      // asks you to read a transcript, the other asks nothing at all.
      flag(pause, 'hidden', !session.blocked)
      phrase(pauseText, session.pausedBy === 'stopped' ? 'queue.pausedStopped' : 'queue.blockedBanner')
      flag(resume, 'hidden', !session.blocked)
      flag(clear, 'hidden', waiting.length === 0)

      flag(groups.running.block, 'hidden', running.length === 0)
      reconcile(groups.running.host, running, jobKey, () => jobRow(RUNNING))

      flag(groups.waiting.block, 'hidden', waiting.length === 0)
      if (groups.waiting.title !== undefined) {
        phrase(groups.waiting.title, pluralKey('queue.waiting', waiting.length), { count: waiting.length })
      }
      positions = new Map(waiting.map((job, at) => [job.id, at + 1]))
      const drawn = reconcile(groups.waiting.host, waiting, jobKey, () => jobRow(WAITING))
      flag(more, 'hidden', drawn.shown >= drawn.total)
      if (drawn.shown < drawn.total) phrase(more, 'queue.more', { shown: drawn.shown, total: drawn.total })

      flag(groups.history.block, 'hidden', history.length === 0)
      reconcile(groups.history.host, history, jobKey, () => jobRow(HISTORY))
    },
  })

  /**
   * @param {string} group
   * @returns {{ root: HTMLElement, update: (job: Job) => void }}
   */
  function jobRow(group) {
    const { root, slots } = clone('tpl-job')
    return {
      root,
      update(job) {
        // The command is the user's own text on its way to a shell. Verbatim,
        // and isolated, or an Arabic UI reorders the flags in it.
        const command = slots['command']
        if (command !== undefined) verbatim(command, job.command)

        // Where in the queue it is, so "mine is third" needs no counting. An
        // identifier rather than a count: it is a position in a list the user is
        // looking at, and it sits beside a latin command.
        const position = slots['position']
        if (position !== undefined) {
          verbatim(position, `${positions.get(job.id) ?? ''}`)
          flag(position, 'hidden', group !== WAITING)
        }

        // A job the queue has asked to close is neither still running nor
        // finished, and showing it as `running` behind a Stop button that now
        // does nothing is what made stopping feel broken.
        const closing = group === RUNNING && session.closing
        const status = slots['status']
        if (status !== undefined) {
          phrase(status, closing ? 'queue.closing' : `job.status.${job.status}`)
          cls(status, 'job', closing ? 'closing' : job.status)
        }

        const dur = slots['duration']
        if (dur !== undefined) verbatim(dur, duration(job.startedAt, job.endedAt))

        const reason = slots['reason']
        if (reason !== undefined) {
          if (job.reason !== null) phrase(reason, job.reason.code, job.reason.params)
          flag(reason, 'hidden', job.reason === null)
        }

        // One control per row, labelled with the verb it performs. Stopping a
        // run and dropping a queued command are different acts with different
        // costs, and they used to share a `×`.
        const stop = slots['stop']
        if (stop !== undefined) {
          stop.dataset['job'] = job.id
          phrase(stop, 'job.stop')
          flag(stop, 'hidden', group !== RUNNING)
          flag(stop, 'disabled', closing)
        }
        const cancel = slots['cancel']
        if (cancel !== undefined) {
          cancel.dataset['job'] = job.id
          phrase(cancel, 'job.remove')
          label(cancel, 'title', 'job.cancel')
          flag(cancel, 'hidden', group !== WAITING)
        }
        const attach = slots['attach']
        if (attach !== undefined) {
          attach.dataset['job'] = job.id
          phrase(attach, 'job.view')
          flag(attach, 'hidden', group === WAITING)
        }
      },
    }
  }
}
