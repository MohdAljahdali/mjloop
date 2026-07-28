/**
 * A keyed reconciler that moves and removes, and never rebuilds.
 *
 * Virtual scrolling is rejected outright for the same reason `innerHTML` is: a
 * virtual scroller recycles nodes under the viewport, which is precisely the
 * node destruction this whole layer exists to prevent. Long lists cap instead,
 * with an explicit "show more".
 *
 * A reconciled host holds rows and nothing else — an empty state or a footer
 * lives in a sibling element, because this walk assumes every child is a row.
 */

/**
 * @template T
 * @typedef {{ root: HTMLElement, update: (item: T) => void }} Row
 */

/** @type {WeakMap<Element, Map<string, Row<any>>>} */
const states = new WeakMap()

/**
 * Bring `host`'s children in line with `items`.
 *
 * A list whose membership and order are unchanged performs **zero** DOM
 * mutations — there is a `MutationObserver` test that asserts exactly that.
 * `insertBefore` on a node already in position is still a move, and a move is
 * how a caret ends up somewhere else.
 *
 * @template T
 * @param {HTMLElement} host
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 * @param {(item: T) => Row<T>} factory
 * @param {number} [limit]
 * @returns {{ shown: number, total: number }}
 */
export function reconcile(host, items, keyOf, factory, limit = 200) {
  /** @type {Map<string, Row<T>>} */
  let rows = states.get(host) ?? new Map()

  const visible = items.slice(0, limit)
  /** @type {Map<string, Row<T>>} */
  const next = new Map()

  for (const item of visible) {
    const key = keyOf(item)
    const row = rows.get(key) ?? factory(item)
    row.update(item)
    next.set(key, row)
  }

  for (const [key, row] of rows) {
    if (!next.has(key)) row.root.remove()
  }

  let cursor = host.firstElementChild
  for (const row of next.values()) {
    if (cursor === row.root) {
      cursor = cursor.nextElementSibling
      continue
    }
    host.insertBefore(row.root, cursor)
  }

  states.set(host, next)
  return { shown: visible.length, total: items.length }
}

/**
 * Forget a host's rows, for a container torn down by something other than the
 * reconciler — otherwise the next pass tries to place nodes that are no longer
 * anywhere.
 *
 * @param {HTMLElement} host
 */
export function forget(host) {
  states.delete(host)
}
