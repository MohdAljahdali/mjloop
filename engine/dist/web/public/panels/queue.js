/**
 * Queue — a second view inside the terminal pane, one click away.
 *
 * It gets no tab of its own on purpose: a queue and a plan compete for exactly
 * the same column, and the queue always loses that fight in a project with more
 * than two plans. Living beside the terminal it belongs to, it never has to.
 */
import { clone, cls, flag, label, phrase, verbatim } from '../ui/dom.js'
import { duration } from '../lib/fmt.js'
import { jobKey } from '../lib/keys.js'
import { reconcile } from '../ui/list.js'
import { register } from '../ui/render.js'

/** @typedef {import('../../protocol.js').Job} Job */

export function mountQueue() {
  const node = /** @type {HTMLElement} */ (document.getElementById('panel-queue'))
  const blocked = /** @type {HTMLElement} */ (document.getElementById('queue-blocked'))
  const empty = /** @type {HTMLElement} */ (document.getElementById('queue-empty'))
  const host = /** @type {HTMLElement} */ (document.getElementById('queue-list'))
  const more = /** @type {HTMLElement} */ (document.getElementById('queue-more'))
  const resume = /** @type {HTMLElement} */ (document.getElementById('queue-resume'))
  const clear = /** @type {HTMLElement} */ (document.getElementById('queue-clear'))

  register({
    id: 'queue',
    node,
    update(snapshot) {
      const jobs = snapshot.queue.slice().reverse()
      flag(empty, 'hidden', jobs.length > 0)
      flag(blocked, 'hidden', !snapshot.session.blocked)
      flag(resume, 'hidden', !snapshot.session.blocked)
      flag(clear, 'hidden', !snapshot.queue.some((job) => job.status === 'queued'))

      const { shown, total } = reconcile(host, jobs, jobKey, jobRow)
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'queue.more', { shown, total })
    },
  })

  /** @returns {{ root: HTMLElement, update: (job: Job) => void }} */
  function jobRow() {
    const { root, slots } = clone('tpl-job')
    return {
      root,
      update(job) {
        // The command is the user's own text on its way to a shell. Verbatim,
        // and isolated, or an Arabic UI reorders the flags in it.
        const command = slots['command']
        if (command !== undefined) verbatim(command, job.command)

        const status = slots['status']
        if (status !== undefined) {
          phrase(status, `job.status.${job.status}`)
          cls(status, 'job', job.status)
        }

        const dur = slots['duration']
        if (dur !== undefined) verbatim(dur, duration(job.startedAt, job.endedAt))

        const reason = slots['reason']
        if (reason !== undefined) {
          if (job.reason !== null) phrase(reason, job.reason.code, job.reason.params)
          flag(reason, 'hidden', job.reason === null)
        }

        // Icon-only controls, so their accessible name has to come from a
        // label rather than from the glyph.
        const cancel = slots['cancel']
        if (cancel !== undefined) {
          cancel.dataset['job'] = job.id
          label(cancel, 'aria-label', 'job.cancel')
          flag(cancel, 'hidden', job.status !== 'queued')
        }
        const attach = slots['attach']
        if (attach !== undefined) {
          attach.dataset['job'] = job.id
          label(attach, 'aria-label', 'job.view')
          flag(attach, 'hidden', job.status === 'queued')
        }
      },
    }
  }
}
