/**
 * Whether the agent-delete confirmation is open, and which agent it names —
 * `useHalt.ts`, ported; `useAgentEditor.ts`'s sibling for the one other write
 * `AgentCard.vue` can start.
 *
 * Lives outside `<KeepAlive>` for the identical reason `useAgentEditor.ts`
 * gives in full: a native `<dialog>` inside a kept-alive panel loses its
 * top-layer state the moment that panel's subtree detaches on a tab switch.
 *
 * `askDelete` is also where this write's compare-and-swap subject gets
 * frozen: it copies `name` and `digest` out of the `AgentView` the pressed
 * button belonged to *at the moment of the click* — not a reference to that
 * (possibly still-live) object — so a snapshot arriving afterward, while the
 * confirmation sits open, can update `AgentCard.vue`'s own props all it wants
 * without ever moving what this dialog is about to send.
 *
 * `open` and its `subject` are one ref, the same collapse `useAgentEditor.ts`
 * makes and for the identical reason — see that file's own header. This one
 * never had the runtime guard the editor's `watch` needed (`AgentDeleteDialog.vue`
 * calls `showModal()` unconditionally and reads `subject` through a `v-if`
 * in its template), but the same two-independent-refs shape was still one a
 * future caller could set out of step; the discriminated union below makes
 * "open with no subject" unrepresentable here too, not merely unencountered.
 */
import { ref } from 'vue'
import type { AgentView } from '../types/protocol.js'

export interface AgentDeleteSubject {
  name: string
  digest: string
}

export type AgentDeleteState = { open: false } | { open: true; subject: AgentDeleteSubject }

const state = ref<AgentDeleteState>({ open: false })

export function useAgentDelete() {
  return {
    state,
    askDelete: (agent: AgentView): void => {
      state.value = { open: true, subject: { name: agent.name, digest: agent.digest } }
    },
    closeDelete: (): void => void (state.value = { open: false }),
  }
}
