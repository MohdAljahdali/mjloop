import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The page's rules, asserted against its own source text.
 *
 * There is no bundler and no framework here, so nothing else notices a mistyped
 * import specifier, a template nobody clones, a `data-act` nobody registered or
 * an `innerHTML` somebody reached for at half past five. Each of these was a
 * real failure mode of the screen this replaced; each is now a failing test
 * rather than a white page.
 *
 * Deliberately node-only and dependency-free: this suite has to keep working in
 * the environment the rest of the engine's tests already run in.
 */

const ENGINE = fileURLToPath(new URL('../../', import.meta.url))
const PUBLIC_DIR = path.join(ENGINE, 'src', 'web', 'public')

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

const files = await walk(PUBLIC_DIR)
const scripts = files.filter((name) => name.endsWith('.js'))
const styles = files.filter((name) => name.endsWith('.css'))

const source = new Map<string, string>()
for (const name of files) {
  if (name.endsWith('.js') || name.endsWith('.css') || name.endsWith('.html')) {
    source.set(name, await fs.readFile(path.join(PUBLIC_DIR, name), 'utf8'))
  }
}
const html = source.get('index.html') ?? ''

const read = (name: string): string => source.get(name) ?? ''

/**
 * The file with its comments taken out.
 *
 * Every rule below is about what the page *does*, and this file's own prose
 * quotes the things it forbids — `innerHTML` is named in `ui/list.js`'s header
 * explaining why it is absent, and every JSDoc type reaches for
 * `import('../../protocol.js')`. Block comments and whole-line `//` comments go;
 * trailing ones stay, so a `//` inside a url string is never mistaken for one.
 */
const code = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('no string-built DOM', () => {
  it.each(scripts)('%s never writes markup', (name) => {
    // `escape()` and every one of its call sites are gone. The cockpit renders
    // PLAN.md, HALT.md, finding claims, agent summaries and memory bodies — all
    // model- or user-authored — and `verbatim()` is the single path for that
    // text. The XSS surface is absent by construction, not by discipline.
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(code(name), `${name} uses ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('the import graph', () => {
  const specifiers = (name: string): string[] =>
    [...read(name).matchAll(/^\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '')

  it.each(scripts)('%s imports only files that exist', (name) => {
    for (const specifier of specifiers(name)) {
      // `../../protocol.js` is a type-only reach into the engine's own source;
      // everything else must be a file the browser can actually fetch.
      if (!specifier.startsWith('.')) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
      if (target.startsWith('..')) continue
      expect(files, `${name} imports ${specifier}`).toContain(target)
    }
  })

  it.each(scripts)('%s uses no dynamic import', (name) => {
    // A dynamic import is the one thing that would defeat this walk, and every
    // panel mounts at boot anyway.
    expect(code(name)).not.toMatch(/\bimport\s*\(/)
  })

  it('reaches every module it ships', async () => {
    const reached = new Set<string>()
    const queue = [...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1] ?? '')]
    while (queue.length > 0) {
      const name = queue.shift() as string
      if (reached.has(name) || !files.includes(name)) continue
      reached.add(name)
      for (const specifier of specifiers(name)) {
        if (!specifier.startsWith('.')) continue
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)))
      }
    }
    // Orphans are the other half of the walk: a module nobody imports is a
    // module nobody notices has stopped working.
    const orphans = scripts.filter((name) => !reached.has(name) && !name.startsWith('vendor/'))
    expect(orphans).toEqual([])
  })

  it('links every stylesheet it ships', () => {
    const linked = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((match) => match[1] ?? '')
    expect(styles.filter((name) => !name.startsWith('vendor/')).sort()).toEqual(
      linked.filter((name) => !name.startsWith('vendor/')).sort(),
    )
  })
})

describe('templates and actions', () => {
  const templates = [...html.matchAll(/<template id="([\w-]+)"/g)].map((match) => match[1] ?? '')
  const cloned = new Set(
    scripts.flatMap((name) => [...read(name).matchAll(/clone\('([\w-]+)'\)/g)].map((match) => match[1] ?? '')),
  )

  it('clones every template it declares', () => {
    expect(templates.filter((id) => !cloned.has(id))).toEqual([])
  })

  it('declares every template it clones', () => {
    expect([...cloned].filter((id) => !templates.includes(id))).toEqual([])
  })

  it('registers every data-act in the markup', () => {
    const used = new Set([...html.matchAll(/data-act="([\w-]+)"/g)].map((match) => match[1] ?? ''))
    const registered = new Set(
      scripts.flatMap((name) => [...read(name).matchAll(/bus\.on\('([\w-]+)'/g)].map((match) => match[1] ?? '')),
    )
    expect([...used].filter((name) => !registered.has(name)).sort()).toEqual([])
    // And the inverse: an action nobody can reach is dead weight that reads as
    // a working button in a review.
    expect([...registered].filter((name) => !used.has(name)).sort()).toEqual([])
  })
})

describe('the invariants a stylesheet edit could undo', () => {
  it('keeps the terminal pinned and clipped', () => {
    const css = read('app.css')
    // xterm parks a measuring span at `left: -9999em`; in an rtl document that
    // otherwise gives the entire page a horizontal scrollbar.
    expect(css).toMatch(/\.terminal\s*\{[^}]*direction:\s*ltr/)
    expect(css).toMatch(/\.terminal\s*\{[^}]*overflow:\s*hidden/)
  })

  it('keeps [hidden] winning over display', () => {
    // Every banner on this page sets a `display`, which outranks the browser's
    // own `[hidden]` rule. Without this they are permanently visible.
    expect(read('app.css')).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })

  it('never lets a pane mode un-clip the terminal', () => {
    for (const name of styles) {
      expect(read(name), name).not.toMatch(/\.terminal[^{]*\{[^}]*overflow:\s*visible/)
    }
  })
})

describe('rtl', () => {
  /** Physical properties, which mirror wrongly the moment the page is Arabic. */
  const PHYSICAL =
    /(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b|(?:^|[\s;{])(?:left|right):|text-align:\s*(?:left|right)\b/

  it.each(styles)('%s uses logical properties', (name) => {
    const offenders = read(name)
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // An annotated exception is allowed and has to say why — the terminal pin
      // is the one place an absolute direction is the point.
      .filter(({ line }) => PHYSICAL.test(line) && !line.startsWith('/*') && !line.startsWith('*'))
      .filter(({ number }) => !annotated(read(name), number))
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

describe('the page never assigns to a control', () => {
  it('writes .value in exactly one place, and for a user action', () => {
    // Rule 3: every control the user types into is uncontrolled and written
    // once at mount, so an 800ms tick cannot eat a half-typed note by
    // construction rather than by a focus check somebody forgets.
    // Two files may, and both for something a person did rather than something
    // a snapshot did: `app.js` fills the language picker at boot, and
    // `launcher.js` clears the command box because Run was pressed.
    const writers = scripts.filter((name) => /\.value\s*=[^=]/.test(code(name)))
    expect(writers).toEqual(['app.js', 'panels/launcher.js'])
  })
})

describe('the server can name everything it serves', () => {
  it('has a MIME type for every shipped extension', async () => {
    const server = await fs.readFile(path.join(ENGINE, 'src', 'web', 'server.ts'), 'utf8')
    const known = new Set([...server.matchAll(/'(\.\w+)':/g)].map((match) => match[1] ?? ''))
    const shipped = new Set(files.map((name) => path.extname(name)))
    expect([...shipped].filter((extension) => !known.has(extension)).sort()).toEqual([])
  })
})
