<script setup lang="ts">
/**
 * Page-level outages, above everything and never inside a list.
 *
 * `config_error` is a total outage and must not read at the weight of a normal
 * row — that is why these live in the header rather than in the panel whose
 * data went missing.
 */
import { computed } from 'vue'
import type { Snapshot } from '../../protocol.js'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps<{ snapshot: Snapshot; online: boolean }>()
const { t } = useI18n()

const stale = computed(() => props.snapshot.state.recovered)
// `rail.js:118` — a project that has not initialised at all is not "missing a
// design system", it is missing everything; showing this banner then would be
// telling the reader to run a command against a project that is not there yet.
const noDesignSystem = computed(() => props.snapshot.state.initialised && !props.snapshot.state.design_system)
</script>

<template>
  <div class="banners" role="status" aria-live="polite">
    <p v-if="!online" class="banner offline">{{ t('app.disconnected') }}</p>
    <p v-if="stale" class="banner warn">{{ t('banner.stale') }}</p>
    <p v-if="noDesignSystem" class="banner note">{{ t('banner.designSystem') }}</p>
  </div>
</template>
