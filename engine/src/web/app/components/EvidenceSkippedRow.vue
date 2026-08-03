<script setup lang="ts">
/**
 * `tpl-skipped`, ported: why an agent did *not* run — the leader's own words,
 * recoverable from nowhere else.
 */
import Bdi from './Bdi.vue'

const props = defineProps<{ entry: { agent: string; reason: string } }>()
</script>

<template>
  <li><code data-slot="agent"><Bdi :value="props.entry.agent" /></code> <span data-slot="reason"><Bdi :value="props.entry.reason" /></span></li>
</template>
