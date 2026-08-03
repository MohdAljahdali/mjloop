<script setup lang="ts">
/**
 * `tpl-story-skill-agent`, ported: one drafted agent's own accepted skills —
 * a bare bullet per skill id, the same shape `story-open-acceptance` and
 * `SkillsView`'s package findings already use, because a skill id here needs
 * nothing more than that.
 */
import { useI18n } from '../composables/useI18n.js'
import type { ProjectSkillAcceptance } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ agent: string; matches: readonly ProjectSkillAcceptance[] }>()
const { t } = useI18n()
</script>

<template>
  <li class="skill-agent">
    <h4><code><Bdi :value="props.agent" /></code></h4>
    <p class="empty" data-slot="none" :hidden="props.matches.length > 0">{{ t('story.skills.agentNone') }}</p>
    <ul class="acceptance" data-slot="skills">
      <li v-for="acceptance in props.matches" :key="acceptance.skillId"><Bdi :value="acceptance.skillId" /></li>
    </ul>
  </li>
</template>
