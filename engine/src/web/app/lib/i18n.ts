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

export interface LocaleMeta {
  name: string
  dir: 'ltr' | 'rtl'
}
export type LocaleRegistry = Record<string, LocaleMeta>
export type Params = Record<string, string | number>

export interface LocaleIO {
  load: (code: string) => Promise<Record<string, string>>
  saved: () => string | null
  save: (code: string) => void
  preferred: () => readonly string[]
  forced: () => string | null
}

let registry: LocaleRegistry = {}
let fallbackCode = 'en'
let io: LocaleIO | null = null

let strings: Record<string, string> = {}
let fallbackStrings: Record<string, string> = {}
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
 */
export function installLocales(locales: LocaleRegistry, fallback: string, ports: LocaleIO): void {
  registry = locales
  fallbackCode = fallback
  io = ports
}

export function locale(): string {
  return current
}

export function direction(): 'ltr' | 'rtl' {
  return registry[current]?.dir ?? 'ltr'
}

export function localeEpoch(): number {
  return epoch
}

/**
 * The locale to open with: an explicit `?lang=`, then the remembered choice,
 * then what the browser asks for, then English.
 */
export function pickLocale(): string {
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
 */
export async function loadFallback(): Promise<void> {
  if (io === null) return
  fallbackStrings = await io.load(fallbackCode).catch(() => ({}))
}

export async function setLocale(code: string): Promise<void> {
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
 * cycle numbers and run ids must never come through here — whichever digits a
 * locale's `Intl.NumberFormat` chooses (some, like `ar-EG`, print Arabic-Indic;
 * `ar` itself prints Latin on this ICU), `P001-S02` is not a count and must not
 * be reformatted digit by digit. Those go through `verbatim()`.
 *
 * The bidi reason a number is safe to pass through here at all, regardless of
 * which digits come out, is that a formatted number resolves to bidi class AN
 * (Arabic Number) rather than a strong-LTR run — it cannot drag a sentence's
 * own punctuation to the wrong end the way an id, a name or free prose can.
 * That is the line `tx()`/`Tx.vue` actually draws when deciding which holes
 * need a `<bdi>`: not "is it a number", but "can it contain a strong-LTR run".
 */
function renderParam(value: string | number): string {
  return typeof value === 'number' ? numbers.format(value) : String(value)
}

/**
 * The raw template for a key, with English as the per-key fallback and the key
 * itself as the last resort — a readable identifier beats a blank line, and it
 * is what makes user-configured names (agent names, track names) safe to look
 * up without declaring every one of them.
 */
function template(key: string): string {
  return strings[key] ?? fallbackStrings[key] ?? key
}

/**
 * Whether this page actually has a word for a key.
 *
 * `template()` falls back to the key itself, which is right for user-authored
 * names — an agent or a track called `scout` should render as `scout` rather
 * than as a blank. But it is wrong for a closed enum the page *does* translate:
 * a value the dictionary has not caught up with would render as the dotted key.
 * So a caller that wants "translate it if we have a word, otherwise show the
 * value as it came" asks here first.
 */
export function known(key: string): boolean {
  return key in strings || key in fallbackStrings
}

/**
 * A translated string. **For attributes only** — content goes through `tx()`,
 * which wraps each hole in `<bdi>` so an English id inside an Arabic sentence
 * cannot drag the punctuation around it to the wrong end.
 */
export function t(key: string, params?: Params): string {
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
 */
export function tn(stem: string, count: number, params?: Params): string {
  return t(pluralKey(stem, count), { count, ...params })
}

/**
 * The key a stem resolves to for this count in *this* language.
 *
 * Exported because content goes through `phrase()`, which memoises on a key —
 * so the category has to be chosen before the node is touched, not inside it.
 * `.other` is the last resort: every plural rule set has it.
 */
export function pluralKey(stem: string, count: number): string {
  const candidate = `${stem}.${plurals.select(count)}`
  return candidate in strings || candidate in fallbackStrings ? candidate : `${stem}.other`
}

/**
 * A translated string split at its `{param}` holes.
 *
 * Pure, so the bidi handling that `ui/dom.js` layers on top is testable in node
 * without a DOM. `kind` says which segments are the user's or the engine's own
 * values and therefore need isolating.
 */
export function parts(key: string, params?: Params): { kind: 'text' | 'param'; value: string }[] {
  const raw = template(key)
  const out: { kind: 'text' | 'param'; value: string }[] = []
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
 */
export function installForTest(input: {
  code: string
  strings: Record<string, string>
  fallback?: Record<string, string>
  registry?: LocaleRegistry
}): void {
  registry = input.registry ?? { en: { name: 'English', dir: 'ltr' }, ar: { name: 'العربية', dir: 'rtl' } }
  current = input.code
  strings = input.strings
  fallbackStrings = input.fallback ?? input.strings
  numbers = new Intl.NumberFormat(input.code)
  plurals = new Intl.PluralRules(input.code)
  epoch += 1
}
