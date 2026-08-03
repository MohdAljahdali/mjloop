<script setup lang="ts">
/**
 * The queue view: what is running, what is waiting, what already happened.
 *
 * A second view inside the terminal pane rather than a tab of its own — see
 * `panels/queue.js`'s file comment for why. This component owns everything
 * `#panel-queue` used to: the pause banner and its two ways out, and the
 * three groups. `hidden` is a prop rather than internal state: which view is
 * on screen is `usePane()`'s `view`, owned by `Pane.vue`.
 */
import { computed } from 'vue'
import type { Job } from '../types/protocol.js'
import { useI18n } from '../composables/useI18n.js'
import { jobKey } from '../lib/keys.js'
import { HISTORY, RUNNING, WAITING, split } from '../lib/queue.js'
import { send, snapshot } from '../stores/session.js'
import QueueRow from './QueueRow.vue'

defineProps<{ hidden: boolean }>()
const emit = defineEmits<{ attach: [jobId: string] }>()

const { t, tn } = useI18n()

/** A long list caps rather than virtualises — `ui/list.js`'s own rule, carried across. */
const CAP = 200
const WAITING_CAP = 50

const session = computed(
  () => snapshot.value?.session ?? { jobId: null, blocked: false, pausedBy: null, closing: false, stalledSince: null },
)
const groups = computed(() => split(snapshot.value?.queue ?? []))
const running = computed(() => groups.value.running.slice(0, CAP))
const waiting = computed(() => groups.value.waiting.slice(0, WAITING_CAP))
const history = computed(() => groups.value.history.slice(0, CAP))
const waitingTotal = computed(() => groups.value.waiting.length)

function key(job: Job): string {
  return jobKey(job)
}

function cancel(jobId: string): void {
  send({ type: 'cancel', jobId })
}
function attach(jobId: string): void {
  emit('attach', jobId)
}
</script>

<template>
  <div class="view" id="panel-queue" :hidden="hidden">
    <!-- The pause, its cause, and the two ways out of it — never further away
         than the jobs it is holding. A paused queue with its Resume button
         hidden is indistinguishable from a broken Run button. -->
    <div class="banner warn queue-pause" id="queue-blocked" :hidden="!session.blocked">
      <span id="queue-pause-text">{{ t(session.pausedBy === 'stopped' ? 'queue.pausedStopped' : 'queue.blockedBanner') }}</span>
      <span class="queue-actions">
        <button type="button" class="primary" id="queue-resume" :hidden="!session.blocked" @click="send({ type: 'resume' })">
          {{ t('queue.resume') }}
        </button>
        <button type="button" id="queue-clear" :hidden="waiting.length === 0" @click="send({ type: 'clear' })">
          {{ t('queue.clear') }}
        </button>
      </span>
    </div>

    <p class="empty" id="queue-empty" :hidden="(snapshot?.queue.length ?? 0) > 0">{{ t('queue.empty') }}</p>

    <!-- Three groups rather than one reversed list — "running", "waiting" and
         "finished" are three different questions. -->
    <section class="queue-group" id="queue-now-group" :hidden="running.length === 0">
      <h3>{{ t('queue.running') }}</h3>
      <ul class="jobs" id="queue-now">
        <QueueRow
          v-for="job in running"
          :key="key(job)"
          :job="job"
          group="running"
          :closing="session.closing"
          @cancel="cancel"
          @attach="attach"
        />
      </ul>
    </section>

    <section class="queue-group" id="queue-waiting-group" :hidden="waiting.length === 0">
      <h3 id="queue-waiting-title">{{ tn('queue.waiting', waitingTotal) }}</h3>
      <ul class="jobs" id="queue-waiting">
        <QueueRow
          v-for="(job, at) in waiting"
          :key="key(job)"
          :job="job"
          group="waiting"
          :position="at + 1"
          @cancel="cancel"
          @attach="attach"
        />
      </ul>
      <p class="more" id="queue-more" :hidden="waiting.length >= waitingTotal">
        {{ t('queue.more', { shown: waiting.length, total: waitingTotal }) }}
      </p>
    </section>

    <section class="queue-group" id="queue-history-group" :hidden="history.length === 0">
      <h3>{{ t('queue.history') }}</h3>
      <ul class="jobs" id="queue-history">
        <QueueRow v-for="job in history" :key="key(job)" :job="job" group="history" @cancel="cancel" @attach="attach" />
      </ul>
    </section>
  </div>
</template>
