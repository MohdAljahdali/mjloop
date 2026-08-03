<script setup lang="ts">
/**
 * `tpl-plan`, ported: one line of prose and one bar. A plan's stories are not
 * drawn here — see `Plans.vue`'s own file comment for why that used to bury a
 * twenty-two-story plan under a wall nobody could scan.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { planProgress, planStatus } from '../lib/stories.js'
import type { PlanView } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ plan: PlanView; open: boolean }>()
defineEmits<{ toggle: [id: string] }>()

const { t } = useI18n()

const breakdown = computed(() => planProgress(props.plan))
const percent = computed(() => (breakdown.value.total === 0 ? 0 : Math.round((breakdown.value.completed / breakdown.value.total) * 100)))
</script>

<template>
  <article class="plan">
    <header class="plan-head">
      <span class="plan-id"><Bdi :value="plan.id" /></span>
      <strong class="plan-title" data-slot="title"><Bdi :value="plan.title" /></strong>
      <span class="tag" :class="`planstate-${planStatus(plan)}`" data-slot="state">{{ t(`plans.state.${planStatus(plan)}`) }}</span>
      <span class="tag" :class="`approval-${plan.approval ?? 'none'}`" data-slot="approval">{{ t(`plans.approval.${plan.approval ?? 'none'}`) }}</span>
      <button type="button" :aria-controls="'plan-detail'" :aria-expanded="open ? 'true' : 'false'" data-slot="open" @click="$emit('toggle', plan.id)">
        {{ t(open ? 'plans.close' : 'plans.open') }}
      </button>
    </header>
    <div
      class="progress"
      data-slot="progress"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="String(percent)"
      :aria-label="t('plans.progress', { done: breakdown.completed, total: breakdown.total })"
      :hidden="breakdown.total === 0"
    >
      <span class="bar" data-slot="bar" :style="{ inlineSize: `${percent}%` }"></span>
    </div>
    <p class="plan-meta">
      <span class="count" data-slot="count"><Bdi :value="`${breakdown.completed}/${breakdown.total}`" /></span>
      <span class="ready-note" data-slot="ready" :hidden="breakdown.ready === 0">{{ t('plans.readyHere', { n: breakdown.ready }) }}</span>
      <span class="waits" data-slot="blocked" :hidden="breakdown.blocked === 0">{{ t('plans.blockedHere', { n: breakdown.blocked }) }}</span>
      <span class="empty" data-slot="empty" :hidden="plan.stories.length > 0">{{ t('story.listEmpty') }}</span>
    </p>
  </article>
</template>
