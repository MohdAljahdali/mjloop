/**
 * Run — what is happening now, without reading the terminal.
 *
 * A person running a plan's worth of stories used to read the terminal to learn
 * things the engine had already written down. Whether a halt is two cycles
 * away, which agent in this cycle has landed, what the critic actually found,
 * what the gate is waiting on — all of it was on disk, in schemas the engine
 * owns, and none of it was on the screen.
 *
 * Two sources, and the split is the whole transport rule: counts and rosters
 * are keys and ride the snapshot; findings, history, gate excerpts and the halt
 * report are bodies and are fetched.
 */
import { clone, cls, flag, phrase, translateStatic, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { pluralKey } from '../lib/i18n.js'
import { stamp } from '../lib/fmt.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../read.js').StateView} StateView
 * @typedef {import('../../read.js').RunDetail} RunDetail
 * @typedef {import('../../read.js').ConfigView} ConfigView
 * @typedef {import('../../../schemas/skill-selection.js').SkillManifest} SkillManifest
 * @typedef {import('../../../schemas/skill-selection.js').SkillSelection} SkillSelection
 */

/**
 * What `/api/preflight/<track>` serves, taken from the reader that serves it.
 *
 * There is no currency figure on it, and that is the design rather than an
 * omission: the engine cannot see what an agent runs on — that is frontmatter
 * under the plugin's `agents/` directory — so a price would be a guess wearing
 * an estimate's clothes. Cycles, dispatches and minutes are what it can
 * actually observe, and they are what this block draws.
 *
 * @typedef {Awaited<ReturnType<typeof import('../../read.js').readPreflightEstimate>>} Preflight
 */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountRun() {
  const node = pick('panel-run')
  const empty = pick('run-empty')
  const body = pick('run-body')

  const manifestBlock = pick('run-manifest')
  const manifestBrief = pick('manifest-brief')
  const manifestProfile = pick('manifest-profile')
  const manifestConcurrency = pick('manifest-concurrency')
  const manifestReason = pick('manifest-reason')
  const manifestGenerated = pick('manifest-generated')
  const manifestEmpty = pick('manifest-empty')
  const manifestHost = pick('manifest-selections')

  const goal = pick('run-goal')
  const storyFact = pick('run-story-fact')
  const story = pick('run-story')
  const planFact = pick('run-plan-fact')
  const plan = pick('run-plan')
  const runIdFact = pick('run-runid-fact')
  const runId = pick('run-runid')
  const findings = pick('run-findings')
  const gateFact = pick('run-gate-fact')
  const gate = pick('run-gate')
  const haltFact = pick('run-halt-fact')
  const halt = pick('run-halt')

  const rosterBlock = pick('run-roster')
  const rosterAgents = pick('run-roster-agents')

  const guardsBlock = pick('run-guards')
  const strikes = pick('run-strikes')
  const cycleErrors = pick('run-cycle-errors')

  const findingsBlock = pick('run-findings-block')
  const findingsList = pick('run-findings-list')

  const gateBlock = pick('run-gate-block')
  const gateState = pick('run-gate-state')
  const gateRef = pick('run-gate-ref')
  const gateExcerpt = pick('run-gate-excerpt')

  const last = pick('run-last')
  const lastResult = pick('run-last-result')
  const lastAgents = pick('run-last-agents')

  const timeline = pick('run-timeline')
  const timelineList = pick('run-timeline-list')

  const haltBlock = pick('run-haltreport')
  const haltReport = pick('run-halt-report')

  const preflightBlock = pick('run-preflight')
  const preflightFacts = pick('preflight-facts')
  const preflightBasis = pick('preflight-basis')
  const preflightPast = pick('preflight-past')
  const trackPicker = /** @type {HTMLSelectElement} */ (document.getElementById('preflight-track'))

  /**
   * Which track the estimate is for.
   *
   * The engine's route takes a track rather than a state, because
   * `status === 'idle'` is exactly when it is asked and an idle state names no
   * track at all. So the page has to name one, and a picker is the only honest
   * way: tracks are configuration, and hard-coding `build` here would be the
   * first place in the cockpit that knew a track name.
   */
  let chosen = ''
  /** The track list currently in the picker, so it is rebuilt only when it moves. */
  let offered = ''

  trackPicker.addEventListener('change', () => {
    chosen = trackPicker.value
    draw()
  })

  /**
   * The whole state file — findings, history, `cycle_errors`, the reproduction
   * with its excerpt. Followed on `revisions.cycle` as well as `revisions.state`
   * because `ops/log.ts:175` only touches `state.json` when an agent result
   * carries findings, a gate proof or error signatures: a clean pass writes
   * `cycle-NN/<agent>.json` and moves nothing else.
   *
   * @type {import('../lib/api.js').Feed<StateView>}
   */
  const state = feed({
    dep: (snapshot) => (snapshot.state.initialised ? `${snapshot.revisions.state}:${snapshot.revisions.cycle}` : null),
    path: () => '/api/state',
    onChange: () => draw(),
  })

  /** @type {import('../lib/api.js').Feed<RunDetail>} */
  const run = feed({
    dep: (snapshot) =>
      snapshot.state.run_id === null ? null : `${snapshot.state.run_id}:${snapshot.revisions.runs}`,
    path: (snapshot) => `/api/runs/${encodeURIComponent(runDirName(snapshot))}`,
    onChange: () => draw(),
  })

  /**
   * The routing decision this run was pinned to, before dispatch.
   *
   * `null` from the route means the run pinned no manifest, and the block is
   * hidden outright — "no manifest" and "a manifest that selected nothing" are
   * two different facts and an empty table would state the wrong one.
   *
   * It rides `revisions.runs` and not `revisions.cycle`: a manifest is written
   * once, before the first dispatch, and is never rewritten by a profile or a
   * brief that moved afterwards. Following the tick counter would re-fetch an
   * immutable document once a second for the length of the run.
   *
   * @type {import('../lib/api.js').Feed<SkillManifest | null>}
   */
  const manifest = feed({
    dep: (snapshot) =>
      snapshot.state.run_id === null ? null : `${snapshot.state.run_id}:${snapshot.revisions.runs}`,
    path: (snapshot) => `/api/runs/${encodeURIComponent(runDirName(snapshot))}/skills`,
    onChange: () => draw(),
  })

  /**
   * The track names to offer, which only `config.yaml` knows. Fetched solely
   * while the estimate is on screen — a running project never asks for it.
   *
   * @type {import('../lib/api.js').Feed<ConfigView>}
   */
  const config = feed({
    dep: (snapshot) => (waiting(snapshot) ? snapshot.revisions.config : null),
    path: () => '/api/config',
    onChange: () => draw(),
  })

  /**
   * The estimate follows both revisions it rests on: `revisions.config`
   * because the track's shape is the whole ceiling, and `revisions.runs`
   * because the comparable half is a walk over finished runs.
   *
   * @type {import('../lib/api.js').Feed<Preflight>}
   */
  const preflight = feed({
    dep: (snapshot) =>
      !waiting(snapshot) || chosen === '' ? null : `${chosen}:${snapshot.revisions.config}:${snapshot.revisions.runs}`,
    path: () => `/api/preflight/${encodeURIComponent(chosen)}`,
    onChange: () => draw(),
  })

  register({
    id: 'run',
    node,
    update(snapshot) {
      state.update(snapshot)
      run.update(snapshot)
      config.update(snapshot)
      manifest.update(snapshot)

      const summary = snapshot.state
      const idle = !summary.initialised || summary.status === 'idle'
      phrase(empty, summary.initialised ? 'run.idle' : 'run.uninitialised')
      flag(empty, 'hidden', !idle)
      flag(body, 'hidden', idle)
      if (idle) {
        // The picker has to be filled before the feed reads `chosen`, so the
        // estimate is asked for after it and not beside it.
        drawPicker(snapshot)
        preflight.update(snapshot)
        drawPreflight(preflight.value())
        return
      }
      preflight.update(snapshot)
      drawPreflight(null)

      verbatim(goal, summary.goal ?? '—')
      verbatim(story, summary.story ?? '')
      flag(storyFact, 'hidden', summary.story === null)
      verbatim(plan, summary.plan ?? '')
      flag(planFact, 'hidden', summary.plan === null)
      verbatim(runId, summary.run_id ?? '')
      flag(runIdFact, 'hidden', summary.run_id === null)

      phrase(findings, 'run.findingsCounts', {
        high: summary.findings.high,
        medium: summary.findings.medium,
        low: summary.findings.low,
      })

      if (summary.reproduction !== null) {
        phrase(gate, summary.reproduction.proven ? 'run.gateState.open' : 'run.gateState.shut')
      }
      flag(gateFact, 'hidden', summary.reproduction === null)

      verbatim(halt, summary.halt_reason ?? '')
      flag(haltFact, 'hidden', summary.halt_reason === null)

      drawRoster(snapshot)
      drawGuards(snapshot)
      drawLastCycle(summary.last_cycle)
      // `summary.reproduction` is null when the *track* has no gate; the full
      // state's is null merely because nothing has been proven yet. Only the
      // summary can tell those two apart.
      drawState(state.value(), summary.reproduction !== null)
      drawHalt(run.value())
      drawManifest(manifest.value())
    },
  })

  /**
   * The track picker, rebuilt only when the configured tracks change.
   *
   * `chosen` opens on the track the state names — a project that has run
   * before is usually about to run the same track again — and falls back to
   * the first one the config declares. Nothing here writes to the picker while
   * a person is using it: the options are replaced only when the list itself
   * moved, which is the same rule the memory tab's kind filter follows.
   *
   * @param {Snapshot} snapshot
   */
  function drawPicker(snapshot) {
    const tracks = Object.keys(config.value()?.parsed?.tracks ?? {})
    if (tracks.join(',') === offered) return
    offered = tracks.join(',')

    const preferred = snapshot.state.track
    chosen = preferred !== null && tracks.includes(preferred) ? preferred : (tracks[0] ?? '')
    trackPicker.replaceChildren(
      ...tracks.map((name) => {
        const option = document.createElement('option')
        // An option with no `value` attribute submits its own text, and a
        // track name is an identifier out of the user's own config file — so
        // the text *is* the value. Written this way deliberately: no renderer
        // on this page assigns to a `.value`, and the selection is expressed
        // on the option rather than on the control the user is pointing at.
        option.textContent = name
        option.selected = name === chosen
        return option
      }),
    )
  }

  /**
   * What the run can cost at most, and what comparable runs actually took.
   *
   * @param {Preflight | null} estimate
   */
  function drawPreflight(estimate) {
    flag(preflightBlock, 'hidden', estimate === null)
    if (estimate === null) return

    /** @type {{ key: string, value: string }[]} */
    const facts = [
      { key: 'preflight.maxCycles', value: String(estimate.max_cycles) },
      { key: 'preflight.perCycle', value: String(estimate.dispatches_per_cycle) },
      { key: 'preflight.ceiling', value: String(estimate.ceiling.dispatches) },
      { key: 'preflight.required', value: estimate.roster.required.join(', ') },
    ]
    // The four sets that are often empty are shown only when they are not: a
    // row reading "—" four times over is how a reader learns to skip the
    // block, and `forbidden` is the one line here that explains an absence.
    // The keys are written out rather than composed, so `locales.test.ts` can
    // still tell a dead key in this namespace from a live one.
    const optional = /** @type {const} */ ([
      ['preflight.available', estimate.roster.available],
      ['preflight.forced', estimate.roster.forced],
      ['preflight.forbidden', estimate.roster.forbidden],
      ['preflight.closing', estimate.roster.closing],
    ])
    for (const [key, agents] of optional) {
      if (agents.length > 0) facts.push({ key, value: agents.join(', ') })
    }
    reconcile(preflightFacts, facts, (fact) => fact.key, labelledRow)

    const comparable = estimate.comparable
    if (comparable === null) {
      // *No basis* is an answer. An invented range is not.
      phrase(preflightBasis, 'preflight.noBasis')
      reconcile(preflightPast, [], (fact) => fact.key, labelledRow)
      return
    }

    phrase(preflightBasis, pluralKey('preflight.basis', comparable.runs), { count: comparable.runs })
    /** @type {{ key: string, value: string }[]} */
    const past = [
      { key: 'preflight.pastCycles', value: spread(comparable.cycles) },
      { key: 'preflight.pastDispatches', value: spread(comparable.dispatches) },
    ]
    // Absent until a run has been timed: nothing archives a finished run's
    // clock, so only the run `state.json` still describes carries one.
    if (comparable.minutes !== null) past.push({ key: 'preflight.pastMinutes', value: spread(comparable.minutes) })
    reconcile(preflightPast, past, (fact) => fact.key, labelledRow)
  }

  /**
   * Which agents this cycle drafted, and which have landed.
   *
   * `roster.selected` diffed against the `cycle-NN/<agent>.json` files that
   * exist — the exact procedure `skills/mjloop-leader/SKILL.md:36-44` prescribes
   * for resuming, and the only real intra-cycle progress signal there is.
   * `StateSchema` permits stage `execute` and `judge`, but nothing in the
   * engine ever sets them, so this must not promise a stage.
   *
   * @param {Snapshot} snapshot
   */
  function drawRoster(snapshot) {
    const roster = snapshot.roster
    flag(rosterBlock, 'hidden', roster === null)
    if (roster === null) return
    const landed = new Set(roster.landed)
    reconcile(
      rosterAgents,
      roster.selected.map((agent) => ({ agent, landed: landed.has(agent) })),
      (entry) => entry.agent,
      () => {
        const { root, slots } = clone('tpl-roster-agent')
        return {
          root,
          /** @param {{ agent: string, landed: boolean }} entry */
          update(entry) {
            const mark = slots['mark']
            if (mark !== undefined) verbatim(mark, entry.landed ? '✓' : '○')
            // An agent name comes from the user's own config: an identifier.
            const name = slots['name']
            if (name !== undefined) verbatim(name, entry.agent)
            cls(root, 'landed', entry.landed ? 'yes' : 'no')
          },
        }
      },
    )
  }

  /**
   * How close the run is to a halt.
   *
   * A stagnation halt arrives without warning today. This says it is coming,
   * and flags the error signature that will end the run if this cycle repeats
   * it.
   *
   * @param {Snapshot} snapshot
   */
  function drawGuards(snapshot) {
    const guards = snapshot.guards
    flag(guardsBlock, 'hidden', guards === null)
    if (guards === null) return

    // Two identifiers side by side, not a prose count: `1/2` must not become `١/٢`.
    verbatim(strikes, `${guards.strikes}/${guards.strikesAllowed ?? '?'}`)

    const armed = guards.errorArmed
    reconcile(
      cycleErrors,
      guards.cycleErrors,
      (signature) => signature,
      () => {
        const { root, slots } = clone('tpl-chip')
        return {
          root,
          /** @param {string} signature */
          update(signature) {
            const text = slots['text']
            if (text !== undefined) verbatim(text, signature)
            cls(root, 'armed', signature === armed ? 'yes' : 'no')
          },
        }
      },
    )
  }

  /** @param {{ result: string, agents: string[] } | null} cycle */
  function drawLastCycle(cycle) {
    flag(last, 'hidden', cycle === null)
    if (cycle === null) return
    phrase(lastResult, `cycle.result.${cycle.result}`)
    reconcile(lastAgents, cycle.agents, (agent) => agent, chipRow)
  }

  /**
   * @param {StateView | null} view
   * @param {boolean} hasGate Whether the running track has a gate at all.
   */
  function drawState(view, hasGate) {
    const full = view?.state ?? null

    flag(findingsBlock, 'hidden', full === null || full.findings.length === 0)
    if (full !== null) {
      // A table, replacing three integers. What the critic actually found is
      // the thing a person opens the terminal to read.
      reconcile(
        findingsList,
        full.findings,
        (finding) => `${finding.file}:${finding.line}:${finding.claim}`,
        () => {
          const { root, slots } = clone('tpl-finding')
          return {
            root,
            /** @param {{ severity: string, file: string, line: number, claim: string }} finding */
            update(finding) {
              const severity = slots['severity']
              if (severity !== undefined) {
                phrase(severity, `findings.severity.${finding.severity}`)
                cls(severity, 'sev', finding.severity)
              }
              const where = slots['where']
              if (where !== undefined) verbatim(where, `${finding.file}:${finding.line}`)
              // Model-authored text. `verbatim()` is the single path for it,
              // which is why this page has no `escape()` to keep right.
              const claim = slots['claim']
              if (claim !== undefined) verbatim(claim, finding.claim)
            },
          }
        },
      )
    }

    const gateProof = full?.reproduction ?? null
    flag(gateBlock, 'hidden', full === null || !hasGate)
    if (full !== null && hasGate) {
      phrase(gateState, gateProof === null ? 'run.gateState.shut' : 'run.gateState.provenBy', {
        agent: gateProof?.agent ?? '',
        cycle: gateProof?.cycle ?? 0,
      })
      // `reproduction.ref` has crossed the wire since the dashboard shipped and
      // was drawn nowhere. It is the command that proves the defect.
      verbatim(gateRef, gateProof?.ref ?? '')
      flag(gateRef, 'hidden', gateProof === null)
      verbatim(gateExcerpt, gateProof?.excerpt ?? '')
      flag(gateExcerpt, 'hidden', gateProof === null || gateProof.excerpt.length === 0)
    }

    flag(timeline, 'hidden', full === null || full.history.length === 0)
    if (full !== null) {
      reconcile(
        timelineList,
        full.history,
        (entry) => `${entry.cycle}:${entry.ref}`,
        () => {
          const { root, slots } = clone('tpl-cycle')
          return {
            root,
            /** @param {{ cycle: number, agents: string[], result: string, ref: string }} entry */
            update(entry) {
              const number = slots['number']
              if (number !== undefined) verbatim(number, entry.cycle)
              const agents = slots['agents']
              if (agents !== undefined) verbatim(agents, entry.agents.join(', '))
              const result = slots['result']
              if (result !== undefined) {
                phrase(result, `cycle.result.${entry.result}`)
                cls(result, 'res', entry.result)
              }
              const ref = slots['ref']
              if (ref !== undefined) verbatim(ref, entry.ref)
            },
          }
        },
      )
    }
  }

  /**
   * `HALT.md`, verbatim.
   *
   * Deliberately **no `max_cycles` control here.** The leader is explicitly
   * forbidden from raising `max_cycles` to escape a halt
   * (`skills/mjloop-leader/SKILL.md:276-278`); the decision is the user's, but
   * putting the knob on the halt banner recreates exactly the reflex that rule
   * exists to prevent. It belongs in Config, as a pre-run setting.
   *
   * @param {RunDetail | null} detail
   */
  function drawHalt(detail) {
    const report = detail?.halt ?? null
    flag(haltBlock, 'hidden', report === null)
    verbatim(haltReport, report ?? '')
  }

  /**
   * What this run was actually routed by.
   *
   * The concurrency mode is drawn with its reason and never without it: a bare
   * `sequential` answers "what happened" and leaves "why did this serialise"
   * — the question anybody actually asks — unanswered, which is exactly why
   * `ConcurrencyDecisionSchema` carries the reason alongside the mode rather
   * than making it optional.
   *
   * @param {SkillManifest | null} view
   */
  function drawManifest(view) {
    flag(manifestBlock, 'hidden', view === null)
    if (view === null) return

    verbatim(manifestBrief, `${view.sourceBrief.id}@${view.sourceBrief.revision}`)
    verbatim(manifestProfile, view.profileRevision)
    // The mode is the engine's enum and the reason is engine-authored prose the
    // page does not own, so one is translated and the other is passed through.
    phrase(manifestConcurrency, `manifest.mode.${view.concurrency.mode}`)
    verbatim(manifestReason, view.concurrency.reason)
    verbatim(manifestGenerated, stamp(view.generatedAt))

    // A manifest that selected nothing for every row is a real and ordinary
    // state — no project has accepted a skill yet on most machines — and it is
    // said rather than drawn as an empty area.
    const selections = view.selections
    flag(manifestEmpty, 'hidden', selections.length > 0)
    phrase(manifestEmpty, 'manifest.empty')
    reconcile(
      manifestHost,
      selections,
      (selection) => `${selection.component}/${selection.agent}`,
      () => selectionCard(view),
    )
  }

  /**
   * One (component, agent) row.
   *
   * `skillIds` and `reasons` are index-aligned by a schema refinement, so this
   * pairs them by position without checking — the check is `SkillSelectionSchema`'s
   * and duplicating it here would be a second place it could be relaxed.
   *
   * @param {SkillManifest} view
   */
  function selectionCard(view) {
    const { root, slots } = clone('tpl-selection')
    return {
      root,
      /** @param {SkillSelection} selection */
      update(selection) {
        const component = slots['component']
        if (component !== undefined) verbatim(component, selection.component)
        const agent = slots['agent']
        if (agent !== undefined) verbatim(agent, selection.agent)

        const none = slots['none']
        if (none !== undefined) {
          flag(none, 'hidden', selection.skillIds.length > 0)
          phrase(none, 'manifest.noneSelected')
        }

        const host = slots['skills']
        if (host === undefined) return
        const rows = selection.skillIds.map((skillId, index) => ({
          skillId,
          reason: selection.reasons[index] ?? '',
          guidance: view.guidance[skillId] ?? '',
        }))
        reconcile(host, rows, (row) => row.skillId, selectedSkillRow)
      },
    }
  }

  function selectedSkillRow() {
    const { root, slots } = clone('tpl-selected-skill')
    return {
      root,
      /** @param {{ skillId: string, reason: string, guidance: string }} row */
      update(row) {
        const skillId = slots['skillId']
        if (skillId !== undefined) verbatim(skillId, row.skillId)
        const reason = slots['reason']
        if (reason !== undefined) verbatim(reason, row.reason)

        const guidance = slots['guidance']
        if (guidance !== undefined) verbatim(guidance, row.guidance)
        // The schema guarantees every selected skill carries guidance, so an
        // empty one means a manifest written before that refinement existed.
        // Hidden rather than shown as an empty disclosure.
        const details = slots['guidanceDetails']
        if (details !== undefined) flag(details, 'hidden', row.guidance === '')

        translateStatic(root)
      },
    }
  }
}

/**
 * Whether the estimate is the thing to show: a project that exists, with
 * nothing running in it. Every one of the preflight feeds is gated on this, so
 * a live run costs no request for a document about a run that has not started.
 *
 * @param {Snapshot} snapshot
 * @returns {boolean}
 */
function waiting(snapshot) {
  return snapshot.state.initialised && snapshot.state.status === 'idle'
}

/**
 * `3 (2–5)`, or the bare number when every comparable run agreed.
 *
 * Through `verbatim()` like every other digit in a dense row: a median of 2.5
 * cycles is a true statement about two runs and rounding it would invent a run
 * neither of them was, so it is printed as the engine computed it.
 *
 * @param {{ median: number, min: number, max: number }} range
 * @returns {string}
 */
function spread(range) {
  return range.min === range.max ? String(range.median) : `${range.median} (${range.min}–${range.max})`
}

/** A `<dl class="facts">` row whose label is a translated phrase. */
function labelledRow() {
  const { root, slots } = clone('tpl-fact')
  return {
    root,
    /** @param {{ key: string, value: string }} fact */
    update(fact) {
      const label = slots['label']
      if (label !== undefined) phrase(label, fact.key)
      // Agent names, track names and counts read against a heading: every one
      // of them an identifier, and none of them prose.
      const value = slots['value']
      if (value !== undefined) verbatim(value, fact.value)
    },
  }
}

function chipRow() {
  const { root, slots } = clone('tpl-chip')
  return {
    root,
    /** @param {string} value */
    update(value) {
      const text = slots['text']
      if (text !== undefined) verbatim(text, value)
    },
  }
}

/**
 * `<run_id>--<story|adhoc>--<track>`, the same shape `ops/run.ts:runDirName`
 * builds. Derived here rather than sent, because every part of it is already on
 * the summary.
 *
 * @param {Snapshot} snapshot
 * @returns {string}
 */
function runDirName(snapshot) {
  const { run_id: id, story, track } = snapshot.state
  return `${id ?? ''}--${story ?? 'adhoc'}--${track ?? ''}`
}
