<script setup lang="ts">
/**
 * `tpl-feature`, ported: one line of a feature — its id, title and status —
 * and the button that opens or closes its detail.
 */
import { useI18n } from '../composables/useI18n.js'
import type { FeatureSummary } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ feature: FeatureSummary; open: boolean }>()
defineEmits<{ toggle: [id: string] }>()

const { t } = useI18n()
</script>

<template>
  <div class="plan">
    <div class="plan-head">
      <code data-slot="id"><Bdi :value="feature.id" /></code>
      <span data-slot="title"><Bdi :value="feature.title" /></span>
      <span class="pill" data-slot="status" :data-status="feature.status">{{ t(`features.status.${feature.status}`) }}</span>
    </div>
    <button type="button" class="plan-open" data-slot="open" :aria-expanded="open ? 'true' : 'false'" @click="$emit('toggle', feature.id)">
      {{ t(open ? 'features.close' : 'features.open') }}
    </button>
  </div>
</template>
