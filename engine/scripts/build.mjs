#!/usr/bin/env node
/**
 * Build `dist/` into something a plugin install can simply copy.
 *
 * A Claude Code plugin ships whatever is in git and runs it as-is: there is no
 * install step, no `npm ci`, no compile. mjloop has a TypeScript engine behind
 * an MCP server and three hooks, so shipping `src/` alone shipped nothing that
 * runs — the server pointed at a file that did not exist, and every update
 * wiped whatever the user had built by hand. That is what this bundle fixes.
 *
 * So every dependency is bundled in and `dist/` is committed. The one exception
 * is `node-pty`: it is a native module, it cannot be bundled, and it is needed
 * only by the web dashboard. `src/web/session.ts` loads it on demand and
 * `src/web/cli.ts` installs it on first use, so the MCP server and the hooks —
 * the parts every session depends on — carry no native code at all.
 */
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// Browser bundles the page loads. Pure JavaScript, so they ship in `dist` too.
// Shared with `verify-ship.mjs` so the two cannot drift.
import { VENDOR } from './vendor.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

const ENTRIES = [
  ['src/mcp/server.ts', 'dist/mcp/server.js'],
  ['src/cli/index.ts', 'dist/cli/index.js'],
  ['src/web/cli.ts', 'dist/web/cli.js'],
]

const SHEBANG = '#!/usr/bin/env node'

/**
 * Written by hand rather than passed as esbuild's `banner`, because the banner
 * lands *above* the shebang esbuild preserves from the entry — and a `#!` on
 * line two is a syntax error, not a shebang.
 *
 * The `require` matters: some dependencies are CommonJS and call `require` at
 * load time (`yaml` reaches for `process`). esbuild's ESM output stubs that
 * with a function that throws unless a real `require` is already in scope, so
 * the bundle parses, starts, and dies on its first import. Defining one here is
 * what the stub looks for.
 */
const PREAMBLE = [
  SHEBANG,
  "import { createRequire as __mjloopCreateRequire } from 'node:module'",
  'var require = __mjloopCreateRequire(import.meta.url)',
  '',
].join('\n')

await fs.rm(path.join(root, 'dist'), { recursive: true, force: true })

for (const [entry, out] of ENTRIES) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(root, out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Left out of the bundle on purpose:
    //   node-pty          native, installed on first use of the dashboard
    //   bufferutil, …     ws's optional native accelerators; it works without them
    external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    legalComments: 'none',
  })

  const file = path.join(root, out)
  const body = (await fs.readFile(file, 'utf8')).replace(/^#![^\n]*\n/, '')
  await fs.writeFile(file, PREAMBLE + body, 'utf8')

  // The two ways this file has already been broken, both silently until run.
  const head = (await fs.readFile(file, 'utf8')).split('\n', 3)
  if (head[0] !== SHEBANG || head[1]?.startsWith('#!') === true) {
    throw new Error(`${out} must open with exactly one shebang, got:\n${head.join('\n')}`)
  }
}

const target = path.join(root, 'dist', 'web', 'public')
await fs.cp(path.join(root, 'src', 'web', 'public'), target, { recursive: true })
const vendorDir = path.join(target, 'vendor')
await fs.mkdir(vendorDir, { recursive: true })
for (const [specifier, name] of VENDOR) {
  await fs.copyFile(require.resolve(specifier), path.join(vendorDir, name))
}

for (const [, out] of ENTRIES) {
  const { size } = await fs.stat(path.join(root, out))
  process.stdout.write(`${out.padEnd(24)} ${(size / 1024).toFixed(0)} kB\n`)
}
process.stdout.write('dist/web/public          page + locales + vendor\n')
