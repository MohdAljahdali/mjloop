<script setup lang="ts">
/**
 * `tpl-selected-skill`, ported: one skill a `(component, agent)` pair
 * received, beside the reason that chose it.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ skillId: string; reason: string; guidance: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="rule">
    <code class="rule-name"><Bdi :value="props.skillId" /></code>
    <span class="rule-why" dir="auto"><Bdi :value="props.reason" /></span>
    <!-- The schema guarantees every selected skill carries guidance, so an
         empty one means a manifest written before that refinement existed.
         Hidden rather than shown as an empty disclosure. -->
    <details v-if="props.guidance !== ''">
      <summary>{{ t('manifest.guidance') }}</summary>
      <pre class="excerpt"><Bdi :value="props.guidance" /></pre>
    </details>
  </div>
</template>
