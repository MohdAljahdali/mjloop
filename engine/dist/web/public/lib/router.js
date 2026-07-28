/**
 * Which tab is open, kept in the URL fragment.
 *
 * The tabs are anchors in a `<nav>` rather than a `role="tablist"`, so this is
 * the browser's own navigation and back/forward move between panels. A tablist
 * would need arrow-key handling that has to honour text direction, which is a
 * real RTL bug waiting to happen for no gain.
 *
 * Ports are injected so the whole thing is node-testable; nothing here touches
 * `location` or `document` directly.
 */

/**
 * @typedef {object} RouterPorts
 * @property {() => string} hash
 * @property {(hash: string) => void} setHash
 * @property {(fn: () => void) => void} onChange
 */

/**
 * Normalise a fragment to a known route.
 *
 * @param {string} hash
 * @param {readonly string[]} routes
 * @param {string} fallback
 * @returns {string}
 */
export function routeFrom(hash, routes, fallback) {
  const id = hash.replace(/^#/, '')
  return routes.includes(id) ? id : fallback
}

/** @type {RouterPorts | null} */
let ports = null
/** @type {readonly string[]} */
let known = []
let fallbackRoute = ''
let active = ''
/** @type {(route: string) => void} */
let listener = () => {}

/**
 * @param {RouterPorts} injected
 * @param {readonly string[]} routes
 * @param {string} fallback
 * @param {(route: string) => void} onRoute
 */
export function startRouter(injected, routes, fallback, onRoute) {
  ports = injected
  known = routes
  fallbackRoute = fallback
  listener = onRoute

  const apply = () => {
    const next = routeFrom(injected.hash(), known, fallbackRoute)
    // Guarded so a `hashchange` that resolves to the route already open — a
    // click on the current tab, a fragment we do not recognise — does not
    // announce a navigation that did not happen.
    if (next === active) return
    active = next
    listener(next)
  }

  injected.onChange(apply)
  active = ''
  apply()
}

/** @returns {string} */
export function route() {
  return active
}

/**
 * @param {string} id
 */
export function go(id) {
  ports?.setHash(`#${routeFrom(`#${id}`, known, fallbackRoute)}`)
}
