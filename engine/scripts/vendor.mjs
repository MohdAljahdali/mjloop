/**
 * The browser bundles the page loads, resolved out of `node_modules` at build
 * time and copied into `dist/web/public/vendor/`.
 *
 * One definition, shared by `build.mjs` (which copies them) and
 * `verify-ship.mjs` (which checks they arrived). This is the only
 * hand-maintained asset list left: every other file the page ships is derived
 * from the source tree or walked out of the import graph.
 */
export const VENDOR = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
]

/** Just the filenames, as they appear under `vendor/`. */
export const VENDOR_FILES = VENDOR.map(([, name]) => name)
