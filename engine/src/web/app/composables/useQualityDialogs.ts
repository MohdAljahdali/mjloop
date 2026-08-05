/**
 * Whether either operator quality dialog is open, and what it is about —
 * `useAgentDelete.ts`, ported, for the two writes that suspend and resume a run.
 *
 * Module-level and hosted in `App.vue` for the reason that file's siblings all
 * give: the buttons that open these live inside the kept-alive Run panel, and a
 * native `<dialog>` inside a kept-alive panel loses its top-layer state the
 * moment that panel's subtree detaches on a tab switch. These two are the worst
 * ones to lose that way — one of them is how a person approves a `DROP TABLE`.
 *
 * Both subjects are **copied** out of the record on screen at the moment of the
 * click, never held by reference. The quality feed behind the panel keeps
 * running while a dialog sits open, so a broadcast could otherwise swap the
 * fingerprint or the ceiling under a reader who is still looking at the old
 * one. The engine refuses a stale write either way — both doors are
 * compare-and-swap — but a dialog that silently re-aimed at a *different*
 * operation between render and submit could produce an approval nobody read.
 */
import { ref } from 'vue'
import { announceClient, send } from '../stores/session.js'
import type { QualityBudget } from '../types/protocol.js'

/**
 * The one destructive operation being decided.
 *
 * `run` and `fingerprint` are the whole compare-and-swap token, and they are
 * carried rather than typed: nothing on the page offers a field for either, so
 * the only decision this dialog can submit is the one it is displaying.
 */
export interface DecisionSubject {
  run: string
  fingerprint: string
  kind: string
  /** Already redacted by `web/read.ts` — run- or project-relative, or a basename. */
  targets: string[]
  /** The literal operation being approved. Never abridged. */
  operation: string
  rollback: string | null
  /** Whether the operation had already touched the worktree when it was caught. */
  applied: boolean
}

/** The ceilings on screen, frozen — an amendment is written against one of them. */
export interface BudgetSubject {
  run: string
  budget: QualityBudget
}

export type DecisionState = { open: false } | { open: true; subject: DecisionSubject }
export type BudgetState = { open: false } | { open: true; subject: BudgetSubject }

const decision = ref<DecisionState>({ open: false })
const budget = ref<BudgetState>({ open: false })

/**
 * Continue the run the operator just unblocked, through the terminal that is
 * already open.
 *
 * The engine state is resumed by the write itself; this is only the command
 * that gets the *session* moving again, and it is deliberately the same
 * `/mjloop:resume` a person would type. There is no second execution path here
 * and no direct API call: `send()` is the one socket, and when it reports the
 * frame never left, the ordinary offline notice says so rather than the page
 * claiming a run resumed that nobody told to. The decision is already recorded,
 * so a later `/mjloop:resume` — typed, or enqueued — picks it up unchanged.
 */
export function resumeRun(): void {
  if (!send({ type: 'input', data: '/mjloop:resume\r' })) announceClient({ code: 'write.offline' })
}

export function useQualityDialogs() {
  return {
    decision,
    budget,
    askDecision: (subject: DecisionSubject): void => {
      decision.value = { open: true, subject: { ...subject, targets: [...subject.targets] } }
    },
    closeDecision: (): void => void (decision.value = { open: false }),
    askBudget: (subject: BudgetSubject): void => {
      budget.value = { open: true, subject: { run: subject.run, budget: { ...subject.budget } } }
    },
    closeBudget: (): void => void (budget.value = { open: false }),
  }
}
