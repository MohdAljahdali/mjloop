import type { Severity, State } from '../schemas/state.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore } from '../store/state-store.js'

export interface StateSummary {
  initialised: boolean
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
}

const NO_FINDINGS: Record<Severity, number> = { high: 0, medium: 0, low: 0 }

/**
 * A compact view for the leader and the SessionStart hook. Deliberately not
 * the whole state file — the leader's context must not grow with cycle count.
 */
export async function stateSummary(projectDir: string): Promise<StateSummary> {
  let state: State
  try {
    state = await new StateStore(projectDir).get()
  } catch {
    return {
      initialised: false,
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
    }
  }

  let maxCycles: number | null = null
  try {
    const config = await loadConfig(projectDir)
    maxCycles = state.track === null ? null : config.tracks[state.track]?.max_cycles ?? null
  } catch {
    // A missing or hand-broken config.yaml (HALT.md tells users to edit it)
    // must not take the summary — and with it the SessionStart hook — down.
    // The cap simply degrades to unknown.
  }

  const findings = { ...NO_FINDINGS }
  for (const finding of state.findings) findings[finding.severity] += 1

  const last = state.history.at(-1)

  return {
    initialised: true,
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
  return `Loop: ${summary.status} · track ${summary.track} · ${target} · cycle ${summary.cycle}/${cap} · stage ${summary.stage} · findings ${findings}${tail}`
}
