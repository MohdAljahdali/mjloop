<script setup lang="ts">
/**
 * `tpl-run-cycle`, ported: one cycle of an open run — its roster, the agents
 * the leader skipped and why, what each agent that ran actually claims, what
 * the engine itself verified, and the handoff this cycle wrote for the next.
 *
 * The verify table's own headings carry no `data-i18n`: `translateStatic`
 * (the old page's static sweep) never descended into `<template>` content,
 * which is why `panels/evidence.js` translated them itself. Vue has no such
 * gap — they are ordinary `t()` calls in this template — but the row stays
 * one component per the shape every other panel task takes.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import type { CycleDetail } from '../types/protocol.js'
import Chip from './Chip.vue'
import EvidenceSkippedRow from './EvidenceSkippedRow.vue'
import AgentRow from './AgentRow.vue'
import VerifyRow from './VerifyRow.vue'
import Bdi from './Bdi.vue'

const props = defineProps<{ cycle: CycleDetail }>()
const { t } = useI18n()

const roster = computed(() => props.cycle.roster?.selected ?? [])
const skipped = computed(() => props.cycle.roster?.skipped ?? [])
const verifyMore = computed(() => props.cycle.verify_total > props.cycle.verify.length)
const handoff = computed(() => props.cycle.handoff)
</script>

<template>
  <section class="cycle-block">
    <h3 data-slot="title">{{ t('evidence.cycle', { cycle: props.cycle.cycle }) }}</h3>
    <ul class="chips" data-slot="roster">
      <Chip v-for="agent in roster" :key="agent" :text="agent" />
    </ul>
    <!-- Why an agent did *not* run is written here and nowhere else. -->
    <ul class="skipped" data-slot="skipped">
      <EvidenceSkippedRow v-for="entry in skipped" :key="entry.agent" :entry="entry" />
    </ul>
    <ul class="agents" data-slot="agents">
      <AgentRow v-for="entry in props.cycle.agents" :key="entry.agent" :entry="entry" />
    </ul>

    <!-- What the *engine* ran, beside what the agents said about it. The two
         are different claims and this is the only place they sit together. -->
    <section v-if="props.cycle.verify.length > 0" class="verify" data-slot="verifyBlock">
      <h4 data-slot="verifyTitle">{{ t('evidence.verify.title') }}</h4>
      <div class="scroller">
        <div class="grid grid-verify" role="table">
          <div class="grid-head" role="row">
            <span role="columnheader" data-slot="vh-slot">{{ t('evidence.verify.slot') }}</span>
            <span role="columnheader" data-slot="vh-command">{{ t('evidence.verify.command') }}</span>
            <span role="columnheader" data-slot="vh-phase">{{ t('evidence.verify.phase') }}</span>
            <span role="columnheader" data-slot="vh-exit">{{ t('evidence.verify.exit') }}</span>
            <span role="columnheader" data-slot="vh-duration">{{ t('evidence.verify.duration') }}</span>
            <span role="columnheader" data-slot="vh-source">{{ t('evidence.verify.source') }}</span>
            <span role="columnheader" data-slot="vh-drift">{{ t('evidence.verify.drift') }}</span>
            <span role="columnheader" data-slot="vh-cached">{{ t('evidence.verify.cached') }}</span>
          </div>
          <div class="grid-body" role="rowgroup" data-slot="verify">
            <!-- Keyed on the log name and the start time, both fixed before
                 the child exits: an entry is written while it is queued or
                 running and amended in place, so a key built from the exit
                 code would replace the row rather than update it. -->
            <VerifyRow v-for="entry in props.cycle.verify" :key="`${entry.slot}:${entry.log}:${entry.at}`" :entry="entry" />
          </div>
        </div>
      </div>
      <!-- The reader caps the rows it puts on the wire, and a cap nobody
           mentions reads as a complete record that is missing invocations. -->
      <p v-if="verifyMore" class="more" data-slot="verifyMore">
        {{ t('evidence.verify.more', { shown: props.cycle.verify.length, total: props.cycle.verify_total }) }}
      </p>
    </section>

    <!-- The handoff is the next cycle's brief, written from this one.
         Collapsed because it repeats — deliberately — what the rows above
         already say. -->
    <details v-if="handoff !== null" data-slot="handoffDetails">
      <summary data-slot="handoffSummary">{{ t('evidence.handoff') }}</summary>
      <pre class="excerpt" data-slot="handoff"><Bdi :value="handoff" /></pre>
      <!-- Only ever a handoff the engine did not write: `writeHandoff`
           truncates well under the reader's ceiling. -->
      <p v-if="props.cycle.handoff_truncated" class="more" data-slot="handoffCut">{{ t('evidence.handoffCut') }}</p>
    </details>
  </section>
</template>
