/**
 * The two globals the page gets from `vendor/`.
 *
 * xterm ships as a classic script rather than a module — `index.html` loads it
 * with a plain `<script src>` — so it arrives as a global and there is nothing
 * for `checkJs` to resolve an import against. Declared loosely on purpose: this
 * file exists so the *rest* of the page can be checked, not to re-type a
 * dependency whose own types live in `@xterm/xterm`.
 *
 * It sits outside `public/` deliberately. Everything under `public/` is served,
 * and `verify-ship.mjs` asserts every shipped extension is a key of the
 * server's MIME map — a `.d.ts` in there would be a file the page could request
 * and the server could not name.
 */
declare const Terminal: new (options?: Record<string, unknown>) => {
  cols: number
  rows: number
  open: (host: HTMLElement) => void
  write: (data: string) => void
  reset: () => void
  loadAddon: (addon: unknown) => void
  onData: (fn: (data: string) => void) => void
}

declare const FitAddon: {
  FitAddon: new () => { fit: () => void }
}
