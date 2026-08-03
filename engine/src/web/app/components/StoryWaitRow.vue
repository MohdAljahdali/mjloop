<script setup lang="ts">
/**
 * `tpl-story-wait`, ported: one unmet dependency in the story pane's
 * readiness inspector — the id it is waiting on and that id's own current
 * status, never composed into a sentence.
 *
 * `status` is `undefined` for an id `unmet()` returned that this plan's own
 * index cannot resolve — a typo, or the cross-plan edge
 * `assertDependenciesResolve` refuses to let anyone write. There is no
 * fourth status word for that; the id itself, with a neutral class, is the
 * only honest thing to show.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ id: string; status: string | undefined }>()
const { t } = useI18n()
</script>

<template>
  <li class="wait-row">
    <code class="story-id" data-slot="id"><Bdi :value="props.id" /></code>
    <span class="story-status" data-slot="status" :class="props.status === undefined ? 'status-unknown' : `status-${props.status}`">
      {{ props.status === undefined ? '—' : t(`story.status.${props.status}`) }}
    </span>
  </li>
</template>
