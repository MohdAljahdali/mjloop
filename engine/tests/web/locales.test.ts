import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ResultSchema, StageSchema, StatusSchema } from '../../src/schemas/state.js'
import { ApprovalDecisionSchema, StoryStatusSchema } from '../../src/schemas/plan.js'
import { FeatureBriefStatusSchema } from '../../src/schemas/feature.js'
import { FeatureDiscoveryModeSchema, SkillUpdateModeSchema } from '../../src/schemas/config.js'
import { SkillPackageSchema } from '../../src/schemas/skill-library.js'
import { ProjectSkillAcceptanceSchema } from '../../src/schemas/skill-acceptance.js'
import { ConcurrencyDecisionSchema } from '../../src/schemas/skill-selection.js'
import { WEB_CODES } from '../../src/web/codes.js'
import { FILTERS } from '../../src/web/app/lib/stories.js'

/**
 * The guard that keeps fifteen languages maintainable.
 *
 * Without it a translation drifts silently: a key renamed in English leaves the
 * other files holding a dead one, and a page that falls back per-key looks fine
 * in testing and half-English in use. Around 200 keys stay reviewable through
 * four conventions, each enforced below — a namespace whitelist, ordered parity,
 * plural stems checked against each language's own categories, and a bidi rule.
 *
 * Task 12 retired `src/web/public/` and with it this file's own second half —
 * the "locale drift between the two shipped copies" describe block that kept
 * `app/locales` and `public/locales` byte-identical. `app/locales` is now the
 * only copy, so what is left below is only what actually reads it: the guards
 * above, repointed at `app/**` instead of `index.html`/`app.js`, and nothing
 * that compared it to a tree that no longer exists.
 */
const ENGINE = fileURLToPath(new URL('../../', import.meta.url))
const APP_DIR = path.join(ENGINE, 'src', 'web', 'app')
const LOCALES_DIR = path.join(APP_DIR, 'locales')

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
  'agents',
  'app',
  'banner',
  'command',
  'config',
  'controls',
  'cycle',
  'error',
  'evidence',
  'features',
  'findings',
  'halt',
  'job',
  'lang',
  'manifest',
  'memory',
  'notice',
  'panel',
  'pane',
  'plans',
  'preflight',
  'queue',
  'rail',
  'roster',
  'run',
  'session',
  'skills',
  'stage',
  'status',
  'story',
  'tabs',
  'telemetry',
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

const appFiles = await walk(APP_DIR)
/**
 * Every source file that can hold a translated string: every SFC template
 * (`.vue`) and every plain module (`.ts`, not `.d.ts`) — `lib/notifications.ts`
 * declares `NOTICE_CODES` as a literal string array, not inside a component,
 * and a sweep of `.vue` files alone would call every one of those eight keys
 * dead. Test files are excluded on purpose: a key a *test* asks for but no
 * shipped file does is still a dead key in production.
 */
const scripts = appFiles.filter(
  (name) => (name.endsWith('.vue') || (name.endsWith('.ts') && !name.endsWith('.d.ts'))) && !name.endsWith('.test.ts'),
)

/**
 * Every dotted string literal the page holds, plus the static half of `Tx`'s
 * own `key-name`/`:key-name` attribute — the four shapes a key is ever asked
 * for in this tree: a `t('x.y')` or `tn('x.y', …)` call (a single-quoted JS
 * string literal, which reaches into a template attribute too — Vue compiles
 * `:aria-label="t('config.remove')"` to source text that still contains the
 * literal `'config.remove'`), `<Tx key-name="x.y">` (a bare double-quoted HTML
 * attribute, not a JS string, so it needs its own pattern), and a template
 * literal whose prefix is fixed and whose tail is chosen at runtime — either
 * `` t(`status.${state.status}`) `` or `` <Tx :key-name="`features.record.${…}`"> ``,
 * both matched by the same prefix regex since Vue's compiled attribute text
 * still carries the backtick literally. A `:key-name="someVariable"` binding
 * (`toast.message.code`, `problem.key`, …) names a code chosen fully at
 * runtime — those are exactly `WebCode`/`NoticeCode` values, harvested below
 * from `WEB_CODES` and (in `notices.test.ts`) `NOTICE_CODES` instead.
 *
 * Deliberately broader than "the first argument of a `t()` call": half the
 * keys on this page are chosen by a ternary, and a sweep that only understood
 * one call shape would quietly declare the other branch dead.
 */
const literals = new Set<string>()
/** `` `status.${state.status}` `` — a family whose members are chosen at runtime. */
const prefixes = new Set<string>()

for (const name of scripts) {
  // Comments stripped, so a key named in prose cannot keep a dead one alive.
  const body = (await fs.readFile(path.join(APP_DIR, name), 'utf8'))
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
  // `<Tx key-name="x.y">` / `<Tx v-else key-name="x.y">` — a bare HTML
  // attribute, double-quoted, so the single-quote pattern above never sees
  // it. The lookbehind is whitespace, not a word boundary: `:key-name="…"`
  // (a *bound*, runtime-chosen code — `toast.message.code`, `problem.key`)
  // has a word boundary too, right after the `:`, and is deliberately not a
  // static key this sweep can — or should — resolve.
  for (const match of body.matchAll(/(?<=\s)key-name="([a-z]\w*(?:\.[\w]+)+)"/g)) literals.add(match[1] ?? '')
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
    // Not from an engine schema — from the page's own vocabulary, which is why
    // this family had no guard at all. Deleting a filter's key from BOTH locale
    // files left all 1781 tests green: `plans.js` composed the key as a template
    // literal, and the two sweeps below harvest `story.filter.` as a *prefix*,
    // so a missing member is invisible in one direction and a stale one in the
    // other. The option shipped labelled with its own raw key.
    expect(family('story.filter.')).toEqual(FILTERS.map((value) => (value === '' ? 'all' : value)).sort())
    expect(family('plans.approval.')).toEqual([...ApprovalDecisionSchema.options, 'none'].sort())

    // The four the orchestration views render. Every one of these was written
    // by hand against a schema that was not open at the time, and the update
    // policy family was wrong — `manual` and `auto`, against an enum that says
    // `auto`, `review`, `pinned` — until the page was run against a real
    // project. This is the assertion that would have said so first.
    expect(family('features.status.')).toEqual([...FeatureBriefStatusSchema.options].sort())
    expect(family('features.discovery.')).toEqual([...FeatureDiscoveryModeSchema.options].sort())
    expect(family('skills.update.')).toEqual([...SkillUpdateModeSchema.options].sort())
    expect(family('skills.state.')).toEqual([...ProjectSkillAcceptanceSchema.shape.status.options].sort())
    expect(family('skills.audit.')).toEqual([...SkillPackageSchema.shape.audit.shape.state.options].sort())
    expect(family('manifest.mode.')).toEqual([...ConcurrencyDecisionSchema.shape.mode.options].sort())
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
    // `useI18n.ts`, not `app.js`: that is where `LOCALES` and the call to
    // `installLocales` live now — `app.js` and the page it booted are gone.
    const useI18n = await fs.readFile(path.join(APP_DIR, 'composables', 'useI18n.ts'), 'utf8')
    const registry = /export const LOCALES: LocaleRegistry = \{([\s\S]*?)\n\}/.exec(useI18n)?.[1] ?? ''
    const registered = [...registry.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] ?? '')
    expect(registered.sort()).toEqual(codes.sort())
    // …and the registry has to be the one the page actually installs, or the
    // grep above is reading a dead literal.
    expect(useI18n).toContain('installLocales(LOCALES')
  })
})
