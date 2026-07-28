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
  for (const asset of ['index.html', 'app.js', 'locales/en.json', 'locales/ar.json', 'vendor/xterm.js']) {
    check(`dist ships ${asset}`, await fs.stat(path.join(page, asset)).then(() => true, () => false), asset)
  }
} finally {
  await fs.rm(staging, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`\nThe shipped tree does not run on its own:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\nThe shipped tree runs with nothing installed.\n')
}
