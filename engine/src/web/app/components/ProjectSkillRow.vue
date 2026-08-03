<script setup lang="ts">
/** `tpl-project-skill`, ported: one `SKILL.md` this checkout's `.claude/skills/` holds. */
import Bdi from './Bdi.vue'
import type { ProjectSkillOnDisk } from '../types/protocol.js'

const props = defineProps<{ skill: ProjectSkillOnDisk }>()
</script>

<template>
  <div class="component">
    <h3 data-slot="name"><Bdi :value="props.skill.name" /></h3>
    <p data-slot="description" dir="auto"><Bdi :value="props.skill.description" /></p>
    <p class="hint" data-slot="path"><Bdi :value="props.skill.path" /></p>
  </div>
</template>
