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
import { t } from '../lib/i18n.js'
import { planKey } from '../lib/keys.js'
import { subscribe, value as planDoc } from '../lib/plandoc.js'
import { activePlan, setActivePlan } from '../lib/selection.js'
import { planStatus, ready, readyIn, tally } from '../lib/stories.js'
import { reconcile } from '../ui/list.js'
import { draw, register, snapshot as latest } from '../ui/render.js'
import { submit } from '../ui/writes.js'

/**
 * @typedef {import('../../protocol.js').Snapshot} Snapshot
 * @typedef {import('../../protocol.js').PlanView} PlanView
 * @typedef {import('../../protocol.js').StoryView} StoryView
 * @typedef {import('../../read.js').PlanDetail} PlanDetail
 * @typedef {import('../../read.js').StoryDetail} StoryDetail
 */

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



  // The document is fetched in `lib/plandoc.js` and ticked from `app.js`,
  // against a node that is always on screen. This panel only reads it: a feed
  // driven from `update()` stops the moment the panel is hidden, and after the
  // split it is hidden most of the time while something else reads the same
  // document.
  subscribe(() => draw())

  register({
    id: 'plans',
    node,
    update(state) {
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


      drawDetail(planDoc())
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

        const done = view.stories.filter((story) => story.status === 'done').length
        const count = slots['count']
        // A done/total count is two identifiers side by side, not a prose
        // count: `3/8` must not become `٣/٨`.
        if (count !== undefined) verbatim(count, `${done}/${view.stories.length}`)

        // The bar is the part of a plan row that reads at a glance. Written as a
        // percentage of the row's own width, so it needs no measurement.
        const total = view.stories.length
        const percent = total === 0 ? 0 : Math.round((done / total) * 100)
        const bar = slots['bar']
        if (bar !== undefined) bar.style.inlineSize = `${percent}%`
        const progress = slots['progress']
        if (progress !== undefined) {
          attr(progress, 'aria-valuenow', String(percent))
          label(progress, 'aria-label', 'plans.progress', { done, total })
          flag(progress, 'hidden', total === 0)
        }

        const buildable = readyIn(view).length
        const readyNote = slots['ready']
        if (readyNote !== undefined) {
          phrase(readyNote, 'plans.readyHere', { n: buildable })
          flag(readyNote, 'hidden', buildable === 0)
        }

        const stuck = view.stories.filter((story) => story.status === 'blocked').length
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
   * @param {Map<string, string>} plansOf
   * @returns {{ root: HTMLElement, update: (story: StoryView) => void }}
   */
  /** @param {PlanDetail | null} view */
  function drawDetail(view) {
    flag(detail, 'hidden', opened() === null || view === null)
    if (view === null) return

    verbatim(detailTitle, `${view.id} — ${view.title}`)

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


    if (focusPending === view.id) {
      focusPending = null
      detailTitle.focus({ preventScroll: true })
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      detail.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
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
