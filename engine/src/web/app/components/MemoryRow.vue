<script setup lang="ts">
/**
 * `tpl-memory`, ported for the Memory panel's own list.
 *
 * `PlanMemoryRow.vue` draws the identical row for Plan Memory's list and is
 * kept separate on purpose, by that component's own comment: that panel task
 * owned nothing outside `Plans.vue` and its own children, and this one owns
 * nothing outside `Memory.vue` and its own — two copies of one small
 * template rather than a shared component neither panel's task was scoped
 * to build.
 */
import { useI18n } from '../composables/useI18n.js'
import { stamp } from '../lib/fmt.js'
import type { MemoryView } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ memory: MemoryView }>()
const { t, known } = useI18n()

/**
 * A kind comes from the engine's own enum, and the page has a word for the
 * ones it knows. The schema is still the engine's to grow, so a kind this
 * dictionary has never heard of renders as it arrived rather than as a
 * dotted key.
 */
function kindWord(kind: string): string {
  const key = `memory.kind.${kind}`
  return known(key) ? t(key) : kind
}
</script>

<template>
  <li class="memory">
    <code class="memory-id" data-slot="id"><Bdi :value="props.memory.id" /></code>
    <span class="tag" data-slot="kind">{{ kindWord(props.memory.kind) }}</span>
    <strong data-slot="title"><Bdi :value="props.memory.title" /></strong>
    <span class="when" data-slot="at"><Bdi :value="stamp(props.memory.at)" /></span>
    <ul class="chips" data-slot="tags">
      <li v-for="tag in props.memory.tags" :key="tag" class="chip"><Bdi :value="tag" /></li>
    </ul>
    <pre class="excerpt" data-slot="body"><Bdi :value="props.memory.body" /></pre>
  </li>
</template>
