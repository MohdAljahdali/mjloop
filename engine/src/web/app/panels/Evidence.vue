<script setup lang="ts">
/**
 * Evidence — the runs on disk, and what each cycle actually did.
 *
 * The list is directory names with outcomes derived from what is inside
 * them. Opening a run fetches its cycles, and each cycle carries the two
 * things that are recoverable from nowhere else: the agents the leader
 * **skipped**, with its stated reason for each, and what the engine itself
 * executed to verify the project.
 *
 * The verify ledger and the handoff ride the cycle document rather than
 * routes of their own, so both follow the per-cycle revision rule already
 * below: the open run's last cycle is live and everything before it is
 * inert. `panels/evidence.js`, ported.
 */
import { computed, ref } from 'vue'
import { snapshot } from '../stores/session.js'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import type { RunSummary, RunDetail } from '../types/protocol.js'
import Bdi from '../components/Bdi.vue'
import EvidenceRunRow from '../components/EvidenceRunRow.vue'
import CycleFeed from '../components/CycleFeed.vue'

const { t } = useI18n()

/** `ui/list.js`'s `reconcile()` own default row cap, matched here since the
 * run list is now a plain `v-for` rather than a reconciled DOM diff. */
const RUN_LIST_LIMIT = 200

/** The run whose cycles are open, or null. */
const opened = ref<string | null>(null)
function toggle(id: string): void {
  opened.value = opened.value === id ? null : id
}

// `revisions.cycle` as well as `revisions.runs`: a cycle directory gains
// files while a run is live, and the outcome column counts them.
const runsFeed = useFeed<RunSummary[]>({
  dep: (state) => `${state.revisions.runs}:${state.revisions.cycle}`,
  path: () => '/api/runs',
})
const allRuns = computed(() => runsFeed.value.value ?? [])
const shownRuns = computed(() => allRuns.value.slice(0, RUN_LIST_LIMIT))
const runsMore = computed(() => allRuns.value.length > shownRuns.value.length)

const runFeed = useFeed<RunDetail>({
  dep: (state) => (opened.value === null ? null : `${opened.value}:${state.revisions.cycle}`),
  path: () => `/api/runs/${encodeURIComponent(opened.value ?? '')}`,
})
const openRun = computed(() => runFeed.value.value)

/**
 * Only the run's last cycle can still be written to, and only while that
 * run is the live one. Passed down to each `CycleFeed` as `live`, which is
 * what picks its revision: `revisions.cycle` for this one, `revisions.runs`
 * for every earlier, inert cycle directory.
 */
const openCycle = computed(() => {
  const state = snapshot.value
  const view = openRun.value
  if (state === null || view === null) return undefined
  return state.state.run_id !== null && view.id.startsWith(`${state.state.run_id}--`) ? view.cycles.at(-1) : undefined
})
</script>

<template>
  <section id="panel-evidence" class="panel" aria-labelledby="panel-evidence-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-evidence-title">{{ t('panel.evidence.title') }}</h1>
        <p class="hint">{{ t('panel.evidence.help') }}</p>
      </div>
    </header>
    <p v-if="allRuns.length === 0" id="evidence-empty" class="empty">{{ t('evidence.empty') }}</p>
    <div class="scroller">
      <div class="grid grid-runs" role="table">
        <div class="grid-head" role="row">
          <span role="columnheader">{{ t('evidence.run') }}</span>
          <span role="columnheader">{{ t('evidence.story') }}</span>
          <span role="columnheader">{{ t('evidence.track') }}</span>
          <span role="columnheader">{{ t('evidence.cycles') }}</span>
          <span role="columnheader">{{ t('evidence.outcome') }}</span>
          <span role="columnheader"></span>
        </div>
        <div id="evidence-list" role="rowgroup" class="grid-body">
          <EvidenceRunRow
            v-for="entry in shownRuns"
            :key="entry.id"
            :entry="entry"
            :open="opened === entry.id"
            @toggle="toggle"
          />
        </div>
      </div>
    </div>
    <p v-if="runsMore" id="evidence-more" class="more">{{ t('evidence.more', { shown: shownRuns.length, total: allRuns.length }) }}</p>

    <section v-if="opened !== null && openRun !== null" id="run-open" class="block">
      <h2 id="run-open-title"><Bdi :value="openRun.id" /></h2>
      <details v-if="openRun.halt !== null" id="run-open-halt">
        <summary>{{ t('evidence.haltReport') }}</summary>
        <pre id="run-open-haltbody" class="excerpt"><Bdi :value="openRun.halt" /></pre>
      </details>
      <div id="run-open-cycles">
        <CycleFeed
          v-for="cycle in openRun.cycles"
          :key="`${openRun.id}/${cycle}`"
          :run="openRun.id"
          :cycle="cycle"
          :live="cycle === openCycle"
        />
      </div>
    </section>
  </section>
</template>
