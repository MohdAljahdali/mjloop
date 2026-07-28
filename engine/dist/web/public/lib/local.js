/**
 * The handful of preferences that belong to this browser rather than to the
 * project: language, terminal pane mode, the memory query.
 *
 * Storage is injected so the module is node-testable, and every read is
 * defensive — a user with storage disabled, or a value left behind by an older
 * version of the page, must get defaults rather than a broken screen.
 */

/**
 * @typedef {object} Prefs
 * @property {string | null} lang
 * @property {'collapsed' | 'docked' | 'full'} pane
 * @property {string} memoryQuery
 */

/** @type {Prefs} */
const DEFAULTS = { lang: null, pane: 'docked', memoryQuery: '' }
const PANES = ['collapsed', 'docked', 'full']
const KEY = 'mjloop.prefs'

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
