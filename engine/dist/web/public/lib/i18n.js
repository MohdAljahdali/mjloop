/**
 * Every word the user reads is resolved here.
 *
 * The server sends `{ code, params }` and never prose, so a fifteenth language
 * costs one JSON file rather than an audit of `src/web/`. That only holds if
 * this module is the single place a key becomes a sentence.
 *
 * DOM-free on purpose: `lib/` is importable under vitest's `environment: 'node'`
 * with no new dependency, which is what makes the plural and bidi rules
 * testable. The one entry point that must produce nodes — `tx()` — lives in
 * `ui/dom.js` and is built out of `parts()` below.
 */

/**
 * @typedef {{ name: string, dir: 'ltr' | 'rtl' }} LocaleMeta
 * @typedef {Record<string, LocaleMeta>} LocaleRegistry
 * @typedef {Record<string, string | number>} Params
 *
 * @typedef {object} LocaleIO
 * @property {(code: string) => Promise<Record<string, string>>} load
 * @property {() => string | null} saved
 * @property {(code: string) => void} save
 * @property {() => readonly string[]} preferred
 * @property {() => string | null} forced
 */

/** @type {LocaleRegistry} */
let registry = {}
/** @type {string} */
let fallbackCode = 'en'
/** @type {LocaleIO | null} */
let io = null

/** @type {Record<string, string>} */
let strings = {}
/** @type {Record<string, string>} */
let fallbackStrings = {}
let current = 'en'

/**
 * Bumped on every locale change, and part of `phrase()`'s memo key.
 *
 * A locale switch mutates no snapshot field, so without this a memo anywhere
 * above the leaf would repaint nothing and leave a half-translated page — the
 * class of bug that survives six months in a project with no compiler watching.
 */
let epoch = 0

let numbers = new Intl.NumberFormat('en')
let plurals = new Intl.PluralRules('en')

/**
 * Injected downward rather than imported, so `lib/i18n.js` never reaches back
 * into `app.js` and there is no cycle around that file's top-level `await`.
 *
 * @param {LocaleRegistry} locales
 * @param {string} fallback
 * @param {LocaleIO} ports
 */
export function installLocales(locales, fallback, ports) {
  registry = locales
  fallbackCode = fallback
  io = ports
}

/** @returns {LocaleRegistry} */
export function locales() {
  return registry
}

/** @returns {string} */
export function locale() {
  return current
}

/** @returns {'ltr' | 'rtl'} */
export function direction() {
  return registry[current]?.dir ?? 'ltr'
}

/** @returns {number} */
export function localeEpoch() {
  return epoch
}

/**
 * The locale to open with: an explicit `?lang=`, then the remembered choice,
 * then what the browser asks for, then English.
 *
 * @returns {string}
 */
export function pickLocale() {
  if (io === null) return fallbackCode
  const forced = io.forced()
  if (forced !== null && forced in registry) return forced
  const saved = io.saved()
  if (saved !== null && saved in registry) return saved
  for (const candidate of io.preferred()) {
    const base = candidate.split('-')[0] ?? ''
    if (base in registry) return base
  }
  return fallbackCode
}

/**
 * Load the fallback dictionary. Every other locale falls back to it per key, so
 * a translation that is missing a line renders English rather than blank.
 *
 * @returns {Promise<void>}
 */
export async function loadFallback() {
  if (io === null) return
  fallbackStrings = await io.load(fallbackCode).catch(() => ({}))
}

/**
 * @param {string} code
 * @returns {Promise<void>}
 */
export async function setLocale(code) {
  if (io === null) return
  current = code in registry ? code : fallbackCode
  strings = current === fallbackCode ? fallbackStrings : await io.load(current).catch(() => ({}))
  numbers = new Intl.NumberFormat(current)
  plurals = new Intl.PluralRules(current)
  io.save(current)
  epoch += 1
}

/**
 * A parameter's rendered form.
 *
 * Numbers go through `Intl` because they are prose counts. Ids, paths, commands,
 * cycle numbers and run ids must never come through here — `Intl.NumberFormat('ar')`
 * renders Arabic-Indic digits and `P001-S02` would become `P٠٠١-S٠٢`. Those go
 * through `verbatim()`.
 *
 * @param {string | number} value
 * @returns {string}
 */
function renderParam(value) {
  return typeof value === 'number' ? numbers.format(value) : String(value)
}

/**
 * The raw template for a key, with English as the per-key fallback and the key
 * itself as the last resort — a readable identifier beats a blank line, and it
 * is what makes user-configured names (agent names, track names) safe to look
 * up without declaring every one of them.
 *
 * @param {string} key
 * @returns {string}
 */
function template(key) {
  return strings[key] ?? fallbackStrings[key] ?? key
}

/**
 * A translated string. **For attributes only** — content goes through `tx()`,
 * which wraps each hole in `<bdi>` so an English id inside an Arabic sentence
 * cannot drag the punctuation around it to the wrong end.
 *
 * @param {string} key
 * @param {Params} [params]
 * @returns {string}
 */
export function t(key, params) {
  const raw = template(key)
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name]
    return value === undefined ? whole : renderParam(value)
  })
}

/**
 * A plural, resolved against *this* language's own categories: `one`/`other`
 * for English, `zero`/`one`/`two`/`few`/`many`/`other` for Arabic. The stem is
 * the key without its category suffix.
 *
 * @param {string} stem
 * @param {number} count
 * @param {Params} [params]
 * @returns {string}
 */
export function tn(stem, count, params) {
  return t(pluralKey(stem, count), { count, ...params })
}

/**
 * The key a stem resolves to for this count in *this* language.
 *
 * Exported because content goes through `phrase()`, which memoises on a key —
 * so the category has to be chosen before the node is touched, not inside it.
 * `.other` is the last resort: every plural rule set has it.
 *
 * @param {string} stem
 * @param {number} count
 * @returns {string}
 */
export function pluralKey(stem, count) {
  const candidate = `${stem}.${plurals.select(count)}`
  return candidate in strings || candidate in fallbackStrings ? candidate : `${stem}.other`
}

/**
 * A message the server sent, as a key and its parameters.
 *
 * @param {{ code: string, params?: Params } | null | undefined} message
 * @returns {{ key: string, params: Params | undefined } | null}
 */
export function messageKey(message) {
  if (message === null || message === undefined) return null
  return { key: message.code, params: message.params }
}

/**
 * A translated string split at its `{param}` holes.
 *
 * Pure, so the bidi handling that `ui/dom.js` layers on top is testable in node
 * without a DOM. `kind` says which segments are the user's or the engine's own
 * values and therefore need isolating.
 *
 * @param {string} key
 * @param {Params} [params]
 * @returns {{ kind: 'text' | 'param', value: string }[]}
 */
export function parts(key, params) {
  const raw = template(key)
  /** @type {{ kind: 'text' | 'param', value: string }[]} */
  const out = []
  let index = 0
  for (const match of raw.matchAll(/\{(\w+)\}/g)) {
    const at = match.index
    if (at > index) out.push({ kind: 'text', value: raw.slice(index, at) })
    const name = match[1] ?? ''
    const value = params?.[name]
    // An unfilled hole renders as itself rather than vanishing: a gap in a
    // sentence is a bug report, a silently dropped one is a mystery.
    out.push(value === undefined ? { kind: 'text', value: match[0] } : { kind: 'param', value: renderParam(value) })
    index = at + match[0].length
  }
  if (index < raw.length) out.push({ kind: 'text', value: raw.slice(index) })
  return out
}

/**
 * Test seam. Production drives this module through `installLocales` + `setLocale`.
 *
 * @param {{ code: string, strings: Record<string, string>, fallback?: Record<string, string>, registry?: LocaleRegistry }} input
 */
export function installForTest(input) {
  registry = input.registry ?? { en: { name: 'English', dir: 'ltr' }, ar: { name: 'العربية', dir: 'rtl' } }
  current = input.code
  strings = input.strings
  fallbackStrings = input.fallback ?? input.strings
  numbers = new Intl.NumberFormat(input.code)
  plurals = new Intl.PluralRules(input.code)
  epoch += 1
}
