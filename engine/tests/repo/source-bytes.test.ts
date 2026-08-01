import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The tree stays searchable.
 *
 * A raw `0x00` in a source file makes it binary to text search, and the failure
 * is silent and tool-dependent: this machine's `grep` returns no output and
 * exit 1 — indistinguishable from an honest no-match — while ripgrep prints
 * "binary file matches" and drops the lines, and `git grep` sniffs only the
 * first 8000 bytes, so two files with the same defect fail differently under
 * the same tool.
 *
 * Three of these survived eight months here, one of them in `ui/dom.js`, which
 * declares the page's whole rendering vocabulary and is imported by fourteen
 * modules. Every audit that grepped it for `clone`, `phrase` or
 * `translateStatic` got a clean false negative — which is how a search can
 * confidently report that a handler does not exist anywhere on the page.
 *
 * Write `\u0000`, not `\0`: the octal form is a syntax error the moment a digit
 * lands beside it, and it is not itself greppable.
 *
 * `dist/` is not walked. Its `web/public` half is a byte-for-byte copy of a
 * tree this test does cover — `verify-ship.mjs` asserts the mirror and CI
 * asserts the commit — and its three bundles are esbuild output, which escapes
 * the byte rather than emitting it.
 *
 * Deliberately node-only and dependency-free, like `tests/web/discipline.test.ts`.
 */

const ENGINE = fileURLToPath(new URL('../../', import.meta.url))
const ROOTS = ['src', 'scripts', 'tests']
const TEXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.css', '.html'])

/**
 * A floor, so a walker that silently returns nothing cannot pass this suite
 * vacuously. It sits well under the 186 files the roots hold today: it is a
 * tripwire for a broken walk, not a second assertion about the tree's size.
 */
const FLOOR = 150

async function walk(dir: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), relative)))
    else if (TEXT.has(path.extname(entry.name))) out.push(relative)
  }
  return out
}

const files: string[] = []
for (const root of ROOTS) files.push(...(await walk(path.join(ENGINE, root), root)))

describe('the tree stays searchable', () => {
  it('walks the whole engine, so an empty result cannot be a pass', () => {
    expect(files.length).toBeGreaterThanOrEqual(FLOOR)
  })

  it('holds no raw NUL byte in any source file', async () => {
    const offenders: string[] = []
    for (const name of files) {
      const buffer = await fs.readFile(path.join(ENGINE, name))
      const at = buffer.indexOf(0)
      if (at === -1) continue
      // Report where, not just that: a byte offset alone sends the reader to a
      // file their editor renders identically either way.
      const line = buffer.subarray(0, at).toString('utf8').split('\n').length
      offenders.push(`${name}:${line} (byte ${at})`)
    }
    // Every offender at once, so one run names them all. Write `\u0000`.
    expect(offenders).toEqual([])
  })
})
