import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ResultSchema, StageSchema, StatusSchema } from '../../src/schemas/state.js'
import { ApprovalDecisionSchema, StoryStatusSchema } from '../../src/schemas/plan.js'
import { WEB_CODES } from '../../src/web/codes.js'

/**
 * The guard that keeps fifteen languages maintainable.
 *
 * Without it a translation drifts silently: a key renamed in English leaves the
 * other files holding a dead one, and a page that falls back per-key looks fine
 * in testing and half-English in use. Around 200 keys stay reviewable through
 * four conventions, each enforced below — a namespace whitelist, ordered parity,
 * plural stems checked against each language's own categories, and a bidi rule.
 */
const ENGINE = fileURLToPath(new URL('../../', import.meta.url))
const PUBLIC_DIR = path.join(ENGINE, 'src', 'web', 'public')
const LOCALES_DIR = path.join(PUBLIC_DIR, 'locales')

async function readLocale(code: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) as Record<string, string>
}

const codes = (await fs.readdir(LOCALES_DIR))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))

const english = await readLocale('en')
const others = codes.filter((code) => code !== 'en')

/** `{name}` holes. A translation that drops one renders a sentence with a gap in it. */
const holes = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()

/** Every namespace a key may open with. A new one is a decision, not a typo. */
const NAMESPACES = [
  'app',
  'banner',
  'command',
  'config',
  'controls',
  'cycle',
  'error',
  'evidence',
  'findings',
  'halt',
  'job',
  'lang',
  'memory',
  'pane',
  'plans',
  'queue',
  'rail',
  'run',
  'session',
  'stage',
  'status',
  'story',
  'tabs',
  'terminal',
  'toast',
  'write',
]

const CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

/** A key with its plural category folded away, so `p.one` and `p.few` are both `p`. */
function stemOf(key: string): string {
  const at = key.lastIndexOf('.')
  return at > 0 && CATEGORIES.has(key.slice(at + 1)) ? key.slice(0, at) : key
}

/** The key order with plural variants collapsed to one entry. */
function logicalKeys(dictionary: Record<string, string>): string[] {
  const out: string[] = []
  for (const key of Object.keys(dictionary)) {
    const stem = stemOf(key)
    if (out.at(-1) !== stem) out.push(stem)
  }
  return out
}

/** Which categories a dictionary supplies for each plural stem. */
function pluralStems(dictionary: Record<string, string>): Map<string, string[]> {
  const stems = new Map<string, string[]>()
  for (const key of Object.keys(dictionary)) {
    const at = key.lastIndexOf('.')
    if (at <= 0 || !CATEGORIES.has(key.slice(at + 1))) continue
    const stem = key.slice(0, at)
    stems.set(stem, [...(stems.get(stem) ?? []), key.slice(at + 1)])
  }
  return stems
}

/* ── what the page actually asks for ──────────────────────────────────────── */

const pageFiles = await walk(PUBLIC_DIR)
const scripts = pageFiles.filter((name) => name.endsWith('.js') && !name.startsWith('vendor/'))
const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), relative)))
    else out.push(relative)
  }
  return out
}

/**
 * Every dotted string literal the page holds, plus the keys named in the
 * markup's `data-i18n*` attributes.
 *
 * Deliberately broader than "the first argument of a `phrase()` call": half the
 * keys on this page are chosen by a ternary, and a sweep that only understood
 * one call shape would quietly declare the other branch dead.
 */
const literals = new Set<string>()
/** `` `status.${state.status}` `` — a family whose members are chosen at runtime. */
const prefixes = new Set<string>()

for (const attribute of ['data-i18n', 'data-i18n-label', 'data-i18n-placeholder']) {
  for (const match of html.matchAll(new RegExp(`${attribute}="([\\w.]+)"`, 'g'))) literals.add(match[1] ?? '')
}

for (const name of scripts) {
  // Comments stripped, so a key named in prose cannot keep a dead one alive.
  const body = (await fs.readFile(path.join(PUBLIC_DIR, name), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // A write's `kind` is a wire discriminant, not a locale key, and
    // `story.status` happens to look like one.
    .replace(/kind:\s*'[\w.]+'/g, '')
  // Filtered by the namespace whitelist, which is what *defines* a locale key
  // here — otherwise `'mjloop.prefs'`, the storage key, would be demanded of
  // every translation. A typo inside a real namespace (`story.buld`) still
  // fails, because `story` is one.
  for (const match of body.matchAll(/'([a-z]\w*(?:\.[\w]+)+)'/g)) {
    const key = match[1] ?? ''
    if (NAMESPACES.includes(key.split('.')[0] ?? '')) literals.add(key)
  }
  // A plural is asked for by its stem; the categories are the language's own.
  for (const match of body.matchAll(/\b(?:tn|pluralKey)\('([\w.]+)'/g)) prefixes.add(`${match[1] ?? ''}.`)
  for (const match of body.matchAll(/`([\w.]+\.)\$\{/g)) prefixes.add(match[1] ?? '')
}

/**
 * The codes the server can emit, imported rather than grepped.
 *
 * `WebCode` is a closed union, so a call site cannot invent one: an
 * untranslated code is now a compile error, and this only has to check that
 * every declared code has a key.
 */
for (const code of WEB_CODES) literals.add(code)

const used = (key: string): boolean =>
  literals.has(key) || literals.has(stemOf(key)) || [...prefixes].some((prefix) => key.startsWith(prefix))

/* ── the tests ────────────────────────────────────────────────────────────── */

describe('locales', () => {
  it('ships english as the base', () => {
    expect(codes).toContain('en')
  })

  it.each(codes)('%s opens every key with a known namespace', async (code) => {
    const translated = await readLocale(code)
    const strays = Object.keys(translated).filter((key) => !NAMESPACES.includes(key.split('.')[0] ?? ''))
    expect(strays).toEqual([])
  })

  it.each(others)('%s carries english\'s keys in english\'s order', async (code) => {
    const translated = await readLocale(code)
    // Ordered, not sorted. Stronger than a set comparison, and it keeps a diff
    // of the two files line-aligned so a translator overwrites values in place
    // rather than hunting for the line a key moved to.
    expect(logicalKeys(translated)).toEqual(logicalKeys(english))
  })

  it.each(codes)('%s gives every plural its own language\'s categories', async (code) => {
    const translated = await readLocale(code)
    const expected = new Intl.PluralRules(code).resolvedOptions().pluralCategories
    for (const [stem, given] of pluralStems(translated)) {
      expect([...given].sort(), `${code}: ${stem}`).toEqual([...expected].sort())
    }
  })

  it.each(codes)('%s leaves nothing blank', async (code) => {
    const translated = await readLocale(code)
    const blank = Object.entries(translated)
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key)
    expect(blank).toEqual([])
  })

  it.each(others)('%s keeps every parameter', async (code) => {
    const translated = await readLocale(code)
    const dropped = Object.entries(english)
      .filter(([key, value]) => {
        const counterpart = translated[key] ?? translated[`${stemOf(key)}.other`] ?? ''
        return JSON.stringify(holes(value)) !== JSON.stringify(holes(counterpart))
      })
      .map(([key]) => key)
    expect(dropped).toEqual([])
  })

  it('marks direction wherever an rtl string embeds a latin run', async () => {
    // A bare `state.json` inside an Arabic sentence takes the punctuation next
    // to it to the wrong end. Holes are stripped first, which is what keeps the
    // rule from firing on `"{cycle} من {max}"` — a parameter's own direction is
    // handled by the `<bdi>` `tx()` wraps it in.
    const arabic = await readLocale('ar')
    const unmarked = Object.entries(arabic)
      .filter(([, value]) => {
        const bare = value.replace(/\{\w+\}/g, '')
        return /[؀-ۿ]/.test(bare) && /[A-Za-z]{2,}/.test(bare) && !/[‎‏]/.test(bare)
      })
      .map(([key]) => key)
    expect(unmarked).toEqual([])
  })

  it('covers every value the engine can produce', () => {
    // Families whose members come from an engine schema are asserted exhaustive
    // against that schema, so adding a status to `state.ts` fails here rather
    // than rendering a raw identifier on screen.
    const family = (prefix: string): string[] =>
      Object.keys(english)
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('.'))
        .map((key) => key.slice(prefix.length))
        .sort()

    expect(family('status.')).toEqual([...StatusSchema.options, 'uninitialised'].sort())
    expect(family('stage.')).toEqual([...StageSchema.options].sort())
    expect(family('cycle.result.')).toEqual([...ResultSchema.options].sort())
    expect(family('story.status.')).toEqual([...StoryStatusSchema.options].sort())
    expect(family('plans.approval.')).toEqual([...ApprovalDecisionSchema.options, 'none'].sort())
  })

  it('has a key for everything the page asks for', () => {
    // A stem counts as present when its `.other` is: that is how a plural is
    // named at the call site.
    const missing = [...literals].filter((key) => !(key in english) && !(`${key}.other` in english))
    expect(missing).toEqual([])
  })

  it('has nothing the page never asks for', () => {
    // The inverse sweep. Run against the tree this replaced it already found
    // six dead keys, so it paid for itself before it was written.
    const dead = Object.keys(english).filter((key) => !used(key))
    expect(dead).toEqual([])
  })

  it('registers every locale file in the page', async () => {
    // A file nobody registered is a translation the user cannot pick.
    const app = await fs.readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8')
    const registry = /const LOCALES = \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? ''
    const registered = [...registry.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] ?? '')
    expect(registered.sort()).toEqual(codes.sort())
    // …and the registry has to be the one the page actually installs, or the
    // grep above is reading a dead literal.
    expect(app).toContain('installLocales(LOCALES')
  })
})
