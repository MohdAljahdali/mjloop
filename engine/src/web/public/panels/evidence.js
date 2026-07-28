/**
 * Evidence — the runs on disk.
 *
 * `snapshot.runs` has been crossing the wire since the dashboard shipped and
 * was drawn nowhere. What it carries is directory names, newest first, and that
 * is exactly what this milestone shows: outcomes, rosters and agent results are
 * bodies rather than keys, so they arrive over the read API rather than in the
 * snapshot.
 */
import { clone, flag, phrase, verbatim } from '../ui/dom.js'
import { runKey } from '../lib/keys.js'
import { reconcile } from '../ui/list.js'
import { register } from '../ui/render.js'

export function mountEvidence() {
  const node = /** @type {HTMLElement} */ (document.getElementById('panel-evidence'))
  const empty = /** @type {HTMLElement} */ (document.getElementById('evidence-empty'))
  const host = /** @type {HTMLElement} */ (document.getElementById('evidence-list'))
  const more = /** @type {HTMLElement} */ (document.getElementById('evidence-more'))

  register({
    id: 'evidence',
    node,
    update(snapshot) {
      const runs = snapshot.runs
      phrase(empty, 'evidence.empty')
      flag(empty, 'hidden', runs.length > 0)

      const { shown, total } = reconcile(host, runs, runKey, () => {
        const { root, slots } = clone('tpl-run')
        return {
          root,
          /** @param {string} run */
          update(run) {
            // A run directory name opens with a timestamp and carries the story
            // id and track. Every part of it is an identifier.
            const id = slots['id']
            if (id !== undefined) verbatim(id, run)
          },
        }
      })
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'evidence.more', { shown, total })
    },
  })
}
