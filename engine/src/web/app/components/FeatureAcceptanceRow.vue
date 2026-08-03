<script setup lang="ts">
/** `tpl-acceptance`, ported: one line of acceptance criteria. */
import Bdi from './Bdi.vue'

defineProps<{ line: string }>()
</script>

<template>
  <li data-slot="text"><Bdi :value="line" /></li>
</template>
