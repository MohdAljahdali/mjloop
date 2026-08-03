import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The page's rules, asserted against its own source text.
 *
 * Task 12 retired `src/web/public/`, the hand-written tree this file used to
 * walk, and with it three checks the Vue compiler now makes structurally
 * impossible to violate: `data-act` no longer exists (a listener is a
 * `@click` in the same file as the markup it binds), `<template id>` cloning
 * no longer exists (SFCs compile to render functions, not `document.
 * importNode`), and there is no hand-rolled import graph to walk — an
 * unresolved specifier or an orphaned module is a Vite build failure, not a
 * silent white page. What is left is what the compiler does *not* enforce:
 * accessibility, a keyboard path for any reorder gesture, RTL, the invariants
 * a stylesheet edit could quietly undo, and — unchanged in kind, sharper in
 * consequence now that assets are hashed and emitted rather than hand-copied
 * — whether the server can actually serve everything that ships.
 */

const ENGINE = fileURLToPath(new URL('../../', import.meta.url))
const APP_DIR = path.join(ENGINE, 'src', 'web', 'app')
const STYLES_DIR = path.join(APP_DIR, 'styles')

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
const vueFiles = appFiles.filter((name) => name.endsWith('.vue'))
const styleFiles = (await walk(STYLES_DIR)).filter((name) => name.endsWith('.css'))

const source = new Map<string, string>()
for (const name of vueFiles) source.set(name, await fs.readFile(path.join(APP_DIR, name), 'utf8'))
const styleSource = new Map<string, string>()
for (const name of styleFiles) styleSource.set(name, await fs.readFile(path.join(STYLES_DIR, name), 'utf8'))

const read = (name: string): string => source.get(name) ?? ''
const readStyle = (name: string): string => styleSource.get(name) ?? ''

describe('accessibility', () => {
  it('gives every top-level view a visible heading and an unmistakable selected route', () => {
    const appVue = read('App.vue')
    // The tab nav is one `v-for` over `tabs`, so its `id`/`aria-controls` pair
    // is asserted generically rather than once per route — this is the whole
    // nav, for every route it will ever offer.
    expect(appVue).toMatch(/:id="`tab-\$\{id\}`"/)
    expect(appVue).toMatch(/:aria-controls="`panel-\$\{id\}`"/)
    expect(appVue).toMatch(/:aria-current="active === id \? 'page' : undefined"/)
    // Each route is one `panels/<Name>.vue`. Read that file directly rather
    // than search every `.vue` file for the id: `App.vue`'s own comments
    // quote `index.html:136`'s old markup verbatim, including the literal
    // string `id="panel-run"` — a substring search over every file would find
    // that comment before it ever reached `Run.vue`.
    const panelFile: Record<string, string> = {
      run: 'panels/Run.vue',
      plans: 'panels/Plans.vue',
      stories: 'panels/Stories.vue',
      features: 'panels/Features.vue',
      skills: 'panels/Skills.vue',
      evidence: 'panels/Evidence.vue',
      memory: 'panels/Memory.vue',
      config: 'panels/Config.vue',
    }
    for (const route of ['run', 'plans', 'stories', 'features', 'skills', 'evidence', 'memory', 'config']) {
      const panel = read(panelFile[route] ?? '')
      expect(panel, `${panelFile[route]} has no content`).not.toBe('')
      expect(panel).toMatch(new RegExp(`id="panel-${route}"[^>]+aria-labelledby="panel-${route}-title"`))
      expect(panel).toMatch(new RegExp(`id="panel-${route}-title"`))
    }
  })

  it('gives every control an accessible name', () => {
    // A placeholder is not a name: it is announced inconsistently and it
    // disappears the moment the user types. `aria-label`, an id that a
    // `data-i18n-label`-style translated attribute names, or a wrapping
    // `<label>` all count; a bare placeholder does not.
    for (const name of vueFiles) {
      const text = read(name)
      const controls = [...text.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((match) => ({
        tag: match[0],
        index: match.index ?? 0,
      }))
      for (const { tag, index } of controls) {
        if (/aria-label/.test(tag)) continue
        // Wrapped in a `<label>`: the nearest `<label` before this control's
        // position opens a span that has not yet been closed by a `</label>`
        // also before it.
        const before = text.slice(0, index)
        const opens = [...before.matchAll(/<label\b/g)].length
        const closes = [...before.matchAll(/<\/label>/g)].length
        expect(opens > closes, `${name}: ${tag} has no accessible name`).toBe(true)
      }
    }
  })

  it('marks the open tab and gives the nav a name', () => {
    const appVue = read('App.vue')
    expect(appVue).toMatch(/<nav class="tabs" :aria-label=/)
    // `aria-current` is bound directly off `active`, the one ref that decides
    // which tab is open.
    expect(appVue).toContain('aria-current')
  })

  it('keeps one live region for notices and one for banners', () => {
    // `NoticeFeed.vue`'s toggle button plus panel is the notice surface;
    // `Toasts.vue` is the banners' announcer. Each names its own live region
    // exactly once — a second would double-announce the same text.
    expect([...read('components/Toasts.vue').matchAll(/aria-live="polite"/g)]).toHaveLength(1)
    expect([...read('components/NoticeFeed.vue').matchAll(/aria-live="polite"/g)]).toHaveLength(0)
    // `NoticeFeed.vue` itself carries no live region — `role="status"` lives
    // on `Toasts.vue`'s root, the one place a message must interrupt without
    // the reader opening anything. The panel below it is opened by hand, so
    // announcing it too would repeat every toast a second time.
  })
})

describe('keyboard before pointer', () => {
  it('never starts a drag/pointer/mouse/touch reorder gesture without a keydown handler in the same file that also reads an arrow, Home or End key', () => {
    // C5's rule, ported. See the original's own header (git history,
    // `discipline.test.ts` before Task 12) for the precedent this narrows to:
    // nothing on this page has ever shipped a pointer-only reorder handle,
    // and this exists for the day a file reaches for one anyway.
    const reorderStart =
      /addEventListener\(\s*['"](?:dragstart|pointerdown|mousedown|touchstart)['"]|@(?:dragstart|pointerdown|mousedown|touchstart)\s*=|\.on(?:dragstart|pointerdown|mousedown|touchstart)\s*=|\bdraggable\s*=\s*["']?true\b|:draggable="true"/
    const keydown = /addEventListener\(\s*['"]keydown['"]|@keydown|\.onkeydown\s*=/
    const arrowNav = /ArrowUp|ArrowDown|ArrowLeft|ArrowRight|\bHome\b|\bEnd\b/
    const offenders = vueFiles.filter((name) => {
      const text = read(name)
      return reorderStart.test(text) && !(keydown.test(text) && arrowNav.test(text))
    })
    expect(offenders).toEqual([])
  })
})

describe('the invariants a stylesheet edit could undo', () => {
  it('keeps the terminal pinned and clipped', () => {
    // xterm parks a measuring span at `left: -9999em`; in an rtl document that
    // otherwise gives the entire page a horizontal scrollbar.
    const app = readStyle('app.css')
    expect(app).toMatch(/\.terminal\s*\{[^}]*direction:\s*ltr/)
    expect(app).toMatch(/\.terminal\s*\{[^}]*overflow:\s*hidden/)
  })

  it('keeps [hidden] winning over display', () => {
    // Every banner on this page sets a `display`, which outranks the browser's
    // own `[hidden]` rule. Without this they are permanently visible.
    expect(readStyle('app.css')).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })

  it('keeps dense chrome inside a narrow viewport', () => {
    expect(readStyle('app.css')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(readStyle('30-tabs.css')).toMatch(/\.tabs\s*\{[^}]*overflow-x:\s*auto/)
    expect(readStyle('20-rail.css')).toMatch(/\.rail\s*\{[^}]*overflow-x:\s*auto/)
    expect(readStyle('60-panels.css')).toMatch(/\.panel-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(readStyle('20-rail.css')).toMatch(/\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*auto\)\s*minmax\(0,\s*1fr\)/)
    expect(readStyle('20-rail.css')).toMatch(/\.project\s*\{[^}]*max-width:\s*40ch/)
  })

  it('never lets a pane mode un-clip the terminal', () => {
    for (const name of styleFiles) {
      expect(readStyle(name), name).not.toMatch(/\.terminal[^{]*\{[^}]*overflow:\s*visible/)
    }
  })
})

describe('rtl', () => {
  /** Physical properties, which mirror wrongly the moment the page is Arabic. */
  const PHYSICAL =
    /(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b|(?:^|[\s;{])(?:left|right):|text-align:\s*(?:left|right)\b/

  it.each(styleFiles)('%s uses logical properties', (name) => {
    const offenders = readStyle(name)
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // An annotated exception is allowed and has to say why — the terminal pin
      // is the one place an absolute direction is the point.
      .filter(({ line }) => PHYSICAL.test(line) && !line.startsWith('/*') && !line.startsWith('*'))
      .filter(({ number }) => !annotated(readStyle(name), number))
      .map(({ number, line }) => `${name}:${number} ${line}`)
    expect(offenders).toEqual([])
  })
})

/** A `physical:` comment in the three lines above the offending declaration. */
function annotated(css: string, line: number): boolean {
  return css
    .split('\n')
    .slice(Math.max(0, line - 4), line - 1)
    .some((text) => text.includes('physical:'))
}

describe('the server can name everything it serves', () => {
  it('has a MIME type for every extension the built page actually ships', async () => {
    // Reads the already-built `dist/web/public`, the same convention
    // `layout.test.ts` uses, rather than triggering a second Vite build here:
    // `npm run build` produced it, and `verify-ship.mjs` already re-derives it
    // from source on every ship. What this test adds is running on every
    // `npm test`, not only on a release — this is what would have caught a
    // `.woff`/`.svg`/font asset landing in `dist` with no MIME entry the day
    // `assetsInlineLimit` changed or an icon font was added, long before
    // `verify-ship` ever ran.
    const dist = path.join(ENGINE, 'dist', 'web', 'public')
    const shipped = await walk(dist).catch(() => {
      throw new Error('dist/web/public is missing — run `npm run build` first')
    })
    const server = await fs.readFile(path.join(ENGINE, 'src', 'web', 'server.ts'), 'utf8')
    const known = new Set([...server.matchAll(/'(\.\w+)':/g)].map((match) => match[1] ?? ''))
    const shippedExtensions = new Set(shipped.map((name) => path.extname(name)).filter((ext) => ext !== ''))
    expect([...shippedExtensions].filter((extension) => !known.has(extension)).sort()).toEqual([])
  })
})
