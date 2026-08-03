<script setup lang="ts">
/**
 * One rule out of `specialists:` — `tpl-specialist-rule`, ported. The mode is
 * a closed picker (the schema's enum is closed) and the sentence beside it is
 * what the chosen mode actually does to a cycle.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ agent: string; mode: string; enabled: boolean }>()
defineEmits<{ 'update:mode': [mode: string]; remove: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="rule">
    <code class="rule-name"><Bdi :value="props.agent" /></code>
    <select
      class="rule-mode"
      :aria-label="t('config.modeLabel')"
      :disabled="!props.enabled"
      :value="props.mode"
      @change="$emit('update:mode', ($event.target as HTMLSelectElement).value)"
    >
      <option value="auto">{{ t('config.mode.auto') }}</option>
      <option value="always">{{ t('config.mode.always') }}</option>
      <option value="never">{{ t('config.mode.never') }}</option>
    </select>
    <span class="rule-why">{{ t(`config.mode.${props.mode}Why`) }}</span>
    <button type="button" class="icon danger" :aria-label="t('config.remove')" :disabled="!props.enabled" @click="$emit('remove')">×</button>
  </div>
</template>
