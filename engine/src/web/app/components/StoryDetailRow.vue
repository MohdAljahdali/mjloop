<script setup lang="ts">
/**
 * `tpl-story-detail`, ported: one row of the story list, worth reading before
 * building it — the title wraps rather than being cut, and everything that
 * is not the title may fall to a second line rather than compete with it for
 * width (`.story.detail`, `60-panels.css`).
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { unmet } from '../lib/stories.js'
import type { StoryDetail } from '../types/protocol.js'
import Bdi from './Bdi.vue'
import Tx from './Tx.vue'

const props = defineProps<{ story: StoryDetail; statuses: Map<string, string> }>()
defineEmits<{ open: [id: string]; build: [id: string]; requeue: [id: string, from: string] }>()

const { t } = useI18n()

const waiting = computed(() => unmet(props.story, props.statuses))
const buildable = computed(() => props.story.status === 'todo' && waiting.value.length === 0)
const anomaly = computed(() => props.story.status === 'done' && props.story.evidence === null)
</script>

<template>
  <li class="story detail">
    <span class="dot" data-slot="dot" :class="`status-${props.story.status}`"></span>
    <span class="story-id" data-slot="id"><Bdi :value="props.story.id" /></span>
    <span class="story-title" data-slot="title"><Bdi :value="props.story.title" /></span>
    <span class="tag ui" data-slot="ui" :hidden="!props.story.ui">{{ t('story.ui') }}</span>
    <span class="story-status" data-slot="status" :class="`status-${props.story.status}`">{{ t(`story.status.${props.story.status}`) }}</span>
    <!-- `phrase(waits, 'story.blockedBy', { ids: waiting.join(', ') })` on the
         old page — one bare `<bdi>` inside the `{ids}` hole via `tx()`, not a
         translated fragment followed by a separately-isolated `<Bdi>`. -->
    <span class="waits" data-slot="waits" :hidden="waiting.length === 0">
      <Tx key-name="story.blockedBy" :params="{ ids: waiting.join(', ') }" />
    </span>
    <span class="waits anomaly" data-slot="anomaly" :hidden="!anomaly">{{ t('story.noEvidence') }}</span>
    <span class="row-actions">
      <button
        type="button"
        data-act="story-tab"
        data-slot="open"
        :data-story="props.story.id"
        :title="t('story.tab.openTitle', { id: props.story.id })"
        @click="$emit('open', props.story.id)"
      >{{ t('story.tab.open') }}</button>
      <button
        type="button"
        class="primary"
        data-act="story-run"
        data-slot="build"
        :data-story="props.story.id"
        :hidden="props.story.status !== 'todo'"
        :disabled="!buildable"
        :title="waiting.length > 0 ? t('story.blockedBy', { ids: waiting.join(', ') }) : buildable ? t('story.build') : t(`story.notBuildable.${props.story.status}`)"
        @click="$emit('build', props.story.id)"
      >{{ t('story.runAction') }}</button>
      <button
        type="button"
        data-act="story-requeue"
        data-slot="requeue"
        :data-story="props.story.id"
        :data-from="props.story.status"
        :hidden="props.story.status !== 'doing' && props.story.status !== 'blocked'"
        @click="$emit('requeue', props.story.id, props.story.status)"
      >{{ t('story.requeue') }}</button>
    </span>
    <details data-slot="acceptDetails" :hidden="props.story.acceptance.length === 0">
      <summary data-slot="acceptSummary">{{ t('story.acceptance', { n: props.story.acceptance.length }) }}</summary>
      <ul class="acceptance" data-slot="acceptance">
        <li v-for="line in props.story.acceptance" :key="line"><Bdi :value="line" /></li>
      </ul>
    </details>
    <code class="evidence" data-slot="evidence" :hidden="props.story.evidence === null"><Bdi :value="props.story.evidence ?? ''" /></code>
  </li>
</template>
