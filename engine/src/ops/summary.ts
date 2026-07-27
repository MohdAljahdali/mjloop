import fs from 'node:fs/promises'
import { findTrack } from '../schemas/config.js'
import type { Severity, State } from '../schemas/state.js'
import { loadConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { StateStore } from '../store/state-store.js'

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
  /** Whether `.loop/design-system.md` exists. The UI agents need one and will not invent it. */
  design_system: boolean
}

const NO_FINDINGS: Record<Severity, number> = { high: 0, medium: 0, low: 0 }

/** A regular file, not merely a path that exists — a directory here is not a design system. */
async function hasDesignSystem(projectDir: string): Promise<boolean> {
  try {
    return (await fs.stat(resolveLoopPaths(projectDir).designSystem)).isFile()
  } catch {
    return false
  }
}

/**
 * A compact view for the leader and the SessionStart hook. Deliberately not
 * the whole state file — the leader's context must not grow with cycle count.
 */
export async function stateSummary(projectDir: string): Promise<StateSummary> {
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
    }
  }

  let maxCycles: number | null = null
  let reproduction: { proven: boolean; ref: string | null } | null = null
  try {
    const config = await loadConfig(projectDir)
    const track = state.track === null ? undefined : findTrack(config, state.track)
    maxCycles = track?.max_cycles ?? null
    if (track?.gate !== undefined) {
      reproduction = { proven: state.reproduction !== null, ref: state.reproduction?.ref ?? null }
    }
  } catch {
    // A config that cannot be read degrades the summary; it does not fail it.
    // The SessionStart hook renders this line on every session, and a YAML
    // typo in a hand-edited config must not turn that into a stack trace.
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
  }
}

/** One line for the SessionStart hook and `/loop:status`. */
export function renderSummaryLine(summary: StateSummary): string {
  if (!summary.initialised) return 'Loop: not initialised in this project — run /loop:init to set it up.'
  if (summary.status === 'idle') return 'Loop: initialised, no active run.'

  const target = summary.story ?? 'adhoc'
  const cap = summary.max_cycles === null ? '?' : String(summary.max_cycles)
  const findings = `${summary.findings.high}H/${summary.findings.medium}M/${summary.findings.low}L`
  const tail = summary.halt_reason === null ? '' : ` — ${summary.halt_reason}`
  // Rendered from the gate's data, not from one track's story: a gate on a
  // custom track proves whatever that track says it proves.
  const gate = summary.reproduction === null ? '' : summary.reproduction.proven ? ' · gate open' : ' · gate shut'
  return `Loop: ${summary.status} · track ${summary.track} · ${target} · cycle ${summary.cycle}/${cap} · stage ${summary.stage} · findings ${findings}${gate}${tail}`
}
