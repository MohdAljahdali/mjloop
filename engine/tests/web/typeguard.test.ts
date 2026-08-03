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
 * One `import` clause: the text between `import` and `from '…'`, and the
 * specifier itself. Non-greedy up to the first `from` — an import clause never
 * contains that word — so this also finds the multi-line form
 * (`import {\n  a,\n  b,\n} from '…'`).
 */
const IMPORT_RE = /import\s+([\s\S]*?)\bfrom\s+['"]([^'"]+)['"]/g

/**
 * A specifier escapes `app/` if, resolved against the importing file, it lands
 * outside `APP_DIR`. Bare package specifiers (`vue`, `zod`, …) never escape —
 * they never resolve to a path at all.
 */
function escapesApp(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  return resolved !== APP_DIR && !resolved.startsWith(APP_DIR + path.sep)
}

describe('the app/server boundary', () => {
  it('never runtime-imports a server module', async () => {
    // A project reference makes a server type resolvable through its built
    // `.d.ts` without the type checker ever opening the server's source — see
    // the test above. That protects `vue-tsc`, not the bundler: a *value*
    // import of a server module (`import { WriteSchema } from '../../writes.js'`)
    // typechecks clean through the same reference and still ships `node:os` to
    // the browser. Only a whole-clause `import type` is erased at build time,
    // so that is the only form allowed to reach past `app/`.
    const files = await walk(APP_DIR)
    const violations: string[] = []
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8')
      for (const match of text.matchAll(IMPORT_RE)) {
        const [, clause, specifier] = match
        if (clause === undefined || specifier === undefined) continue
        const isTypeOnly = /^type\s/.test(clause.trim())
        if (!isTypeOnly && escapesApp(file, specifier)) {
          violations.push(`${path.relative(ENGINE, file)}: import ... from '${specifier}'`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
