<script setup lang="ts">
/**
 * `tpl-story-run`, ported: the Story pane's own run list — one story's
 * history, not the whole project's, so unlike `PlanEvidenceRow` it carries
 * no `story` column.
 */
import { useI18n } from '../composables/useI18n.js'
import type { RunSummary } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ entry: RunSummary }>()
const { t, tn } = useI18n()
</script>

<template>
  <li class="run">
    <span class="run-id" data-slot="id"><Bdi :value="props.entry.id" /></span>
    <span class="chip" data-slot="track"><Bdi :value="props.entry.track ?? '—'" /></span>
    <span data-slot="cycles">{{ tn('story.run.cycles', props.entry.cycles) }}</span>
    <span class="res" :class="props.entry.halted ? 'res-fail' : 'res-pass'" data-slot="outcome">
      {{ t(props.entry.halted ? 'story.run.halted' : 'story.run.ended') }}
    </span>
  </li>
</template>
