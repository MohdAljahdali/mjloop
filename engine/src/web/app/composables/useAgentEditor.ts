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
 * name pool `copyName` needs — lives here as a second module ref, set once by
 * whichever handler is still mounted when the button is pressed
 * (`Agents.vue`). `AgentEditor.vue` still freezes its own working copy of it
 * in a `watch(open)`, the same shape `HaltDialog.vue` freezes `subject` from
 * `runId` in: read once, when the dialog opens, never re-read afterward.
 */
import { ref } from 'vue'
import type { AgentView } from '../types/protocol.js'

export interface AgentEditSubject {
  mode: 'update' | 'create'
  agent: AgentView
  /** Every name already in use — `create` mode seeds a free one from this via `copyName`. */
  takenNames: readonly string[]
}

const open = ref(false)
const subject = ref<AgentEditSubject | null>(null)

export function useAgentEditor() {
  return {
    open,
    subject,
    openEdit: (agent: AgentView, takenNames: readonly string[]): void => {
      subject.value = { mode: 'update', agent, takenNames }
      open.value = true
    },
    openDerive: (agent: AgentView, takenNames: readonly string[]): void => {
      subject.value = { mode: 'create', agent, takenNames }
      open.value = true
    },
    closeEditor: (): void => void (open.value = false),
  }
}
