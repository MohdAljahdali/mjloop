/**
 * Five panels, one visible.
 *
 * The links are ordinary anchors in a `<nav>`: these panels are URL-addressable
 * and back/forward should move between them. `aria-current="page"` marks the
 * open one — a `role="tablist"` would need arrow-key handling that has to
 * honour text direction, which is a real RTL bug for no gain.
 */
import { attr, flag } from './dom.js'
import { draw } from './render.js'

/** @typedef {{ id: string, link: HTMLAnchorElement, node: HTMLElement }} Tab */

/** @type {Tab[]} */
let tabs = []

/**
 * @param {readonly string[]} ids
 * @returns {readonly string[]} the ids that were found in the document
 */
export function mountTabs(ids) {
  tabs = []
  for (const id of ids) {
    const link = document.getElementById(`tab-${id}`)
    const node = document.getElementById(`panel-${id}`)
    if (link instanceof HTMLAnchorElement && node instanceof HTMLElement) tabs.push({ id, link, node })
  }
  return tabs.map((tab) => tab.id)
}

/**
 * @param {string} active
 */
export function showTab(active) {
  for (const tab of tabs) {
    const on = tab.id === active
    flag(tab.node, 'hidden', !on)
    attr(tab.link, 'aria-current', on ? 'page' : null)
  }
  // The panel that just became visible was skipped by every draw while it was
  // hidden, so it is holding whatever was on screen when it was last open.
  draw()
}
