<script setup lang="ts">
/**
 * `tpl-candidate`, ported: one search result. Metadata only — nothing here
 * is downloaded, written or active — so the way forward is a command line,
 * not a button: importing runs a package's declared smoke checks.
 */
import Tx from './Tx.vue'
import Bdi from './Bdi.vue'
import type { SkillCandidate } from '../types/protocol.js'

const props = defineProps<{ candidate: SkillCandidate }>()
</script>

<template>
  <div class="component">
    <h3 data-slot="skillName"><Bdi :value="props.candidate.skillName" /></h3>
    <p data-slot="description" dir="auto"><Bdi :value="props.candidate.description" /></p>
    <p class="record"><span data-slot="repository"><Bdi :value="props.candidate.repository" /></span> · <span data-slot="source"><Bdi :value="props.candidate.source" /></span></p>
    <p class="hint" data-slot="next"><Tx key-name="skills.searchNext" :params="{ url: props.candidate.url }" /></p>
  </div>
</template>
