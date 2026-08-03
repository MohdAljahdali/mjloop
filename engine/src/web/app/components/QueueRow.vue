<script setup lang="ts">
/**
 * One row of the queue: `panels/queue.js`'s `jobRow`, ported.
 *
 * One control per row, labelled with the verb it performs. Stopping a
 * running session and dropping a queued command are different acts with
 * different costs, and used to share a single `×` — see `tpl-job` in
 * `index.html` and the comment above `panels/queue.js`'s `jobRow`.
 */
import type { Job } from '../types/protocol.js'
import { useI18n } from '../composables/useI18n.js'
import { duration } from '../lib/fmt.js'
import Bdi from './Bdi.vue'

const props = defineProps<{
  job: Job
  group: 'running' | 'waiting' | 'history'
  /** Its place in the run order — 1-based. Only meaningful for the waiting group. */
  position?: number
  /**
   * The live session is mid-shutdown. Only meaningful for the running group's
   * one row: a job the queue has asked to close is neither still running nor
   * finished, and showing it as `running` behind a Stop button that now does
   * nothing is what made stopping feel broken.
   */
  closing?: boolean
}>()

defineEmits<{ cancel: [jobId: string]; attach: [jobId: string] }>()

const { t } = useI18n()
</script>

<template>
  <li class="job">
    <span v-if="group === 'waiting'" class="pos"><Bdi :value="String(position ?? '')" /></span>
    <span class="cmd"><Bdi :value="job.command" /></span>
    <span class="st" :class="group === 'running' && closing ? 'job-closing' : `job-${job.status}`">
      {{ group === 'running' && closing ? t('queue.closing') : t(`job.status.${job.status}`) }}
    </span>
    <span class="dur"><Bdi :value="duration(job.startedAt, job.endedAt)" /></span>
    <span class="row-actions">
      <button
        v-if="group === 'running'"
        type="button"
        class="danger"
        :disabled="closing"
        @click="$emit('cancel', job.id)"
      >
        {{ t('job.stop') }}
      </button>
      <button v-if="group === 'waiting'" type="button" :title="t('job.cancel')" @click="$emit('cancel', job.id)">
        {{ t('job.remove') }}
      </button>
      <button v-if="group !== 'waiting'" type="button" @click="$emit('attach', job.id)">{{ t('job.view') }}</button>
    </span>
    <span v-if="job.reason !== null" class="reason">{{ t(job.reason.code, job.reason.params) }}</span>
  </li>
</template>
