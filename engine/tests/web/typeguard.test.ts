import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The web program must not carry Node typings.
 *
 * They were added when `app/lib` began importing `protocol.js`, which pulls the
 * server's own modules into the browser's compile. The cost is silent: with
 * `node` in `types`, a component that reaches for `process` or Node's
 * `setTimeout` overloads compiles clean and breaks in a browser.
 */
describe('the web program', () => {
  it('typechecks without node typings', () => {
    // `tsconfig.web.json` resolves `Snapshot`/`ClientMessage`/`Write` through a
    // project reference to `tsconfig.protocol.json` (see that file for why a
    // type-only barrel alone could not cut the graph). A reference is consumed
    // through its built `.d.ts`, so it has to be built before `vue-tsc` can
    // resolve it — `-b` is incremental, so a repeat run here costs nothing.
    execFileSync('npx', ['tsc', '-b', 'tsconfig.protocol.json'], { encoding: 'utf8', stdio: 'pipe' })
    const out = execFileSync('npx', ['vue-tsc', '-p', 'tsconfig.web.json'], { encoding: 'utf8', stdio: 'pipe' })
    expect(out).toBe('')
  })
})

const ENGINE = fileURLToPath(new URL('../../', import.meta.url))
const APP_DIR = path.join(ENGINE, 'src', 'web', 'app')

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) out.push(full)
  }
  return out
}

/**
 * A specifier escapes `app/` if, resolved against the importing file, it lands
 * outside `appDir`. Bare package specifiers (`vue`, `zod`, …) never escape —
 * they never resolve to a path at all.
 */
function escapesApp(appDir: string, fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  return resolved !== appDir && !resolved.startsWith(appDir + path.sep)
}

/**
 * Every `import …` or `export … from …` clause in a file, as one string each
 * — multi-line named lists included.
 *
 * Anchored at line starts on purpose, after a false positive: a non-greedy
 * `import\s+([\s\S]*?)\bfrom` scanning the whole file runs an unterminated
 * clause (`import './util.js'`, no `from`) forward across the newline into
 * the *next* statement, and blames whatever `from '…'` it finds first —
 * which can be a perfectly innocent `import type` two lines down. A clause
 * only starts on a line that looks like the start of one, and only keeps
 * reading while its own braces are still open, so it can never run past its
 * own statement.
 *
 * `export …` only starts a clause when a `{` or `*` follows (`export type? [{*]`)
 * — that is what a re-export looks like. `export interface`, `export function`,
 * `export const`, `export type Foo = …` are declarations, not re-exports, and
 * must never make this loop start swallowing the rest of the file waiting for
 * a `from` that will never come.
 */
function extractClauses(text: string): string[] {
  const lines = text.split('\n')
  const clauses: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    i++
    if (line === undefined) continue
    const trimmed = line.trim()
    const isImport = /^import\b/.test(trimmed) && !/^import\s*\(/.test(trimmed)
    const isExportFrom = /^export\s+(type\s+)?[{*]/.test(trimmed)
    if (!isImport && !isExportFrom) continue

    const buffer = [line]
    let depth = 0
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    while (depth > 0 && i < lines.length) {
      const next = lines[i]
      i++
      if (next === undefined) break
      buffer.push(next)
      for (const ch of next) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    }
    clauses.push(buffer.join('\n'))
  }
  return clauses
}

/**
 * Whether every binding a clause carries is type-only, i.e. the clause is
 * erased at build time and cannot ship a server module to the browser.
 *
 * Two shapes qualify:
 *  - whole-clause: `import type …` / `export type …`
 *  - inline: every named specifier individually marked (`import { type A, type B } from …`)
 *
 * A default or namespace binding (`import Foo from …`, `import * as ns from
 * …`) can only be marked type-only in the whole-clause form, because neither
 * has an inline `type` syntax — so either form present outside `{ … }`
 * disqualifies the clause. A side-effect import (`import '…'`, no bindings at
 * all) is a value pull by definition and is handled by the caller before this
 * runs.
 */
function isTypeOnlySafe(clause: string): boolean {
  const trimmed = clause.trim()
  if (/^(import|export)\s+type\s/.test(trimmed)) return true

  const bindingsMatch = trimmed.match(/^(?:import|export)\s+([\s\S]*?)\s+from\s+['"]/)
  const bindings = bindingsMatch?.[1]
  if (bindings === undefined) return false

  const outsideBraces = bindings.replace(/\{[\s\S]*\}/, '').trim().replace(/,$/, '').trim()
  if (outsideBraces !== '') return false // a default or namespace binding

  const named = bindings.match(/\{([\s\S]*)\}/)?.[1] ?? ''
  const specifiers = named
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (specifiers.length === 0) return false
  return specifiers.every((s) => /^type\s/.test(s))
}

/** The specifier a clause names, from either its `from '…'` or a bare side-effect import. */
function specifierOf(clause: string): string | undefined {
  const fromMatch = clause.match(/\bfrom\s+['"]([^'"]+)['"]/)
  if (fromMatch?.[1] !== undefined) return fromMatch[1]
  return clause.trim().match(/^import\s+['"]([^'"]+)['"]/)?.[1]
}

/**
 * Every way `text` (the contents of `fromFile`, somewhere under `appDir`) can
 * carry a server module past the `app/` boundary at *runtime* — a value
 * import a project reference cannot make disappear. Returns one message per
 * violation, empty when the file is clean.
 */
function findBoundaryViolations(appDir: string, fromFile: string, text: string): string[] {
  const violations: string[] = []

  for (const clause of extractClauses(text)) {
    const specifier = specifierOf(clause)
    if (specifier === undefined) continue
    if (!escapesApp(appDir, fromFile, specifier)) continue
    if (isTypeOnlySafe(clause)) continue
    violations.push(`${fromFile}: ${clause.trim().split('\n')[0]}`)
  }

  // `import('…')` — a dynamic import is a value by construction; there is no
  // type-only form of it. `verify-ship` would eventually catch one reaching
  // `dist/`, but only after a build, and pointing at the bundle rather than
  // the line that caused it.
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1]
    if (specifier === undefined) continue
    if (escapesApp(appDir, fromFile, specifier)) {
      violations.push(`${fromFile}: import('${specifier}')`)
    }
  }

  return violations
}

describe('the app/server boundary', () => {
  it('never runtime-imports a server module', async () => {
    // A project reference makes a server type resolvable through its built
    // `.d.ts` without the type checker ever opening the server's source — see
    // the test above. That protects `vue-tsc`, not the bundler: a *value*
    // import of a server module (`import { WriteSchema } from '../../writes.js'`)
    // typechecks clean through the same reference and still ships `node:os` to
    // the browser. Only a clause every one of whose bindings is type-only is
    // erased at build time, so that is the only form allowed to reach past
    // `app/`.
    const files = await walk(APP_DIR)
    const violations: string[] = []
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8')
      violations.push(...findBoundaryViolations(APP_DIR, file, text))
    }
    expect(violations).toEqual([])
  })
})

describe('findBoundaryViolations', () => {
  // A fixed, fake `app/` so every case resolves the same way regardless of
  // where the real `app/` happens to live. `fromFile` sits at `lib/x.ts`,
  // matching how the real offenders in the review sat at `app/lib/api.ts`.
  const appDir = '/project/src/web/app'
  const fromFile = '/project/src/web/app/lib/x.ts'

  const flagged: Array<[string, string]> = [
    ['a named value import', `import { WriteSchema } from '../../writes.js'`],
    ['a bare side-effect import', `import '../../writes.js'`],
    ['a value re-export', `export { WriteSchema } from '../../writes.js'`],
    ['a dynamic import', `async function f() {\n  const m = await import('../../writes.js')\n  return m\n}`],
    ['a default import', `import WriteSchema from '../../writes.js'`],
    ['a namespace import', `import * as writes from '../../writes.js'`],
    [
      'one non-type-only specifier among type-only ones',
      `import { type Snapshot, WriteSchema } from '../../protocol.js'`,
    ],
    [
      // The reported false positive: an unterminated side-effect import must
      // not swallow the next statement. This one *is* a real violation
      // ('../../writes.js' escapes `app/`), and it must be reported against
      // its own line, not the `import type` line after it.
      'a value import that starts the file, ahead of an unrelated import type',
      `import '../../writes.js'\nimport type { PlanView } from '../../protocol.js'`,
    ],
  ]

  it.each(flagged)('flags %s', (_name, source) => {
    expect(findBoundaryViolations(appDir, fromFile, source)).not.toEqual([])
  })

  const safe: Array<[string, string]> = [
    ['a whole-clause type-only import', `import type { Snapshot } from '../../protocol.js'`],
    ['a single inline type-only import', `import { type Snapshot } from '../../protocol.js'`],
    ['two inline type-only imports', `import { type Snapshot, type PlanView } from '../../protocol.js'`],
    ['a whole-clause type-only re-export', `export type { Snapshot } from '../../protocol.js'`],
    ['a bare package specifier', `import { ref } from 'vue'`],
    ['a value import that stays inside app/', `import { helper } from './util.js'`],
    [
      'a multi-line, all-inline-type-only import',
      `import {\n  type PlanView,\n  type StoryView,\n} from '../../protocol.js'`,
    ],
    [
      // The false-positive scenario, minus the real violation: neither line
      // should be flagged — the side-effect import stays inside app/, and the
      // import type is whole-clause safe regardless of what precedes it.
      'an unrelated local side-effect import ahead of an import type',
      `import './util.js'\nimport type { PlanView } from '../../protocol.js'`,
    ],
  ]

  it.each(safe)('does not flag %s', (_name, source) => {
    expect(findBoundaryViolations(appDir, fromFile, source)).toEqual([])
  })
})
