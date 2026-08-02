<script setup lang="ts">
/**
 * The one line that says what the loop is doing, on screen in every tab.
 *
 * Nothing here is a sentence: every label is a key, and every value that is an
 * identifier goes through `Bdi`. Cycle and strike counts are `n/m` pairs, not
 * prose counts — like a run id, they must never pass through `t()`'s `Intl`
 * number formatting (`3/5` must not become `٣/٥`), so they are built as plain
 * strings and isolated with `Bdi` the same way `state.run_id` is.
 *
 * The strike counter is deliberately outside the `open` (run detail) block: a
 * project can be sitting on strikes from a run that has already closed
 * (`run_id` back to `null`), and that is exactly the moment a reader most
 * needs the warning still on screen.
 */
import { computed } from 'vue'
import type { Snapshot } from '../../protocol.js'
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ snapshot: Snapshot }>()
const { t } = useI18n()

const state = computed(() => props.snapshot.state)
const open = computed(() => state.value.run_id !== null)
const findings = computed(() => state.value.findings)
const findingsTotal = computed(() => findings.value.high + findings.value.medium + findings.value.low)
const cycleText = computed(() => `${state.value.cycle}/${state.value.max_cycles ?? '?'}`)

const guards = computed(() => props.snapshot.guards)
const strikes = computed(() => guards.value?.strikes ?? 0)
const strikesText = computed(() => `${strikes.value}/${guards.value?.strikesAllowed ?? '?'}`)
</script>

<template>
  <div class="rail">
    <span class="pill" :class="`status-${state.status}`">{{ t(`status.${state.status}`) }}</span>
    <span v-if="open" class="rail-detail">
      <span class="bit"><Bdi :value="state.run_id ?? ''" /></span>
      <span v-if="state.track" class="bit">
        <span class="k">{{ t('rail.track') }}</span>
        <span class="v"><Bdi :value="state.track" /></span>
      </span>
      <span class="bit">
        <span class="k">{{ t('rail.cycle') }}</span>
        <span class="v"><Bdi :value="cycleText" /></span>
      </span>
      <span class="bit">
        <span class="k">{{ t('rail.stage') }}</span>
        <span class="v">{{ t(`stage.${state.stage}`) }}</span>
      </span>
      <span v-if="findingsTotal > 0" class="bit warnish">
        {{ t('rail.findings', { high: findings.high, medium: findings.medium, low: findings.low }) }}
      </span>
    </span>
    <span v-if="strikes > 0" class="bit warnish" data-test="strikes">
      <span class="k">{{ t('rail.strikes') }}</span>
      <span class="v"><Bdi :value="strikesText" /></span>
    </span>
  </div>
</template>
