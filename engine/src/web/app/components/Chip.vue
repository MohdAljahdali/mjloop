<script setup lang="ts">
/**
 * `tpl-chip`, ported: one identifier in a `ul.chips`. Used for the last
 * cycle's agent roster, which carries no family class of its own — unlike
 * `RosterAgentChip` and `CycleErrorChip`, which each mark one.
 */
import Bdi from './Bdi.vue'

defineProps<{ text: string }>()
</script>

<template>
  <li class="chip"><Bdi :value="text" /></li>
</template>
