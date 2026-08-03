<script setup lang="ts">
/**
 * The halt dialog: `ui/dialog.js` + its markup, ported.
 *
 * The one control on this page that gets a confirmation, and it gets one for
 * a reason the others do not have: a halt's inverse is not another permitted
 * write. Everything reversible — an approval, a requeue — goes through
 * without a dialog, because a stale click is refused rather than obeyed and
 * an undo is one press away.
 *
 * Halt is not Stop and they never share a control: Stop kills the pty, halt
 * writes `HALT.md` and only then closes the session. Halt goes through the
 * store's `submit()`; Stop goes through `send()` — see `PaneHead.vue`.
 *
 * A native `<dialog>` opened with `showModal()`, so focus trapping, the
 * backdrop, `Escape` and inertness of the rest of the page are the browser's
 * job. A hand-rolled overlay gets exactly those wrong.
 */
import { ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { submit } from '../stores/session.js'

const props = defineProps<{
  open: boolean
  /** The run this dialog is about, captured when it opened. Null halts nothing. */
  runId: string | null
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
// Written once, on open, by a user action — never by a renderer. Uncontrolled
// for the rest of its life, the same as the old page's `reason.value = ''`.
const reason = ref('')

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      reason.value = ''
      dialog.value?.showModal()
    } else {
      dialog.value?.close()
    }
  },
)

function cancel(): void {
  emit('close')
}

function confirm(): void {
  const text = reason.value.trim()
  emit('close')
  if (props.runId === null || text.length === 0) return
  submit({ kind: 'halt', run: props.runId, reason: text })
}
</script>

<template>
  <dialog id="halt-dialog" ref="dialog" @cancel.prevent="cancel">
    <form id="halt-form" method="dialog" @submit.prevent="confirm">
      <h2>{{ t('halt.title') }}</h2>
      <p class="hint">{{ t('halt.explain') }}</p>
      <label>
        <span>{{ t('halt.reason') }}</span>
        <input id="halt-reason" v-model="reason" name="reason" required maxlength="2000" dir="auto" autocomplete="off" />
      </label>
      <div class="dialog-actions">
        <button type="button" @click="cancel">{{ t('halt.cancel') }}</button>
        <button type="submit" class="danger">{{ t('halt.confirm') }}</button>
      </div>
    </form>
  </dialog>
</template>
