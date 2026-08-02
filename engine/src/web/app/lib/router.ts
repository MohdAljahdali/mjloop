/**
 * Which tab is open, kept in the URL fragment.
 *
 * The tabs are anchors in a `<nav>` rather than a `role="tablist"`, so this is
 * the browser's own navigation and back/forward move between panels. A tablist
 * would need arrow-key handling that has to honour text direction, which is a
 * real RTL bug waiting to happen for no gain.
 *
 * Ports are injected so the whole thing is node-testable; nothing here touches
 * `location` or `document` directly. There is no `go()`: navigation is what the
 * anchors already do, and a second way to change the route would be a second
 * thing to keep in step with the browser's history.
 */

export interface RouterPorts {
  hash: () => string
  setHash: (hash: string) => void
  onChange: (fn: () => void) => void
}

/**
 * Normalise a fragment to a known route.
 */
export function routeFrom(hash: string, routes: readonly string[], fallback: string): string {
  const id = hash.replace(/^#/, '')
  return routes.includes(id) ? id : fallback
}

let known: readonly string[] = []
let fallbackRoute = ''
let active = ''
let listener: (route: string) => void = () => {}

export function startRouter(
  injected: RouterPorts,
  routes: readonly string[],
  fallback: string,
  onRoute: (route: string) => void,
): void {
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
