<script setup lang="ts">
/**
 * The pane's head — never hidden, whichever view is up underneath it.
 *
 * Ported from `ui/pane.js`'s `register()` block, which is registered against
 * `.pane-head` and not either view for exactly that reason: the job label
 * and the Stop button must stay right even while the queue view is covering
 * the session view.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usePane } from '../composables/usePane.js'
import { activeJob, send, snapshot } from '../stores/session.js'
import Bdi from './Bdi.vue'

const { t, tn } = useI18n()
const pane = usePane()

const session = computed(
  () => snapshot.value?.session ?? { jobId: null, blocked: false, pausedBy: null, closing: false, stalledSince: null },
)
const queued = computed(() => (snapshot.value?.queue ?? []).filter((entry) => entry.status === 'queued').length)
const queueTabText = computed(() => (queued.value === 0 ? t('queue.tab') : tn('queue.tabCount', queued.value)))

/** The job whose transcript is on screen, so the head can name it. */
const job = computed(() => snapshot.value?.queue.find((entry) => entry.id === pane.shown.value) ?? null)

// Typing into a finished transcript would reach whatever is running now,
// which is not what the reader looking at it means.
const viewingHidden = computed(() => pane.shown.value === null || pane.shown.value === activeJob.value)
</script>

<template>
  <div class="pane-head">
    <button type="button" class="icon" :aria-label="t('pane.toggle')" @click="pane.cycle()">▼</button>
    <button
      type="button"
      class="view-tab"
      id="view-session"
      :aria-current="pane.view.value === 'session' ? 'true' : undefined"
      @click="pane.setView('session')"
    >
      {{ t('terminal.title') }}
    </button>
    <button
      type="button"
      class="view-tab"
      id="view-queue"
      :aria-current="pane.view.value === 'queue' ? 'true' : undefined"
      @click="pane.setView('queue')"
    >
      {{ queueTabText }}
    </button>
    <span class="job-label" id="job-label"><Bdi :value="job?.command ?? ''" /></span>
    <span class="viewing" id="job-viewing" :hidden="viewingHidden">{{ t('terminal.viewing') }}</span>
    <!-- Two states that used to be visible only after opening the queue view:
         that the queue is holding, and that the job on screen is already
         being closed. Both change what these buttons will do. -->
    <span class="pill warnish" id="pane-paused" :hidden="!session.blocked">{{ t('queue.paused') }}</span>
    <span class="pill" id="pane-closing" :hidden="!session.closing">{{ t('queue.closing') }}</span>
    <button type="button" class="icon" :aria-label="t('pane.fullscreen')" @click="pane.toggleFull()">⤢</button>
    <button
      type="button"
      class="danger"
      id="pane-stop"
      :hidden="session.jobId === null"
      :disabled="session.closing"
      @click="send({ type: 'stop' })"
    >
      {{ t('controls.stop') }}
    </button>
  </div>
</template>
