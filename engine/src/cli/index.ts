#!/usr/bin/env node
import path from 'node:path'
import { renderSummaryLine, stateSummary, type StateSummary } from '../ops/summary.js'
import { loadConfig } from '../store/config-store.js'
import { PROTECTED_BASENAMES } from '../store/paths.js'
import { isEntrypoint } from '../util/entrypoint.js'

const USAGE = `usage: loop-cli <command>

  summary [--dir <path>] [--json]   print the current loop state
  session-start                     SessionStart hook (reads hook JSON on stdin)
  state-guard                       PreToolUse hook (reads hook JSON on stdin)
  stop-guard                        Stop hook (reads hook JSON on stdin)
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
    case 'stop-guard':
      return stopGuardCommand(stdin)
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
    reason: `${basename} is owned by the loop MCP server. Use the loop_* tools (loop_run_start, loop_cycle_advance, loop_run_log, ...) instead of editing it directly.`,
  }
}

export interface StopVerdict {
  block: boolean
  reason: string
}

/**
 * Decide whether an autonomous run should keep going when Claude Code is about
 * to end the turn.
 *
 * Every branch that is not "a running loop in a project that opted in" allows
 * the stop. That includes anything this function could not make sense of: a
 * guard that blocks on its own confusion traps the session, and there is no
 * way out from inside it.
 */
export function evaluateStopGuard(input: unknown, summary: StateSummary, autonomous: boolean): StopVerdict {
  if (typeof input !== 'object' || input === null) return { block: false, reason: '' }

  // Claude Code sets this once a Stop hook has already caused a continuation
  // this turn. Re-blocking is how a hook loops forever; its own cap on
  // consecutive blocks is a backstop, not a design.
  if ((input as { stop_hook_active?: unknown }).stop_hook_active === true) return { block: false, reason: '' }

  if (!autonomous) return { block: false, reason: '' }
  if (!summary.initialised) return { block: false, reason: '' }

  // `state.json` was unreadable and this summary came from `.bak`, so it is the
  // previous write — a run recorded as `running` here may already be done. The
  // store itself could not trust the primary; blocking is the one decision that
  // must never be made on state that stale.
  if (summary.recovered) return { block: false, reason: '' }

  if (summary.status !== 'running') return { block: false, reason: '' }

  // No cap means the running track is not in config — renamed, removed, or on
  // another branch. `cycleAdvance` throws before any status transition in that
  // state, so none of the guards named below can ever end this run: blocking
  // would promise an ending that cannot arrive, once per turn, forever. An
  // uncapped run is also exactly the run that should not continue unattended.
  if (summary.max_cycles === null) return { block: false, reason: '' }

  const open = summary.findings.high + summary.findings.medium + summary.findings.low
  // The open cycle's, not the previous one's: `cycleAdvance` clears findings
  // before it increments the cycle, so a non-zero count here was logged by
  // this cycle's own agents.
  const findings =
    open === 0
      ? 'There are no open findings in this cycle.'
      : `${open} open findings in this cycle (${summary.findings.high} high, ${summary.findings.medium} medium, ${summary.findings.low} low).`

  return {
    block: true,
    reason: [
      `Loop is running autonomously: track ${summary.track}, cycle ${summary.cycle} of ${summary.max_cycles}, stage ${summary.stage}.`,
      `Goal: ${summary.goal ?? 'not set'}.`,
      findings,
      'Continue the cycle with the loop-leader skill. Do not stop until the run reaches done or halted —',
      "the engine's guards end it: the cycle cap, the stagnation guard, and the repeated-error guard.",
    ].join('\n'),
  }
}

async function stopGuardCommand(stdin: string): Promise<CliResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin) as unknown
  } catch {
    return { stdout: '', exitCode: 0 }
  }

  const cwd = readCwd(stdin)
  const summary = await stateSummary(cwd)

  let autonomous = false
  try {
    autonomous = (await loadConfig(cwd)).autonomous
  } catch {
    // Every way of failing to read the config means the same thing: nothing
    // opted in. A project with no config never did, and a malformed or
    // unreadable one cannot be read as having done so. Assigned rather than
    // left to the initialiser above, so the fail-safe survives a refactor that
    // seeds `autonomous` from a cached value or a default object.
    autonomous = false
  }

  const verdict = evaluateStopGuard(input, summary, autonomous)
  if (!verdict.block) return { stdout: '', exitCode: 0 }

  // A top-level decision object. This is NOT the hookSpecificOutput shape the
  // SessionStart and PreToolUse hooks use — the Stop event has its own.
  return { stdout: `${JSON.stringify({ decision: 'block', reason: verdict.reason })}\n`, exitCode: 0 }
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

if (await isEntrypoint(import.meta.url)) {
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
