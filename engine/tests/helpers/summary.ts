import type { StateSummary } from '../../src/ops/summary.js'

/** A `stateSummary` result with everything at rest, for tests that vary one field. */
export function summary(overrides: Partial<StateSummary> = {}): StateSummary {
  return {
    initialised: true,
    recovered: false,
    status: 'idle',
    track: null,
    run_id: null,
    cycle: 0,
    max_cycles: null,
    plan: null,
    story: null,
    stage: 'idle',
    goal: null,
    findings: { high: 0, medium: 0, low: 0 },
    last_cycle: null,
    halt_reason: null,
    reproduction: null,
    design_system: false,
    config_error: null,
    ...overrides,
  }
}

/** A summary describing a live run. */
export function running(runId = '2026-07-28-001'): StateSummary {
  return summary({ status: 'running', track: 'build', run_id: runId, cycle: 1 })
}
