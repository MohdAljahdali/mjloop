<script setup lang="ts">
/**
 * One of a track's agent lists — `tpl-track-list`, ported. `required`,
 * `available`, `closing` and a gate's `blocks` are all this one component:
 * chips plus a combobox, the same shape every list on this card uses.
 *
 * Presentational only — it never touches the draft itself. `TrackEditor.vue`
 * owns which bucket `list` names (a gate's `blocks` lives one level deeper
 * than the other three) and is the one that calls `mutate`.
 */
import { ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { validAgent, LIST_LABEL } from '../lib/config.js'
import ConfigChip from './ConfigChip.vue'

const props = defineProps<{
  track: string
  list: 'required' | 'available' | 'closing' | 'blocks'
  agents: string[]
  enabled: boolean
}>()
const emit = defineEmits<{ add: [name: string]; remove: [agent: string] }>()
const { t } = useI18n()

const entry = ref('')
function add(): void {
  const agent = entry.value.trim()
  if (!validAgent(agent)) return
  emit('add', agent)
  entry.value = ''
}
</script>

<template>
  <div class="track-list">
    <span class="track-list-label">{{ t(LIST_LABEL[props.list]) }}</span>
    <ul class="chips">
      <ConfigChip v-for="agent in props.agents" :key="agent" :name="agent" @remove="emit('remove', agent)" />
    </ul>
    <span v-if="props.agents.length === 0" class="track-list-empty">{{ t('config.noAgents') }}</span>
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
