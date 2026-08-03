/**
 * Whether the agent editor is open, and which agent it opened on —
 * `useHalt.ts`, ported.
 *
 * Shared, module-level state for the same reason `useHalt.ts` keeps its own:
 * the control that opens this (`AgentCard.vue`'s edit/derive buttons, inside
 * the kept-alive `Agents` panel) and the dialog itself (`App.vue`, a sibling
 * of `<main>` and deliberately outside its `<KeepAlive>`) must not be torn
 * down together. `useHalt.ts`'s own comment names the failure this avoids: a
 * native `<dialog>` living inside a kept-alive panel loses its top-layer
 * state — backdrop, focus trap, `Escape` — the instant that panel's subtree
 * detaches on a tab switch, because `showModal()` ran once in `onMounted` and
 * nothing calls it again on `onActivated`. A round-1 review caught exactly
 * this: `AgentEditor.vue` and the delete confirmation both used to live
 * inside `Agents.vue`, reachable only because the test harness happened to
 * mount that panel directly — a test convenience, not an argument.
 *
 * Unlike `useHalt.ts`'s `runId` (a plain prop `App.vue` binds from the live
 * snapshot), there is no single live field this dialog's subject reduces to,
 * so the subject itself — which agent, which mode, and (for `create`) the
 * name pool `copyName` needs — lives here, set once by whichever handler is
 * still mounted when the button is pressed (`Agents.vue`).
 *
 * **`open` and its `subject` are one ref, not two.** A round-2 fix added a
 * runtime guard in `AgentEditor.vue` for `open === true` with `subject ===
 * null` — reachable only if some future caller set one without the other,
 * which today's two setters never do, but nothing enforced that pairing
 * beyond the two of them agreeing to write both at once. A round-3 review
 * called that a trap that self-heals one tick late, not a fix that makes the
 * bad state unrepresentable. `AgentEditorState` below is a discriminated
 * union: the `open: false` member carries no `subject` field at all, and the
 * `open: true` member requires one, so "open with no subject" is not a value
 * this type can hold — `AgentEditor.vue` narrows on `.open` and the compiler
 * proves `.subject` exists on the other side, the same way it already proves
 * it inside `openEdit`/`openDerive` below.
 */
import { ref } from 'vue'
import type { AgentView } from '../types/protocol.js'

export interface AgentEditSubject {
  mode: 'update' | 'create'
  agent: AgentView
  /** Every name already in use — `create` mode seeds a free one from this via `copyName`. */
  takenNames: readonly string[]
}

export type AgentEditorState = { open: false } | { open: true; subject: AgentEditSubject }

const state = ref<AgentEditorState>({ open: false })

export function useAgentEditor() {
  return {
    state,
    openEdit: (agent: AgentView, takenNames: readonly string[]): void => {
      state.value = { open: true, subject: { mode: 'update', agent, takenNames } }
    },
    openDerive: (agent: AgentView, takenNames: readonly string[]): void => {
      state.value = { open: true, subject: { mode: 'create', agent, takenNames } }
    },
    closeEditor: (): void => void (state.value = { open: false }),
  }
}
