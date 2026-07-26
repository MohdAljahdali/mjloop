#!/usr/bin/env node
import path from 'node:path'
import { renderSummaryLine, stateSummary } from '../ops/summary.js'
import { PROTECTED_BASENAMES } from '../store/paths.js'

const USAGE = `usage: loop-cli <command>

  summary [--dir <path>] [--json]   print the current loop state
  session-start                     SessionStart hook (reads hook JSON on stdin)
  state-guard                       PreToolUse hook (reads hook JSON on stdin)
`

export interface CliResult {
  stdout: string
  exitCode: number
}

export async function runCli(argv: string[], stdin: string): Promise<CliResult> {
  const [command, ...rest] = argv
  switch (command) {
    case 'summary':
      return summaryCommand(rest)
    case 'session-start':
      return sessionStartCommand(stdin)
    case 'state-guard':
      return stateGuardCommand(stdin)
    default:
      return { stdout: USAGE, exitCode: 1 }
  }
}

async function summaryCommand(args: string[]): Promise<CliResult> {
  const dirIndex = args.indexOf('--dir')
  const dir = dirIndex === -1 ? process.cwd() : args[dirIndex + 1] ?? process.cwd()
  const summary = await stateSummary(dir)
  const stdout = args.includes('--json') ? `${JSON.stringify(summary, null, 2)}\n` : `${renderSummaryLine(summary)}\n`
  return { stdout, exitCode: 0 }
}

async function sessionStartCommand(stdin: string): Promise<CliResult> {
  const cwd = readCwd(stdin)
  const summary = await stateSummary(cwd)
  // Say nothing in projects that do not use loop — silence beats noise.
  if (!summary.initialised) return { stdout: '', exitCode: 0 }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: renderSummaryLine(summary),
    },
  }
  return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 }
}

async function stateGuardCommand(stdin: string): Promise<CliResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin) as unknown
  } catch {
    return { stdout: '', exitCode: 0 }
  }
  const verdict = evaluateStateGuard(input)
  if (!verdict.deny) return { stdout: '', exitCode: 0 }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }
  return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 }
}

export interface GuardVerdict {
  deny: boolean
  reason: string
}

/**
 * Loop state is owned by the MCP server. A model editing it by hand is the
 * fastest way to lose a run, so the write is denied outright.
 */
export function evaluateStateGuard(input: unknown): GuardVerdict {
  const filePath = extractFilePath(input)
  if (filePath === null) return { deny: false, reason: '' }

  const segments = filePath.split(path.sep)
  if (!segments.includes('.loop')) return { deny: false, reason: '' }

  const basename = path.basename(filePath)
  if (!PROTECTED_BASENAMES.includes(basename as (typeof PROTECTED_BASENAMES)[number])) {
    return { deny: false, reason: '' }
  }

  return {
    deny: true,
    reason: `${basename} is owned by the loop MCP server. Use the loop_* tools (loop_run_start, loop_cycle_advance, loop_story_update, ...) instead of editing it directly.`,
  }
}

function extractFilePath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const toolInput = (input as { tool_input?: unknown }).tool_input
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const filePath = (toolInput as { file_path?: unknown }).file_path
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
}

function readCwd(stdin: string): string {
  try {
    const parsed = JSON.parse(stdin) as { cwd?: unknown }
    return typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : process.cwd()
  } catch {
    return process.cwd()
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`
if (isEntrypoint) {
  const stdin = process.stdin.isTTY === true ? '' : await readAll()
  const result = await runCli(process.argv.slice(2), stdin)
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  process.exitCode = result.exitCode
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
