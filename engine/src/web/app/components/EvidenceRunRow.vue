<script setup lang="ts">
/**
 * `tpl-run`, ported: the Evidence tab's own run list. The whole project's
 * runs, unlike `StoryRunRow` (one story) or `PlanEvidenceRow` (one plan's
 * stories) — so this is the only one of the three with an `open` control,
 * which opens this same tab's per-cycle detail below the list.
 */
import { useI18n } from '../composables/useI18n.js'
import type { RunSummary } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ entry: RunSummary; open: boolean }>()
defineEmits<{ toggle: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <div class="grid-row run" role="row">
    <span role="cell"><span class="run-id" data-slot="id"><Bdi :value="props.entry.id" /></span></span>
    <span role="cell" data-slot="story"><Bdi :value="props.entry.story ?? '—'" /></span>
    <span role="cell" data-slot="track"><Bdi :value="props.entry.track ?? '—'" /></span>
    <!-- Verbatim, not `tn()`: `panels/evidence.js`'s own row writes the raw
         count (`verbatim(count, entry.cycles)`), not the prose
         `StoryRunRow`/`PlanEvidenceRow` render for their own lists. -->
    <span role="cell" data-slot="cycles"><Bdi :value="String(props.entry.cycles)" /></span>
    <span role="cell">
      <span class="res" :class="props.entry.halted ? 'res-fail' : 'res-pass'" data-slot="outcome">
        {{ t(props.entry.halted ? 'evidence.halted' : 'evidence.ended') }}
      </span>
    </span>
    <span role="cell">
      <button type="button" data-act="open-run" :data-run="props.entry.id" @click="$emit('toggle', props.entry.id)">
        {{ t(props.open ? 'evidence.close' : 'evidence.open') }}
      </button>
    </span>
  </div>
</template>
