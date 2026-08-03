<script setup lang="ts">
/**
 * One row of a `<dl class="facts">`: `tpl-fact`, ported. The label is always
 * a translated phrase here — the preflight estimate and the pinned manifest
 * are the two places this page draws one, and both key their rows off a
 * phrase rather than a config field name.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

defineProps<{ label: string; value: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="fact">
    <dt>{{ t(label) }}</dt>
    <dd><Bdi :value="value" /></dd>
  </div>
</template>
