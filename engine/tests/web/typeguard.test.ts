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

/**
 * `lib/local.ts`'s `read` (commonly imported `as prefs`) — every getter
 * `lib/selection.ts` wraps it in (`activePlan`, `storyFilter`, `activeStory`,
 * `openStories`, `recentlyClosed`), and `composables/useSelection.ts`'s own
 * `useSelection` — must never be called to seed a module-scope binding.
 *
 * `main.ts`'s very first statement, `import App from './App.vue'`, pulls in
 * every composable and panel `App.vue` imports transitively — and ES module
 * imports are evaluated before the importing module's own body runs, so that
 * whole graph is evaluated *before* `main.ts` reaches its own
 * `installStorage(localStorage)` call. A `const x = ref(read().field)` at
 * module scope therefore always reads `lib/local.ts`'s `DEFAULTS` — storage
 * is not installed yet — and pins `x` to a default forever, because nothing
 * ever re-reads it. `useSelection.ts` shipped exactly this bug (fix round 2
 * of the Plans panel) — not as a direct call to `read`, but one hop out
 * through `lib/selection.ts`'s `activePlan`, which is why that module's own
 * getters are guarded here too, by name, rather than trying to trace an
 * arbitrary call graph. `useSelection` itself is guarded for the identical
 * reason one hop further out: a module-scope `useSelection()` call in a
 * `.ts` helper or a non-setup `<script>` block seeds every ref it returns
 * from the same unset defaults, before `App.vue`'s own setup ever runs.
 * `usePane.ts` shipped the direct form earlier still (Task 2) and survives
 * only because `bootPane()` deliberately re-reads and corrects it from
 * `App.vue`'s `onMounted` — see the exemption below. The fix in every case is
 * the same: read storage lazily, from inside a function a caller invokes
 * after `installStorage()` has run, never at import time.
 */
function findLocalScopeSeeds(text: string): string[] {
  const violations: string[] = []
  const aliases = new Set<string>()
  // `lib/selection.ts`'s own getters, every one of them a thin wrapper over
  // `local.ts`'s `read()` — see this function's header for why a name list
  // stands in for tracing the call graph through a second file.
  const selectionGetters = new Set(['activePlan', 'storyFilter', 'activeStory', 'openStories', 'recentlyClosed'])
  // Aliases bound to `useSelection` itself, held apart from `aliases` below —
  // see the `<script setup>` exemption, immediately after this loop, for why.
  const useSelectionAliases = new Set<string>()

  for (const clause of extractClauses(text)) {
    const specifier = specifierOf(clause)
    if (specifier === undefined) continue
    const guardLocal = specifier.endsWith('/local.js')
    const guardSelection = specifier.endsWith('/selection.js')
    const guardUseSelection = specifier.endsWith('/useSelection.js')
    if (!guardLocal && !guardSelection && !guardUseSelection) continue
    const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? ''
    for (const entry of named.split(',')) {
      const trimmed = entry.trim()
      if (trimmed === '') continue
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/)
      const imported = asMatch?.[1] ?? trimmed
      const local = asMatch?.[2] ?? trimmed
      if (guardLocal && imported === 'read') aliases.add(local)
      if (guardSelection && selectionGetters.has(imported)) aliases.add(local)
      if (guardUseSelection && imported === 'useSelection') useSelectionAliases.add(local)
    }
  }
  // A `<script setup>` block's top-level statements are a component's own
  // `setup()` body, not module-scope code: Vue runs them at instantiation,
  // strictly after `main.ts` reaches `installStorage()`, for every component
  // no matter how deep it mounts. `useSelection()` is safe to call there —
  // `App.vue`, `Plans.vue` and `Stories.vue` all do — so it is exempted from
  // this scan only inside such a block. A `.ts` helper or a non-setup
  // `<script>` block gets no such exemption, which is the actual bug this
  // guard exists to catch.
  if (!/<script\s+setup\b/.test(text)) for (const alias of useSelectionAliases) aliases.add(alias)
  if (aliases.size === 0) return violations

  // A line at column 0 is a top-level statement — nothing under this
  // codebase's 2-space-indent convention puts a function or composable
  // body's own statements there. A continuation line of a top-level
  // statement (an initializer that wraps) is a known gap this scan does not
  // see, the same class of limitation `findBoundaryViolations`'s own header
  // documents for its own scan.
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s/.test(line) || line.trim() === '') continue
    for (const alias of aliases) {
      if (new RegExp(`\\b${alias}\\s*\\(`).test(line)) {
        violations.push(`line ${index + 1}: ${line.trim()}`)
      }
    }
  }
  return violations
}

describe('findLocalScopeSeeds', () => {
  const flagged: Array<[string, string]> = [
    ['a plain module-scope call', `import { read } from '../lib/local.js'\nconst x = read().pane`],
    ['an aliased module-scope call', `import { read as prefs } from '../lib/local.js'\nconst mode = ref(prefs().pane)`],
    [
      'an aliased call inside a single-line const, regardless of what wraps it',
      `import { read as prefs } from '../lib/local.js'\nconst DEFAULTS = { pane: prefs().pane }`,
    ],
    // The `selection.js` branch (`guardSelection`, above) was widened for
    // `useSelection.ts`'s own imports of `lib/selection.ts`'s getters, but
    // the three fixtures above only ever exercise the `local.js` branch —
    // this is the one that actually calls through `guardSelection` rather
    // than proving it only by reading the source.
    [
      'a module-scope call through lib/selection.ts, one hop out from local.ts',
      `import { activePlan } from '../lib/selection.js'\nconst x = ref(activePlan())`,
    ],
    // `useSelection` itself, one hop further out than `lib/selection.ts` — a
    // helper or a non-setup `<script>` block that calls it at module scope
    // seeds every ref it returns from the same unset defaults.
    [
      'a module-scope call to useSelection itself',
      `import { useSelection } from '../composables/useSelection.js'\nconst { activeStory } = useSelection()`,
    ],
  ]
  it.each(flagged)('flags %s', (_name, source) => {
    expect(findLocalScopeSeeds(source)).not.toEqual([])
  })

  const safe: Array<[string, string]> = [
    ['a lazy seed inside a function body', `import { read as prefs } from '../lib/local.js'\nfunction boot() {\n  return ref(prefs().pane)\n}`],
    [
      'a lazy seed inside an exported composable',
      `import { read as prefs } from '../lib/local.js'\nexport function useThing() {\n  return prefs().pane\n}`,
    ],
    ['no import of read at all', `import { write } from '../lib/local.js'\nconst x = write({ pane: 'docked' })`],
    [
      'write called at module scope alongside an unrelated read import — only the read/prefs alias is guarded',
      `import { read as prefs, write } from '../lib/local.js'\nfunction boot() {\n  return prefs().pane\n}\nconst x = write({ pane: 'docked' })`,
    ],
    // The exemption a `<script setup>` block gets: its top-level statements
    // are a component's own `setup()` body, run at instantiation rather than
    // at module-evaluation time — `App.vue`'s and `Plans.vue`'s own shape.
    [
      'useSelection called at the top of a <script setup> block',
      `<script setup lang="ts">\nimport { useSelection } from '../composables/useSelection.js'\nconst { activeStory } = useSelection()\n</script>`,
    ],
  ]
  it.each(safe)('does not flag %s', (_name, source) => {
    expect(findLocalScopeSeeds(source)).toEqual([])
  })
})

describe('the app/local-storage boundary', () => {
  it('never seeds a module-scope binding from lib/local.ts', async () => {
    // `usePane.ts`'s own module-scope `ref(prefs().pane)` (line 16) is the
    // one instance that predates this guard. It is not the bug this guard
    // exists to catch a third time: `'collapsed'` is a legitimate default
    // for a first-time visitor (this file's own header, "Collapsed on a
    // first visit, not docked"), and `bootPane()` — called from `App.vue`'s
    // `onMounted` — corrects it to a returning visitor's real preference
    // before the terminal's first meaningful paint. `useSelection.ts`'s
    // equivalent line had no such correction and silently broke persistence
    // forever, which is the failure mode this guard is for.
    const allowed = new Set([path.join(APP_DIR, 'composables', 'usePane.ts')])
    const files = await walk(APP_DIR)
    const violations: string[] = []
    for (const file of files) {
      if (allowed.has(file)) continue
      const text = await fs.readFile(file, 'utf8')
      for (const violation of findLocalScopeSeeds(text)) violations.push(`${file}: ${violation}`)
    }
    expect(violations).toEqual([])
  })
})
