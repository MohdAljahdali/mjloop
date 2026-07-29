import fs from 'node:fs/promises'
import path from 'node:path'
import { findTrack, type Config } from '../schemas/config.js'
import type { Severity, State } from '../schemas/state.js'
import { ConfigMissingError, loadConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { StateStore } from '../store/state-store.js'
import { runDirName, runDirPath } from './run.js'

export interface StateSummary {
  initialised: boolean
  /**
   * True when `state.json` was unreadable and the value came from `.bak` — so
   * this summary describes the write *before* the last one. Reporting on it is
   * fine; deciding on it is not, and the autonomous `Stop` guard treats it as
   * state it cannot reason about.
   */
  recovered: boolean
  status: State['status'] | 'uninitialised'
  track: string | null
  run_id: string | null
  cycle: number
  max_cycles: number | null
  plan: string | null
  story: string | null
  stage: string
  goal: string | null
  /**
   * The open cycle's findings while a run is `running`; on a run that has
   * ended, the ones the last cycle closed with — the same list HALT.md prints.
   */
  findings: Record<Severity, number>
  last_cycle: { result: string; agents: string[] } | null
  halt_reason: string | null
  /**
   * The state of the running track's gate: `null` when the track has no gate,
   * otherwise whether it has been opened and by which command. What the gate
   * proves is the track's business — on `fix` it is a reproduction.
   */
  reproduction: { proven: boolean; ref: string | null } | null
  /** Whether `.mjloop/design-system.md` exists. The UI agents need one and will not invent it. */
  design_system: boolean
  /**
   * The run map's repo-relative path once the run has one, else null.
   *
   * One `fs.stat`, exactly as `design_system` is, so the leader learns the path
   * from the call it already makes rather than listing the run directory at
   * compose time. `handoff` is deliberately **not** here beside it: the handoff
   * path is `cycleAdvance`'s return value, which the leader is already holding
   * when it composes the next brief, and putting a derivable string on every
   * summary payload buys nothing.
   */
  map: string | null
  /**
   * The reason the config could not be read, or null. Every other field
   * degrades silently when config is unreadable — this is the one that says so,
   * because a user whose config has a typo currently sees nothing at all.
   */
  config_error: string | null
}

const NO_FINDINGS: Record<Severity, number> = { high: 0, medium: 0, low: 0 }

/**
 * The run map's file name. `runLog` writes it and this reports it; the two
 * agree on one word, in the same way `runStart` and `verifyRun` agree on the
 * pin's. `map` is a reserved agent name, so nothing else can produce this file.
 */
const MAP_FILE = 'map.md'

/** A regular file, not merely a path that exists — a directory here is not a design system. */
async function hasDesignSystem(projectDir: string): Promise<boolean> {
  try {
    return (await fs.stat(resolveLoopPaths(projectDir).designSystem)).isFile()
  } catch {
    return false
  }
}

/**
 * Repo-relative, so the value can be handed to an agent as it stands — the same
 * form `HistoryEntry.ref` takes. Null before a mapping agent has passed, and
 * null on a track that declares no mapping agent, which are the same answer to
 * the only question the leader asks: is there a map to carry forward?
 */
async function runMap(projectDir: string, state: State): Promise<string | null> {
  if (state.run_id === null || state.track === null) return null
  try {
    if (!(await fs.stat(path.join(runDirPath(projectDir, state), MAP_FILE))).isFile()) return null
  } catch {
    return null
  }
  return path.join('.mjloop', 'runs', runDirName(state), MAP_FILE)
}

/**
 * A compact view for the leader and the SessionStart hook. Deliberately not
 * the whole state file — the leader's context must not grow with cycle count.
 */
export async function stateSummary(projectDir: string): Promise<StateSummary> {
  // Read before the state, and reported whether or not the state reads. A
  // project whose config is broken is exactly the project whose state cannot be
  // read — `.mjloop` unreadable breaks both — and the /mjloop:add validation
  // contract checks this field after an edit that may have left neither usable.
  //
  // A missing config is not an error: a project may be mid-provisioning.
  // Anything else is worth surfacing.
  let config: Config | null = null
  let configError: string | null = null
  try {
    config = await loadConfig(projectDir)
  } catch (error) {
    // A config that cannot be read degrades the summary; it does not fail it.
    // The SessionStart hook renders this line on every session, and a YAML
    // typo in a hand-edited config must not turn that into a stack trace.
    configError = error instanceof ConfigMissingError ? null : (error as Error).message
  }

  let state: State
  let recovered: boolean
  try {
    ;({ state, recovered } = await new StateStore(projectDir).read())
  } catch {
    return {
      initialised: false,
      recovered: false,
      status: 'uninitialised',
      track: null,
      run_id: null,
      cycle: 0,
      max_cycles: null,
      plan: null,
      story: null,
      stage: 'idle',
      goal: null,
      findings: { ...NO_FINDINGS },
      last_cycle: null,
      halt_reason: null,
      reproduction: null,
      design_system: false,
      map: null,
      config_error: configError,
    }
  }

  let maxCycles: number | null = null
  let reproduction: { proven: boolean; ref: string | null } | null = null
  if (config !== null) {
    const track = state.track === null ? undefined : findTrack(config, state.track)
    maxCycles = track?.max_cycles ?? null
    if (track?.gate !== undefined) {
      reproduction = { proven: state.reproduction !== null, ref: state.reproduction?.ref ?? null }
    }
  }

  const findings = { ...NO_FINDINGS }
  for (const finding of state.findings) findings[finding.severity] += 1

  const last = state.history.at(-1)

  return {
    initialised: true,
    recovered,
    status: state.status,
    track: state.track,
    run_id: state.run_id,
    cycle: state.cycle,
    max_cycles: maxCycles,
    plan: state.current.plan,
    story: state.current.story,
    stage: state.current.stage,
    goal: state.goal,
    findings,
    last_cycle: last === undefined ? null : { result: last.result, agents: last.agents },
    halt_reason: state.halt_reason,
    reproduction,
    design_system: await hasDesignSystem(projectDir),
    map: await runMap(projectDir, state),
    config_error: configError,
  }
}

/** The line is one line: a prettified schema error arrives with newlines in it. */
const CONFIG_ERROR_MAX = 200

function configClause(summary: StateSummary): string {
  if (summary.config_error === null) return ''
  const flattened = summary.config_error.replace(/\s+/g, ' ').trim()
  const shown = flattened.length > CONFIG_ERROR_MAX ? `${flattened.slice(0, CONFIG_ERROR_MAX)}…` : flattened
  return ` · config error: ${shown}`
}

/** One line for the SessionStart hook and `/mjloop:status`. */
export function renderSummaryLine(summary: StateSummary): string {
  // Rendered on every branch, including both early returns: a project whose
  // config has a typo sits in exactly those states, and this line is the only
  // surface that would otherwise never say so.
  const config = configClause(summary)
  if (!summary.initialised) {
    return `Loop: not initialised in this project — run /mjloop:init to set it up.${config}`
  }
  if (summary.status === 'idle') return `Loop: initialised, no active run.${config}`

  const target = summary.story ?? 'adhoc'
  const cap = summary.max_cycles === null ? '?' : String(summary.max_cycles)
  const findings = `${summary.findings.high}H/${summary.findings.medium}M/${summary.findings.low}L`
  const tail = summary.halt_reason === null ? '' : ` — ${summary.halt_reason}`
  // Rendered from the gate's data, not from one track's story: a gate on a
  // custom track proves whatever that track says it proves.
  const gate = summary.reproduction === null ? '' : summary.reproduction.proven ? ' · gate open' : ' · gate shut'
  return `Loop: ${summary.status} · track ${summary.track} · ${target} · cycle ${summary.cycle}/${cap} · stage ${summary.stage} · findings ${findings}${gate}${config}${tail}`
}
