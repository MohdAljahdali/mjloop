<script setup lang="ts">
/**
 * `tpl-ready`, ported: one buildable story, with its title and the plan it
 * belongs to on the same row as the button — the chip this replaced said
 * `P001-S11` and nothing else, asking the reader to hold an id in their head
 * and go looking for it.
 */
import { useI18n } from '../composables/useI18n.js'
import type { StoryView } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ story: StoryView; plan: string; next: boolean }>()
defineEmits<{ build: [id: string] }>()

const { t } = useI18n()
</script>

<template>
  <li class="ready-row">
    <span class="tag next" data-slot="next" :hidden="!props.next">{{ t('story.nextTag') }}</span>
    <span class="story-id" data-slot="id"><Bdi :value="props.story.id" /></span>
    <span class="story-title" data-slot="title"><Bdi :value="props.story.title" /></span>
    <span class="chip" data-slot="plan"><Bdi :value="props.plan" /></span>
    <button
      type="button"
      class="primary"
      data-act="story-run"
      data-slot="build"
      :data-story="props.story.id"
      :title="t('story.build')"
      @click="$emit('build', props.story.id)"
    >{{ t('story.runAction') }}</button>
  </li>
</template>
