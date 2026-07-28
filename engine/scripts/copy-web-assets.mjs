#!/usr/bin/env node
/**
 * `tsc` compiles TypeScript and nothing else, so the page's own files — html,
 * css, the locale dictionaries — never reach `dist` on their own. Neither do
 * xterm's browser bundles, which are dependencies of the page rather than of
 * the server.
 *
 * Copied rather than served out of `node_modules` at runtime: `dist` is what
 * ships, and a `dist` that only works next to a populated `node_modules` tree
 * is a build output that lies about being one.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = path.join(root, 'src', 'web', 'public')
const target = path.join(root, 'dist', 'web', 'public')
const require = createRequire(import.meta.url)

/** Resolved through node so a hoisted or deduped install is found wherever it landed. */
function resolveAsset(specifier) {
  return require.resolve(specifier)
}

const VENDOR = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
]

await fs.rm(target, { recursive: true, force: true })
await fs.cp(source, target, { recursive: true })

const vendorDir = path.join(target, 'vendor')
await fs.mkdir(vendorDir, { recursive: true })
for (const [specifier, name] of VENDOR) {
  await fs.copyFile(resolveAsset(specifier), path.join(vendorDir, name))
}

process.stdout.write(`web assets -> ${path.relative(root, target)}\n`)
