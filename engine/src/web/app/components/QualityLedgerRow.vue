<script setup lang="ts">
/**
 * One dimension of the quality ledger, as both panels draw it.
 *
 * **Every verdict is a word.** `pending`, `pass`, `fail`, `blocked` and
 * `not_applicable` each print their own label; the `data-verdict` attribute
 * beside it is what the stylesheet keys a colour off, and the colour is never
 * the only difference — a monochrome screen, a screen reader and a printed
 * screenshot all read the same five states.
 *
 * Not a `.grid-row`: that class is `display: contents`, which hands the columns
 * to the parent `.grid` and is exactly what stops a row stacking on a narrow
 * screen. This row owns its own columns so `60-panels.css` can collapse them to
 * one at 390px, in either direction — see `layout.test.ts`.
 */
import { useI18n } from '../composables/useI18n.js'
import type { QualityDimension, QualityLedger } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ dimension: QualityDimension; entry: QualityLedger['dimensions'][QualityDimension] }>()

const { t } = useI18n()
</script>

<template>
  <li class="quality-ledger-row" :data-dimension="dimension" :data-verdict="entry.status">
    <span class="quality-dimension">{{ t(`quality.dimension.${dimension}`) }}</span>
    <span class="verdict" :class="`verdict-${entry.status}`">{{ t(`quality.verdict.${entry.status}`) }}</span>
    <span class="quality-reason">
      <Bdi :value="props.entry.reason" />
      <!-- Evidence collected and then invalidated is not evidence, and the
           difference is a word rather than a struck-through style. -->
      <span v-if="entry.invalidated_at !== null" class="tag">{{ t('quality.invalidated') }}</span>
    </span>
    <span class="quality-evidence">
      <template v-if="entry.evidence_refs.length === 0">{{ t('quality.evidenceNone') }}</template>
      <code v-for="ref in entry.evidence_refs" v-else :key="ref"><Bdi :value="ref" /></code>
    </span>
  </li>
</template>
