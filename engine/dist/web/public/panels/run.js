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
import { clone, cls, flag, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../read.js').StateView} StateView
 * @typedef {import('../../read.js').RunDetail} RunDetail
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

  register({
    id: 'run',
    node,
    update(snapshot) {
      state.update(snapshot)
      run.update(snapshot)

      const summary = snapshot.state
      const idle = !summary.initialised || summary.status === 'idle'
      phrase(empty, summary.initialised ? 'run.idle' : 'run.uninitialised')
      flag(empty, 'hidden', !idle)
      flag(body, 'hidden', idle)
      if (idle) return

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
    },
  })

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
