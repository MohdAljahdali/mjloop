#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveLoopPaths } from '../store/paths.js'
import { isEntrypoint } from '../util/entrypoint.js'
import { startServer } from './server.js'

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
