#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLoopPaths } from '../store/paths.js'
import { isEntrypoint } from '../util/entrypoint.js'
import { startServer } from './server.js'
import { isPtyAvailable } from './session.js'

const USAGE = `usage: mjloop-web [options]

  --dir <path>    project to drive (default: cwd)
  --port <n>      port to listen on (default: 4177, 0 for any free port)
  --no-open       do not open a browser
`

export interface WebArgs {
  dir: string
  port: number
  open: boolean
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], cwd: string): WebArgs {
  const args: WebArgs = { dir: cwd, port: 4177, open: true }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    switch (flag) {
      case '--dir': {
        const value = argv[++index]
        if (value === undefined) throw new UsageError('--dir needs a path')
        args.dir = path.resolve(cwd, value)
        break
      }
      case '--port': {
        const value = argv[++index]
        const port = Number(value)
        // `0` is meaningful — it asks the OS for any free port — so the range
        // starts there rather than at 1.
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new UsageError(`--port needs a number between 0 and 65535, got ${String(value)}`)
        }
        args.port = port
        break
      }
      case '--no-open':
        args.open = false
        break
      default:
        throw new UsageError(`unknown option ${String(flag)}`)
    }
  }
  return args
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    // Detached and unref'd: a browser that outlives this process must not keep
    // it alive, and a machine with no browser at all must not fail the server.
    spawn(command, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref()
  } catch {
    /* the url is printed either way */
  }
}

/**
 * Both `dist/web/cli.js` and `src/web/cli.ts` sit two directories under the
 * engine root, so one expression serves the shipped bundle and a dev checkout.
 */
const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Make sure a terminal can be opened, installing `node-pty` if this is the
 * first time the dashboard has run.
 *
 * The rest of the plugin is bundled and needs nothing installed, which is the
 * whole point — the MCP server and the hooks must work the instant a plugin is
 * copied into place. `node-pty` is native and cannot be bundled, so the one
 * feature that needs it pays for it, once, and only if it is used.
 *
 * `--omit=dev` is what keeps this small: after bundling, the engine's only
 * non-dev dependency is `node-pty` itself.
 */
async function ensurePty(): Promise<boolean> {
  if (isPtyAvailable()) return true

  process.stdout.write('Preparing the dashboard — installing node-pty, this happens once.\n')
  const code = await new Promise<number>((resolve) => {
    // `--loglevel=error`: npm resolves the whole lockfile even when installing
    // almost none of it, and warns about peer conflicts among dev tooling the
    // user will never install. Those warnings are true and irrelevant, and a
    // wall of them under "this happens once" reads like something went wrong.
    const npm = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: ENGINE_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    })
    npm.on('error', () => resolve(-1))
    npm.on('close', (status) => resolve(status ?? -1))
  })

  if (code !== 0) {
    process.stderr.write(
      `\nCould not install node-pty in ${ENGINE_DIR}.\n` +
        'The dashboard needs it to open a terminal; the rest of mjloop does not.\n' +
        'Install it by hand with:  npm install --omit=dev --prefix "' +
        ENGINE_DIR +
        '"\n',
    )
    return false
  }
  // Resolution is cached per process, and the module did not exist when the
  // first attempt ran. Re-checking here reports honestly rather than letting
  // the first spawn fail with the server already listening.
  return isPtyAvailable()
}

export async function main(argv: string[]): Promise<number> {
  let args: WebArgs
  try {
    args = parseArgs(argv, process.cwd())
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`)
    return 1
  }

  try {
    await fs.stat(resolveLoopPaths(args.dir).root)
  } catch {
    process.stderr.write(`no .mjloop/ in ${args.dir} — run /mjloop:init there first.\n`)
    return 1
  }

  // Before the server listens, not after: a page that loads and then cannot
  // open a terminal is a worse failure than one that never opened.
  if (!(await ensurePty())) return 1

  const server = await startServer({ projectDir: args.dir, port: args.port })
  process.stdout.write(`mjloop web  ${args.dir}\n${server.url}\n\nThe url carries the access token. Ctrl-C to stop.\n`)
  if (args.open) openBrowser(server.url)

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Resolves only on signal. Returning would end the process and take the
  // server with it.
  await new Promise<never>(() => {})
  return 0
}

if (await isEntrypoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
