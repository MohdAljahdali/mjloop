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
 */
import { ref } from 'vue'
import type { AgentView } from '../types/protocol.js'

export interface AgentDeleteSubject {
  name: string
  digest: string
}

const open = ref(false)
const subject = ref<AgentDeleteSubject | null>(null)

export function useAgentDelete() {
  return {
    open,
    subject,
    askDelete: (agent: AgentView): void => {
      subject.value = { name: agent.name, digest: agent.digest }
      open.value = true
    },
    closeDelete: (): void => void (open.value = false),
  }
}
