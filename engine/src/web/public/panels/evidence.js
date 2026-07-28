/**
 * Evidence — the runs on disk, and what each cycle actually did.
 *
 * The list is directory names with outcomes derived from what is inside them.
 * Opening a run fetches its cycles, and each cycle carries the thing that is
 * recoverable from nowhere else: the agents the leader **skipped**, with its
 * stated reason for each.
 */
import { clone, cls, flag, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { runKey } from '../lib/keys.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/**
 * @typedef {import('../../read.js').RunSummary} RunSummary
 * @typedef {import('../../read.js').RunDetail} RunDetail
 * @typedef {import('../../read.js').CycleDetail} CycleDetail
 */

/** The run whose cycles are open, or null. */
let opened = /** @type {string | null} */ (null)

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountEvidence() {
  const node = pick('panel-evidence')
  const empty = pick('evidence-empty')
  const host = pick('evidence-list')
  const more = pick('evidence-more')

  const detail = pick('run-open')
  const detailTitle = pick('run-open-title')
  const haltDetails = pick('run-open-halt')
  const haltBody = pick('run-open-haltbody')
  const cyclesHost = pick('run-open-cycles')

  /** @type {import('../lib/api.js').Feed<RunSummary[]>} */
  const runs = feed({
    // `revisions.cycle` as well as `revisions.runs`: a cycle directory gains
    // files while a run is live, and the outcome column counts them.
    dep: (state) => `${state.revisions.runs}:${state.revisions.cycle}`,
    path: () => '/api/runs',
    onChange: () => draw(),
  })

  /** @type {import('../lib/api.js').Feed<RunDetail>} */
  const run = feed({
    dep: (state) => (opened === null ? null : `${opened}:${state.revisions.cycle}`),
    path: () => `/api/runs/${encodeURIComponent(opened ?? '')}`,
    onChange: () => draw(),
  })

  /** Cycle bodies, fetched one at a time as the open run's list is walked. */
  const cycles = new Map()

  register({
    id: 'evidence',
    node,
    update(state) {
      runs.update(state)
      run.update(state)

      const list = runs.value() ?? []
      phrase(empty, 'evidence.empty')
      flag(empty, 'hidden', list.length > 0)

      const { shown, total } = reconcile(host, list, (entry) => runKey(entry.id), runRow)
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'evidence.more', { shown, total })

      drawDetail(state, run.value())
    },
  })

  function runRow() {
    const { root, slots } = clone('tpl-run')
    return {
      root,
      /** @param {RunSummary} entry */
      update(entry) {
        // A run directory name opens with a timestamp and carries the story id
        // and track. Every part of it is an identifier.
        const id = slots['id']
        if (id !== undefined) verbatim(id, entry.id)
        const story = slots['story']
        if (story !== undefined) verbatim(story, entry.story ?? '—')
        const track = slots['track']
        if (track !== undefined) verbatim(track, entry.track ?? '—')
        const count = slots['cycles']
        if (count !== undefined) verbatim(count, entry.cycles)

        const outcome = slots['outcome']
        if (outcome !== undefined) {
          phrase(outcome, entry.halted ? 'evidence.halted' : 'evidence.ended')
          cls(outcome, 'res', entry.halted ? 'fail' : 'pass')
        }

        const open = slots['open']
        if (open !== undefined) {
          open.dataset['run'] = entry.id
          phrase(open, opened === entry.id ? 'evidence.close' : 'evidence.open')
        }
      },
    }
  }

  /**
   * @param {import('../../protocol.js').Snapshot} state
   * @param {RunDetail | null} view
   */
  function drawDetail(state, view) {
    flag(detail, 'hidden', opened === null || view === null)
    if (view === null) return

    verbatim(detailTitle, view.id)
    verbatim(haltBody, view.halt ?? '')
    flag(haltDetails, 'hidden', view.halt === null)

    // Only the run's last cycle can still be written to, and only while that
    // run is the live one. Every earlier cycle directory is inert, so it is
    // fetched once and then follows `revisions.runs` — otherwise opening a run
    // with eight cycles would issue eight conditional GETs a second forever.
    const openCycle = state.state.run_id !== null && view.id.startsWith(`${state.state.run_id}--`) ? view.cycles.at(-1) : undefined

    for (const cycle of view.cycles) {
      const key = `${view.id}/${cycle}`
      if (!cycles.has(key)) {
        cycles.set(
          key,
          feed({
            dep: (snapshot) =>
              opened !== view.id
                ? null
                : `${key}:${cycle === openCycle ? snapshot.revisions.cycle : snapshot.revisions.runs}`,
            path: () => `/api/runs/${encodeURIComponent(view.id)}/${cycle}`,
            onChange: () => draw(),
          }),
        )
      }
      cycles.get(key)?.update(state)
    }

    // Feeds for a run nobody is looking at are dropped rather than left to
    // accumulate for as long as the tab stays open.
    for (const key of [...cycles.keys()]) {
      if (!key.startsWith(`${view.id}/`)) cycles.delete(key)
    }

    const loaded = view.cycles
      .map((cycle) => cycles.get(`${view.id}/${cycle}`)?.value())
      .filter((value) => value !== null && value !== undefined)
    reconcile(cyclesHost, loaded, (cycle) => `${view.id}/${cycle.cycle}`, cycleBlock)
  }

  function cycleBlock() {
    const { root, slots } = clone('tpl-run-cycle')
    return {
      root,
      /** @param {CycleDetail} cycle */
      update(cycle) {
        const title = slots['title']
        if (title !== undefined) phrase(title, 'evidence.cycle', { cycle: cycle.cycle })

        const roster = slots['roster']
        if (roster !== undefined) reconcile(roster, cycle.roster?.selected ?? [], (name) => name, chipRow)

        // Why an agent did *not* run is written here and nowhere else.
        const skipped = slots['skipped']
        if (skipped !== undefined) {
          reconcile(skipped, cycle.roster?.skipped ?? [], (entry) => entry.agent, () => {
            const row = clone('tpl-skipped')
            return {
              root: row.root,
              /** @param {{ agent: string, reason: string }} entry */
              update(entry) {
                const agent = row.slots['agent']
                if (agent !== undefined) verbatim(agent, entry.agent)
                // The leader's own words.
                const reason = row.slots['reason']
                if (reason !== undefined) verbatim(reason, entry.reason)
              },
            }
          })
        }

        const agents = slots['agents']
        if (agents !== undefined) reconcile(agents, cycle.agents, (entry) => entry.agent, agentRow)
      },
    }
  }

  function agentRow() {
    const { root, slots } = clone('tpl-agent')
    return {
      root,
      /** @param {{ agent: string, result: any }} entry */
      update(entry) {
        const name = slots['name']
        if (name !== undefined) verbatim(name, entry.agent)

        const status = slots['status']
        if (status !== undefined) {
          phrase(status, `cycle.result.${entry.result?.status ?? 'blocked'}`)
          cls(status, 'res', entry.result?.status ?? 'blocked')
        }

        // Model-authored text, so `verbatim()` — the single path for it.
        const summary = slots['summary']
        if (summary !== undefined) verbatim(summary, entry.result?.summary ?? '')

        const files = slots['files']
        if (files !== undefined) {
          const touched = entry.result?.files_touched ?? []
          verbatim(files, touched.join('  '))
          flag(files, 'hidden', touched.length === 0)
        }

        const evidence = slots['evidence']
        if (evidence !== undefined) {
          reconcile(evidence, entry.result?.evidence ?? [], (card) => `${card.kind}:${card.ref}`, () => {
            const row = clone('tpl-evidence-card')
            return {
              root: row.root,
              /** @param {{ kind: string, ref: string, excerpt: string }} card */
              update(card) {
                const ref = row.slots['ref']
                if (ref !== undefined) verbatim(ref, `${card.kind}: ${card.ref}`)
                const excerpt = row.slots['excerpt']
                if (excerpt !== undefined) {
                  verbatim(excerpt, card.excerpt)
                  // The contract allows an empty excerpt.
                  flag(excerpt, 'hidden', card.excerpt.length === 0)
                }
              },
            }
          })
        }
      },
    }
  }

  return {
    /** @param {string} id */
    toggle(id) {
      opened = opened === id ? null : id
      draw()
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
