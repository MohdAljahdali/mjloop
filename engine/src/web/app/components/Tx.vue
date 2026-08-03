<script setup lang="ts">
/**
 * The Vue analogue of `ui/dom.js`'s `tx()` — the one component that renders
 * translated *content*, as opposed to `t()`, which is for attributes only
 * (`lib/i18n.ts:148`'s own docstring).
 *
 * Built out of `parts()` (`lib/i18n.ts`), exactly as `tx()` is: each text
 * segment is emitted plainly and each parameter segment is wrapped in its own
 * bare `<bdi>` — no `dir` attribute, unlike `Bdi.vue`, which pins `dir="ltr"`
 * for identifiers that must never render as Arabic-Indic digits. A hole here
 * carries whatever the sentence already decided to pass it — an id, an agent
 * name, a count, free prose — and the isolation is what keeps that value from
 * dragging the sentence's own punctuation to the wrong end of the line when
 * the page is read right-to-left. `Bdi.vue` is the wrong tool for this: it
 * would additionally force the hole itself left-to-right, which `tx()` never
 * did.
 */
import { useI18n } from '../composables/useI18n.js'
import type { Params } from '../lib/i18n.js'

const props = defineProps<{ keyName: string; params?: Params | undefined }>()
const { parts } = useI18n()
</script>

<template>
  <template v-for="(part, index) in parts(props.keyName, props.params)" :key="index"
    ><bdi v-if="part.kind === 'param'">{{ part.value }}</bdi
    ><template v-else>{{ part.value }}</template></template
  >
</template>
