/**
 * Plans — what can be built now, what each plan is waiting on, and one list of
 * stories per plan rather than two.
 *
 * Stories are one tab over. This panel counts them — a progress bar, a tally,
 * how many are ready here — and links across; it never lists them. Two rhythms,
 * two tabs: a plan is read occasionally, a story is watched while it runs.
 *
 * Readiness is `lib/stories.js`'s rule, which is the engine's per-plan one
 * (`ops/plan.ts`'s `storyNext`, what resolves `--next`).
 *
 * The list rides the snapshot. The open plan's body, its review, and its
 * stories' acceptance criteria and evidence are documents, so they are fetched
 * — and they have to be: `acceptance` and `evidence` live in story frontmatter
 * and are deliberately absent from `ManifestEntry`.
 *
 * Three things about the shape of this screen are deliberate, and each was a
 * complaint about the one it replaces:
 *
 *  1. Stories are drawn once, in the open plan's detail. They used to be drawn
 *     inline under every plan row *as well*, so a plan with twenty-two of them
 *     buried the plan list under a wall nobody could scan.
 *  2. The buildable stories carry their own title and plan. A chip reading
 *     `P001-S11` asks the reader to hold an id in their head and then go and
 *     look it up in the wall from (1).
 *  3. Every action is a word. A bare `+` on a row is only obvious to whoever
 *     wrote it.
 */
import { attr, clone, cls, flag, label, phrase, verbatim } from '../ui/dom.js'
import { stamp } from '../lib/fmt.js'
import { feed } from '../lib/api.js'
import { pluralKey, t } from '../lib/i18n.js'
import { planKey, runKey } from '../lib/keys.js'
import { subscribe, value as planDoc } from '../lib/plandoc.js'
import { activePlan, setActivePlan } from '../lib/selection.js'
import { planProgress, planStatus, tally } from '../lib/stories.js'
import { reconcile } from '../ui/list.js'
import { draw, register, snapshot as latest } from '../ui/render.js'
import { submit } from '../ui/writes.js'
import { memoryRow } from './memory.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
 * @typedef {import('../../read.js').PlanDetail} PlanDetail
 * @typedef {import('../../read.js').StoryDetail} StoryDetail
 * @typedef {import('../../read.js').RunSummary} RunSummary
 * @typedef {import('../../read.js').MemoryView} MemoryView
 */

/**
 * The runs whose directory names one of this plan's own stories.
 *
 * `RunSummary.story` (`readRuns`, `web/read.ts:467-495`) is parsed out of the
 * run *directory name* — `<run_id>--<story|adhoc>--<track>` — never stored
 * against a plan anywhere on disk, so this is a convention read off a path,
 * not a foreign key: the same one `panels/stories.js` already filters on for
 * a single story's own history, widened here to every story this plan
 * carries. An ad-hoc run's directory names no story at all — `readRuns` maps
 * that segment to `null` — so it can never be attributed to any plan; that is
 * the fact the directory name itself records, not a gap in this filter.
 *
 * @param {readonly RunSummary[]} runs
 * @param {{ stories: readonly { id: string }[] }} plan
 * @returns {RunSummary[]}
 */
export function planRuns(runs, plan) {
  const ids = new Set(plan.stories.map((story) => story.id))
  return runs.filter((entry) => entry.story !== null && ids.has(entry.story))
}

/**
 * The memories scoped to this plan itself, or to one of its stories.
 *
 * A real join: `MemoryFrontmatterSchema` (`schemas/memory.ts`) carries `plan`
 * and `story` fields precisely so this could stop being a text match. A
 * memory matches when its own `plan` names this plan, or its `story` names
 * one of this plan's stories — the same two ways `mjloop_memory_add` can
 * scope an entry. A memory naming neither is project-wide and belongs to no
 * plan's list, which is what a title or body that merely *mentions* a plan
 * id in passing used to get wrong.
 *
 * @param {readonly MemoryView[]} memories
 * @param {{ id: string, stories: readonly { id: string }[] }} plan
 * @returns {MemoryView[]}
 */
export function planMemories(memories, plan) {
  const storyIds = new Set(plan.stories.map((story) => story.id))
  return memories.filter((memory) => memory.plan === plan.id || (memory.story !== null && storyIds.has(memory.story)))
}

/**
 * The plan whose detail is open, or null.
 *
 * Held in `lib/selection.js` rather than here, so it survives a reload and so
 * the Stories side reads the same answer. Read at draw time, which means a
 * value written before or after mount is picked up on the next frame with no
 * rewiring.
 */
const opened = () => activePlan()
/** The plan opened by a user action and waiting for its fetched detail. */
let focusPending = /** @type {string | null} */ (null)

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountPlans() {
  const node = pick('panel-plans')
  const empty = pick('plans-empty')
  const workspace = pick('plans-workspace')
  const host = pick('plans-list')
  const more = pick('plans-more')

  const tallyBlock = pick('plans-tally-block')
  const tallySlots = {
    plans: pick('tally-plans'),
    ready: pick('tally-ready'),
    doing: pick('tally-doing'),
    blocked: pick('tally-blocked'),
    done: pick('tally-done'),
  }


  const detail = pick('plan-detail')
  const detailTitle = pick('plan-detail-title')
  const record = pick('plan-approval-record')
  const bodyDetails = pick('plan-body-details')
  const body = pick('plan-body')
  const reviewDetails = pick('plan-review-details')
  const review = pick('plan-review')
  const note = /** @type {HTMLInputElement} */ (document.getElementById('approve-note'))
  const decisions = {
    approved: /** @type {HTMLButtonElement} */ (document.querySelector('[data-act="approve"]')),
    changes_requested: /** @type {HTMLButtonElement} */ (document.querySelector('[data-act="request-changes"]')),
    rejected: /** @type {HTMLButtonElement} */ (document.querySelector('[data-act="reject"]')),
  }

  const progressBlock = pick('plan-progress')
  const progressSlots = {
    completed: pick('plan-progress-completed'),
    doing: pick('plan-progress-doing'),
    ready: pick('plan-progress-ready'),
    blocked: pick('plan-progress-blocked'),
    remaining: pick('plan-progress-remaining'),
  }

  const evidenceEmpty = pick('plan-evidence-empty')
  const evidenceHost = pick('plan-evidence-list')
  const evidenceMore = pick('plan-evidence-more')

  const memoryEmpty = pick('plan-memory-empty')
  const memoryHost = pick('plan-memory-list')
  const memoryMore = pick('plan-memory-more')

  // The document is fetched in `lib/plandoc.js` and ticked from `app.js`,
  // against a node that is always on screen. This panel only reads it: a feed
  // driven from `update()` stops the moment the panel is hidden, and after the
  // split it is hidden most of the time while something else reads the same
  // document.
  subscribe(() => draw())

  /**
   * Every run on disk, for Plan Evidence — a second copy of the same feed
   * `panels/stories.js` and `panels/evidence.js` each already hold, and for
   * the identical reason both of theirs exist: `ui/render.js` skips a hidden
   * panel, so a feed driven from someone else's `update()` would stop moving
   * the moment this tab is the one on screen.
   *
   * @type {import('../lib/api.js').Feed<RunSummary[]>}
   */
  const runs = feed({
    dep: (state) => `${state.revisions.runs}:${state.revisions.cycle}`,
    path: () => '/api/runs',
    onChange: () => draw(),
  })

  /**
   * The whole memory corpus, for Plan Memory — `panels/memory.js`'s own copy
   * only draws while the Memory tab itself is open, for the same reason the
   * run feed above needs its own.
   *
   * @type {import('../lib/api.js').Feed<MemoryView[]>}
   */
  const memories = feed({
    dep: (state) => state.revisions.memory,
    path: () => '/api/memory',
    onChange: () => draw(),
  })

  register({
    id: 'plans',
    node,
    update(state) {
      runs.update(state)
      memories.update(state)

      const plans = state.plans
      workspace.dataset['detailOpen'] = opened() === null ? 'false' : 'true'
      phrase(empty, 'plans.empty')
      flag(empty, 'hidden', plans.length > 0)

      const counts = tally(plans)
      flag(tallyBlock, 'hidden', plans.length === 0)
      // Counts, so they are localised digits: unlike `3/8` these are numbers a
      // sentence is talking about, not an identifier.
      phrase(tallySlots.plans, 'plans.number', { n: counts.plans })
      phrase(tallySlots.ready, 'plans.number', { n: counts.ready })
      phrase(tallySlots.doing, 'plans.number', { n: counts.doing })
      phrase(tallySlots.blocked, 'plans.number', { n: counts.blocked })
      phrase(tallySlots.done, 'plans.number', { n: counts.done })

      const { shown, total } = reconcile(host, plans, planKey, () => planRow())
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'plans.more', { shown, total })

      // The exact object `tally()` above already summed and, through
      // `ready()`, the navigation badge already read — never a plan pulled
      // off the fetched document, which can be one revision behind the
      // snapshot this frame is drawing from.
      const openPlan = plans.find((entry) => entry.id === opened()) ?? null
      drawDetail(planDoc(), openPlan)
    },
  })

  /**
   * @returns {{ root: HTMLElement, update: (plan: PlanView) => void }}
   */
  function planRow() {
    const { root, slots } = clone('tpl-plan')
    return {
      root,
      update(view) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, view.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, view.title)

        const state = slots['state']
        if (state !== undefined) {
          phrase(state, `plans.state.${planStatus(view)}`)
          cls(state, 'planstate', planStatus(view))
        }

        const approval = slots['approval']
        if (approval !== undefined) {
          phrase(approval, `plans.approval.${view.approval ?? 'none'}`)
          cls(approval, 'approval', view.approval ?? 'none')
        }

        // `planProgress` (`lib/stories.js`) rather than a filter written out
        // here a second time: it is the same function the Plan Progress
        // block below sums this plan through, so a row and its own detail
        // cannot end up naming two different counts of the same plan.
        const breakdown = planProgress(view)
        const done = breakdown.completed
        const count = slots['count']
        // A done/total count is two identifiers side by side, not a prose
        // count: `3/8` must not become `٣/٨`.
        if (count !== undefined) verbatim(count, `${done}/${breakdown.total}`)

        // The bar is the part of a plan row that reads at a glance. Written as a
        // percentage of the row's own width, so it needs no measurement.
        const total = breakdown.total
        const percent = total === 0 ? 0 : Math.round((done / total) * 100)
        const bar = slots['bar']
        if (bar !== undefined) bar.style.inlineSize = `${percent}%`
        const progress = slots['progress']
        if (progress !== undefined) {
          attr(progress, 'aria-valuenow', String(percent))
          label(progress, 'aria-label', 'plans.progress', { done, total })
          flag(progress, 'hidden', total === 0)
        }

        const buildable = breakdown.ready
        const readyNote = slots['ready']
        if (readyNote !== undefined) {
          phrase(readyNote, 'plans.readyHere', { n: buildable })
          flag(readyNote, 'hidden', buildable === 0)
        }

        const stuck = breakdown.blocked
        const blocked = slots['blocked']
        if (blocked !== undefined) {
          phrase(blocked, 'plans.blockedHere', { n: stuck })
          flag(blocked, 'hidden', stuck === 0)
        }

        const open = slots['open']
        if (open !== undefined) {
          open.dataset['plan'] = view.id
          attr(open, 'aria-controls', 'plan-detail')
          attr(open, 'aria-expanded', opened() === view.id ? 'true' : 'false')
          phrase(open, opened() === view.id ? 'plans.close' : 'plans.open')
        }

        const noStories = slots['empty']
        if (noStories !== undefined) {
          phrase(noStories, 'story.listEmpty')
          flag(noStories, 'hidden', view.stories.length > 0)
        }
      },
    }
  }

  /**
   * @param {PlanDetail | null} view The fetched document — `PLAN.md`,
   *   `REVIEW.md`, the decision, and (for Evidence and Memory below) this
   *   plan's own story ids.
   * @param {PlanView | null} planView The matching entry off `state.plans`,
   *   for Plan Progress — see the comment where this is computed, in
   *   `update()` above, for why that source and not `view`.
   */
  function drawDetail(view, planView) {
    flag(detail, 'hidden', opened() === null || view === null)
    if (view === null) return

    verbatim(detailTitle, `${view.id} — ${view.title}`)

    // Plan Progress. Hidden rather than drawn from a stale document when the
    // snapshot has stopped listing the open plan — `snapshot.ts:113`'s "one
    // unreadable plan directory must not blank the whole panel" guard is
    // about the selection surviving, not about this block inventing numbers
    // for a plan no longer on record.
    flag(progressBlock, 'hidden', planView === null)
    if (planView !== null) {
      const breakdown = planProgress(planView)
      // Counts, so they are localised digits — the same reason the aside
      // tally above renders its own five numbers through `phrase()` rather
      // than `verbatim()`.
      phrase(progressSlots.completed, 'plans.number', { n: breakdown.completed })
      phrase(progressSlots.doing, 'plans.number', { n: breakdown.doing })
      phrase(progressSlots.ready, 'plans.number', { n: breakdown.ready })
      phrase(progressSlots.blocked, 'plans.number', { n: breakdown.blocked })
      phrase(progressSlots.remaining, 'plans.number', { n: breakdown.remaining })
    }

    // The whole approval record, where the list shows only the decision. An
    // approval is auditable or it is a flag.
    const approval = view.approval
    if (approval === null) {
      phrase(record, 'plans.noDecision')
    } else {
      phrase(record, 'plans.decidedBy', {
        // The decision is an engine enum with a translated word for every
        // member — asserted exhaustive against `ApprovalDecisionSchema` — so it
        // renders as that word rather than as `changes_requested`.
        decision: t(`plans.approval.${approval.decision}`),
        by: approval.by,
        at: stamp(approval.at),
        note: approval.note ?? '—',
      })
    }

    // The decision already on record is not an action. Offering it as one is how
    // a user ends up pressing Approve on an approved plan and wondering which
    // of the two of them is confused.
    for (const [decision, button] of Object.entries(decisions)) {
      if (button !== null) flag(button, 'disabled', approval?.decision === decision)
    }

    verbatim(body, view.body)
    flag(bodyDetails, 'hidden', view.body.trim().length === 0)
    verbatim(review, view.review ?? '')
    // Nothing in `engine/src` reads REVIEW.md at all, so this is the only place
    // the plan-critic's verdict is ever seen again.
    flag(reviewDetails, 'hidden', view.review === null)

    // Plan Evidence: `planRuns` (above) filters the shared `/api/runs` feed
    // by the run directory's own naming convention against this plan's own
    // story ids, off the fetched document rather than `planView` — the doc is
    // what the detail is already showing, and it is what `planRuns`' own
    // signature asks for.
    const evidenceRows = planRuns(runs.value() ?? [], view)
    phrase(evidenceEmpty, 'plans.evidence.empty')
    flag(evidenceEmpty, 'hidden', evidenceRows.length > 0)
    const evidenceDrawn = reconcile(evidenceHost, evidenceRows, (entry) => runKey(entry.id), planRunRow)
    flag(evidenceMore, 'hidden', evidenceDrawn.shown >= evidenceDrawn.total)
    if (evidenceDrawn.shown < evidenceDrawn.total) {
      phrase(evidenceMore, 'plans.evidence.more', { shown: evidenceDrawn.shown, total: evidenceDrawn.total })
    }

    // Plan Memory: `planMemories` (above) — a real join on `plan`/`story`.
    const memoryRows = planMemories(memories.value() ?? [], view)
    phrase(memoryEmpty, 'plans.memory.empty')
    flag(memoryEmpty, 'hidden', memoryRows.length > 0)
    const memoryDrawn = reconcile(memoryHost, memoryRows, (memory) => memory.id, memoryRow)
    flag(memoryMore, 'hidden', memoryDrawn.shown >= memoryDrawn.total)
    if (memoryDrawn.shown < memoryDrawn.total) {
      phrase(memoryMore, 'plans.memory.more', { shown: memoryDrawn.shown, total: memoryDrawn.total })
    }

    if (focusPending === view.id) {
      focusPending = null
      detailTitle.focus({ preventScroll: true })
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      detail.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
    }
  }

  /**
   * One row of Plan Evidence: the same fields `tpl-story-run`'s row draws for
   * a single story's own history, plus the story id — see `tpl-plan-run`'s
   * own comment in `index.html` for why there is no `open-run` control here.
   *
   * @returns {{ root: HTMLElement, update: (entry: RunSummary) => void }}
   */
  function planRunRow() {
    const { root, slots } = clone('tpl-plan-run')
    return {
      root,
      /** @param {RunSummary} entry */
      update(entry) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, entry.id)
        const story = slots['story']
        // `planRuns` already filtered out `null`, but the field itself is
        // still nullable in the type this row is drawn from — the fallback
        // stays honest about that rather than asserting it away.
        if (story !== undefined) verbatim(story, entry.story ?? '—')
        const track = slots['track']
        if (track !== undefined) verbatim(track, entry.track ?? '—')
        const cycles = slots['cycles']
        if (cycles !== undefined) phrase(cycles, pluralKey('story.run.cycles', entry.cycles), { count: entry.cycles })
        const outcome = slots['outcome']
        if (outcome !== undefined) {
          phrase(outcome, entry.halted ? 'story.run.halted' : 'story.run.ended')
          cls(outcome, 'res', entry.halted ? 'fail' : 'pass')
        }
      },
    }
  }

  return {
    /** @param {string} id */
    toggle(id) {
      const closing = opened() === id
      setActivePlan(closing ? null : id)
      focusPending = closing ? null : id
      draw()
    },
    close() {
      setActivePlan(null)
      focusPending = null
      draw()
    },
    /** @param {'approved' | 'rejected' | 'changes_requested'} decision */
    decide(decision) {
      // Read once: the decision is submitted against the plan that was open
      // when the button was pressed, not against whatever it is by the time the
      // frame is composed.
      const plan = opened()
      const current = latest()?.plans.find((view) => view.id === plan)
      if (plan === null || current === undefined) return
      const written = note.value.trim()
      submit({
        kind: 'gate',
        plan,
        // What was on record when the button was pressed. A stale click is
        // refused rather than obeyed, which is why this needs no dialog.
        from: /** @type {'approved' | 'rejected' | 'changes_requested' | null} */ (current.approval),
        to: decision,
        note: written.length === 0 ? null : written,
      })
      // A user action, not a render.
      note.value = ''
    },
  }
}
