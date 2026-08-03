<script setup lang="ts">
/**
 * One required/available agent's row in a track's order graph — its name,
 * the chips naming what it waits on, and the combobox that adds one more.
 * `tpl-track-order-agent`, ported. Presentational only, like
 * `TrackAgentList.vue`; `TrackEditor.vue` calls `mutate`.
 */
import { ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { validAgent } from '../lib/config.js'
import Bdi from './Bdi.vue'
import ConfigChip from './ConfigChip.vue'

const props = defineProps<{ track: string; agent: string; after: string[]; enabled: boolean }>()
const emit = defineEmits<{ add: [pred: string]; remove: [pred: string] }>()
const { t } = useI18n()

const entry = ref('')
function add(): void {
  const pred = entry.value.trim()
  // Naming itself is a 1-node cycle `findOrderCycle` would refuse anyway.
  if (!validAgent(pred) || pred === props.agent) return
  emit('add', pred)
  entry.value = ''
}
</script>

<template>
  <div class="track-order-agent" :data-agent="props.agent">
    <code class="track-order-name"><Bdi :value="props.agent" /></code>
    <span class="track-order-after">{{ t('config.orderAfter') }}</span>
    <ul class="chips">
      <ConfigChip v-for="pred in props.after" :key="pred" :name="pred" @remove="emit('remove', pred)" />
    </ul>
    <span v-if="props.after.length === 0" class="track-list-empty">{{ t('config.noAgents') }}</span>
    <div class="rule-add">
      <input
        v-model="entry"
        list="config-agent-names"
        dir="ltr"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('config.agentName')"
        :aria-label="t('config.agentName')"
        :disabled="!props.enabled"
        @keydown.enter.prevent="add"
      />
      <button type="button" class="icon" :aria-label="t('config.add')" :disabled="!props.enabled" @click="add">+</button>
    </div>
  </div>
</template>
