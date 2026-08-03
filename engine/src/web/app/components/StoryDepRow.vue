<script setup lang="ts">
/**
 * `tpl-story-dep`, ported: one node of the dependency view, indented by its
 * own depth from the open story via a `depth-<n>` class — the id and current
 * status are the same two facts `StoryWaitRow` renders, because it is the
 * same shape: an id and its status, never composed into a sentence.
 *
 * `role="treeitem"` (the list itself is `role="tree"`) plus `aria-level`
 * carry the same nesting to a screen reader that the indentation class
 * carries visually.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ id: string; status: string | undefined; depth: number }>()
const { t } = useI18n()
</script>

<template>
  <li class="dep-row" role="treeitem" :class="`depth-${props.depth}`" :aria-level="props.depth + 1">
    <code class="story-id" data-slot="id"><Bdi :value="props.id" /></code>
    <span class="story-status" data-slot="status" :class="props.status === undefined ? 'status-unknown' : `status-${props.status}`">
      {{ props.status === undefined ? '—' : t(`story.status.${props.status}`) }}
    </span>
  </li>
</template>
