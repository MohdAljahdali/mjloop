/**
 * The page's half of the one write door.
 *
 * Every write carries what was on record when the button was pressed, and the
 * server evaluates that inside the lock the op already takes. Three
 * consequences, and they are why this module is as small as it is:
 *
 *  - **No optimistic render, and no rollback.** The snapshot broadcast goes out
 *    before the receipt, so by the time a write receipts `ok` the page is
 *    already showing the result.
 *  - **No confirmation dialog on anything reversible.** A stale click is
 *    refused rather than obeyed, so there is nothing to protect the user from.
 *  - **Undo is safe.** An undo that arrives after the leader moved on is
 *    refused too, precisely because it is conditional as well.
 */
import { send } from '../net/socket.js'
import { toast } from './toasts.js'

/** @typedef {import('../../writes.js').Write} Write */

/** Pending writes by correlation id, so a receipt knows what it answers. */
const pending = new Map()

let counter = 0

/**
 * @param {Write} write
 * @param {{ undo?: Write }} [options] An inverse write to offer in the receipt.
 */
export function submit(write, options = {}) {
  const id = `w${++counter}`
  pending.set(id, options)
  send({ type: 'write', id, write })
}

/**
 * @param {{ id: string, ok: boolean, code: string }} receipt
 */
export function settle(receipt) {
  const held = pending.get(receipt.id)
  pending.delete(receipt.id)

  if (!receipt.ok) {
    // A refusal is worth saying out loud: the user pressed something and it did
    // not happen, and the reason is that the world moved underneath them.
    toast({ code: receipt.code })
    return
  }

  const undo = held?.undo
  if (undo === undefined) {
    toast({ code: receipt.code })
    return
  }
  toast({ code: receipt.code }, { code: 'write.undo', run: () => submit(undo) })
}
