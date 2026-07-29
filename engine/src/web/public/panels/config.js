/**
 * Config — read-only, and it says so.
 *
 * `writeConfig` serialises the whole parsed document back to YAML, dropping
 * every comment and every key the schema stripped, and it takes no lock —
 * unlike every state and plan write. Its only caller is `init`. So this tab
 * reads, names the `config.yaml` key behind each value, and shows the file as
 * written; it does not offer to set anything.
 *
 * The three verify commands get a callout when unset: each is injected verbatim
 * into every agent brief, and a missing one is a `blocked` the engine is
 * forbidden to invent around.
 *
 * The specialist telemetry is the one thing here that is not configuration. It
 * is on this tab because it is the only useful reading of a `specialists:` map:
 * the mode a project set is one column beside what that agent actually
 * returned. It is a report and never a rule — nothing in the engine drafts or
 * skips an agent because of a number in it.
 */
import { clone, flag, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { pluralKey } from '../lib/i18n.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/**
 * @typedef {import('../../read.js').ConfigView} ConfigView
 * @typedef {NonNullable<ConfigView['parsed']>} Config
 */

/**
 * What `/api/telemetry` serves, taken from the reader that serves it rather
 * than restated here.
 *
 * `public/` is the browser and imports no engine module, but `read.ts` is the
 * wire this page is already typed against — so a column renamed on the engine
 * side is a compile error rather than a cell that silently goes blank.
 *
 * @typedef {Awaited<ReturnType<typeof import('../../read.js').readTelemetryReport>>} Telemetry
 * @typedef {Telemetry['specialists'][number]} SpecialistRow
 */

/**
 * The slots that are commands, named rather than derived.
 *
 * `verify:` is not a map of commands: it also carries `timeout_ms`,
 * `lock_timeout_ms` and `failure_patterns`, all of which are executed policy
 * and none of which is a string the engine spawns. A row per
 * `Object.entries(verify)` put all three under "Verify commands" — three lines
 * telling an operator the engine runs a number.
 */
const VERIFY_COMMANDS = /** @type {const} */ (['test', 'lint', 'build'])

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountConfig() {
  const node = pick('panel-config')
  const design = pick('config-design')
  const project = pick('config-project')
  const autonomous = pick('config-autonomous')
  const strikes = pick('config-strikes')
  const planGate = pick('config-plan-gate')
  const commitGate = pick('config-commit-gate')
  const preflightGate = pick('config-preflight-gate')
  const verifyCache = pick('config-verify-cache')
  const verifyHost = pick('config-verify')
  const policyHost = pick('config-verify-policy')
  const tracksHost = pick('config-tracks')
  const telemetryEmpty = pick('telemetry-empty')
  const telemetryFlagged = pick('telemetry-flagged')
  const telemetryTable = pick('telemetry-table')
  const telemetryHost = pick('telemetry-list')
  const telemetryMore = pick('telemetry-more')
  const rawDetails = pick('config-raw-details')
  const raw = pick('config-raw')

  /** @type {import('../lib/api.js').Feed<ConfigView>} */
  const config = feed({
    dep: (state) => state.revisions.config,
    path: () => '/api/config',
    onChange: () => draw(),
  })

  /**
   * `revisions.runs` alone, and not the cycle tick.
   *
   * That revision is the run directory listing plus its own mtime, so it does
   * not move when a `cycle-NN/<agent>.json` lands inside a run already open.
   * This table therefore goes stale during a live run and refreshes when the
   * next one opens — which is the right trade for a report whose subject is
   * the last fifty runs: they do not change while one of them is in flight,
   * and the alternative is a cross-run walk at the poller's rate.
   *
   * @type {import('../lib/api.js').Feed<Telemetry>}
   */
  const telemetry = feed({
    dep: (state) => state.revisions.runs,
    path: () => '/api/telemetry',
    onChange: () => draw(),
  })

  register({
    id: 'config',
    node,
    update(state) {
      config.update(state)
      telemetry.update(state)

      phrase(design, state.state.design_system ? 'config.design.present' : 'config.design.missing')
      // An absolute path: an identifier, and one that must not be mirrored.
      verbatim(project, state.project)

      const view = config.value()
      const parsed = view?.parsed ?? null

      verbatim(raw, view?.raw ?? '')
      flag(rawDetails, 'hidden', view?.raw === null || view?.raw === undefined)

      drawTelemetry(telemetry.value())

      if (parsed === null) {
        verbatim(autonomous, '—')
        verbatim(strikes, '—')
        verbatim(planGate, '—')
        verbatim(commitGate, '—')
        verbatim(preflightGate, '—')
        verbatim(verifyCache, '—')
        reconcile(verifyHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
        reconcile(policyHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
        reconcile(tracksHost, [], (entry) => entry, () => ({ root: document.createElement('tr'), update: () => {} }))
        return
      }

      // Values the user set, shown as they appear in the file.
      verbatim(autonomous, String(parsed.autonomous))
      verbatim(strikes, String(parsed.limits.no_progress_strikes))
      verbatim(planGate, parsed.gates.plan_approval)
      verbatim(commitGate, parsed.gates.commit)
      verbatim(preflightGate, parsed.gates.preflight)
      verbatim(verifyCache, String(parsed.verify_cache))

      reconcile(verifyHost, commandRows(parsed.verify), (entry) => entry.key, factRow)
      reconcile(policyHost, policyRows(parsed.verify), (entry) => entry.key, factRow)

      const tracks = /** @type {[string, any][]} */ (Object.entries(parsed.tracks))
      reconcile(tracksHost, tracks, ([name]) => name, trackRow)
    },
  })

  /** @param {Telemetry | null} view */
  function drawTelemetry(view) {
    const rows = view?.specialists ?? []
    flag(telemetryTable, 'hidden', rows.length === 0)
    // "Nothing to report" is claimed only once the report has arrived. A
    // project that has never run genuinely has nothing to say about any agent
    // — a table of zeroes would be a report about the config rather than about
    // what happened — but neither has a fetch that is still in flight.
    flag(telemetryEmpty, 'hidden', view === null || rows.length > 0)
    reconcile(telemetryHost, rows, (row) => row.agent, specialistRow)

    const truncated = view?.truncated ?? 0
    flag(telemetryMore, 'hidden', truncated === 0)
    if (truncated > 0) phrase(telemetryMore, pluralKey('telemetry.truncated', truncated), { count: truncated })

    const flagged = view?.flagged ?? []
    flag(telemetryFlagged, 'hidden', flagged.length === 0)
    if (flagged.length > 0) {
      phrase(telemetryFlagged, pluralKey('telemetry.flagged', flagged.length), {
        count: flagged.length,
        agents: flagged.join(', '),
      })
    }
  }
}

/**
 * @param {Config['verify']} verify
 * @returns {{ key: string, value: string | null }[]}
 */
function commandRows(verify) {
  return VERIFY_COMMANDS.map((slot) => ({ key: `verify.${slot}`, value: verify[slot] }))
}

/**
 * @param {Config['verify']} verify
 * @returns {{ key: string, value: string | null }[]}
 */
function policyRows(verify) {
  /** @type {{ key: string, value: string | null }[]} */
  const rows = [
    { key: 'verify.timeout_ms', value: String(verify.timeout_ms) },
    { key: 'verify.lock_timeout_ms', value: String(verify.lock_timeout_ms) },
  ]
  // Only the slots that override the defaults. An empty array is the schema's
  // own value and says nothing a reader of `config.yaml` did not already know.
  for (const slot of VERIFY_COMMANDS) {
    const patterns = verify.failure_patterns[slot]
    if (patterns.length > 0) rows.push({ key: `verify.failure_patterns.${slot}`, value: patterns.join('  ') })
  }
  return rows
}

function factRow() {
  const { root, slots } = clone('tpl-fact')
  return {
    root,
    /** @param {{ key: string, value: string | null }} entry */
    update({ key, value }) {
      // A `config.yaml` key, and the whole point of naming it: an identifier.
      const label = slots['label']
      if (label !== undefined) verbatim(label, key)
      const cell = slots['value']
      if (cell !== undefined) {
        // Unset is the case worth saying out loud, not a blank cell: this
        // string is injected verbatim into every agent brief, and an agent
        // that cannot verify is one the engine is forbidden to work around.
        if (value === null) phrase(cell, 'config.verifyUnset')
        else verbatim(cell, value)
      }
    },
  }
}

function trackRow() {
  const { root, slots } = clone('tpl-track')
  return {
    root,
    /** @param {[string, { required: string[], available: string[], max_cycles: number, gate?: { proven_by: string, blocks: string[] } }]} entry */
    update([name, track]) {
      const label = slots['name']
      if (label !== undefined) verbatim(label, name)
      const required = slots['required']
      if (required !== undefined) verbatim(required, track.required.join(', '))
      const available = slots['available']
      if (available !== undefined) verbatim(available, track.available.join(', ') || '—')
      const max = slots['max']
      if (max !== undefined) verbatim(max, String(track.max_cycles))
      const gate = slots['gate']
      if (gate !== undefined) {
        verbatim(gate, track.gate === undefined ? '—' : `${track.gate.proven_by} → ${track.gate.blocks.join(', ')}`)
      }
    },
  }
}

function specialistRow() {
  const { root, slots } = clone('tpl-specialist')
  return {
    root,
    /** @param {SpecialistRow} row */
    update(row) {
      const agent = slots['agent']
      if (agent !== undefined) verbatim(agent, row.agent)
      // `auto`, `always`, `never` — a value out of the user's own config file,
      // and an em dash where the project has no rule about this agent at all.
      const mode = slots['mode']
      if (mode !== undefined) verbatim(mode, row.mode ?? '—')

      const drafted = slots['drafted']
      if (drafted !== undefined) verbatim(drafted, row.drafted)
      const skipped = slots['skipped']
      if (skipped !== undefined) verbatim(skipped, row.skipped)
      const landed = slots['landed']
      if (landed !== undefined) verbatim(landed, row.landed)

      // Counts packed into one cell each, in the fixed order the column
      // heading names. Through `verbatim()` like every other digit on this
      // page: `Intl` would render `2/1/0` as `٢/١/٠` in Arabic, and these are
      // read against the heading rather than as prose.
      const results = slots['results']
      if (results !== undefined) verbatim(results, `${row.results.pass}/${row.results.fail}/${row.results.blocked}`)
      const findings = slots['findings']
      if (findings !== undefined) {
        verbatim(findings, `${row.findings.high}/${row.findings.medium}/${row.findings.low}`)
      }

      const runs = slots['runs']
      if (runs !== undefined) verbatim(runs, row.runs)
      const lastRun = slots['lastRun']
      if (lastRun !== undefined) verbatim(lastRun, row.last_seen ?? '—')
    },
  }
}
