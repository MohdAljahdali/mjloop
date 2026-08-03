<script setup lang="ts">
/**
 * `tpl-roster-agent`, ported: one agent this cycle drafted, marked once it
 * has landed a `cycle-NN/<agent>.json` result. The `landed-*` class pair is
 * `60-panels.css`'s `.chip.landed-yes` — a status transition can never leave
 * both classes on the row, the same guarantee `cls()` gave it.
 */
import Bdi from './Bdi.vue'

const props = defineProps<{ agent: string; landed: boolean }>()
</script>

<template>
  <li class="chip roster" :class="props.landed ? 'landed-yes' : 'landed-no'">
    <span>{{ props.landed ? '✓' : '○' }}</span>
    <Bdi :value="props.agent" />
  </li>
</template>
