<script setup lang="ts">
/** `tpl-project-skill-unreadable`, ported: a `SKILL.md` the walk could not read, and why. */
import Bdi from './Bdi.vue'
import type { UnreadableProjectSkill } from '../types/protocol.js'

const props = defineProps<{ entry: UnreadableProjectSkill }>()
</script>

<template>
  <p class="banner warn"><span data-slot="path"><Bdi :value="props.entry.path" /></span> — <!--
    --><span data-slot="reason"><Bdi :value="props.entry.reason" /></span></p>
</template>
