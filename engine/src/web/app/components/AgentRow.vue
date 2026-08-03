<script setup lang="ts">
/**
 * `tpl-agent`, ported: one agent's own result for the cycle — what the
 * *agent* claims, beside the verify ledger's record of what the *engine*
 * ran.
 *
 * `result` is `unknown` on the wire (`CycleDetail.agents`, `read.ts`):
 * `readCycleDetail` reads whatever JSON sits in `cycle-NN/<agent>.json`
 * without validating it against `AgentResultSchema`, exactly as
 * `panels/evidence.js`'s own `agentRow` read it — every field below is
 * optional-chained for that reason, not merely for style.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import type { AgentResult } from '../types/protocol.js'
import Bdi from './Bdi.vue'
import EvidenceCardRow from './EvidenceCardRow.vue'

const props = defineProps<{ entry: { agent: string; result: unknown } }>()
const { t } = useI18n()

const result = computed(() => props.entry.result as Partial<AgentResult> | null | undefined)
const status = computed(() => result.value?.status ?? 'blocked')
const filesTouched = computed(() => result.value?.files_touched ?? [])
const evidence = computed(() => result.value?.evidence ?? [])
</script>

<template>
  <li class="agent">
    <code data-slot="name"><Bdi :value="props.entry.agent" /></code>
    <span class="res" :class="`res-${status}`" data-slot="status">{{ t(`cycle.result.${status}`) }}</span>
    <!-- Model-authored text, so `<Bdi>` — the single path for it. -->
    <span data-slot="summary"><Bdi :value="result?.summary ?? ''" /></span>
    <ul class="evidence-cards" data-slot="evidence">
      <EvidenceCardRow v-for="card in evidence" :key="`${card.kind}:${card.ref}`" :card="card" />
    </ul>
    <code v-if="filesTouched.length > 0" class="files" data-slot="files"><Bdi :value="filesTouched.join('  ')" /></code>
  </li>
</template>
