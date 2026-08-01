/**
 * Config — a typed editor in front of the guarded config mutator.
 *
 * The browser never sends a YAML path or a replacement document. It compares
 * these controls with the parsed document it received and sends a closed list
 * of typed changes plus that document's revision. The engine then validates
 * the whole result while holding the project lock and preserves comments.
 *
 * `specialists:` and `tracks:` were two JSON textareas until this rewrite,
 * which meant editing a roster by hand-writing JSON that had to satisfy four
 * cross-field rules nothing reported until after a round trip. They are
 * structured controls now, over a **draft** the page holds in memory:
 *
 *   draft ──(every mutation)──> hidden `*_json` fields ──> collectConfigChanges
 *
 * The hidden fields are the seam. `collectConfigChanges` still reads the same
 * two form values and still emits the same closed change vocabulary, so the
 * surface changed and the wire did not. Keeping the draft out of the visible
 * controls is also what keeps rule 3 in `ui/dom.js` intact: the only control a
 * person types into that the renderer ever writes to is `max_cycles`, and it is
 * written on a reseed epoch rather than on a poll.
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
import { attr, clone, flag, phrase, text, translateStatic, verbatim } from '../ui/dom.js'
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
 * The `orchestration.skills.sources` members, in the order the checkboxes are
 * read back. `SkillSourceSchema`'s own order, so the array this page sends is
 * the one a person reading `config.yaml` afterwards would have written.
 */
const SKILL_SOURCES = /** @type {const} */ (['github', 'registry', 'web'])

/**
 * The two `orchestration.quality` leaves. They share a type, which is why the
 * server gives them one change kind with a `key` — the same shape `gate` and
 * `limit` already use — and why they are a loop here rather than two blocks.
 */
const QUALITY_KEYS = /** @type {const} */ (['independent_plan_review', 'independent_verification'])

/**
 * The label above each of a track's four agent lists.
 *
 * `blocks` is one of them: it lives under `gate` rather than at the track's
 * root, but it is a set of this track's agent names like the other three, so it
 * gets the same chips, the same combobox and the same pair of actions.
 */
const LIST_LABEL = {
  required: 'config.required',
  available: 'config.available',
  closing: 'config.closing',
  blocks: 'config.gateBlocks',
}

/** Names the cycle directory keeps for itself — `contract.ts:23`. */
const RESERVED_AGENTS = ['findings', 'roster', 'verify', 'evidence', 'handoff', 'map']

/** `IdSchema` and `AgentNameSchema` share this pattern; both reject the rest. */
const NAME = /^[A-Za-z0-9_-]+$/

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
  const specialistHost = pick('config-specialist-rules')
  const specialistEmpty = pick('config-specialists-empty')
  const specialistNew = /** @type {HTMLInputElement} */ (pick('config-specialist-new'))
  const trackHost = pick('config-track-editors')
  const trackNew = /** @type {HTMLInputElement} */ (pick('config-track-new'))
  const agentNames = /** @type {HTMLDataListElement} */ (
    /** @type {unknown} */ (document.getElementById('config-agent-names'))
  )
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
  /**
   * `config.yaml`'s own text, for the same revision `baseline` was seeded
   * from — never the live feed's, which can move ahead of the draft while a
   * reader is still typing. The one thing it is for is counting the comment
   * lines inside one track's own block, in `trackCommentLoss` below.
   *
   * @type {string | null}
   */
  let rawText = null
  let dirty = false
  let saving = false
  let conflict = false
  let enabled = false

  /**
   * The two structured maps, as the user is editing them.
   *
   * Deep-copied out of the baseline on every reseed and never shared with it:
   * `collectConfigChanges` compares the two, so an alias would make every diff
   * empty and every save a no-op.
   *
   * @type {{ specialists: Record<string, string>, tracks: Record<string, any> } | null}
   */
  let draft = null

  /**
   * Bumped on every reseed, and the only thing that lets a row write into the
   * `max_cycles` box a person may be typing in. A row records the epoch it last
   * seeded at; the 800ms poll does not change it, so the poll cannot reach the
   * caret.
   */
  let seedEpoch = 0

  editor.addEventListener('input', markDirty)
  editor.addEventListener('change', markDirty)
  // Controls the structured editors own. Separate from `data-act`, which is the
  // delegated *click* bus: a `<select>` and a checkbox act on `change`, and a
  // number box on `input`, neither of which that bus carries.
  editor.addEventListener('input', onField)
  editor.addEventListener('change', onField)

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
        drawStructured()
        return
      }

      reconcile(verifyHost, commandRows(parsed.verify), (entry) => entry.key, factRow)
      reconcile(policyHost, policyRows(parsed.verify), (entry) => entry.key, factRow)
      drawStructured()
    },
  })

  /* ── the structured editors ──────────────────────────────────────────── */

  /**
   * Render the draft: the specialist rules, the track cards, and the agent-name
   * suggestions both of them offer.
   */
  function drawStructured() {
    const model = draft
    if (model === null) {
      reconcile(specialistHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
      reconcile(trackHost, [], (entry) => entry, () => ({ root: document.createElement('div'), update: () => {} }))
      flag(specialistEmpty, 'hidden', true)
      return
    }

    const names = knownAgents(model)
    // A plain `<option>` list: no caret, no selection, nothing a person is in
    // the middle of. Rebuilt only when the set actually moved.
    const offered = names.join(',')
    if (agentNames.dataset['offered'] !== offered) {
      agentNames.dataset['offered'] = offered
      agentNames.replaceChildren(
        ...names.map((name) => {
          const option = document.createElement('option')
          option.value = name
          return option
        }),
      )
    }

    // `?? 'auto'` for the type checker rather than for the data: the keys come
    // from this very object, so the lookup cannot miss — but an index signature
    // says `string | undefined` and the row below needs a mode.
    const rules = Object.keys(model.specialists)
      .sort()
      .map((agent) => ({ agent, mode: model.specialists[agent] ?? 'auto' }))
    flag(specialistEmpty, 'hidden', rules.length > 0)
    reconcile(specialistHost, rules, (rule) => rule.agent, specialistRule)

    const tracks = Object.keys(model.tracks).sort().map((name) => ({ name, model }))
    reconcile(trackHost, tracks, (entry) => entry.name, trackEditor)

    // Rows created a moment ago were not in the form when `updateEditor` ran.
    setEditorEnabled(editor, enabled)
  }

  /**
   * A draft mutation: apply it, mirror it into the hidden fields the diff
   * reads, and repaint. Every editor action goes through here, so there is one
   * place where "the draft moved" and "the form is dirty" cannot disagree.
   *
   * @param {(model: NonNullable<typeof draft>) => boolean | void} change
   */
  function mutate(change) {
    if (!enabled || draft === null) return
    if (change(draft) === false) return
    syncStructured()
    markDirty()
    draw()
  }

  /** Write the draft into the two hidden fields `collectConfigChanges` reads. */
  function syncStructured() {
    if (draft === null) return
    const specialists = /** @type {HTMLInputElement} */ (editor.elements.namedItem('specialists_json'))
    const tracks = /** @type {HTMLInputElement} */ (editor.elements.namedItem('tracks_json'))
    specialists.value = JSON.stringify(draft.specialists)
    tracks.value = JSON.stringify(draft.tracks)
  }

  /**
   * The `change`/`input` half of the editor's event handling.
   *
   * @param {Event} event
   */
  function onField(event) {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const field = target.dataset['field']
    if (field === undefined) return
    const track = target.dataset['track'] ?? ''
    const agent = target.dataset['agent'] ?? ''

    switch (field) {
      case 'specialist-mode':
        mutate((model) => {
          if (!(agent in model.specialists)) return false
          model.specialists[agent] = /** @type {HTMLSelectElement} */ (target).value
        })
        return
      case 'max-cycles': {
        const next = Number(/** @type {HTMLInputElement} */ (target).value)
        mutate((model) => {
          const entry = model.tracks[track]
          // An empty or half-typed box is not a number yet. Leaving the draft
          // alone keeps the last good value rather than writing `NaN` into the
          // patch the moment the field is cleared to retype it.
          if (entry === undefined || !Number.isInteger(next) || next < 1) return false
          entry.max_cycles = next
        })
        return
      }
      case 'gate-enabled':
        mutate((model) => {
          const entry = model.tracks[track]
          if (entry === undefined) return false
          if (/** @type {HTMLInputElement} */ (target).checked) {
            const first = entry.required[0] ?? entry.available[0] ?? entry.closing[0] ?? ''
            entry.gate = { proven_by: first, blocks: [] }
          } else delete entry.gate
        })
        return
      case 'gate-proven':
        mutate((model) => {
          const entry = model.tracks[track]
          if (entry?.gate === undefined) return false
          entry.gate.proven_by = /** @type {HTMLSelectElement} */ (target).value
        })
        return
      case 'map-enabled':
        mutate((model) => {
          const entry = model.tracks[track]
          if (entry === undefined) return false
          if (/** @type {HTMLInputElement} */ (target).checked) {
            entry.map = { drafted_by: entry.required[0] ?? entry.available[0] ?? '' }
          } else delete entry.map
        })
        return
      case 'map-drafted':
        mutate((model) => {
          const entry = model.tracks[track]
          if (entry?.map === undefined) return false
          entry.map.drafted_by = /** @type {HTMLSelectElement} */ (target).value
        })
    }
  }

  /* ── the actions the click bus dispatches ─────────────────────────────── */

  const api = {
    /** A new `specialists:` rule, from the box beside the list. */
    specialistAdd() {
      const agent = specialistNew.value.trim()
      if (!validAgent(agent)) return
      mutate((model) => {
        if (agent in model.specialists) return false
        model.specialists[agent] = 'auto'
      })
      // Cleared because a person pressed Add — the one reason this page ever
      // writes to a control.
      specialistNew.value = ''
    },
    /** @param {HTMLElement} element */
    specialistRemove(element) {
      const agent = element.dataset['agent'] ?? ''
      mutate((model) => {
        if (!(agent in model.specialists)) return false
        delete model.specialists[agent]
      })
    },
    trackAdd() {
      const name = trackNew.value.trim()
      if (!NAME.test(name)) return
      mutate((model) => {
        if (name in model.tracks) return false
        model.tracks[name] = { required: [], available: [], closing: [], order: [], max_cycles: 5 }
      })
      trackNew.value = ''
    },
    /** @param {HTMLElement} element */
    trackRemove(element) {
      const name = element.dataset['track'] ?? ''
      mutate((model) => {
        if (!(name in model.tracks)) return false
        delete model.tracks[name]
      })
    },
    /** @param {HTMLElement} element */
    trackDuplicate(element) {
      const name = element.dataset['track'] ?? ''
      mutate((model) => {
        const source = model.tracks[name]
        if (source === undefined) return false
        let copy = `${name}-copy`
        let n = 2
        while (copy in model.tracks) copy = `${name}-copy-${n++}`
        model.tracks[copy] = JSON.parse(JSON.stringify(source))
      })
    },
    /** @param {HTMLElement} element */
    agentAdd(element) {
      const track = element.dataset['track'] ?? ''
      const list = element.dataset['list'] ?? ''
      const box = element.parentElement?.querySelector('input')
      if (!(box instanceof HTMLInputElement)) return
      const agent = box.value.trim()
      if (!validAgent(agent)) return
      mutate((model) => {
        const entry = model.tracks[track]
        if (entry === undefined) return false
        const bucket = list === 'blocks' ? entry.gate?.blocks : entry[list]
        if (!Array.isArray(bucket) || bucket.includes(agent)) return false
        bucket.push(agent)
      })
      box.value = ''
    },
    /** @param {HTMLElement} element */
    agentRemove(element) {
      const track = element.dataset['track'] ?? ''
      const list = element.dataset['list'] ?? ''
      const agent = element.dataset['agent'] ?? ''
      mutate((model) => {
        const entry = model.tracks[track]
        if (entry === undefined) return false
        const bucket = list === 'blocks' ? entry.gate?.blocks : entry[list]
        if (!Array.isArray(bucket)) return false
        const at = bucket.indexOf(agent)
        if (at < 0) return false
        bucket.splice(at, 1)
      })
    },
    /**
     * A predecessor, onto one agent's order edge. `element` is the row's `+`
     * button — `data-track`/`data-agent` name the edge, and the box beside it
     * (like every other list on this card) holds the name being added.
     *
     * @param {HTMLElement} element
     */
    edgeAdd(element) {
      const track = element.dataset['track'] ?? ''
      const agent = element.dataset['agent'] ?? ''
      const box = element.parentElement?.querySelector('input')
      if (!(box instanceof HTMLInputElement)) return
      const pred = box.value.trim()
      // Naming itself is a 1-node cycle `findOrderCycle` would refuse anyway
      // (schemas/config.ts:266-311) — caught here so the draft never even
      // holds it, the same way the other lists reject a duplicate before the
      // problem list has to say so.
      if (!validAgent(pred) || pred === agent) return
      mutate((model) => {
        const entry = model.tracks[track]
        if (entry === undefined) return false
        /** @type {{ agent: string, after: string[] }[]} */
        const order = Array.isArray(entry.order) ? entry.order : (entry.order = [])
        // The engine supports more than one edge naming the same agent —
        // `findOrderViolation` (ops/log.ts:598-611) filters `track.order` for
        // every edge naming `agent` and loops all of them, and
        // `dispatchWaves` (schemas/config.ts:767-773) does the same — so
        // membership has to be checked across every edge already naming
        // `agent`, not just the first one `.find` would return, or a second
        // edge's predecessor could be re-added here even though the row
        // (whose chips are that same union, see `edgeAfter` below) already
        // shows it as present.
        const edges = order.filter((candidate) => candidate.agent === agent)
        if (edges.some((edge) => edge.after.includes(pred))) return false
        let edge = edges[0]
        if (edge === undefined) {
          edge = { agent, after: [] }
          order.push(edge)
        }
        edge.after.push(pred)
      })
      box.value = ''
    },
    /**
     * @param {HTMLElement} element The chip's own remove button —
     *   `data-track`/`data-agent`/`data-pred` name the one predecessor leaving.
     */
    edgeRemove(element) {
      const track = element.dataset['track'] ?? ''
      const agent = element.dataset['agent'] ?? ''
      const pred = element.dataset['pred'] ?? ''
      mutate((model) => {
        const entry = model.tracks[track]
        if (entry === undefined || !Array.isArray(entry.order)) return false
        /** @type {{ agent: string, after: string[] }[]} */
        const order = entry.order
        // The chip this row shows is the union across every edge naming
        // `agent` (`edgeAfter` below), so removing one has to clear `pred`
        // from every one of those edges too — walked back-to-front so the
        // splice below cannot skip the edge after the one just removed.
        let removed = false
        for (let i = order.length - 1; i >= 0; i--) {
          const edge = order[i]
          if (edge === undefined || edge.agent !== agent) continue
          const at = edge.after.indexOf(pred)
          if (at < 0) continue
          edge.after.splice(at, 1)
          removed = true
          // `OrderEdgeSchema.after` is `.min(1)` (schemas/config.ts:62) — an
          // edge with zero predecessors is not "no constraint", it is a
          // shape the server refuses outright. Dropping the whole edge here
          // is what lets removing its last predecessor read as clearing the
          // constraint, the way every other chip removal on this card does,
          // rather than leaving a draft that Save can never reach.
          if (edge.after.length === 0) order.splice(i, 1)
        }
        if (!removed) return false
      })
    },
  }

  // Enter inside one of the four `.rule-add` boxes (`css/60-panels.css:994`)
  // is otherwise swallowed by implicit form submission: `<form
  // id="config-editor" data-act="config-save">` (index.html:748) has exactly
  // one submit button, `config-save` (index.html:756), and by the time a name
  // is typed `editor.addEventListener('input', markDirty)` above has usually
  // already enabled it. Worst on the edge combobox (`index.html:1648`) — the
  // one box on this card with no pointer-only fallback keyboard-blocked by
  // this: the typed name has no `name` attribute, so `collectConfigChanges`
  // never sees it, and Enter saves the whole track subtree instead of adding
  // the edge. `agent-add`/`edge-add`/`specialist-add`/`track-add` below call
  // the same functions the bus dispatches for those buttons (`app.js:212`,
  // `217`, `214`, `219`) directly rather than through a synthetic click,
  // because the bus is installed once, on the real document, in `app.js` —
  // not re-installed by every control that needs to fire its own action.
  editor.addEventListener('keydown', (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key
    if (key !== 'Enter') return
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    const box = target.closest('.rule-add')
    if (box === null) return
    const button = box.querySelector('[data-act]')
    if (!(button instanceof HTMLElement)) return
    event.preventDefault()
    switch (button.dataset['act']) {
      case 'agent-add':
        api.agentAdd(button)
        break
      case 'edge-add':
        api.edgeAdd(button)
        break
      case 'specialist-add':
        api.specialistAdd()
        break
      case 'track-add':
        api.trackAdd()
        break
    }
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
      // Decided before `editorRevision` moves, because the question is about
      // the *old* baseline a dirty draft was diffing against, not the one
      // this frame is about to install.
      const conflicting = editorRevision !== null && dirty && !saving

      // One assignment of the trio, on every branch that reaches here, so a
      // later refactor cannot drop `rawText` from one arm and leave it
      // pointing at a stale document while `baseline` moves on: both are read
      // together by `trackCommentLoss` below, which the "counts the comment
      // lines…" test already covers for this same line.
      baseline = parsed
      editorRevision = revision
      rawText = view?.raw ?? null

      if (conflicting) {
        conflict = true
        flag(editorState, 'hidden', false)
        phrase(editorState, 'config.editorChanged')
        updateEditorActions()
        return
      }
      conflict = false
      dirty = false
      seedDraft(/** @type {Config} */ (parsed))
      seedConfigForm(editor, /** @type {Config} */ (parsed))
    }

    flag(editorState, 'hidden', !conflict)
    if (conflict) phrase(editorState, 'config.editorChanged')
    updateEditorActions()
  }

  function updateEditorActions() {
    // A draft the schema would reject cannot be saved. The server would refuse
    // it anyway; refusing here costs no round trip and the reason is already on
    // the card that caused it.
    const problem = enabled ? orchestrationProblem() : null
    // The orchestration rules have no card of their own to carry their reason,
    // so they borrow the editor's banner. `markDirty` hides it immediately
    // before calling this, which is what makes the message disappear the moment
    // the pair is completed rather than needing a second place to clear it.
    if (problem !== null && !conflict) {
      flag(editorState, 'hidden', false)
      phrase(editorState, problem)
    }
    saveButton.disabled = !enabled || !dirty || saving || conflict || broken() || problem !== null
    resetButton.disabled = !enabled || (!dirty && !conflict) || saving
  }

  /**
   * Why `ConfigSchema` would refuse this form as a whole document, or null.
   *
   * The first two rules are about a setting that could never take effect, which
   * is exactly what makes them worth catching here: the server refuses the
   * *patch* and is right to, but a person who moved eight settings would be told
   * only that one of them was wrong. Mirrored, never replacing — the engine
   * re-validates the whole document under the project lock and stays the
   * authority, the same arrangement `trackProblems` is in.
   *
   * The third is mirrored for a harder reason. Every other orchestration control
   * is a select, a checkbox or a `min`/`max` number input, so the browser itself
   * keeps them inside the schema; the trusted-registry textarea is the one
   * control that can express a value `ConfigChangeSchema` refuses. A refused
   * change is not a refused save: the server drops a frame it cannot parse
   * without answering it, and this panel clears `saving` only from a receipt, so
   * the save never settles and the editor stays disabled until the tab is
   * reloaded — taking every other setting edited in the same press with it.
   *
   * @returns {string | null}
   */
  function orchestrationProblem() {
    /** @param {string} name */
    const field = (name) => /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (
      editor.elements.namedItem(name)
    )
    // `auto-plan` names a start driven by an approved feature brief, and a
    // project with discovery off never produces one.
    if (field('orch_discovery_completion').value === 'auto-plan' && field('orch_discovery_mode').value === 'off') {
      return 'config.problem.autoPlanOff'
    }
    // Read the same way `collectConfigChanges` reads it, blank lines and all, so
    // what is judged here is exactly what would go on the wire.
    const registries = field('orch_skills_trusted_registries')
      .value.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    // A source that names no registry admits nothing, and the project believes
    // it enabled one.
    if (/** @type {HTMLInputElement} */ (field('orch_skills_sources_registry')).checked && registries.length === 0) {
      return 'config.problem.registryUntrusted'
    }
    if (registries.some((registry) => !registry.startsWith('https://'))) {
      return 'config.problem.registryNotHttps'
    }
    return null
  }

  /** Whether any track in the draft would fail `ConfigSchema`. */
  function broken() {
    if (draft === null) return false
    return Object.keys(draft.tracks).some((name) => trackProblems(draft, name).length > 0)
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
    seedDraft(baseline)
    seedConfigForm(editor, baseline)
    dirty = false
    conflict = false
    updateEditorActions()
    flag(editorState, 'hidden', true)
    // The structured editors are rendered from the draft, and a draft that
    // moved without a repaint is a page showing rules the user just discarded.
    // Nothing else schedules one here: an idle project produces no state churn,
    // so there is no poll to ride in on.
    draw()
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

  /* ── row factories ───────────────────────────────────────────────────── */

  /** One `specialists:` rule. */
  function specialistRule() {
    const { root, slots } = clone('tpl-specialist-rule')
    return {
      root,
      /** @param {{ agent: string, mode: string }} rule */
      update({ agent, mode }) {
        const name = slots['agent']
        if (name !== undefined) verbatim(name, agent)

        const select = /** @type {HTMLSelectElement | undefined} */ (slots['mode'])
        if (select !== undefined) {
          attr(select, 'data-agent', agent)
          if (select.value !== mode) select.value = mode
        }
        const why = slots['why']
        if (why !== undefined) phrase(why, `config.mode.${mode}Why`)
        const remove = slots['remove']
        if (remove !== undefined) attr(remove, 'data-agent', agent)

        // `translateStatic` does not descend into `<template>` content, so a
        // cloned row's own labels are still keys until it translates itself.
        // Every update, because the memo is per node and carries the locale
        // epoch: a language switch repaints, an 800ms tick does not.
        translateStatic(root)
      },
    }
  }

  /**
   * One of a track's agent lists, mounted into a placeholder and kept.
   *
   * @param {HTMLElement | undefined} host
   * @param {'required' | 'available' | 'closing' | 'blocks'} list
   */
  function agentList(host, list) {
    if (host === undefined) return { update() {} }
    const { root, slots } = clone('tpl-track-list')
    host.replaceChildren(root)
    const label = slots['label']
    const chips = slots['chips']
    const add = slots['add']

    return {
      /** @param {string} track @param {string[]} agents */
      update(track, agents) {
        // Phrased on every update rather than once at mount: `phrase` memoises
        // per node *including the locale epoch*, so this costs nothing until
        // the language changes — and a label written once at mount is a label
        // that stays English in an Arabic page.
        if (label !== undefined) phrase(label, LIST_LABEL[list])
        if (add !== undefined) {
          attr(add, 'data-track', track)
          attr(add, 'data-list', list)
        }
        const empty = slots['empty']
        if (empty !== undefined) flag(empty, 'hidden', agents.length > 0)
        if (chips === undefined) return
        reconcile(
          chips,
          agents.map((agent) => ({ track, list, agent })),
          (chip) => chip.agent,
          agentChip,
        )
      },
    }
  }

  /** One agent inside one list. */
  function agentChip() {
    const { root, slots } = clone('tpl-agent-chip')
    return {
      root,
      /** @param {{ track: string, list: string, agent: string }} chip */
      update({ track, list, agent }) {
        const name = slots['name']
        if (name !== undefined) text(name, agent)
        const remove = slots['remove']
        if (remove !== undefined) {
          attr(remove, 'data-track', track)
          attr(remove, 'data-list', list)
          attr(remove, 'data-agent', agent)
        }
      },
    }
  }

  /**
   * One required/available agent's row in the order graph: its name, the
   * chips naming what it waits on, and the combobox that adds one more.
   *
   * A dependency graph rather than a sortable list — Milestone C's design
   * (`docs/superpowers/specs/2026-08-01-plans-stories-split-design.md`,
   * Milestone C) — because the track's two real orderings are both cross-set
   * (`ui-designer` before `builder`, `verifier` before `ui-critic`) and
   * neither is a position in `required` or `available` alone. So the control
   * this row offers is per-agent — "which agents does *this one* wait for" —
   * the same shape `required`/`available`/`closing`/`blocks` already use:
   * chips plus a combobox, following `agentList` above rather than inventing
   * a second control shape for one more list.
   */
  function orderAgentRow() {
    const { root, slots } = clone('tpl-track-order-agent')
    return {
      root,
      /** @param {{ track: string, agent: string, after: string[] }} entry */
      update({ track, agent, after }) {
        const name = slots['agent']
        if (name !== undefined) verbatim(name, agent)
        const add = slots['add']
        if (add !== undefined) {
          attr(add, 'data-track', track)
          attr(add, 'data-agent', agent)
        }
        const empty = slots['empty']
        if (empty !== undefined) flag(empty, 'hidden', after.length > 0)
        const chips = slots['chips']
        if (chips === undefined) return
        reconcile(
          chips,
          after.map((pred) => ({ track, agent, pred })),
          (chip) => chip.pred,
          edgeChip,
        )
      },
    }
  }

  /** One predecessor inside one agent's order edge. */
  function edgeChip() {
    const { root, slots } = clone('tpl-edge-chip')
    return {
      root,
      /** @param {{ track: string, agent: string, pred: string }} chip */
      update({ track, agent, pred }) {
        const name = slots['name']
        if (name !== undefined) text(name, pred)
        const remove = slots['remove']
        if (remove !== undefined) {
          attr(remove, 'data-track', track)
          attr(remove, 'data-agent', agent)
          attr(remove, 'data-pred', pred)
        }
      },
    }
  }

  /** One reason this track would be rejected. */
  function problemRow() {
    const { root, slots } = clone('tpl-track-problem')
    return {
      root,
      /** @param {{ id: string, key: string, params: Record<string, string> }} problem */
      update({ key, params }) {
        const cell = slots['text'] ?? root
        phrase(cell, key, params)
      },
    }
  }

  /** One track, as a card. */
  function trackEditor() {
    const { root, slots } = clone('tpl-track-editor')
    const lists = {
      required: agentList(slots['requiredList'], 'required'),
      available: agentList(slots['availableList'], 'available'),
      closing: agentList(slots['closingList'], 'closing'),
      blocks: agentList(slots['blocksList'], 'blocks'),
    }
    // The epoch this row last wrote into its own number box. Never the poll's.
    let seeded = -1

    return {
      root,
      /** @param {{ name: string, model: NonNullable<typeof draft> }} entry */
      update({ name, model }) {
        const track = model.tracks[name]
        if (track === undefined) return
        root.dataset['track'] = name

        const label = slots['name']
        if (label !== undefined) verbatim(label, name)

        const cycles = /** @type {HTMLInputElement | undefined} */ (slots['cycles'])
        if (cycles !== undefined) {
          attr(cycles, 'data-track', name)
          if (seeded !== seedEpoch) {
            seeded = seedEpoch
            cycles.value = String(track.max_cycles)
          }
        }
        for (const key of /** @type {const} */ (['duplicate', 'remove'])) {
          const button = slots[key]
          if (button !== undefined) attr(button, 'data-track', name)
        }

        lists.required.update(name, track.required)
        lists.available.update(name, track.available ?? [])
        lists.closing.update(name, track.closing ?? [])
        lists.blocks.update(name, track.gate?.blocks ?? [])

        const known = [...track.required, ...(track.available ?? []), ...(track.closing ?? [])]
        const draftable = [...track.required, ...(track.available ?? [])]

        const gateOn = track.gate !== undefined
        const gateEnabled = /** @type {HTMLInputElement | undefined} */ (slots['gateEnabled'])
        if (gateEnabled !== undefined) {
          attr(gateEnabled, 'data-track', name)
          if (gateEnabled.checked !== gateOn) gateEnabled.checked = gateOn
        }
        const gateBody = slots['gateBody']
        if (gateBody !== undefined) flag(gateBody, 'hidden', !gateOn)
        const gateProven = /** @type {HTMLSelectElement | undefined} */ (slots['gateProven'])
        if (gateProven !== undefined) {
          attr(gateProven, 'data-track', name)
          fillSelect(gateProven, known, track.gate?.proven_by ?? '')
        }

        const mapOn = track.map !== undefined
        const mapEnabled = /** @type {HTMLInputElement | undefined} */ (slots['mapEnabled'])
        if (mapEnabled !== undefined) {
          attr(mapEnabled, 'data-track', name)
          if (mapEnabled.checked !== mapOn) mapEnabled.checked = mapOn
        }
        const mapBody = slots['mapBody']
        if (mapBody !== undefined) flag(mapBody, 'hidden', !mapOn)
        const mapDrafted = /** @type {HTMLSelectElement | undefined} */ (slots['mapDrafted'])
        if (mapDrafted !== undefined) {
          attr(mapDrafted, 'data-track', name)
          // Deliberately narrower than the gate's list: a map drafted by a
          // closing agent is a document no run ever writes — `config.ts` rejects
          // it, so the control must not offer it.
          fillSelect(mapDrafted, draftable, track.map?.drafted_by ?? '')
        }

        // One row per required/available agent — `draftable`, the same set
        // `mapDrafted` above scopes to and for the same reason: a closing
        // agent runs once, after the run passes, so `TrackSchema.superRefine`
        // (schemas/config.ts:186-214, the whole per-edge block: the agent-side
        // closing check at 193-199 and the predecessor-side one at 207-213)
        // refuses an edge naming one as either side, and a row that could
        // never be legal has nothing useful to offer here.
        //
        // `draftable` alone would leave an edge whose own agent fell out of
        // `required`/`available` with no row at all: `agentRemove` only ever
        // touches the four membership lists, never `track.order`, so the edge
        // is still in the draft and `trackProblems` below still raises
        // `config.problem.orderAgentUnknown` (or `...Closing`, if the agent
        // landed in `closing` instead) for it — a refusal naming a control
        // nothing on the card could reach. `fillSelect` below keeps a stale
        // `gate.proven_by` visible for the identical reason: "dropping it
        // would silently rewrite the config… and the problem list is what
        // says it is wrong." So the rows are the union of `draftable` and
        // every `edge.agent` already in `track.order`, draftable first and
        // orphans after, and an orphan gets the same chips and the same × as
        // any other row — chipping its predecessors away one at a time drops
        // the edge itself, the way `edgeRemove` below already empties it.
        const orderAgents = slots['orderAgents']
        if (orderAgents !== undefined) {
          /** @type {{ agent: string, after: string[] }[]} */
          const order = track.order ?? []
          const orphans = [...new Set(order.map((edge) => edge.agent))].filter((agent) => !draftable.includes(agent))
          reconcile(
            orderAgents,
            [...draftable, ...orphans].map((agent) => ({ track: name, agent, after: edgeAfter(order, agent) })),
            (entry) => entry.agent,
            orderAgentRow,
          )
        }

        const problems = slots['problems']
        if (problems !== undefined) {
          reconcile(problems, trackProblems(model, name), (problem) => problem.id, problemRow)
        }

        // C6: what Save on this card would actually do, read from state this
        // panel already holds — `baseline` (the last-synced document) and
        // `rawText` (that same document's text), never a second fetch.
        const previewChanges = slots['previewChanges']
        const previewEmpty = slots['previewEmpty']
        const previewComments = slots['previewComments']
        if (previewChanges !== undefined) {
          const baselineTrack = baseline?.tracks?.[name]
          // The same predicate `collectConfigChanges` sends a `kind:'track'`
          // change on (:1203: `JSON.stringify(baseline.tracks[track] ?? null)
          // !== JSON.stringify(next)`), computed here from the same two
          // objects rather than from `items.length`. The two are *not*
          // equivalent: `onField`'s `gate-enabled`/`map-enabled` cases
          // `delete entry.gate`/`entry.map` and then reassign it, which moves
          // that key to the end of the track object without moving any
          // field's own value — every per-field `differs` check below comes
          // back equal, so `items` is `[]`, while the whole-track
          // `JSON.stringify` still differs on key order and Save still sends
          // the subtree. `items.length === 0` therefore does not imply
          // nothing is pending; only `!pending` implies the serialised forms
          // are equal, which is the actual condition a save with nothing to
          // send requires.
          const pending = JSON.stringify(baselineTrack ?? null) !== JSON.stringify(track)
          const items = [
            ...trackFieldChanges(baselineTrack, track),
            ...(baselineTrack === undefined ? [] : orderEdgeChanges(baselineTrack, track)),
          ]
          reconcile(previewChanges, items, (item) => item.id, previewRow)
          if (previewEmpty !== undefined) flag(previewEmpty, 'hidden', pending)
          if (previewComments !== undefined) {
            const lost = !pending || baselineTrack === undefined ? null : trackCommentLoss(rawText, name)
            flag(previewComments, 'hidden', lost === null || lost === 0)
            if (lost !== null && lost > 0) {
              phrase(previewComments, pluralKey('config.preview.commentsLost', lost), { count: lost })
            }
          }
        }

        // Last, so the lists and chips this update just created are translated
        // in the same pass rather than one frame later.
        translateStatic(root)
      },
    }
  }

  /** @param {Config} config */
  function seedDraft(config) {
    draft = /** @type {NonNullable<typeof draft>} */ (
      JSON.parse(JSON.stringify({ specialists: config.specialists, tracks: config.tracks }))
    )
    seedEpoch += 1
    syncStructured()
  }

  return { save, reset, ...api }
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

  // `order` rides through here with the rest of the track — no new write kind
  // for the edge editor. `ConfigChangeSchema`'s `track` variant already types
  // `value` as `TrackSchema.nullable()` (store/config-mutation.ts), and
  // `TrackSchema` already carries `order` (schemas/config.ts), so a draft that
  // moved only its order graph is, from this loop's point of view, a track
  // whose serialised JSON changed like any other edit to the same object.
  //
  // The cost that comes with reusing this door: `applyConfigChange`'s `track`
  // case (store/config-mutation.ts:220-222) calls `setIn(['tracks', track],
  // value)`, replacing the whole subtree — so saving one new edge also
  // discards any YAML comment written inside that track's block, not only the
  // fields this editor exposes. Showing the reader what a save would replace
  // before they press it is C6 (Milestone C, "Change-impact preview") — this
  // phase does not add that preview, and this comment is where C6 should look
  // first.
  const tracks = record(value('tracks_json'))
  for (const track of [...new Set([...Object.keys(baseline.tracks), ...Object.keys(tracks)])].sort()) {
    const next = track in tracks ? tracks[track] : null
    push(changes, JSON.stringify(baseline.tracks[track] ?? null) !== JSON.stringify(next), {
      kind: 'track',
      track,
      value: /** @type {Config['tracks'][string] | null} */ (next),
    })
  }

  // One change per orchestration leaf, matching the server's discriminants
  // exactly: the wire has a kind per setting rather than a section plus a key,
  // which is what lets each `value` schema be as narrow as `ConfigSchema`'s.
  const orchestration = baseline.orchestration
  push(changes, orchestration.profile.auto_accept !== boolean('orch_profile_auto_accept'), {
    kind: 'orchestration.profile.auto_accept',
    value: boolean('orch_profile_auto_accept'),
  })
  push(changes, orchestration.discovery.mode !== value('orch_discovery_mode'), {
    kind: 'orchestration.discovery.mode',
    value: /** @type {Config['orchestration']['discovery']['mode']} */ (value('orch_discovery_mode')),
  })
  push(changes, orchestration.discovery.question_budget !== number('orch_discovery_question_budget'), {
    kind: 'orchestration.discovery.question_budget',
    value: number('orch_discovery_question_budget'),
  })
  push(changes, orchestration.discovery.completion !== value('orch_discovery_completion'), {
    kind: 'orchestration.discovery.completion',
    value: /** @type {Config['orchestration']['discovery']['completion']} */ (value('orch_discovery_completion')),
  })
  push(changes, orchestration.execution.after_plan_approval !== value('orch_execution_after_plan_approval'), {
    kind: 'orchestration.execution.after_plan_approval',
    value: /** @type {Config['orchestration']['execution']['after_plan_approval']} */ (
      value('orch_execution_after_plan_approval')
    ),
  })
  push(
    changes,
    orchestration.execution.uncertain_concurrency !== value('orch_execution_uncertain_concurrency'),
    {
      kind: 'orchestration.execution.uncertain_concurrency',
      value: /** @type {Config['orchestration']['execution']['uncertain_concurrency']} */ (
        value('orch_execution_uncertain_concurrency')
      ),
    },
  )
  push(changes, orchestration.execution.repair_attempts !== number('orch_execution_repair_attempts'), {
    kind: 'orchestration.execution.repair_attempts',
    value: number('orch_execution_repair_attempts'),
  })
  for (const key of QUALITY_KEYS) {
    const next = boolean(`orch_quality_${key}`)
    push(changes, orchestration.quality[key] !== next, { kind: 'orchestration.quality', key, value: next })
  }

  const sources = SKILL_SOURCES.filter((source) => boolean(`orch_skills_sources_${source}`))
  // Compared as a set rather than as a list, because three checkboxes cannot
  // express an order: a `config.yaml` that lists `[web, github]` must not be
  // rewritten into `[github, web]` merely because this panel drew it. When the
  // set genuinely moves, what goes out is `SkillSourceSchema`'s own order.
  push(changes, [...orchestration.skills.sources].sort().join(' ') !== [...sources].sort().join(' '), {
    kind: 'orchestration.skills.sources',
    value: /** @type {Config['orchestration']['skills']['sources']} */ ([...sources]),
  })
  const registries = patterns('orch_skills_trusted_registries')
  push(changes, JSON.stringify(orchestration.skills.trusted_registries) !== JSON.stringify(registries), {
    kind: 'orchestration.skills.trusted_registries',
    value: registries,
  })
  push(changes, orchestration.skills.update_mode !== value('orch_skills_update_mode'), {
    kind: 'orchestration.skills.update_mode',
    value: /** @type {Config['orchestration']['skills']['update_mode']} */ (value('orch_skills_update_mode')),
  })
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
  /** @param {string} name @param {boolean} on */
  const check = (name, on) => {
    /** @type {HTMLInputElement} */ (form.elements.namedItem(name)).checked = on
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

  // The orchestration block arrives whole whatever the file holds: every field
  // is defaulted and every sub-block prefaulted, so a `config.yaml` written
  // before this key existed still seeds a full set of controls rather than a
  // half-empty fieldset the first save would fill in by accident.
  const orchestration = config.orchestration
  check('orch_profile_auto_accept', orchestration.profile.auto_accept)
  set('orch_discovery_mode', orchestration.discovery.mode)
  set('orch_discovery_question_budget', orchestration.discovery.question_budget)
  set('orch_discovery_completion', orchestration.discovery.completion)
  set('orch_execution_after_plan_approval', orchestration.execution.after_plan_approval)
  set('orch_execution_uncertain_concurrency', orchestration.execution.uncertain_concurrency)
  set('orch_execution_repair_attempts', orchestration.execution.repair_attempts)
  for (const key of QUALITY_KEYS) check(`orch_quality_${key}`, orchestration.quality[key])
  for (const source of SKILL_SOURCES) {
    check(`orch_skills_sources_${source}`, orchestration.skills.sources.includes(source))
  }
  set('orch_skills_trusted_registries', orchestration.skills.trusted_registries.join('\n'))
  set('orch_skills_update_mode', orchestration.skills.update_mode)
  // `specialists_json` and `tracks_json` are hidden fields now, owned by
  // `syncStructured()` — the draft is their single writer.
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

/**
 * Every agent name this project has already named, from the draft alone.
 *
 * There is no endpoint behind this and there deliberately never will be:
 * `ops/preflight.ts` records that the engine "has never read and cannot
 * reliably locate" the agents directory, and a project-local agent may shadow a
 * plugin one without the engine knowing. So these are *suggestions* — every box
 * that offers them also accepts a name typed by hand, which is what keeps an
 * agent scaffolded a minute ago usable the same minute.
 *
 * @param {{ specialists: Record<string, string>, tracks: Record<string, any> }} model
 * @returns {string[]}
 */
function knownAgents(model) {
  const names = new Set(Object.keys(model.specialists))
  for (const track of Object.values(model.tracks)) {
    for (const list of ['required', 'available', 'closing']) {
      for (const agent of track[list] ?? []) names.add(agent)
    }
    if (track.gate !== undefined) {
      names.add(track.gate.proven_by)
      for (const agent of track.gate.blocks ?? []) names.add(agent)
    }
    if (track.map !== undefined) names.add(track.map.drafted_by)
  }
  names.delete('')
  return [...names].sort()
}

/**
 * `AgentNameSchema` in the browser: the pattern, the `--` rule and the reserved
 * list. Restated rather than imported because `public/` imports no engine
 * module — and the server still validates, so this only saves a round trip.
 *
 * @param {string} name
 * @returns {boolean}
 */
function validAgent(name) {
  return NAME.test(name) && !name.includes('--') && !RESERVED_AGENTS.includes(name)
}

/**
 * Why the schema would reject this track, in the order a reader meets the
 * fields. These are the same rules `TrackSchema` and `ConfigSchema.superRefine`
 * apply — mirrored, never replacing them: the server re-validates the whole
 * document under the project lock and remains the authority.
 *
 * @param {{ specialists: Record<string, string>, tracks: Record<string, any> } | null} model
 * @param {string} name
 * @returns {{ id: string, key: string, params: Record<string, string> }[]}
 */
function trackProblems(model, name) {
  const track = model?.tracks[name]
  if (model === null || track === undefined) return []

  /** @type {{ id: string, key: string, params: Record<string, string> }[]} */
  const problems = []
  const seen = new Set()
  /** @param {string} key @param {string} [name] @param {string} [paramName] */
  const add = (key, name, paramName) => {
    const id = name === undefined ? key : `${key}:${name}`
    if (seen.has(id)) return
    seen.add(id)
    problems.push({ id, key, params: name === undefined ? {} : { [paramName ?? 'agent']: name } })
  }

  const known = new Set([...track.required, ...(track.available ?? []), ...(track.closing ?? [])])
  const draftable = new Set([...track.required, ...(track.available ?? [])])
  const forbidden = new Set(
    Object.entries(model.specialists).filter(([, mode]) => mode === 'never').map(([agent]) => agent),
  )

  if (track.required.length === 0) add('config.problem.noRequired')

  if (track.gate !== undefined) {
    if (!known.has(track.gate.proven_by)) add('config.problem.gateUnknown', track.gate.proven_by)
    for (const agent of track.gate.blocks ?? []) {
      if (!known.has(agent)) add('config.problem.blockUnknown', agent)
    }
    if ((track.gate.blocks ?? []).includes(track.gate.proven_by)) {
      add('config.problem.gateSelfBlock', track.gate.proven_by)
    }
    if ((track.gate.blocks ?? []).length === 0) add('config.problem.noBlocks')
    if (forbidden.has(track.gate.proven_by)) add('config.problem.forbidden', track.gate.proven_by)
  }

  if (track.map !== undefined) {
    if (!draftable.has(track.map.drafted_by)) add('config.problem.mapUnknown', track.map.drafted_by)
    if (forbidden.has(track.map.drafted_by)) add('config.problem.forbidden', track.map.drafted_by)
  }

  for (const agent of [...track.required, ...(track.closing ?? [])]) {
    if (forbidden.has(agent)) add('config.problem.forbidden', agent)
  }

  // C1's four order refusals (`TrackSchema.superRefine`, schemas/config.ts:
  // 186-232 for the per-edge checks and :244-255 for the cycle, folding the
  // gate in beside `track.order` exactly as that block does). Mirrored, never
  // replacing — the server re-parses the whole document under the project
  // lock and remains the authority, same as every check above this one.
  /** @type {{ agent: string, after: string[] }[]} */
  const order = track.order ?? []
  for (const edge of order) {
    if (!known.has(edge.agent)) add('config.problem.orderAgentUnknown', edge.agent)
    else if (track.closing.includes(edge.agent)) add('config.problem.orderAgentClosing', edge.agent)
    for (const pred of edge.after ?? []) {
      if (!known.has(pred)) add('config.problem.orderPredUnknown', pred)
      else if (track.closing.includes(pred)) add('config.problem.orderPredClosing', pred)
    }
    // The gate checks above already make `gate.proven_by`'s pass the
    // precondition every name in `gate.blocks` waits on; an edge that makes
    // `proven_by` itself wait on one of them demands the opposite order.
    if (
      track.gate !== undefined &&
      edge.agent === track.gate.proven_by &&
      (edge.after ?? []).some((pred) => (track.gate?.blocks ?? []).includes(pred))
    ) {
      add('config.problem.orderInvertsGate', edge.agent)
    }
  }
  // The gate folded in as edges, the same way `dispatchWaves` and
  // `TrackSchema.superRefine`'s own cycle check fold it in (schemas/
  // config.ts:244-247) — this is what catches a deadlock through a third
  // agent, one hop past what the direct check above sees.
  /** @type {string[]} */
  const blocks = track.gate?.blocks ?? []
  const gateEdges = track.gate === undefined ? [] : blocks.map((agent) => ({ agent, after: [track.gate.proven_by] }))
  const cycle = findOrderCycle([...order, ...gateEdges])
  if (cycle !== null) add('config.problem.orderCycle', cycle.join(' → '), 'path')

  return problems
}

/**
 * Every predecessor a track's order graph names for one agent, across every
 * edge that names it — not just the first `.find` would return. The engine
 * treats a second edge naming the same agent as real (`findOrderViolation`,
 * ops/log.ts:598-611, filters and loops all of them; `dispatchWaves`,
 * schemas/config.ts:767-773, iterates every edge), so a row that showed only
 * the first edge's chips would read as a smaller set than `runLog` enforces.
 *
 * @param {{ agent: string, after: string[] }[]} order @param {string} agent @returns {string[]}
 */
function edgeAfter(order, agent) {
  return [...new Set(order.filter((edge) => edge.agent === agent).flatMap((edge) => edge.after))]
}

/**
 * The first cycle a track's order graph contains, as the path that closes it,
 * or `null` if the graph is acyclic.
 *
 * A client-side mirror of `findOrderCycle` (schemas/config.ts:266-311): the
 * same three-colour DFS over the same predecessor -> successor adjacency (an
 * `after`-edge from `pred` to `edge.agent` means "`edge.agent` depends on
 * `pred`"). Mirrored, never replacing — `trackProblems` above is the only
 * caller, and the server re-parses through `TrackSchema.superRefine` under
 * the project lock regardless of what this says.
 *
 * @param {{ agent: string, after: string[] }[]} order
 * @returns {string[] | null}
 */
function findOrderCycle(order) {
  /** @type {Map<string, string[]>} */
  const successors = new Map()
  /** @type {Set<string>} */
  const nodes = new Set()
  for (const edge of order) {
    nodes.add(edge.agent)
    for (const pred of edge.after) {
      nodes.add(pred)
      const list = successors.get(pred) ?? []
      list.push(edge.agent)
      successors.set(pred, list)
    }
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  /** @type {Map<string, number>} */
  const color = new Map()
  /** @type {string[]} */
  const path = []

  /** @param {string} node @returns {string[] | null} */
  function visit(node) {
    color.set(node, GRAY)
    path.push(node)
    for (const next of successors.get(node) ?? []) {
      const state = color.get(next) ?? WHITE
      if (state === GRAY) {
        const start = path.indexOf(next)
        return [...path.slice(start), next]
      }
      if (state === WHITE) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    color.set(node, BLACK)
    path.pop()
    return null
  }

  for (const node of nodes) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node)
      if (found !== null) return found
    }
  }
  return null
}

/* ── C6: change-impact preview ───────────────────────────────────────────
 *
 * `config.patch`'s `track` variant replaces the whole subtree
 * (`store/config-mutation.ts`, `applyChange`'s `'track'` case: `document.
 * setIn(['tracks', change.track], change.value)`), under a compare-and-swap
 * over the sha256 of the *whole* `config.yaml` (`mutateConfig`: `if
 * (configRevision(raw) !== parsedPatch.revision) throw new
 * ConfigMutationError('stale')`) — so Save on one track card is the most
 * destructive control this editor has, and everything below exists to show
 * what it would do before it does it, from state this panel already holds.
 */

/** @param {string} name @returns {{ id: string, key: string, params: Record<string, string> }} */
function previewField(name) {
  return { id: `field:${name}`, key: 'config.preview.fieldChanged', params: { field: name } }
}

/**
 * Which of a track's own fields (everything but `order`, named separately
 * below) would come out of Save different from the baseline this card was
 * seeded from. `undefined` means the track is not in the baseline at all —
 * added in this editing session and never yet saved, so there is nothing to
 * diff it against and nothing of its own for Save to discard.
 *
 * @param {{ required?: string[], available?: string[], closing?: string[], max_cycles?: number, gate?: unknown, map?: unknown } | undefined} baselineTrack
 * @param {{ required: string[], available?: string[], closing?: string[], max_cycles: number, gate?: unknown, map?: unknown }} draftTrack
 * @returns {{ id: string, key: string, params: Record<string, string> }[]}
 */
function trackFieldChanges(baselineTrack, draftTrack) {
  if (baselineTrack === undefined) return [{ id: 'new', key: 'config.preview.newTrack', params: {} }]
  const differs = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) !== JSON.stringify(b)
  /** @type {{ id: string, key: string, params: Record<string, string> }[]} */
  const changes = []
  if (differs(baselineTrack.required ?? [], draftTrack.required)) changes.push(previewField('required'))
  if (differs(baselineTrack.available ?? [], draftTrack.available ?? [])) changes.push(previewField('available'))
  if (differs(baselineTrack.closing ?? [], draftTrack.closing ?? [])) changes.push(previewField('closing'))
  if (baselineTrack.max_cycles !== draftTrack.max_cycles) changes.push(previewField('max_cycles'))
  if (differs(baselineTrack.gate ?? null, draftTrack.gate ?? null)) changes.push(previewField('gate'))
  if (differs(baselineTrack.map ?? null, draftTrack.map ?? null)) changes.push(previewField('map'))
  return changes
}

/**
 * Every `{agent, pred}` pair a track's order graph names, flattened across
 * every edge — the same union `edgeAfter` above reads for one agent's own
 * row, here read for the whole track so a pair can be set-compared against
 * the other side regardless of which `OrderEdge` object happens to hold it.
 *
 * @param {{ agent: string, after: string[] }[]} order
 * @returns {{ agent: string, pred: string }[]}
 */
function flattenOrder(order) {
  return order.flatMap((edge) => (edge.after ?? []).map((pred) => ({ agent: edge.agent, pred })))
}

/**
 * The order edges Save would add and remove, named by agent and predecessor
 * — not a count and not the raw arrays, because "which edges" is the
 * question a reader deciding whether to press Save actually has.
 *
 * @param {{ order?: { agent: string, after: string[] }[] }} baselineTrack
 * @param {{ order?: { agent: string, after: string[] }[] }} draftTrack
 * @returns {{ id: string, key: string, params: Record<string, string> }[]}
 */
function orderEdgeChanges(baselineTrack, draftTrack) {
  const before = flattenOrder(baselineTrack.order ?? [])
  const after = flattenOrder(draftTrack.order ?? [])
  const pairKey = (/** @type {{ agent: string, pred: string }} */ pair) => `${pair.agent}:${pair.pred}`
  const beforeKeys = new Set(before.map(pairKey))
  const afterKeys = new Set(after.map(pairKey))
  const added = after.filter((pair) => !beforeKeys.has(pairKey(pair)))
  const removed = before.filter((pair) => !afterKeys.has(pairKey(pair)))
  return [
    ...added.map((pair) => ({ id: `add:${pairKey(pair)}`, key: 'config.preview.orderAdded', params: pair })),
    ...removed.map((pair) => ({ id: `remove:${pairKey(pair)}`, key: 'config.preview.orderRemoved', params: pair })),
  ]
}

/**
 * How many whole-line comments live inside one track's own block in
 * `config.yaml`'s raw text, or `null` when that block cannot be located
 * reliably.
 *
 * Deliberately conservative, and deliberately willing to say "cannot tell"
 * rather than guess: only a line whose trimmed content *starts* with `#`
 * counts, and only between this track's own `name:` line and the next line
 * at its indentation or shallower (the next sibling track, or the end of the
 * `tracks:` block). A trailing `# comment` on a value line is not counted —
 * telling it apart from a `#` inside a quoted string needs a real YAML
 * parser, and `public/` ships none (this file's own header, line 4: "The
 * browser never sends a YAML path or a replacement document"; line 49:
 * "`public/` is the browser and imports no engine module"). So this
 * undercounts rather than risks inventing a number, and returns `null`
 * outright the moment the text does not have the shape this walk assumes —
 * no `tracks:` block, or no line matching this track's name at the
 * indentation its siblings sit at.
 *
 * @param {string | null} raw
 * @param {string} track
 * @returns {number | null}
 */
function trackCommentLoss(raw, track) {
  if (raw === null) return null
  const lines = raw.split('\n')
  const indentOf = (/** @type {string} */ line) => line.length - line.trimStart().length

  const tracksAt = lines.findIndex((line) => /^tracks:\s*(#.*)?$/.test(line))
  if (tracksAt < 0) return null

  let bodyStart = -1
  let indent = -1
  for (let i = tracksAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const width = indentOf(line)
    if (width === 0) break // `tracks:` closed with no body of its own.
    bodyStart = i
    indent = width
    break
  }
  if (bodyStart < 0) return null

  const escaped = track.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const header = new RegExp(`^ {${indent}}${escaped}:(\\s|$)`)
  let headerAt = -1
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const width = indentOf(line)
    if (width < indent) break // past the whole `tracks:` block.
    if (width === indent && header.test(line)) {
      headerAt = i
      break
    }
  }
  if (headerAt < 0) return null

  let count = 0
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const width = indentOf(line)
    if (width <= indent) break // the next sibling track, or the block closed.
    if (line.trim().startsWith('#')) count++
  }
  return count
}

/** One line of the change preview: a field that moved, or an order edge added or removed. */
function previewRow() {
  const { root, slots } = clone('tpl-track-preview-item')
  return {
    root,
    /** @param {{ id: string, key: string, params: Record<string, string> }} item */
    update({ key, params }) {
      const cell = slots['text'] ?? root
      phrase(cell, key, params)
    },
  }
}

/**
 * Options for a `<select>` whose choices come from the draft.
 *
 * Rebuilt only when the set moved — a `<select>` is not typed into, but
 * replacing its children while its dropdown is open closes it.
 *
 * @param {HTMLSelectElement} select
 * @param {string[]} names
 * @param {string} value
 */
function fillSelect(select, names, value) {
  // The current value always appears, even when it names an agent the track no
  // longer has: dropping it would silently rewrite the config to whatever
  // happened to be first, and the problem list is what says it is wrong.
  const offered = [...new Set(value === '' ? names : [value, ...names])].sort()
  if (select.dataset['offered'] !== offered.join(',')) {
    select.dataset['offered'] = offered.join(',')
    select.replaceChildren(
      ...offered.map((name) => {
        const option = document.createElement('option')
        option.value = name
        option.textContent = name
        return option
      }),
    )
  }
  if (select.value !== value) select.value = value
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
