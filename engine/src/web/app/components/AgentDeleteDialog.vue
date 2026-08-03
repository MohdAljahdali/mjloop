<script setup lang="ts">
/**
 * The agent-delete confirmation: `HaltDialog.vue`, ported to
 * `useAgentDelete.ts`'s subject.
 *
 * **Round-1 fix.** This used to be a `<dialog>` inlined in `AgentCard.vue`,
 * reading `props.agent.name`/`.digest` straight off the card's own live prop
 * at confirm time. Two defects followed from that: first, `props.agent` is
 * live — `Agents.vue` re-renders the same card instance with a new
 * `AgentView` the moment `/api/agents` refetches, so a snapshot arriving
 * while this confirmation sat open would silently swap in a new digest
 * before the reader ever pressed the button they were looking at, exactly
 * the failure `HaltDialog.vue:37-49` freezes its own `subject` to prevent.
 * Second, the `<dialog>` itself lived inside the kept-alive `Agents` panel,
 * so a tab switch while it sat open detached its subtree and dropped its
 * top-layer state — `useAgentDelete.ts`'s own header explains that half in
 * full. Both are fixed the same way: `askDelete` (`useAgentDelete.ts`) copies
 * `name`/`digest` out of the pressed card's `AgentView` into a fresh object
 * at the moment of the click, and this component — now a single
 * always-mounted instance hosted in `App.vue`, outside `<KeepAlive>` — freezes
 * its own `subject` from that copy in the `watch(open)` below, the same
 * moment `HaltDialog.vue` freezes its own `subject` from `props.runId`.
 */
import { ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { submit } from '../stores/session.js'
import type { AgentDeleteSubject } from '../composables/useAgentDelete.js'
import Tx from './Tx.vue'

const props = defineProps<{ open: boolean; subject: AgentDeleteSubject | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)

/** Frozen at open — see this file's own header. */
const subject = ref<AgentDeleteSubject | null>(null)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      subject.value = props.subject
      dialog.value?.showModal()
      cancelButton.value?.focus()
    } else {
      dialog.value?.close()
    }
  },
)

function cancel(): void {
  emit('close')
}

function confirm(): void {
  const frozen = subject.value
  emit('close')
  if (frozen === null) return
  submit({ kind: 'agent.delete', name: frozen.name, digest: frozen.digest })
}
</script>

<template>
  <dialog class="agent-delete-dialog" ref="dialog" @cancel.prevent="cancel">
    <form method="dialog" @submit.prevent="confirm">
      <h2>{{ t('agents.deleteConfirmTitle') }}</h2>
      <p class="hint">{{ t('agents.deleteConfirmExplain') }}</p>
      <p class="record"><Tx v-if="subject !== null" key-name="agents.deleteConfirmSubject" :params="{ name: subject.name }" /></p>
      <div class="dialog-actions">
        <button type="button" ref="cancelButton" @click="cancel">{{ t('agents.deleteCancel') }}</button>
        <button type="submit" class="danger">{{ t('agents.deleteConfirm') }}</button>
      </div>
    </form>
  </dialog>
</template>
