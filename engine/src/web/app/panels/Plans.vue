<script setup lang="ts">
/**
 * Plans — what can be built now, what each plan is waiting on, and one list
 * of stories per plan rather than two. `panels/plans.js`, ported.
 *
 * Stories are one tab over. This panel counts them — a progress bar, a
 * tally, how many are ready here — and links across; it never lists them.
 * Two rhythms, two tabs: a plan is read occasionally, a story is watched
 * while it runs.
 *
 * Readiness is `lib/stories.ts`'s rule, which is the engine's per-plan one.
 *
 * The list rides the snapshot. The open plan's body, its review, and its
 * stories' acceptance criteria and evidence are documents, so they are
 * fetched through `lib/plandoc.ts` — `PlanDetail` deliberately is not on
 * `PlanView`.
 *
 * This is also the first panel to submit a write with an inverse: a gate
 * decision that replaces a *previous* decision is reversible, and
 * `stores/session.ts`'s `submit()` offers `write.undo` for exactly that when
 * one is passed. A decision made against "no decision yet" has no valid
 * inverse — `ApprovalDecisionSchema` has no member meaning "undecided" — so
 * that one submits with no `undo` at all, and the store announces the result
 * with nothing to press.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { mountPlanDoc, subscribe as subscribePlanDoc, value as planDocValue } from '../lib/plandoc.js'
import { stamp } from '../lib/fmt.js'
import { planMemories, planRuns } from '../lib/plans.js'
import { activePlan, setActivePlan } from '../lib/selection.js'
import { planProgress, tally } from '../lib/stories.js'
import { send, snapshot, submit } from '../stores/session.js'
import type { MemoryView, RunSummary, Write } from '../types/protocol.js'
import Bdi from '../components/Bdi.vue'
import PlanRow from '../components/PlanRow.vue'
import PlanEvidenceRow from '../components/PlanEvidenceRow.vue'
import PlanMemoryRow from '../components/PlanMemoryRow.vue'

const { t } = useI18n()

/** `ui/list.js`'s own cap, carried across — a long list caps rather than virtualises. */
const CAP = 200

const plans = computed(() => snapshot.value?.plans ?? [])
const shownPlans = computed(() => plans.value.slice(0, CAP))
const counts = computed(() => tally(plans.value))

/**
 * The plan whose detail is open, or null.
 *
 * `lib/selection.ts` is per-browser storage, not a Vue ref, so it is mirrored
 * into one here — the only writer of it is this panel, until Stories opens
 * a second one.
 */
const openId = ref<string | null>(activePlan())
/** The plan opened by a user action and waiting for its fetched detail. */
const focusPending = ref<string | null>(null)

function toggle(id: string): void {
  const closing = openId.value === id
  openId.value = closing ? null : id
  setActivePlan(openId.value)
  focusPending.value = closing ? null : id
}

function closeDetail(): void {
  openId.value = null
  setActivePlan(null)
  focusPending.value = null
}

// The document is fetched in `lib/plandoc.ts`, driven from here: this panel
// is its only reader so far, and `ui/render.js`'s "a hidden panel's feed goes
// stale" rule carries the same way — nothing pumps it while this panel is
// not the mounted one under `<KeepAlive>`.
const planDocFeed = mountPlanDoc()
const docTick = ref(0)
subscribePlanDoc(() => void docTick.value++)
watch(
  [snapshot, openId],
  ([current]) => {
    if (current !== null) planDocFeed.update(current)
  },
  { immediate: true },
)
const planDoc = computed(() => (docTick.value, planDocValue()))

/**
 * Every run on disk, for Plan Evidence — its own feed for the same reason
 * `panels/stories.js` and `panels/evidence.js` each keep one: a feed driven
 * from someone else's update stops moving the moment this tab is the one on
 * screen.
 */
const runsFeed = useFeed<RunSummary[]>({
  dep: (state) => `${state.revisions.runs}:${state.revisions.cycle}`,
  path: () => '/api/runs',
})

/** The whole memory corpus, for Plan Memory. */
const memoriesFeed = useFeed<MemoryView[]>({
  dep: (state) => state.revisions.memory,
  path: () => '/api/memory',
})

const evidenceRows = computed(() => (planDoc.value === null ? [] : planRuns(runsFeed.value.value ?? [], planDoc.value)))
const shownEvidence = computed(() => evidenceRows.value.slice(0, CAP))

const memoryRows = computed(() => (planDoc.value === null ? [] : planMemories(memoriesFeed.value.value ?? [], planDoc.value)))
const shownMemory = computed(() => memoryRows.value.slice(0, CAP))

/**
 * The exact object `tally()` already summed, never a plan pulled off the
 * fetched document — which can be one revision behind the snapshot this
 * frame is drawing from.
 */
const openPlanView = computed(() => plans.value.find((entry) => entry.id === openId.value) ?? null)
const progress = computed(() => (openPlanView.value === null ? null : planProgress(openPlanView.value)))

const detailTitleEl = ref<HTMLElement | null>(null)
const detailEl = ref<HTMLElement | null>(null)

watch(planDoc, (doc) => {
  if (doc === null || focusPending.value !== doc.id) return
  focusPending.value = null
  void nextTick(() => {
    detailTitleEl.value?.focus({ preventScroll: true })
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    detailEl.value?.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  })
})

const noteEl = ref<HTMLInputElement | null>(null)

/**
 * @param decision What the button pressed means.
 */
function decide(decision: 'approved' | 'rejected' | 'changes_requested'): void {
  // Read once: the decision is submitted against the plan that was open when
  // the button was pressed, not against whatever it is by the time the frame
  // is composed.
  const plan = openId.value
  const current = plans.value.find((view) => view.id === plan)
  if (plan === null || current === undefined) return
  const from = current.approval as 'approved' | 'rejected' | 'changes_requested' | null
  const written = noteEl.value?.value.trim() ?? ''
  const write: Write = { kind: 'gate', plan, from, to: decision, note: written.length === 0 ? null : written }
  // No inverse when there was nothing on record: `ApprovalDecisionSchema` has
  // no member meaning "undecided", so a write back to `from` would not be a
  // legal `to`. `submit()` announces such a write with nothing to press.
  const undo: Write | undefined = from === null ? undefined : { kind: 'gate', plan, from: decision, to: from, note: null }
  submit(write, undo === undefined ? {} : { undo })
  // A user action, not a render.
  if (noteEl.value !== null) noteEl.value.value = ''
}

const newPlanEl = ref<HTMLInputElement | null>(null)

function submitNewPlan(): void {
  const idea = newPlanEl.value?.value.trim() ?? ''
  if (idea.length === 0) return
  send({ type: 'enqueue', command: `/mjloop:plan ${idea}`, story: null })
  if (newPlanEl.value !== null) newPlanEl.value.value = ''
}
</script>

<template>
  <section id="panel-plans" class="panel" aria-labelledby="panel-plans-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-plans-title">{{ t('panel.plans.title') }}</h1>
        <p class="hint">{{ t('panel.plans.help') }}</p>
      </div>
    </header>
    <p class="empty" id="plans-empty" :hidden="plans.length > 0">{{ t('plans.empty') }}</p>

    <div class="panel-grid">
      <div class="panel-main">
        <div class="plans-workspace" id="plans-workspace" :data-detail-open="openId === null ? 'false' : 'true'">
          <div class="plans-master">
            <div class="plans" id="plans-list">
              <PlanRow v-for="plan in shownPlans" :key="plan.id" :plan="plan" :open="openId === plan.id" @toggle="toggle" />
            </div>
            <p class="more" id="plans-more" :hidden="shownPlans.length >= plans.length">
              {{ t('plans.more', { shown: shownPlans.length, total: plans.length }) }}
            </p>
          </div>

          <section class="plan-detail block" id="plan-detail" ref="detailEl" :hidden="openId === null || planDoc === null">
            <template v-if="planDoc !== null">
              <header class="plan-detail-head">
                <button type="button" class="plan-back" @click="closeDetail">{{ t('plans.back') }}</button>
                <h2 id="plan-detail-title" ref="detailTitleEl" tabindex="-1"><Bdi :value="planDoc.id" /> — <Bdi :value="planDoc.title" /></h2>
              </header>

              <section class="plan-detail-sub" id="plan-progress" :hidden="progress === null">
                <h3>{{ t('plans.progressTitle') }}</h3>
                <p class="hint">{{ t('plans.progressHint') }}</p>
                <ul v-if="progress !== null" class="tally">
                  <li><span class="k">{{ t('plans.count.done') }}</span><span class="v" id="plan-progress-completed">{{ t('plans.number', { n: progress.completed }) }}</span></li>
                  <li><span class="k">{{ t('plans.count.doing') }}</span><span class="v" id="plan-progress-doing">{{ t('plans.number', { n: progress.doing }) }}</span></li>
                  <li><span class="k">{{ t('plans.count.ready') }}</span><span class="v tally-ready" id="plan-progress-ready">{{ t('plans.number', { n: progress.ready }) }}</span></li>
                  <li><span class="k">{{ t('plans.count.blocked') }}</span><span class="v tally-blocked" id="plan-progress-blocked">{{ t('plans.number', { n: progress.blocked }) }}</span></li>
                  <li><span class="k">{{ t('plans.count.remaining') }}</span><span class="v" id="plan-progress-remaining">{{ t('plans.number', { n: progress.remaining }) }}</span></li>
                </ul>
              </section>

              <section class="plan-detail-sub">
                <h3>{{ t('plans.decisionTitle') }}</h3>
                <p class="hint">{{ t('plans.decisionHint') }}</p>
                <p class="record" id="plan-approval-record">
                  {{
                    planDoc.approval === null
                      ? t('plans.noDecision')
                      : t('plans.decidedBy', {
                          decision: t(`plans.approval.${planDoc.approval.decision}`),
                          by: planDoc.approval.by,
                          at: stamp(planDoc.approval.at),
                          note: planDoc.approval.note ?? '—',
                        })
                  }}
                </p>

                <div class="approve">
                  <input id="approve-note" ref="noteEl" name="note" maxlength="2000" dir="auto" autocomplete="off" :placeholder="t('plans.notePlaceholder')" :aria-label="t('plans.noteLabel')" />
                  <button type="button" :disabled="planDoc.approval?.decision === 'approved'" @click="decide('approved')">{{ t('plans.approve') }}</button>
                  <button type="button" :disabled="planDoc.approval?.decision === 'changes_requested'" @click="decide('changes_requested')">{{ t('plans.requestChanges') }}</button>
                  <button type="button" class="danger" :disabled="planDoc.approval?.decision === 'rejected'" @click="decide('rejected')">{{ t('plans.reject') }}</button>
                </div>
              </section>

              <details id="plan-body-details" :hidden="planDoc.body.trim().length === 0">
                <summary>{{ t('plans.readPlan') }}</summary>
                <pre class="excerpt" id="plan-body"><Bdi :value="planDoc.body" /></pre>
              </details>
              <details id="plan-review-details" :hidden="planDoc.review === null">
                <summary>{{ t('plans.readReview') }}</summary>
                <pre class="excerpt" id="plan-review"><Bdi :value="planDoc.review ?? ''" /></pre>
              </details>

              <section class="plan-detail-sub plan-evidence">
                <h3>{{ t('plans.evidence.title') }}</h3>
                <p class="hint">{{ t('plans.evidence.hint') }}</p>
                <p class="empty" id="plan-evidence-empty" :hidden="evidenceRows.length > 0">{{ t('plans.evidence.empty') }}</p>
                <ul class="runs" id="plan-evidence-list">
                  <PlanEvidenceRow v-for="entry in shownEvidence" :key="entry.id" :entry="entry" />
                </ul>
                <p class="more" id="plan-evidence-more" :hidden="shownEvidence.length >= evidenceRows.length">
                  {{ t('plans.evidence.more', { shown: shownEvidence.length, total: evidenceRows.length }) }}
                </p>
              </section>

              <section class="plan-detail-sub">
                <h3>{{ t('plans.memory.title') }}</h3>
                <p class="hint">{{ t('plans.memory.hint') }}</p>
                <p class="empty" id="plan-memory-empty" :hidden="memoryRows.length > 0">{{ t('plans.memory.empty') }}</p>
                <ul class="memories" id="plan-memory-list">
                  <PlanMemoryRow v-for="memory in shownMemory" :key="memory.id" :memory="memory" />
                </ul>
                <p class="more" id="plan-memory-more" :hidden="shownMemory.length >= memoryRows.length">
                  {{ t('plans.memory.more', { shown: shownMemory.length, total: memoryRows.length }) }}
                </p>
              </section>

              <p class="plan-stories"><a href="#stories">{{ t('plans.seeStories') }}</a></p>
            </template>
          </section>
        </div>
      </div>

      <aside class="panel-side">
        <section class="block" id="plans-tally-block" :hidden="plans.length === 0">
          <h2>{{ t('plans.tallyTitle') }}</h2>
          <ul class="tally" id="plans-tally">
            <li><span class="k">{{ t('plans.count.plans') }}</span><span class="v" id="tally-plans">{{ t('plans.number', { n: counts.plans }) }}</span></li>
            <li><span class="k">{{ t('plans.count.ready') }}</span><span class="v tally-ready" id="tally-ready">{{ t('plans.number', { n: counts.ready }) }}</span></li>
            <li><span class="k">{{ t('plans.count.doing') }}</span><span class="v" id="tally-doing">{{ t('plans.number', { n: counts.doing }) }}</span></li>
            <li><span class="k">{{ t('plans.count.blocked') }}</span><span class="v tally-blocked" id="tally-blocked">{{ t('plans.number', { n: counts.blocked }) }}</span></li>
            <li><span class="k">{{ t('plans.count.done') }}</span><span class="v" id="tally-done">{{ t('plans.number', { n: counts.done }) }}</span></li>
          </ul>
        </section>

        <section class="block">
          <h2>{{ t('plans.create') }}</h2>
          <form class="command stacked" @submit.prevent="submitNewPlan">
            <input id="new-plan" ref="newPlanEl" name="idea" dir="auto" autocomplete="off" :placeholder="t('plans.newPlanHint')" :aria-label="t('plans.newPlanLabel')" />
            <button type="submit">{{ t('plans.newPlan') }}</button>
          </form>
        </section>
      </aside>
    </div>
  </section>
</template>
