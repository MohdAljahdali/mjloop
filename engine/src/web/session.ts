import { createRequire } from 'node:module'
import type { spawn as PtySpawn } from 'node-pty'

/**
 * `node-pty` is the one thing in this engine that cannot be bundled — it is a
 * native module — and it is needed only by the dashboard. Loading it here, on
 * the first session rather than at import time, is what keeps the MCP server
 * and the three hooks free of native code: they import nothing from this file,
 * and a machine that never runs `/mjloop:web` never needs a compiler.
 *
 * `createRequire` rather than `await import`, so the factory stays synchronous
 * and the queue does not have to become async to accommodate it.
 */
const require = createRequire(import.meta.url)
let cached: { spawn: typeof PtySpawn } | null = null

export class PtyMissingError extends Error {
  constructor(cause: string) {
    super(`node-pty is not installed, so the dashboard cannot open a terminal (${cause})`)
    this.name = 'PtyMissingError'
  }
}

function pty(): { spawn: typeof PtySpawn } {
  if (cached !== null) return cached
  try {
    cached = require('node-pty') as { spawn: typeof PtySpawn }
  } catch (error) {
    throw new PtyMissingError((error as Error).message)
  }
  return cached
}

/** Whether a terminal can be opened, asked before the server starts listening. */
export function isPtyAvailable(): boolean {
  try {
    pty()
    return true
  } catch {
    return false
  }
}

/**
 * One `claude` session, seen as the four things the queue actually needs.
 *
 * The queue depends on this rather than on `node-pty` so its whole state
 * machine — sequencing, cancellation, the failure path, the shutdown ladder —
 * is testable without spawning a process or owning a terminal.
 */
export interface LoopSession {
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Signal defaults to SIGTERM. */
  kill(signal?: string): void
  onData(fn: (chunk: string) => void): void
  /** Called once, whether the exit was the session's own or the queue's doing. */
  onExit(fn: (code: number) => void): void
}

export interface SpawnOptions {
  /** The project directory. The loop reads `.mjloop/` relative to it. */
  cwd: string
  /** The loop command, handed to `claude` as its opening prompt. */
  command: string
  cols: number
  rows: number
}

export type SessionFactory = (options: SpawnOptions) => LoopSession

/**
 * The binary is overridable so the tests that do exercise a real pty can point
 * at a script instead of at the user's actual Claude Code.
 */
function claudeBinary(): string {
  const override = process.env.MJLOOP_WEB_CLAUDE_BIN
  return override !== undefined && override.length > 0 ? override : 'claude'
}

export const spawnPtySession: SessionFactory = ({ cwd, command, cols, rows }) => {
  const child = pty().spawn(claudeBinary(), [command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      // The session renders into a browser terminal that understands colour.
      // Inheriting a TERM from whatever launched the server would sometimes
      // hand `claude` a dumb terminal and lose its whole interface.
      TERM: 'xterm-256color',
    } as Record<string, string>,
  })

  return {
    write: (data) => child.write(data),
    resize: (nextCols, nextRows) => {
      // A resize racing the exit throws from the ioctl. The session is already
      // gone; there is nothing to resize and nothing to report.
      try {
        child.resize(nextCols, nextRows)
      } catch {
        /* exited */
      }
    },
    kill: (signal) => {
      try {
        child.kill(signal)
      } catch {
        /* already dead */
      }
    },
    onData: (fn) => {
      child.onData(fn)
    },
    onExit: (fn) => {
      child.onExit(({ exitCode }) => fn(exitCode))
    },
  }
}
