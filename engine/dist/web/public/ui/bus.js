/**
 * One delegated click and one delegated submit, dispatched over `[data-act]`.
 *
 * Handlers are registered by name, never bound to a node. That is what lets the
 * reconciler move a row's DOM around — or the same template be cloned three
 * hundred times — without a listener being added, removed or leaked anywhere.
 *
 * A discipline test asserts every `data-act` in `index.html` has a registered
 * action and vice versa, so a renamed action is a failing test rather than a
 * button that silently does nothing.
 */

/** @typedef {(element: HTMLElement, event: Event) => void} Action */

/** @type {Map<string, Action>} */
const actions = new Map()

/**
 * @param {string} name
 * @param {Action} fn
 */
export function on(name, fn) {
  if (actions.has(name)) throw new Error(`duplicate action: ${name}`)
  actions.set(name, fn)
}

/** @returns {readonly string[]} */
export function registered() {
  return [...actions.keys()]
}

/**
 * @param {Event} event
 */
function dispatch(event) {
  const target = event.target
  if (!(target instanceof Element)) return
  const host = target.closest('[data-act]')
  if (!(host instanceof HTMLElement)) return
  const name = host.dataset['act']
  if (name === undefined) return
  const action = actions.get(name)
  // Unregistered is a bug in our own page, not in the input. It is left to the
  // discipline test rather than swallowed *and* re-thrown into a click handler
  // where it would only reach the console.
  if (action === undefined) return
  if (event.type === 'submit') event.preventDefault()
  action(host, event)
}

/**
 * @param {Document | HTMLElement} root
 */
export function install(root) {
  root.addEventListener('click', dispatch)
  root.addEventListener('submit', dispatch)
}
