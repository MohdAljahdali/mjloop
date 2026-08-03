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
import { send } from '../stores/session.js'
import { time } from '../lib/fmt.js'
import Bdi from './Bdi.vue'

// `snapshot` is nullable: the server may be down, the token may be bad, or
// an upgrade may have been refused before a first snapshot ever arrives —
// `app.js:273`'s `onStatus` drives the offline banner off socket status
// alone, independent of any snapshot, and this must too.
const props = defineProps<{ snapshot: Snapshot | null; online: boolean }>()
const { t } = useI18n()

// A total outage — the file cannot be parsed, or the write door cannot be
// reached — and must not read at the weight of a normal row. Moved here from
// `ui/rail.js`'s own `configBanner` slot; `Config.vue` is the panel this
// error is *about*, but the banner is page-level like every other one on
// this component, so it stays with them rather than living inside a tab that
// might not be the one open.
const configError = computed(() => props.snapshot?.state.config_error ?? null)
const stale = computed(() => props.snapshot?.state.recovered ?? false)
// `rail.js:118` — a project that has not initialised at all is not "missing a
// design system", it is missing everything; showing this banner then would be
// telling the reader to run a command against a project that is not there yet.
const noDesignSystem = computed(() => (props.snapshot?.state.initialised ?? false) && !props.snapshot?.state.design_system)

/**
 * `autonomous: false` lets a session end its turn mid-run and wait for a
 * human. A queue that cannot see that hangs forever on job one, so this is a
 * notice and a button — never automatic input. `nudge` names no run, unlike
 * halt: it feeds the pty that is already attached rather than writing
 * anything to disk, so it needs no run id — see `Run.vue`'s halt dialog for
 * the write that does.
 */
const stalledSince = computed(() => props.snapshot?.session.stalledSince ?? null)
</script>

<template>
  <div class="banners" role="status" aria-live="polite">
    <p v-if="!online" class="banner offline">{{ t('app.disconnected') }}</p>
    <p v-if="configError !== null" class="banner error">
      <strong>{{ t('banner.configError') }}</strong>
      <code><Bdi :value="configError" /></code>
    </p>
    <p v-if="stale" class="banner warn">{{ t('banner.stale') }}</p>
    <p v-if="noDesignSystem" class="banner note">{{ t('banner.designSystem') }}</p>
    <p v-if="stalledSince !== null" class="banner warn">
      <span>{{ t('session.stalled', { time: time(stalledSince) }) }}</span>
      <button type="button" @click="send({ type: 'nudge' })">{{ t('session.nudge') }}</button>
      <small>{{ t('session.stalledHint') }}</small>
    </p>
  </div>
</template>
