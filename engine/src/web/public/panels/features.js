/**
 * Feature briefs, and the one write this page is permitted.
 *
 * Structurally `panels/plans.js`: a master list, one detail fetched only while
 * it is open, and a decision taken against what that detail actually showed.
 * The differences are all consequences of what a brief *is*.
 *
 *  - **A revision is immutable and an approval is final.** `approveFeatureBrief`
 *    refuses to touch an approved revision ever again, so unlike a plan gate
 *    there is no re-decision and no undo to offer. That is why this is the
 *    second control on the page with a confirmation dialog.
 *  - **The compare-and-swap is on content, not on the revision number.** A draft
 *    holds one number for the whole of its editable life, so the number alone
 *    would approve whatever the brief says by the time the click lands. The
 *    digest served beside the brief is handed straight back.
 *  - **A criteria-less draft is refused before it is sent.** The schema requires
 *    at least one acceptance criterion on an approved brief, and `web/writes.ts`
 *    deliberately gives that refusal no code of its own — it falls to
 *    `write.failed` with the diagnosis on the server's terminal. The page cannot
 *    explain it afterwards, so it does not let it happen.
 *
 * There is no create, no edit, and no discovery launched from here. Writing a
 * brief is the interview's work, and a second, weaker discovery flow beside the
 * skill that exists to run one is what `web/writes.ts:58` argues against.
 */
import { attr, clone, flag, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { stamp } from '../lib/fmt.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'
import { submit } from '../ui/writes.js'

/** @typedef {import('../../read.js').FeatureDetail} FeatureDetail */
/** @typedef {import('../../read.js').FeatureRevisionView} FeatureRevisionView */
/** @typedef {import('../../../schemas/feature.js').FeatureBrief} FeatureBrief */
/** @typedef {import('../../../store/feature-store.js').FeatureSummary} FeatureSummary */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/** The feature opened by a user action, and waiting for its fetched detail. */
let opened = /** @type {string | null} */ (null)
/** Moved to on the tick after a detail opens, so the heading takes focus once. */
let focusPending = /** @type {string | null} */ (null)

/**
 * Whether this brief can be approved from here, and why not when it cannot.
 *
 * Exported because it is the whole of the button's policy and the one piece of
 * this panel worth testing without a DOM. The two refusals are not the same
 * kind of thing: a non-draft is a state the page can see and describe, and an
 * empty acceptance list is a schema rule the server would answer with a code
 * that says nothing about acceptance criteria.
 *
 * @param {FeatureDetail | null} detail
 * @returns {{ can: boolean, why: string | null }}
 */
export function approvable(detail) {
  if (detail === null) return { can: false, why: null }
  if (detail.status !== 'draft') return { can: false, why: null }
  if (detail.brief.acceptance.length === 0) return { can: false, why: 'features.needsAcceptance' }
  return { can: true, why: null }
}

export function mountFeatures() {
  const node = pick('panel-features')
  const empty = pick('features-empty')
  const workspace = pick('features-workspace')
  const host = pick('features-list')
  const more = pick('features-more')

  const detail = pick('feature-detail')
  const detailTitle = pick('feature-detail-title')
  const record = pick('feature-record')
  const blocked = pick('feature-blocked')
  const approve = /** @type {HTMLButtonElement} */ (document.getElementById('feature-approve'))
  const problem = pick('feature-problem')
  const acceptanceHost = pick('feature-acceptance')
  const acceptanceEmpty = pick('feature-acceptance-empty')
  const decisionsBlock = pick('feature-decisions-block')
  const decisionsHost = pick('feature-decisions')
  const components = pick('feature-components')
  const tags = pick('feature-tags')
  const discovery = pick('feature-discovery')
  const created = pick('feature-created')
  const approvalBlock = pick('feature-approval-block')
  const approvedBy = pick('feature-approved-by')
  const approvedAt = pick('feature-approved-at')
  const approvalNote = pick('feature-approval-note')
  const revisionsHost = pick('feature-revisions')

  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('feature-dialog'))
  const subject = pick('feature-dialog-subject')
  const note = /** @type {HTMLInputElement} */ (document.getElementById('feature-note'))

  /** @type {import('../lib/api.js').Feed<FeatureSummary[]>} */
  const features = feed({
    dep: (state) => state.revisions.features,
    path: () => '/api/features',
    onChange: () => draw(),
  })

  /** @type {import('../lib/api.js').Feed<FeatureDetail>} */
  const brief = feed({
    // Only the open brief, and only while it is open — one conditional GET
    // rather than one per row, exactly as `plans.js` reasons about its own.
    dep: (state) => (opened === null ? null : `${opened}:${state.revisions.features}`),
    path: () => `/api/features/${encodeURIComponent(opened ?? '')}`,
    onChange: () => draw(),
  })

  register({
    id: 'features',
    node,
    update(state) {
      features.update(state)
      brief.update(state)

      const all = features.value() ?? []
      workspace.dataset['detailOpen'] = opened === null ? 'false' : 'true'
      phrase(empty, 'features.empty')
      flag(empty, 'hidden', all.length > 0)

      const { shown, total } = reconcile(host, all, (view) => view.id, featureRow)
      flag(more, 'hidden', shown >= total)
      if (shown < total) phrase(more, 'features.more', { shown, total })

      drawDetail(brief.value())
    },
  })

  function featureRow() {
    const { root, slots } = clone('tpl-feature')
    return {
      root,
      /** @param {FeatureSummary} view */
      update(view) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, view.id)
        const title = slots['title']
        if (title !== undefined) verbatim(title, view.title)

        const status = slots['status']
        if (status !== undefined) {
          phrase(status, `features.status.${view.status}`)
          attr(status, 'data-status', view.status)
        }

        const open = slots['open']
        if (open !== undefined) {
          attr(open, 'data-feature', view.id)
          attr(open, 'aria-expanded', opened === view.id ? 'true' : 'false')
          phrase(open, opened === view.id ? 'features.close' : 'features.open')
        }
      },
    }
  }

  /**
   * @param {FeatureDetail | null} view
   */
  function drawDetail(view) {
    flag(detail, 'hidden', opened === null || view === null)
    if (view === null) return

    verbatim(detailTitle, view.brief.title)
    if (focusPending !== null && focusPending === view.brief.id) {
      focusPending = null
      detailTitle.focus()
    }

    // The revision and the status in one line, because either alone invites the
    // wrong question: "approved" without a revision hides which words were
    // approved, and a revision without a status hides whether anything was.
    phrase(record, `features.record.${view.status}`, { id: view.brief.id, revision: view.brief.revision })

    const gate = approvable(view)
    flag(approve, 'hidden', view.status !== 'draft')
    flag(approve, 'disabled', !gate.can)
    flag(blocked, 'hidden', gate.why === null)
    if (gate.why !== null) phrase(blocked, gate.why)

    verbatim(problem, view.brief.problem)

    flag(acceptanceEmpty, 'hidden', view.brief.acceptance.length > 0)
    phrase(acceptanceEmpty, 'features.acceptanceEmpty')
    reconcile(acceptanceHost, view.brief.acceptance, (line) => line, () => {
      const row = clone('tpl-acceptance')
      return {
        root: row.root,
        /** @param {string} line */
        update(line) {
          verbatim(row.slots['text'] ?? row.root, line)
        },
      }
    })

    flag(decisionsBlock, 'hidden', view.brief.decisions.length === 0)
    reconcile(decisionsHost, view.brief.decisions, (decision) => decision.question, decisionCard)

    verbatim(components, view.brief.affectedComponents.join(' '))
    verbatim(tags, view.brief.tags.join(' '))
    // The mode is the engine's own enum; the note beside it is the interview's
    // prose and stays verbatim.
    phrase(discovery, `features.discovery.${view.brief.discovery.mode}`)
    verbatim(created, stamp(view.brief.createdAt))

    const approval = view.brief.approval
    flag(approvalBlock, 'hidden', approval === null)
    verbatim(approvedBy, approval?.by ?? '')
    verbatim(approvedAt, approval === null ? '' : stamp(approval.at))
    verbatim(approvalNote, approval?.note ?? '')

    reconcile(revisionsHost, view.revisions, (entry) => String(entry.revision), revisionRow)
  }

  function decisionCard() {
    const { root, slots } = clone('tpl-decision')
    return {
      root,
      /** @param {import('../../../schemas/feature.js').Decision} decision */
      update(decision) {
        const question = slots['question']
        if (question !== undefined) verbatim(question, decision.question)

        // An unanswered question is a sentence, an answered one is the person's
        // own words. Two different kinds of content in one slot, so the branch
        // chooses which to write rather than whether to write — rule 2 in
        // `ui/dom.js`. A row is keyed by its question and an answer can arrive
        // later, so this node really does cross between the two forms.
        const answer = slots['answer']
        if (answer !== undefined) {
          if (decision.answer === null) phrase(answer, 'features.unanswered')
          else verbatim(answer, decision.answer)
        }

        // A recommendation the answer took is not worth a second line: the
        // interview very often records both and they are then the same words,
        // which renders as the answer stated twice with nothing saying which is
        // which. It is worth a line when it was *not* taken, or when nothing has
        // been decided yet — and it is labelled either way, because an unlabelled
        // sentence under an answer reads as part of the answer.
        const recommendation = slots['recommendation']
        if (recommendation !== undefined) {
          const shown = decision.recommendation !== null && decision.recommendation !== decision.answer
          flag(recommendation, 'hidden', !shown)
          if (shown) phrase(recommendation, 'features.recommended', { what: decision.recommendation ?? '' })
        }
      },
    }
  }

  function revisionRow() {
    const { root, slots } = clone('tpl-feature-revision')
    return {
      root,
      /** @param {FeatureRevisionView} entry */
      update(entry) {
        const revision = slots['revision']
        if (revision !== undefined) verbatim(revision, entry.revision)
        const status = slots['status']
        if (status !== undefined) {
          phrase(status, `features.status.${entry.status}`)
          attr(status, 'data-status', entry.status)
        }
      },
    }
  }

  return {
    /** @param {string} id */
    toggle(id) {
      const closing = opened === id
      opened = closing ? null : id
      focusPending = closing ? null : id
      draw()
    },
    close() {
      opened = null
      focusPending = null
      draw()
    },
    /**
     * Open the confirmation, naming exactly what is about to become permanent.
     */
    ask() {
      const view = brief.value()
      if (!approvable(view).can || view === null) return
      // Written once, on a user action. No renderer touches it again, which is
      // rule 3 in `ui/dom.js`.
      note.value = ''
      phrase(subject, 'features.confirmSubject', {
        id: view.brief.id,
        revision: view.brief.revision,
        n: view.brief.acceptance.length,
      })
      dialog.showModal()
      note.focus()
    },
    dismiss() {
      dialog.close()
    },
    confirm() {
      const view = brief.value()
      dialog.close()
      // Re-checked after the dialog rather than trusted from before it: the feed
      // keeps running while the modal is open, so the brief on screen behind it
      // can have been approved elsewhere or gained another decision. The digest
      // below would refuse it either way — this only avoids sending a frame
      // whose answer is already known.
      if (!approvable(view).can || view === null) return
      const written = note.value.trim()
      submit({
        kind: 'feature.approve',
        feature: view.brief.id,
        revision: view.brief.revision,
        // What the screen the decision was made from actually said. Not a
        // fingerprint of the id, and not the revision number restated: a draft
        // is edited in place, so this is the only field that moves when the
        // words do.
        digest: view.digest,
        note: written.length === 0 ? null : written,
      })
    },
  }
}
