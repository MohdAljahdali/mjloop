<script setup lang="ts">
/**
 * `tpl-memory`, ported.
 *
 * Shared between the Memory panel's own list and Plan Memory's
 * (`Plans.vue`) — `panels/memory.js:114-121`'s own reason for exporting
 * `memoryRow` as a module-scoped function rather than a closure inside
 * `mountMemory`: "so `panels/plans.js`'s Plan Memory list clones the
 * identical row instead of a second copy of this same rendering." Two
 * components drawing the same node-for-node template is the DOM-diffing
 * version of the bug that comment heads off — a second copy with nothing to
 * keep it in step with the first.
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
 * dotted key — `memory.js:138-141`'s own split: a known kind is translated,
 * plain prose (`phrase()`); an unknown one is the engine's own raw token,
 * isolated the way any other engine value is (`verbatim()`, `<Bdi>` here) so
 * it cannot drag the punctuation around it out of place inside an RTL row.
 */
function kindKnown(kind: string): boolean {
  return known(`memory.kind.${kind}`)
}
function kindWord(kind: string): string {
  return t(`memory.kind.${kind}`)
}
</script>

<template>
  <li class="memory">
    <code class="memory-id" data-slot="id"><Bdi :value="props.memory.id" /></code>
    <span class="tag" data-slot="kind">
      <template v-if="kindKnown(props.memory.kind)">{{ kindWord(props.memory.kind) }}</template>
      <Bdi v-else :value="props.memory.kind" />
    </span>
    <strong data-slot="title"><Bdi :value="props.memory.title" /></strong>
    <span class="when" data-slot="at"><Bdi :value="stamp(props.memory.at)" /></span>
    <ul class="chips" data-slot="tags">
      <li v-for="tag in props.memory.tags" :key="tag" class="chip"><Bdi :value="tag" /></li>
    </ul>
    <pre class="excerpt" data-slot="body"><Bdi :value="props.memory.body" /></pre>
  </li>
</template>
