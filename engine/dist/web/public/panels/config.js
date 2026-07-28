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
 */
import { clone, flag, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/** @typedef {import('../../read.js').ConfigView} ConfigView */

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
  const verifyHost = pick('config-verify')
  const tracksHost = pick('config-tracks')
  const specialistsBlock = pick('config-specialists-block')
  const specialistsHost = pick('config-specialists')
  const rawDetails = pick('config-raw-details')
  const raw = pick('config-raw')

  /** @type {import('../lib/api.js').Feed<ConfigView>} */
  const config = feed({
    dep: (state) => state.revisions.config,
    path: () => '/api/config',
    onChange: () => draw(),
  })

  register({
    id: 'config',
    node,
    update(state) {
      config.update(state)

      phrase(design, state.state.design_system ? 'config.design.present' : 'config.design.missing')
      // An absolute path: an identifier, and one that must not be mirrored.
      verbatim(project, state.project)

      const view = config.value()
      const parsed = view?.parsed ?? null

      verbatim(raw, view?.raw ?? '')
      flag(rawDetails, 'hidden', view?.raw === null || view?.raw === undefined)

      if (parsed === null) {
        verbatim(autonomous, '—')
        verbatim(strikes, '—')
        verbatim(planGate, '—')
        verbatim(commitGate, '—')
        reconcile(verifyHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
        reconcile(tracksHost, [], (entry) => entry, () => ({ root: document.createElement('tr'), update: () => {} }))
        flag(specialistsBlock, 'hidden', true)
        return
      }

      // Values the user set, shown as they appear in the file.
      verbatim(autonomous, String(parsed.autonomous))
      verbatim(strikes, String(parsed.limits.no_progress_strikes))
      verbatim(planGate, parsed.gates.plan_approval)
      verbatim(commitGate, parsed.gates.commit)

      const verify = /** @type {[string, string | null][]} */ (Object.entries(parsed.verify))
      reconcile(verifyHost, verify, ([name]) => name, verifyRow)

      const tracks = /** @type {[string, any][]} */ (Object.entries(parsed.tracks))
      reconcile(tracksHost, tracks, ([name]) => name, trackRow)

      const specialists = /** @type {[string, string][]} */ (Object.entries(parsed.specialists))
      flag(specialistsBlock, 'hidden', specialists.length === 0)
      reconcile(specialistsHost, specialists, ([name]) => name, specialistRow)
    },
  })
}

function verifyRow() {
  const { root, slots } = clone('tpl-verify')
  return {
    root,
    /** @param {[string, string | null]} entry */
    update([name, command]) {
      const label = slots['name']
      if (label !== undefined) verbatim(label, `verify.${name}`)
      const value = slots['command']
      if (value !== undefined) {
        // Unset is the case worth saying out loud, not a blank cell: this
        // string is injected verbatim into every agent brief, and an agent
        // that cannot verify is one the engine is forbidden to work around.
        if (command === null) phrase(value, 'config.verifyUnset')
        else verbatim(value, command)
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
  const { root, slots } = clone('tpl-chip')
  return {
    root,
    /** @param {[string, string]} entry */
    update([name, mode]) {
      const text = slots['text']
      if (text !== undefined) verbatim(text, `${name}: ${mode}`)
    },
  }
}
