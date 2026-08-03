<script setup lang="ts">
/**
 * `tpl-plan-run`, ported: Plan Evidence's own run list — the same shape as
 * `tpl-story-run`, plus the story id, because a plan spans more than one
 * story and unlike that list this one has to say which. No open-run control:
 * that action opens the Evidence tab's own per-cycle detail, which this tab
 * cannot show.
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
    <!-- `planRuns` already filtered out `null`, but the field itself is still
         nullable in the type this row is drawn from — the fallback stays
         honest about that rather than asserting it away. -->
    <code class="story-id" data-slot="story"><Bdi :value="props.entry.story ?? '—'" /></code>
    <span class="chip" data-slot="track"><Bdi :value="props.entry.track ?? '—'" /></span>
    <span data-slot="cycles">{{ tn('story.run.cycles', props.entry.cycles) }}</span>
    <span class="res" :class="props.entry.halted ? 'res-fail' : 'res-pass'" data-slot="outcome">
      {{ t(props.entry.halted ? 'story.run.halted' : 'story.run.ended') }}
    </span>
  </li>
</template>
