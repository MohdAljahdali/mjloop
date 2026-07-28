/**
 * The `{type:'notice'}` frames the server already sends, and the receipts for
 * the three writes.
 *
 * `queue.blocked` and `job.abandoned` had been crossing the wire since the
 * dashboard shipped, parsed in the page and dropped on the floor because there
 * was no branch for them. They land here.
 *
 * The region is `aria-live="polite"` and is never replaced — announcements come
 * from appending into a node that has been in the document since boot, which is
 * the only arrangement a screen reader reliably reads.
 */
import { clone, flag, label, phrase } from './dom.js'

/** How long a toast stays. Long enough to read a sentence, short enough not to stack. */
const LIFETIME_MS = 8000

/** @type {HTMLElement | null} */
let region = null

/** An action button's callback, keyed on the button rather than bound to it. */
const actions = new WeakMap()

/**
 * @param {HTMLElement} host
 */
export function mountToasts(host) {
  region = host
}

/**
 * @param {{ code: string, params?: Record<string, string | number> }} message
 * @param {{ code: string, run: () => void }} [action] An offered follow-up — an Undo, usually.
 */
export function toast(message, action) {
  if (region === null) return
  const { root, slots } = clone('tpl-toast')
  const body = slots['text']
  if (body !== undefined) phrase(body, message.code, message.params)
  const close = slots['dismiss']
  if (close !== undefined) label(close, 'aria-label', 'toast.dismiss')

  const button = slots['action']
  if (button !== undefined) {
    flag(button, 'hidden', action === undefined)
    if (action !== undefined) {
      phrase(button, action.code)
      actions.set(button, action.run)
    }
  }

  region.append(root)
  setTimeout(() => root.remove(), LIFETIME_MS)
}

/**
 * @param {HTMLElement} node
 */
export function dismiss(node) {
  node.closest('.toast')?.remove()
}

/**
 * @param {HTMLElement} node
 */
export function runAction(node) {
  const run = actions.get(node)
  // The toast goes away either way: the offer was for one press.
  dismiss(node)
  if (typeof run === 'function') run()
}
