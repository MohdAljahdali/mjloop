/**
 * The local files a built page asks the server for.
 *
 * Shared by `verify-ship.mjs`, which checks they all arrived. A hashed asset
 * name that no file answers is a blank page, and it is invisible in review
 * because the diff of a built `index.html` is one changed hash.
 */

/** @param {string} html @returns {string[]} */
export function referencedAssets(html) {
  const out = []
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const raw = match[1] ?? ''
    // Anything with a scheme, a protocol-relative host, or an inline payload is
    // not a file in the shipped tree.
    if (raw === '' || /^(?:[a-z]+:|\/\/)/i.test(raw)) continue
    out.push(raw.replace(/^\.?\//, ''))
  }
  return out
}
