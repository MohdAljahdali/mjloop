<script setup lang="ts">
/**
 * `tpl-cycle`, ported: one row of the run's history, newest at whatever
 * position `full.history` puts it — this component does not sort.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'
import type { HistoryEntry } from '../types/protocol.js'

const props = defineProps<{ entry: HistoryEntry }>()
const { t } = useI18n()
</script>

<template>
  <div class="grid-row cycle" role="row">
    <span role="cell"><Bdi :value="String(props.entry.cycle)" /></span>
    <span role="cell"><Bdi :value="props.entry.agents.join(', ')" /></span>
    <span role="cell"><span class="res" :class="`res-${props.entry.result}`">{{ t(`cycle.result.${props.entry.result}`) }}</span></span>
    <span role="cell"><code><Bdi :value="props.entry.ref" /></code></span>
  </div>
</template>
