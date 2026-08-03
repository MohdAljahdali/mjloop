<script setup lang="ts">
/**
 * `tpl-story-skill-warning`, ported: one accepted skill this story's track
 * has reason to look at, flagged for one of exactly three facts its own
 * record can support (`lib/stories.ts`'s `skillWarnings`) — never a fourth
 * invented one. There is deliberately no "accepted for an agent this track
 * never drafts" banner: skill routing never reads `config.tracks` at all, so
 * that fact describes no engine behaviour to warn about.
 */
import { useI18n } from '../composables/useI18n.js'
import type { ProjectSkillAcceptance } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{
  acceptance: ProjectSkillAcceptance
  warn: { noAgents: boolean; notActive: boolean; notCompatible: boolean }
}>()
const { t } = useI18n()
</script>

<template>
  <li class="skill-warning">
    <code><Bdi :value="props.acceptance.skillId" /></code>
    <p class="banner warn" data-slot="noAgents" :hidden="!props.warn.noAgents">{{ t('story.skills.warnNoAgents') }}</p>
    <p class="banner warn" data-slot="notActive" :hidden="!props.warn.notActive">{{ t('story.skills.warnDisabled') }}</p>
    <p class="banner warn" data-slot="notCompatible" :hidden="!props.warn.notCompatible">{{ t('story.skills.warnIncompatible') }}</p>
  </li>
</template>
