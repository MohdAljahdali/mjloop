<script setup lang="ts">
/**
 * `tpl-chip`, drawn with the `armed` family `panels/run.js`'s `drawGuards`
 * gave it: the one cycle error signature that will halt the run if this cycle
 * repeats it gets `60-panels.css`'s `.chip.armed-yes`, every other one
 * `armed-no`.
 */
import Bdi from './Bdi.vue'

const props = defineProps<{ signature: string; armed: boolean }>()
</script>

<template>
  <li class="chip" :class="props.armed ? 'armed-yes' : 'armed-no'">
    <Bdi :value="props.signature" />
  </li>
</template>
