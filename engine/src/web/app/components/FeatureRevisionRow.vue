<script setup lang="ts">
/**
 * `tpl-feature-revision`, ported: one line of a brief's history. The history
 * *is* the audit trail — a revision is immutable, so every earlier one is
 * still exactly what it was when it was written. `superseded` is derived by
 * `readFeatureDetail`, never stored — see `read.ts`'s own comment.
 */
import { useI18n } from '../composables/useI18n.js'
import type { FeatureRevisionView } from '../types/protocol.js'

const props = defineProps<{ entry: FeatureRevisionView }>()

const { t } = useI18n()
</script>

<template>
  <div class="grid-row" role="row">
    <span role="cell"><code data-slot="revision">{{ entry.revision }}</code></span>
    <span role="cell" data-slot="status" :data-status="entry.status">{{ t(`features.status.${entry.status}`) }}</span>
  </div>
</template>
