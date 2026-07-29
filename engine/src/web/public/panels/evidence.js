/**
 * Evidence — the runs on disk, and what each cycle actually did.
 *
 * The list is directory names with outcomes derived from what is inside them.
 * Opening a run fetches its cycles, and each cycle carries the two things that
 * are recoverable from nowhere else: the agents the leader **skipped**, with
 * its stated reason for each, and what the engine itself executed to verify
 * the project.
 *
 * The verify ledger and the handoff ride the cycle document rather than routes
 * of their own, so both follow the per-cycle revision rule already below: the
 * open run's last cycle is live and everything before it is inert.
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

/**
 * One line of `cycle-NN/verify/index.json` — the engine's record of what the
 * engine itself executed.
 *
 * Taken from the reader's own type rather than restated: `public/` is the
 * browser and imports nothing from `src/`, but `read.ts` is the wire it is
 * already typed against, so the ledger's shape stays in one place.
 *
 * @typedef {CycleDetail['verify'][number]} LedgerEntry
 */

/**
 * The verify table's headings, which live inside a cloned block and so are
 * translated by the row's own `update()` — `translateStatic` cannot reach into
 * `<template>` content, and phrasing them once at clone time would leave them
 * in the old language after a locale switch.
 */
const VERIFY_HEADERS = /** @type {const} */ ([
  ['vh-slot', 'evidence.verify.slot'],
  ['vh-command', 'evidence.verify.command'],
  ['vh-phase', 'evidence.verify.phase'],
  ['vh-exit', 'evidence.verify.exit'],
  ['vh-duration', 'evidence.verify.duration'],
  ['vh-source', 'evidence.verify.source'],
  ['vh-drift', 'evidence.verify.drift'],
  ['vh-cached', 'evidence.verify.cached'],
])

/**
 * Written out rather than composed into `` `evidence.verify.${phase}` ``, so
 * `tests/web/locales.test.ts` can still tell a dead key from a live one: a
 * template literal marks the whole namespace used and the inverse sweep stops
 * finding anything.
 */
const PHASE_KEY = {
  queued: 'evidence.verify.queued',
  running: 'evidence.verify.running',
  complete: 'evidence.verify.complete',
}

const SOURCE_KEY = { pinned: 'evidence.verify.pinned', live: 'evidence.verify.live' }

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

        // What the *engine* ran, beside what the agents said about it. The two
        // are different claims and this is the only place they sit together.
        const ledger = cycle.verify
        const verifyBlock = slots['verifyBlock']
        if (verifyBlock !== undefined) flag(verifyBlock, 'hidden', ledger.length === 0)
        const verifyTitle = slots['verifyTitle']
        if (verifyTitle !== undefined) phrase(verifyTitle, 'evidence.verify.title')
        for (const [name, key] of VERIFY_HEADERS) {
          const head = slots[name]
          if (head !== undefined) phrase(head, key)
        }
        const verifyHost = slots['verify']
        if (verifyHost !== undefined) {
          // Keyed on the log name and the start time, both of which are fixed
          // before the child exits: an entry is written while it is queued or
          // running and amended in place, so a key built from the exit code
          // would replace the row rather than update it.
          reconcile(verifyHost, ledger, (entry) => `${entry.slot}:${entry.log}:${entry.at}`, verifyRow)
        }
        // The reader caps the rows it puts on the wire, and a cap nobody
        // mentions reads as a complete record that is missing invocations.
        const verifyMore = slots['verifyMore']
        if (verifyMore !== undefined) {
          flag(verifyMore, 'hidden', cycle.verify_total <= ledger.length)
          if (cycle.verify_total > ledger.length) {
            phrase(verifyMore, 'evidence.verify.more', { shown: ledger.length, total: cycle.verify_total })
          }
        }

        // The handoff is the next cycle's brief, written from this one. It is
        // collapsed because it repeats — deliberately — what the rows above
        // already say.
        const handoffDetails = slots['handoffDetails']
        if (handoffDetails !== undefined) flag(handoffDetails, 'hidden', cycle.handoff === null)
        const handoffSummary = slots['handoffSummary']
        if (handoffSummary !== undefined) phrase(handoffSummary, 'evidence.handoff')
        const handoffBody = slots['handoff']
        if (handoffBody !== undefined) verbatim(handoffBody, cycle.handoff ?? '')
        const handoffCut = slots['handoffCut']
        if (handoffCut !== undefined) {
          // Only ever a handoff the engine did not write: `writeHandoff`
          // truncates well under the reader's ceiling.
          flag(handoffCut, 'hidden', !cycle.handoff_truncated)
          phrase(handoffCut, 'evidence.handoffCut')
        }
      },
    }
  }

  function verifyRow() {
    const { root, slots } = clone('tpl-verify-row')
    return {
      root,
      /** @param {LedgerEntry} entry */
      update(entry) {
        const slot = slots['slot']
        if (slot !== undefined) verbatim(slot, entry.slot)
        // The string the engine handed to `spawn`, byte for byte.
        const command = slots['command']
        if (command !== undefined) verbatim(command, entry.command)

        const phase = slots['phase']
        if (phase !== undefined) {
          phrase(phase, PHASE_KEY[entry.phase])
          cls(phase, 'phase', entry.phase)
        }

        const exit = slots['exit']
        if (exit !== undefined) {
          // A timeout has no exit code and is not a failing one either: the
          // child was killed at the ceiling, which is a different fact and the
          // one a person needs to raise `verify.timeout_ms`.
          if (entry.timed_out) phrase(exit, 'evidence.verify.timedOut')
          else verbatim(exit, entry.exit_code === null ? '—' : entry.exit_code)
          // The colour reports the exit code and nothing beyond it. Whether
          // this cycle passed is an agent's judgement, written in the results
          // above; an exit code is only ever a fact about a process.
          cls(exit, 'exit', entry.exit_code === null ? 'none' : entry.exit_code === 0 ? 'zero' : 'nonzero')
        }

        const duration = slots['duration']
        if (duration !== undefined) verbatim(duration, seconds(entry.duration_ms))

        const source = slots['source']
        if (source !== undefined) phrase(source, SOURCE_KEY[entry.source])

        // The drift marker. `config.yaml` is hand-editable and an agent
        // holding Write can rewrite a verify command mid-run; the run executes
        // its pinned copy regardless, and this column is where an operator
        // finds out that the file no longer describes what ran.
        const drift = slots['drift']
        if (drift !== undefined) verbatim(drift, entry.live_command ?? '—')

        const cached = slots['cached']
        if (cached !== undefined) verbatim(cached, entry.cached_from_cycle ?? '—')
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

/**
 * Milliseconds as `1.8s`, and an em dash while there is nothing to measure.
 *
 * Deliberately not localised into words, for `lib/fmt.js:duration`'s reason:
 * it sits in a dense row beside a command and an exit code, and the unit
 * letter reads the same at a glance in both directions. One decimal, because
 * the number the cache argument turns on is under two seconds.
 *
 * @param {number | null} ms
 * @returns {string}
 */
function seconds(ms) {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`
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
