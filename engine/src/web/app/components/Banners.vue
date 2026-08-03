<script setup lang="ts">
/**
 * Page-level outages, above everything and never inside a list.
 *
 * `config_error` is a total outage and must not read at the weight of a normal
 * row — that is why these live in the header rather than in the panel whose
 * data went missing.
 */
import { computed } from 'vue'
import type { Snapshot } from '../types/protocol.js'
import { useI18n } from '../composables/useI18n.js'

// `snapshot` is nullable: the server may be down, the token may be bad, or
// an upgrade may have been refused before a first snapshot ever arrives —
// `app.js:273`'s `onStatus` drives the offline banner off socket status
// alone, independent of any snapshot, and this must too.
const props = defineProps<{ snapshot: Snapshot | null; online: boolean }>()
const { t } = useI18n()

const stale = computed(() => props.snapshot?.state.recovered ?? false)
// `rail.js:118` — a project that has not initialised at all is not "missing a
// design system", it is missing everything; showing this banner then would be
// telling the reader to run a command against a project that is not there yet.
const noDesignSystem = computed(() => (props.snapshot?.state.initialised ?? false) && !props.snapshot?.state.design_system)
</script>

<template>
  <div class="banners" role="status" aria-live="polite">
    <p v-if="!online" class="banner offline">{{ t('app.disconnected') }}</p>
    <p v-if="stale" class="banner warn">{{ t('banner.stale') }}</p>
    <p v-if="noDesignSystem" class="banner note">{{ t('banner.designSystem') }}</p>
  </div>
</template>
