<script setup lang="ts">
/**
 * `tpl-verify-row`, ported: one line of `cycle-NN/verify/index.json` — what
 * the engine itself executed, beside what the config file holds now.
 */
import { useI18n } from '../composables/useI18n.js'
import { verifyDuration } from '../lib/fmt.js'
import type { LedgerEntry } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ entry: LedgerEntry }>()
const { t } = useI18n()

const PHASE_KEY: Record<LedgerEntry['phase'], string> = {
  queued: 'evidence.verify.queued',
  running: 'evidence.verify.running',
  complete: 'evidence.verify.complete',
}
const SOURCE_KEY: Record<LedgerEntry['source'], string> = {
  pinned: 'evidence.verify.pinned',
  live: 'evidence.verify.live',
}
</script>

<template>
  <div class="grid-row" role="row">
    <span role="cell"><code data-slot="slot"><Bdi :value="props.entry.slot" /></code></span>
    <!-- The string the engine handed to `spawn`, byte for byte. -->
    <span role="cell"><code data-slot="command"><Bdi :value="props.entry.command" /></code></span>
    <span role="cell">
      <span class="phase" :class="`phase-${props.entry.phase}`" data-slot="phase">{{ t(PHASE_KEY[props.entry.phase]) }}</span>
    </span>
    <span role="cell">
      <!-- A timeout has no exit code and is not a failing one either: the
           child was killed at the ceiling, a different fact from a failing
           exit — and the colour reports the exit code alone, never a
           verdict: whether this cycle passed is an agent's own judgement,
           drawn elsewhere. -->
      <span
        class="exit"
        :class="`exit-${props.entry.exit_code === null ? 'none' : props.entry.exit_code === 0 ? 'zero' : 'nonzero'}`"
        data-slot="exit"
      >
        <template v-if="props.entry.timed_out">{{ t('evidence.verify.timedOut') }}</template>
        <Bdi v-else :value="props.entry.exit_code === null ? '—' : String(props.entry.exit_code)" />
      </span>
    </span>
    <span role="cell" data-slot="duration"><Bdi :value="verifyDuration(props.entry.duration_ms)" /></span>
    <span role="cell" data-slot="source">{{ t(SOURCE_KEY[props.entry.source]) }}</span>
    <!-- `config.yaml` is hand-editable and an agent holding Write can rewrite
         a verify command mid-run; the run executes its pinned copy
         regardless, and this column is where an operator finds out the file
         no longer describes what ran. -->
    <span role="cell"><code data-slot="drift"><Bdi :value="props.entry.live_command ?? '—'" /></code></span>
    <span role="cell" data-slot="cached"><Bdi :value="props.entry.cached_from_cycle === null ? '—' : String(props.entry.cached_from_cycle)" /></span>
  </div>
</template>
