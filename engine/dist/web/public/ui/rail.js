/**
 * The status rail: what you must never have to go looking for.
 *
 * Visible in every tab, so nothing below it can push the run's own state below
 * the fold. Above it sit the page-level banners — promoted out of the sidebar
 * where they used to whisper at the weight of a normal row. `config_error` is a
 * total outage and must not read like the cycle count.
 */
import { attr, flag, phrase, verbatim } from './dom.js'
import { time } from '../lib/fmt.js'

/** @typedef {import('../../protocol.js').Snapshot} Snapshot */

/** @type {Record<string, HTMLElement>} */
let node = {}

/**
 * @param {Record<string, HTMLElement>} slots
 */
export function mountRail(slots) {
  node = slots
}

/**
 * @param {HTMLElement | undefined} host
 * @param {boolean} on
 */
function show(host, on) {
  if (host !== undefined) flag(host, 'hidden', !on)
}

/**
 * @param {Snapshot} snapshot
 */
export function drawRail(snapshot) {
  const state = snapshot.state
  const running = state.status !== 'idle' && state.status !== 'uninitialised'

  const status = node['status']
  if (status !== undefined) {
    phrase(status, `status.${state.status}`)
    attr(status, 'data-status', state.status)
  }

  show(node['detail'], running)
  if (running) {
    const track = node['track']
    // A track name comes from the user's own config, so it is an identifier
    // rather than prose: `t()`'s `?? key` fallback would render it, but through
    // `verbatim()` it also keeps its digits and its direction.
    if (track !== undefined) verbatim(track, state.track ?? '—')

    const cycle = node['cycle']
    if (cycle !== undefined) {
      // Cycle numbers are identifiers, not counts: `Intl.NumberFormat('ar')`
      // would render `3/5` as `٣/٥`.
      verbatim(cycle, `${state.cycle}/${state.max_cycles === null ? '?' : state.max_cycles}`)
    }

    const target = node['target']
    if (target !== undefined) verbatim(target, state.story ?? state.plan ?? '')
    show(node['target'], (state.story ?? state.plan) !== null)

    const stage = node['stage']
    if (stage !== undefined) phrase(stage, `stage.${state.stage}`)

    const run = node['run']
    if (run !== undefined) verbatim(run, state.run_id ?? '')
    show(node['run'], state.run_id !== null)

    const findings = node['findings']
    if (findings !== undefined) {
      phrase(findings, 'rail.findings', {
        high: state.findings.high,
        medium: state.findings.medium,
        low: state.findings.low,
      })
    }
    // The counts are only worth a slot when there is something to count.
    show(node['findings'], state.findings.high + state.findings.medium + state.findings.low > 0)

    const gate = node['gate']
    if (gate !== undefined && state.reproduction !== null) {
      phrase(gate, state.reproduction.proven ? 'rail.gate.open' : 'rail.gate.shut')
    }
    show(node['gate'], state.reproduction !== null)
  }

  show(node['stop'], snapshot.session.jobId !== null)

  // ── banners ──────────────────────────────────────────────────────────────
  const configError = node['configError']
  if (configError !== undefined) verbatim(configError, state.config_error ?? '')
  show(node['configBanner'], state.config_error !== null)

  // The state came from `.bak`, so it describes the write *before* the last
  // one. Fine to report on, not fine to decide on — and a user staring at a
  // cycle count has no other way to know.
  show(node['staleBanner'], state.recovered)

  show(node['designBanner'], state.initialised && !state.design_system)

  // `autonomous: false` lets a session end its turn mid-run and wait for a
  // human. A queue that cannot see that hangs forever on job one, so this is a
  // notice and a button — never automatic input.
  const stalledSince = snapshot.session.stalledSince
  const stalledText = node['stalledText']
  if (stalledText !== undefined && stalledSince !== null) {
    phrase(stalledText, 'session.stalled', { time: time(stalledSince) })
  }
  show(node['stalledBanner'], stalledSince !== null)
}
