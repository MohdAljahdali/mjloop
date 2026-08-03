<script setup lang="ts">
/**
 * `tpl-evidence-card`, ported: one piece of evidence an agent's result cited.
 */
import type { Evidence } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ card: Evidence }>()
</script>

<template>
  <li>
    <code data-slot="ref"><Bdi :value="`${props.card.kind}: ${props.card.ref}`" /></code>
    <!-- The contract allows an empty excerpt. -->
    <pre v-if="props.card.excerpt.length > 0" class="excerpt" data-slot="excerpt"><Bdi :value="props.card.excerpt" /></pre>
  </li>
</template>
