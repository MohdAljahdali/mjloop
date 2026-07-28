/**
 * The `{type:'notice'}` frames the server already sends.
 *
 * `queue.blocked` and `job.abandoned` have been crossing the wire since the
 * dashboard shipped, parsed in the page and dropped on the floor because there
 * was no branch for them. They land here.
 *
 * The region is `aria-live="polite"` and is never replaced — announcements come
 * from appending into a node that has been in the document since boot, which is
 * the only arrangement a screen reader reliably reads.
 */
import { clone, label, phrase } from './dom.js'

/** How long a toast stays. Long enough to read a sentence, short enough not to stack. */
const LIFETIME_MS = 8000

/** @type {HTMLElement | null} */
let region = null

/**
 * @param {HTMLElement} host
 */
export function mountToasts(host) {
  region = host
}

/**
 * @param {{ code: string, params?: Record<string, string | number> }} message
 */
export function toast(message) {
  if (region === null) return
  const { root, slots } = clone('tpl-toast')
  const body = slots['text']
  if (body !== undefined) phrase(body, message.code, message.params)
  const close = slots['dismiss']
  if (close !== undefined) label(close, 'aria-label', 'toast.dismiss')
  region.append(root)
  setTimeout(() => root.remove(), LIFETIME_MS)
}

/**
 * @param {HTMLElement} node
 */
export function dismiss(node) {
  node.closest('.toast')?.remove()
}
