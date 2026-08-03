<script setup lang="ts">
/**
 * One name inside a `.chips` list — `tpl-agent-chip` and `tpl-edge-chip`,
 * which shared one shape in the old markup and share one component here: a
 * required/available/closing/blocks membership and an order edge's own
 * predecessor both render as a bare, unforced `<bdi>` plus a remove button.
 *
 * A **bare** `<bdi>`, not `Bdi.vue`: `config.js`'s own `agentChip()` and
 * `edgeChip()` call `text()` on a `<bdi>` slot that carries no `dir`
 * attribute, never `verbatim()` — the one place on this whole panel an
 * identifier is isolated without also being forced left-to-right. Track and
 * agent *header* names (`track-name`, `track-order-name`) are `verbatim()`
 * and go through `Bdi.vue` instead; see `TrackEditor.vue` and
 * `TrackOrderRow.vue`.
 */
import { useI18n } from '../composables/useI18n.js'

defineProps<{ name: string }>()
defineEmits<{ remove: [] }>()
const { t } = useI18n()
</script>

<template>
  <li class="chip chip-agent">
    <bdi>{{ name }}</bdi>
    <button type="button" class="icon" :aria-label="t('config.remove')" @click="$emit('remove')">×</button>
  </li>
</template>
