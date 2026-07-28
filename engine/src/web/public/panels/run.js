/**
 * Run — what is happening now, without reading the terminal.
 *
 * This milestone draws what the snapshot already carries and nothing more. Four
 * of those fields — `run_id`, `plan`, `last_cycle` and `reproduction.ref` —
 * have been crossing the wire every 800ms since the dashboard shipped and were
 * drawn nowhere.
 */
import { clone, flag, phrase, verbatim } from '../ui/dom.js'
import { reconcile } from '../ui/list.js'
import { register } from '../ui/render.js'

/** @typedef {import('../../protocol.js').Snapshot} Snapshot */

export function mountRun() {
  const node = /** @type {HTMLElement} */ (document.getElementById('panel-run'))
  const empty = /** @type {HTMLElement} */ (document.getElementById('run-empty'))
  const body = /** @type {HTMLElement} */ (document.getElementById('run-body'))

  const goal = /** @type {HTMLElement} */ (document.getElementById('run-goal'))
  const storyFact = /** @type {HTMLElement} */ (document.getElementById('run-story-fact'))
  const story = /** @type {HTMLElement} */ (document.getElementById('run-story'))
  const planFact = /** @type {HTMLElement} */ (document.getElementById('run-plan-fact'))
  const plan = /** @type {HTMLElement} */ (document.getElementById('run-plan'))
  const runIdFact = /** @type {HTMLElement} */ (document.getElementById('run-runid-fact'))
  const runId = /** @type {HTMLElement} */ (document.getElementById('run-runid'))
  const findings = /** @type {HTMLElement} */ (document.getElementById('run-findings'))
  const gateFact = /** @type {HTMLElement} */ (document.getElementById('run-gate-fact'))
  const gate = /** @type {HTMLElement} */ (document.getElementById('run-gate'))
  const haltFact = /** @type {HTMLElement} */ (document.getElementById('run-halt-fact'))
  const halt = /** @type {HTMLElement} */ (document.getElementById('run-halt'))

  const last = /** @type {HTMLElement} */ (document.getElementById('run-last'))
  const lastResult = /** @type {HTMLElement} */ (document.getElementById('run-last-result'))
  const lastAgents = /** @type {HTMLElement} */ (document.getElementById('run-last-agents'))

  register({
    id: 'run',
    node,
    update(snapshot) {
      const state = snapshot.state
      const idle = !state.initialised || state.status === 'idle'
      phrase(empty, state.initialised ? 'run.idle' : 'run.uninitialised')
      flag(empty, 'hidden', !idle)
      flag(body, 'hidden', idle)
      if (idle) return

      verbatim(goal, state.goal ?? '—')

      verbatim(story, state.story ?? '')
      flag(storyFact, 'hidden', state.story === null)
      verbatim(plan, state.plan ?? '')
      flag(planFact, 'hidden', state.plan === null)
      verbatim(runId, state.run_id ?? '')
      flag(runIdFact, 'hidden', state.run_id === null)

      phrase(findings, 'run.findingsCounts', {
        high: state.findings.high,
        medium: state.findings.medium,
        low: state.findings.low,
      })

      // A gate is the running track's business — on `fix` it is a reproduction,
      // on another track it is whatever that track says it proves. So the label
      // is the gate's, and the command that proved it is shown verbatim.
      if (state.reproduction !== null) {
        phrase(gate, state.reproduction.proven ? 'run.gateState.open' : 'run.gateState.shut')
      }
      flag(gateFact, 'hidden', state.reproduction === null)

      verbatim(halt, state.halt_reason ?? '')
      flag(haltFact, 'hidden', state.halt_reason === null)

      const cycle = state.last_cycle
      flag(last, 'hidden', cycle === null)
      if (cycle !== null) {
        phrase(lastResult, `cycle.result.${cycle.result}`)
        reconcile(
          lastAgents,
          cycle.agents,
          (agent) => agent,
          () => {
            const { root, slots } = clone('tpl-chip')
            return {
              root,
              /** @param {string} agent */
              update(agent) {
                // Agent names come from the user's own config: an identifier,
                // never a phrase, and never through `Intl`.
                const text = slots['text']
                if (text !== undefined) verbatim(text, agent)
              },
            }
          },
        )
      }
    },
  })
}
