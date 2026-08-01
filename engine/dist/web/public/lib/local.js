/**
 * The handful of preferences that belong to this browser rather than to the
 * project: language, terminal pane mode, the memory query.
 *
 * Storage is injected so the module is node-testable, and every read is
 * defensive — a user with storage disabled, or a value left behind by an older
 * version of the page, must get defaults rather than a broken screen.
 */

/**
 * One open story tab.
 *
 * A record from the first version that persists it, not a bare id. Pinning and
 * reopening a closed tab both need somewhere to put a flag, and a stored shape
 * is stuck with itself: a payload written by yesterday's page is read by
 * today's, and `parse` drops what it has no branch for — silently, which is the
 * point of the whitelist and also the reason a wrong shape here is expensive.
 *
 * @typedef {object} OpenStory
 * @property {string} id
 * @property {boolean} pinned
 */

/**
 * @typedef {object} Prefs
 * @property {string | null} lang
 * @property {'collapsed' | 'docked' | 'full'} pane
 * @property {string} memoryQuery
 * @property {string | null} activePlan
 * @property {string} storyFilter
 * @property {string | null} activeStory
 * @property {readonly OpenStory[]} openStories
 * @property {readonly string[]} recentlyClosed
 */

/**
 * Collapsed on a first visit, not docked.
 *
 * The pane is 38% of the window, and on arrival there is nothing in it: the run
 * a person came to read is in `main`, above the fold, and the terminal used to
 * take more than a third of the screen to say "nothing running". It opens itself
 * the moment a job starts — `mountPane().follow()` — and once the reader has set
 * a height, that choice is what is remembered.
 *
 * @type {Prefs}
 */
const DEFAULTS = {
  lang: null,
  pane: 'collapsed',
  memoryQuery: '',
  activePlan: null,
  storyFilter: '',
  activeStory: null,
  // Frozen, because `read()` hands the cache back by reference and a caller
  // that pushed onto a default would be editing every later reader's default.
  openStories: Object.freeze([]),
  recentlyClosed: Object.freeze([]),
}
const PANES = ['collapsed', 'docked', 'full']
const KEY = 'mjloop.prefs'
/**
 * Bounds on two lists that come back from storage.
 *
 * Not tuning. A stored value is whatever was last written there, by any version
 * of this page or by hand, and both of these are rendered — an unbounded array
 * is an unbounded number of tabs to draw.
 */
const TABS_MAX = 24
const RECENT_MAX = 10

/** @type {Pick<Storage, 'getItem' | 'setItem'> | null} */
let store = null
/** @type {Prefs} */
let cache = { ...DEFAULTS }

/**
 * @param {Pick<Storage, 'getItem' | 'setItem'>} storage
 */
export function installStorage(storage) {
  store = storage
  cache = { ...DEFAULTS, ...parse(safeGet()) }
}

/** @returns {string | null} */
function safeGet() {
  try {
    return store?.getItem(KEY) ?? null
  } catch {
    return null
  }
}

/**
 * A stored value as a bag of fields, or null if it is not one.
 *
 * Written out rather than leaning on a narrowing at the call site: inside a
 * loop over `unknown[]`, the false branch of `typeof entry === 'string'`
 * narrows to `{}`, and reading `.id` off `{}` is a compile error under
 * `tsconfig.web.json`. Typing the loop `any[]` would compile and disable every
 * check below, which is the opposite of what these branches are for.
 *
 * @param {unknown} entry
 * @returns {Record<string, unknown> | null}
 */
function fields(entry) {
  return typeof entry === 'object' && entry !== null ? /** @type {Record<string, unknown>} */ (entry) : null
}

/**
 * The open story tabs, normalised.
 *
 * A bare string is read as an unpinned id rather than dropped, so a payload
 * written before tabs could be pinned upgrades in place instead of losing the
 * reader's tabs on the release that adds pinning.
 *
 * @param {unknown[]} entries
 * @returns {OpenStory[]}
 */
function tabs(entries) {
  /** @type {OpenStory[]} */
  const out = []
  const seen = new Set()
  for (const entry of entries) {
    const bag = fields(entry)
    const id = typeof entry === 'string' ? entry : typeof bag?.['id'] === 'string' ? bag['id'] : null
    if (id === null || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, pinned: bag?.['pinned'] === true })
    if (out.length === TABS_MAX) break
  }
  return out
}

/**
 * @param {string | null} raw
 * @returns {Partial<Prefs>}
 */
function parse(raw) {
  if (raw === null) return {}
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const value = /** @type {Record<string, unknown>} */ (parsed)
  /** @type {Partial<Prefs>} */
  const out = {}
  if (typeof value['lang'] === 'string') out.lang = value['lang']
  if (typeof value['pane'] === 'string' && PANES.includes(value['pane'])) {
    out.pane = /** @type {Prefs['pane']} */ (value['pane'])
  }
  if (typeof value['memoryQuery'] === 'string') out.memoryQuery = value['memoryQuery']
  if (typeof value['activePlan'] === 'string') out.activePlan = value['activePlan']
  // Not checked against `FILTERS`: importing the vocabulary here would tie a
  // storage module to a derivation module, and an unknown filter shows every
  // story rather than none — a value from a newer page degrades to "all".
  if (typeof value['storyFilter'] === 'string') out.storyFilter = value['storyFilter']
  if (typeof value['activeStory'] === 'string') out.activeStory = value['activeStory']
  if (Array.isArray(value['openStories'])) out.openStories = tabs(value['openStories'])
  if (Array.isArray(value['recentlyClosed'])) {
    out.recentlyClosed = value['recentlyClosed']
      .filter((entry) => typeof entry === 'string' && entry !== '')
      .slice(0, RECENT_MAX)
  }
  return out
}

/** @returns {Prefs} */
export function read() {
  return cache
}

/**
 * @param {Partial<Prefs>} patch
 * @returns {Prefs}
 */
export function write(patch) {
  cache = { ...cache, ...patch }
  try {
    store?.setItem(KEY, JSON.stringify(cache))
  } catch {
    // Storage disabled or full. The preference simply does not survive a
    // reload, which is not worth breaking the page over.
  }
  return cache
}
