#!/usr/bin/env node
/**
 * Prove the shipped tree runs with nothing installed.
 *
 * 0.4.0 shipped a plugin whose MCP server and three hooks pointed into a
 * `dist/` that was not in git. Every test passed: they run against `src/` with
 * a full `node_modules` beside them, which is the one situation a user is never
 * in. This copies what git would ship into an empty directory and runs it there
 * — no `node_modules`, no install, no compiler — because that is the only way
 * the failure was ever going to show up before a release rather than after.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDOR_FILES } from './vendor.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'mjloop-ship-'))
const engine = path.join(staging, 'engine')

async function run(script, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: staging,
      // A bare environment: nothing may be resolved out of the developer's
      // own install by accident.
      env: { ...process.env, NODE_PATH: '' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  })
}

const failures = []
const check = (name, ok, detail) => {
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}\n`)
  if (!ok) failures.push(`${name}: ${detail}`)
}

try {
  await fs.mkdir(engine, { recursive: true })
  for (const entry of ['dist', 'package.json']) {
    await fs.cp(path.join(root, entry), path.join(engine, entry), { recursive: true })
  }

  const nodeModules = path.join(engine, 'node_modules')
  check('the staged tree has no node_modules', !(await fs.stat(nodeModules).catch(() => false)), nodeModules)

  const handshake =
    [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-ship","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    ].join('\n') + '\n'

  const mcp = await run(path.join(engine, 'dist/mcp/server.js'), [], handshake)
  const tools = mcp.stdout
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((message) => message?.id === 2)?.result?.tools
  check('the mcp server lists its tools', Array.isArray(tools) && tools.length > 0, mcp.stderr || mcp.stdout)

  const cli = path.join(engine, 'dist/cli/index.js')
  const sessionStart = await run(cli, ['session-start'], `{"cwd":${JSON.stringify(root)}}\n`)
  check('the SessionStart hook answers', sessionStart.code === 0, sessionStart.stderr)

  const guard = await run(cli, ['state-guard'], '{"tool_input":{"file_path":"/x/.mjloop/state.json"}}\n')
  check(
    'the PreToolUse hook still denies a state.json write',
    guard.code === 0 && guard.stdout.includes('"deny"'),
    guard.stderr || guard.stdout,
  )

  const stop = await run(cli, ['stop-guard'], `{"cwd":${JSON.stringify(root)}}\n`)
  check('the Stop hook answers', stop.code === 0, stop.stderr)

  // The dashboard is allowed to need an install; it must say so rather than
  // crash, and it must never be what a plain session depends on.
  const web = await run(path.join(engine, 'dist/web/cli.js'), ['--port', 'not-a-port'])
  check('the web cli reports a bad argument rather than crashing', web.code === 1, web.stderr)

  const page = path.join(engine, 'dist/web/public')
  await checkPage(page)
} finally {
  await fs.rm(staging, { recursive: true, force: true })
}

/**
 * The page, checked against the source tree rather than against a list.
 *
 * A hand-maintained asset list is a list somebody forgets to extend. The build
 * copies `src/web/public` verbatim, so the shipped page is *defined* as a
 * byte-for-byte mirror of it plus the three vendor bundles — and with no
 * bundler, a mistyped import specifier is a white screen rather than a build
 * error, so the import graph is walked too.
 */
async function checkPage(page) {
  const source = path.join(root, 'src', 'web', 'public')

  const shipped = await walk(page)
  const authored = await walk(source)

  /** A floor, so a bug in the walker cannot make all of this vacuously pass. */
  check('the page has its files', authored.length >= 25, `${authored.length} files under src/web/public`)

  const mismatched = []
  for (const relative of authored) {
    const [a, b] = await Promise.all([
      fs.readFile(path.join(source, relative)).catch(() => null),
      fs.readFile(path.join(page, relative)).catch(() => null),
    ])
    if (a === null || b === null || !a.equals(b)) mismatched.push(relative)
  }
  check('dist mirrors src/web/public byte for byte', mismatched.length === 0, mismatched.join(', '))

  // The other direction: nothing may be shipped that is not either authored or
  // a declared vendor bundle.
  const known = new Set([...authored, ...VENDOR_FILES.map((name) => `vendor/${name}`)])
  const extra = shipped.filter((relative) => !known.has(relative))
  check('dist ships nothing the source tree does not have', extra.length === 0, extra.join(', '))

  const missingVendor = VENDOR_FILES.filter((name) => !shipped.includes(`vendor/${name}`))
  check('dist ships the vendor bundles', missingVendor.length === 0, missingVendor.join(', '))

  const spine = ['index.html', 'app.js', 'app.css', 'locales/en.json']
  const missingSpine = spine.filter((asset) => !shipped.includes(asset))
  check('dist ships the page spine', missingSpine.length === 0, missingSpine.join(', '))

  const { missing, dynamic, reached } = await walkImports(page)
  check('every import and asset reference resolves', missing.length === 0, missing.join(', '))
  check('the page uses no dynamic import', dynamic.length === 0, dynamic.join(', '))
  // Orphans are the other half of the graph walk: a module nobody imports is a
  // module nobody notices has stopped working.
  const orphans = shipped.filter((relative) => relative.endsWith('.js') && !reached.has(relative))
  check('the page ships no unreachable module', orphans.length === 0, orphans.join(', '))
}

/** Every file under `dir`, as forward-slash relative paths. */
async function walk(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), relative)))
    else out.push(relative)
  }
  return out
}

/** BFS from `index.html` over `<script src>`, `<link href>` and static `import`. */
async function walkImports(page) {
  const missing = []
  const dynamic = []
  const reached = new Set()
  const queue = ['index.html']
  const seen = new Set(queue)

  while (queue.length > 0) {
    const relative = queue.shift()
    const body = await fs.readFile(path.join(page, relative), 'utf8').catch(() => null)
    if (body === null) {
      missing.push(relative)
      continue
    }
    if (relative.endsWith('.js')) reached.add(relative)

    const references = relative.endsWith('.html') ? htmlRefs(body) : jsRefs(body)
    // Comments out first: every JSDoc type on the page reaches for
    // `import('../../protocol.js')`, which is a type annotation and not a load.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (relative.endsWith('.js') && /\bimport\s*\(/.test(code)) dynamic.push(relative)

    for (const reference of references) {
      // Only same-tree, relative references are ours to resolve.
      if (/^[a-z]+:/i.test(reference) || reference.startsWith('//')) continue
      const target = path
        .normalize(path.join(path.dirname(relative), reference))
        .split(path.sep)
        .join('/')
      if (seen.has(target)) continue
      seen.add(target)
      queue.push(target)
    }
  }
  return { missing, dynamic, reached }
}

function htmlRefs(body) {
  return [
    ...[...body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]),
    ...[...body.matchAll(/<link[^>]+href="([^"]+)"/g)].map((match) => match[1]),
  ]
}

function jsRefs(body) {
  return [...body.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1])
}

if (failures.length > 0) {
  process.stderr.write(`\nThe shipped tree does not run on its own:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\nThe shipped tree runs with nothing installed.\n')
}
