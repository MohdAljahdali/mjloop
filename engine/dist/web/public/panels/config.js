/**
 * Config — a typed editor in front of the guarded config mutator.
 *
 * The browser never sends a YAML path or a replacement document. It compares
 * these controls with the parsed document it received and sends a closed list
 * of typed changes plus that document's revision. The engine then validates
 * the whole result while holding the project lock and preserves comments.
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
import { submit } from '../ui/writes.js'

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
  const editor = /** @type {HTMLFormElement} */ (pick('config-editor'))
  const editorState = pick('config-editor-state')
  const saveButton = /** @type {HTMLButtonElement} */ (pick('config-save'))
  const resetButton = /** @type {HTMLButtonElement} */ (pick('config-reset'))
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

  /** @type {Config | null} */
  let baseline = null
  /** @type {string | null} */
  let editorRevision = null
  let dirty = false
  let saving = false
  let conflict = false
  let enabled = false

  editor.addEventListener('input', markDirty)
  editor.addEventListener('change', markDirty)

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
      updateEditor(view)

      verbatim(raw, view?.raw ?? '')
      flag(rawDetails, 'hidden', view?.raw === null || view?.raw === undefined)

      drawTelemetry(telemetry.value())

      if (parsed === null) {
        reconcile(verifyHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
        reconcile(policyHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
        reconcile(tracksHost, [], (entry) => entry, () => ({ root: document.createElement('tr'), update: () => {} }))
        return
      }

      reconcile(verifyHost, commandRows(parsed.verify), (entry) => entry.key, factRow)
      reconcile(policyHost, policyRows(parsed.verify), (entry) => entry.key, factRow)

      const tracks = /** @type {[string, any][]} */ (Object.entries(parsed.tracks))
      reconcile(tracksHost, tracks, ([name]) => name, trackRow)
    },
  })

  function markDirty() {
    if (!enabled) return
    dirty = true
    if (!conflict) flag(editorState, 'hidden', true)
    updateEditorActions()
  }

  /** @param {ConfigView | null} view */
  function updateEditor(view) {
    const parsed = view?.parsed ?? null
    const revision = view?.revision ?? null
    enabled = parsed !== null && revision !== null
    setEditorEnabled(editor, enabled)

    if (!enabled) {
      flag(editorState, 'hidden', false)
      phrase(editorState, view?.invalid === true ? 'config.editorInvalid' : 'config.editorUnavailable')
      updateEditorActions()
      return
    }

    if (revision !== editorRevision) {
      if (editorRevision !== null && dirty && !saving) {
        baseline = parsed
        editorRevision = revision
        conflict = true
        flag(editorState, 'hidden', false)
        phrase(editorState, 'config.editorChanged')
        updateEditorActions()
        return
      }
      baseline = parsed
      editorRevision = revision
      conflict = false
      dirty = false
      seedConfigForm(editor, /** @type {Config} */ (parsed))
    }

    flag(editorState, 'hidden', !conflict)
    if (conflict) phrase(editorState, 'config.editorChanged')
    updateEditorActions()
  }

  function updateEditorActions() {
    saveButton.disabled = !enabled || !dirty || saving || conflict
    resetButton.disabled = !enabled || (!dirty && !conflict) || saving
  }

  function save() {
    if (!enabled || baseline === null || editorRevision === null || saving || conflict) return
    if (!editor.reportValidity()) return
    let changes
    try {
      changes = collectConfigChanges(editor, baseline)
    } catch {
      flag(editorState, 'hidden', false)
      phrase(editorState, 'config.editorStructuredInvalid')
      return
    }
    if (changes.length === 0) {
      dirty = false
      updateEditorActions()
      return
    }

    saving = true
    updateEditorActions()
    submit(
      { kind: 'config.patch', revision: editorRevision, changes },
      {
        settled(receipt) {
          saving = false
          if (receipt.ok) dirty = false
          updateEditorActions()
        },
      },
    )
  }

  function reset() {
    if (!enabled || baseline === null) return
    seedConfigForm(editor, baseline)
    dirty = false
    conflict = false
    updateEditorActions()
    flag(editorState, 'hidden', true)
  }

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

  return { save, reset }
}

/**
 * Turn the editor into the same closed change vocabulary the server accepts.
 *
 * @param {HTMLFormElement} form
 * @param {Config} baseline
 * @returns {import('../../../store/config-mutation.js').ConfigChange[]}
 */
export function collectConfigChanges(form, baseline) {
  /** @type {import('../../../store/config-mutation.js').ConfigChange[]} */
  const changes = []
  /** @param {string} name */
  const boolean = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name)).checked
  /** @param {string} name */
  const number = (name) => Number(/** @type {HTMLInputElement} */ (form.elements.namedItem(name)).value)
  /** @param {string} name */
  const value = (name) => /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (
    form.elements.namedItem(name)
  ).value
  /** @param {string} name */
  const command = (name) => value(name).trim() || null
  /** @param {string} name */
  const patterns = (name) => value(name).split('\n').map((entry) => entry.trim()).filter(Boolean)

  push(changes, baseline.autonomous !== boolean('autonomous'), {
    kind: 'root',
    key: 'autonomous',
    value: boolean('autonomous'),
  })
  push(changes, baseline.verify_cache !== boolean('verify_cache'), {
    kind: 'root',
    key: 'verify_cache',
    value: boolean('verify_cache'),
  })
  push(changes, baseline.limits.max_parallel_agents !== number('max_parallel_agents'), {
    kind: 'limit',
    key: 'max_parallel_agents',
    value: number('max_parallel_agents'),
  })
  push(changes, baseline.limits.no_progress_strikes !== number('no_progress_strikes'), {
    kind: 'limit',
    key: 'no_progress_strikes',
    value: number('no_progress_strikes'),
  })

  for (const key of /** @type {const} */ (['plan_approval', 'commit', 'preflight'])) {
    const next = /** @type {'human' | 'auto'} */ (value(key))
    push(changes, baseline.gates[key] !== next, { kind: 'gate', key, value: next })
  }

  for (const key of VERIFY_COMMANDS) {
    const next = command(`verify_${key}`)
    push(changes, baseline.verify[key] !== next, { kind: 'verify.command', key, value: next })
  }
  for (const key of /** @type {const} */ (['timeout_ms', 'lock_timeout_ms'])) {
    const next = number(key)
    push(changes, baseline.verify[key] !== next, { kind: 'verify.number', key, value: next })
  }
  for (const key of VERIFY_COMMANDS) {
    const next = patterns(`patterns_${key}`)
    push(changes, JSON.stringify(baseline.verify.failure_patterns[key]) !== JSON.stringify(next), {
      kind: 'verify.patterns',
      key,
      value: next,
    })
  }

  const specialists = record(value('specialists_json'))
  for (const agent of [...new Set([...Object.keys(baseline.specialists), ...Object.keys(specialists)])].sort()) {
    const next = agent in specialists ? specialists[agent] : null
    push(changes, baseline.specialists[agent] !== next, {
      kind: 'specialist',
      agent,
      value: /** @type {'auto' | 'always' | 'never' | null} */ (next),
    })
  }

  const tracks = record(value('tracks_json'))
  for (const track of [...new Set([...Object.keys(baseline.tracks), ...Object.keys(tracks)])].sort()) {
    const next = track in tracks ? tracks[track] : null
    push(changes, JSON.stringify(baseline.tracks[track] ?? null) !== JSON.stringify(next), {
      kind: 'track',
      track,
      value: /** @type {Config['tracks'][string] | null} */ (next),
    })
  }
  return changes
}

/** @param {string} source @returns {Record<string, unknown>} */
function record(source) {
  const parsed = JSON.parse(source)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object')
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * @param {import('../../../store/config-mutation.js').ConfigChange[]} changes
 * @param {boolean} changed
 * @param {import('../../../store/config-mutation.js').ConfigChange} change
 */
function push(changes, changed, change) {
  if (changed) changes.push(change)
}

/** @param {HTMLFormElement} form @param {Config} config */
function seedConfigForm(form, config) {
  /** @param {string} name @param {unknown} value */
  const set = (name, value) => {
    const control = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (
      form.elements.namedItem(name)
    )
    control.value = String(value)
  }
  const autonomous = /** @type {HTMLInputElement} */ (form.elements.namedItem('autonomous'))
  const verifyCache = /** @type {HTMLInputElement} */ (form.elements.namedItem('verify_cache'))
  autonomous.checked = config.autonomous
  verifyCache.checked = config.verify_cache
  set('max_parallel_agents', config.limits.max_parallel_agents)
  set('no_progress_strikes', config.limits.no_progress_strikes)
  set('plan_approval', config.gates.plan_approval)
  set('commit', config.gates.commit)
  set('preflight', config.gates.preflight)
  for (const key of VERIFY_COMMANDS) set(`verify_${key}`, config.verify[key] ?? '')
  set('timeout_ms', config.verify.timeout_ms)
  set('lock_timeout_ms', config.verify.lock_timeout_ms)
  for (const key of VERIFY_COMMANDS) set(`patterns_${key}`, config.verify.failure_patterns[key].join('\n'))
  set('specialists_json', JSON.stringify(config.specialists, null, 2))
  set('tracks_json', JSON.stringify(config.tracks, null, 2))
}

/** @param {HTMLFormElement} form @param {boolean} enabled */
function setEditorEnabled(form, enabled) {
  for (const control of form.querySelectorAll('input, select, textarea')) {
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
      control.disabled = !enabled
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
