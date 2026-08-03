<script setup lang="ts">
/**
 * `tpl-finding`, ported. What the critic actually found — the thing a person
 * used to open the terminal to read.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'
import type { Finding } from '../types/protocol.js'

const props = defineProps<{ finding: Finding }>()
const { t } = useI18n()
</script>

<template>
  <div class="grid-row finding" role="row">
    <span role="cell"><span class="sev" :class="`sev-${props.finding.severity}`">{{ t(`findings.severity.${props.finding.severity}`) }}</span></span>
    <span role="cell"><code><Bdi :value="`${props.finding.file}:${props.finding.line}`" /></code></span>
    <!-- Model-authored text. `<Bdi>` is the single path for it, mirroring
         `verbatim()` — this page has no `escape()` to keep right. -->
    <span role="cell"><Bdi :value="props.finding.claim" /></span>
  </div>
</template>
