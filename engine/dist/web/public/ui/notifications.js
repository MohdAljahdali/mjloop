/**
 * A persistent notification surface, built only from what the page already
 * receives.
 *
 * `ui/toasts.js`'s region is ephemeral by design — eight seconds, gone, no
 * history — and a refusal receipt (`{id, ok, code}`) has no room to name its
 * subject even while it is on screen, so with several story tabs open there
 * was nowhere to look back at "what just happened". This is that surface: a
 * bounded, in-memory list of every notice this session has shown, opened from
 * a toggle beside the rail, with an unread count on it. It survives a tab
 * change — the list lives in module state, not inside a hidden panel's own
 * DOM — but **not** a reload: nothing here is written to disk, and
 * `notice.hint` says so rather than letting a reader assume more than that.
 *
 * `notify()` is the single door: every existing call site that used to call
 * `ui/toasts.js`'s `toast()` directly — a write's receipt, the two
 * `{type:'notice'}` frames the queue sends — now calls this instead, so the
 * ephemeral toast and the durable log can never disagree about what was
 * shown. `drawNoticeFeed()` adds a third source, `lib/notifications.js`'s
 * `deriveEvents()`, for the snapshot transitions neither a toast nor a
 * receipt was ever wired to announce — a story finishing, a plan completing,
 * config becoming unreadable, a cycle or a verification failing.
 *
 * The panel itself carries no `aria-live` region of its own:
 * `discipline.test.ts` fixes the page at exactly two (the banners and the
 * toasts), and a third would mean a screen reader hearing the same sentence
 * announced twice — once from the toast the instant it happens, again from a
 * log a reader only opens deliberately. The toast keeps doing the announcing;
 * this panel is a silent list.
 */
import { toast } from './toasts.js'
import { clone, flag, label, phrase, verbatim } from './dom.js'
import { reconcile } from './list.js'
import { stamp } from '../lib/fmt.js'
import { pluralKey } from '../lib/i18n.js'
import { deriveEvents } from '../lib/notifications.js'

/** @typedef {import('../../protocol.js').Snapshot} Snapshot */
/** @typedef {{ code: string, params?: Record<string, string | number> }} Message */
/** @typedef {{ id: string, code: string, params?: Record<string, string | number>, at: string }} Entry */

/**
 * How many entries the log keeps. Well above `reconcile`'s own 200-row draw
 * cap, deliberately: a store that could never exceed the cap would make the
 * "show more" tell it drives untestable in practice, the same reason the
 * Plan Evidence and Plan Memory fixtures upstream of this commit each seed
 * past 200 rather than up to it.
 */
const HISTORY_MAX = 300

/** @type {Entry[]} */
let history = []
let counter = 0
let unread = 0
let isOpen = false

/** @type {Snapshot | null} */
let previous = null

/** @type {Record<string, HTMLElement>} */
let node = {}

/**
 * A mount starts fresh — a new page load has shown nothing yet, and a test
 * that mounts a second time must not inherit the first mount's history. The
 * production call site (`app.js`) mounts exactly once at boot, so this is a
 * no-op there; it is load-bearing for the suite, where a module stays
 * imported once across every `it()` in a file.
 *
 * @param {Record<string, HTMLElement>} slots
 */
export function mountNotifications(slots) {
  node = slots
  history = []
  counter = 0
  unread = 0
  isOpen = false
  previous = null
  drawBadge()
  drawList()
}

/**
 * Show the toast and log it, in one call. `params` travel through untouched —
 * `phrase()`/`tx()` interpolate a param, they never translate it, which is
 * what already lets `job.abandoned`'s `{job}` hold an arbitrary command
 * string safely.
 *
 * @param {Message} message
 * @param {{ code: string, run: () => void }} [action]
 */
export function notify(message, action) {
  toast(message, action)
  // Spread rather than a plain `params: message.params`: `exactOptionalPropertyTypes`
  // treats an explicit `undefined` as a distinct value from an absent key, and
  // `Entry['params']` is `Record<...> | undefined` only through `?`, not through
  // the value itself accepting `undefined`.
  history.push({
    id: `n${++counter}`,
    code: message.code,
    at: new Date().toISOString(),
    ...(message.params === undefined ? {} : { params: message.params }),
  })
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
  if (!isOpen) unread += 1
  drawBadge()
  if (isOpen) drawList()
}

/**
 * Diff this snapshot against the one before it and notify on whatever
 * changed. Registered against an always-visible node exactly like `app.js`'s
 * `nav` and `chrome` panels — `ui/render.js` skips a hidden one, and a feed
 * that stopped moving whenever some other tab was open would miss the very
 * thing it exists to catch.
 *
 * @param {Snapshot} snapshot
 */
export function drawNoticeFeed(snapshot) {
  for (const event of deriveEvents(previous, snapshot)) notify(event)
  previous = snapshot
}

export function toggle() {
  if (isOpen) close()
  else open()
}

export function open() {
  isOpen = true
  unread = 0
  const panel = node['panel']
  if (panel !== undefined) flag(panel, 'hidden', false)
  const toggleButton = node['toggle']
  if (toggleButton !== undefined) toggleButton.setAttribute('aria-expanded', 'true')
  drawBadge()
  drawList()
}

export function close() {
  isOpen = false
  const panel = node['panel']
  if (panel !== undefined) flag(panel, 'hidden', true)
  const toggleButton = node['toggle']
  if (toggleButton !== undefined) toggleButton.setAttribute('aria-expanded', 'false')
}

function drawBadge() {
  const badge = node['count']
  if (badge !== undefined) {
    phrase(badge, 'tabs.number', { n: unread })
    flag(badge, 'hidden', unread === 0)
  }
  const toggleButton = node['toggle']
  if (toggleButton !== undefined) {
    if (unread === 0) toggleButton.removeAttribute('title')
    // A plural family, not a flat key: Arabic has six categories, and a flat
    // `notice.unreadCount` would ship only the English singular for all of
    // them (the defect the review on B12 caught — same idiom as `tabs.readyCount`
    // and `tabs.highCount` above, fixed together for the same reason).
    else label(toggleButton, 'title', pluralKey('notice.unreadCount', unread), { count: unread })
  }
}

function drawList() {
  const list = node['list']
  if (list === undefined) return
  // Newest first: what just happened is what a reader who opens this panel
  // wants at the top, not scrolled past a session's worth of older entries.
  const items = [...history].reverse()
  const { shown, total } = reconcile(list, items, (entry) => entry.id, noticeRow)

  const empty = node['empty']
  if (empty !== undefined) flag(empty, 'hidden', total > 0)

  const more = node['more']
  if (more !== undefined) {
    if (shown < total) phrase(more, 'notice.more', { shown, total })
    flag(more, 'hidden', shown >= total)
  }
}

/** @returns {{ root: HTMLElement, update: (entry: Entry) => void }} */
function noticeRow() {
  const { root, slots } = clone('tpl-notice')
  return {
    root,
    /** @param {Entry} entry */
    update(entry) {
      const text = slots['text']
      if (text !== undefined) phrase(text, entry.code, entry.params)
      const time = slots['time']
      if (time !== undefined) verbatim(time, stamp(entry.at))
    },
  }
}
