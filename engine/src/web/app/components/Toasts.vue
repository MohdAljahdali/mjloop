<script setup lang="ts">
import { useI18n } from '../composables/useI18n.js'
import { useToasts } from '../composables/useToasts.js'
import Tx from './Tx.vue'

const { t } = useI18n()
const { toasts, dismiss } = useToasts()

function act(id: number, run: () => void): void {
  run()
  dismiss(id)
}
</script>

<template>
  <div class="toasts" id="toasts" role="status" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast">
      <!-- Server-sent `{code, params}`, same as `NoticeFeed.vue` — `Tx`,
           unconditionally, for the same reason. -->
      <span><Tx :key-name="toast.message.code" :params="toast.message.params" /></span>
      <button
        v-if="toast.action !== null"
        type="button"
        class="toast-action"
        @click="act(toast.id, toast.action.run)"
      >
        {{ t(toast.action.code) }}
      </button>
      <button type="button" class="icon toast-dismiss" :aria-label="t('toast.dismiss')" @click="dismiss(toast.id)">×</button>
    </div>
  </div>
</template>
