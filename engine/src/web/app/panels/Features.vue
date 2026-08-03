<script setup lang="ts">
/**
 * Feature briefs, and the one write this page is permitted to make.
 * `panels/features.js`, ported.
 *
 * Structurally `panels/plans.js`/`Plans.vue`: a master list, one detail
 * fetched only while it is open, and a decision taken against what that
 * detail actually showed. The differences are all consequences of what a
 * brief *is*.
 *
 *  - **A revision is immutable and an approval is final.** `approveFeatureBrief`
 *    refuses to touch an approved revision ever again, so unlike a plan gate
 *    there is no re-decision and no undo to offer — `submit()` here is never
 *    called with an `undo`, and `stores/session.ts`'s `settle()` announces
 *    such a write with nothing to press. That is why this is the second
 *    control on the page with a confirmation dialog, and why (unlike
 *    `HaltDialog.vue`'s destructive styling) its confirm button is styled
 *    `primary`, not `danger` — nothing here is being taken away.
 *  - **The compare-and-swap is on content, not on the revision number.** A
 *    draft holds one number for the whole of its editable life, so the
 *    number alone would approve whatever the brief says by the time the
 *    click lands. The digest served beside the brief is handed straight back
 *    — see `FeatureApproveDialog.vue`.
 *  - **A criteria-less draft is refused before it is sent.** The schema
 *    requires at least one acceptance criterion on an approved brief, and
 *    `web/writes.ts` deliberately gives that refusal no code of its own — it
 *    falls to `write.failed` with the diagnosis on the server's terminal.
 *    The page cannot explain it afterwards, so `approvable()` (`lib/features.ts`)
 *    does not let it happen.
 *
 * There is no create, no edit, and no discovery launched from here. Writing a
 * brief is the interview's work.
 *
 * The open feature and its fetched detail live in `lib/featuredoc.ts`, not
 * here — `FeatureApproveDialog.vue` (mounted from `App.vue`, outside the
 * `<KeepAlive>` this panel sits behind) reads the same live document at
 * confirm time, and a copy owned by this panel would go stale the moment the
 * reader's focus moved to the dialog.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { useFeatureApprove } from '../composables/useFeatureApprove.js'
import { approvable } from '../lib/features.js'
import { closeFeature, opened, subscribe as subscribeFeatureDoc, toggleFeature, value as featureDocValue } from '../lib/featuredoc.js'
import { stamp } from '../lib/fmt.js'
import type { FeatureSummary } from '../types/protocol.js'
import Bdi from '../components/Bdi.vue'
import Tx from '../components/Tx.vue'
import FeatureRow from '../components/FeatureRow.vue'
import FeatureAcceptanceRow from '../components/FeatureAcceptanceRow.vue'
import FeatureDecisionRow from '../components/FeatureDecisionRow.vue'
import FeatureRevisionRow from '../components/FeatureRevisionRow.vue'

const { t } = useI18n()

/** `ui/list.js`'s own cap, carried across — a long list caps rather than virtualises. */
const CAP = 200

const featuresFeed = useFeed<FeatureSummary[]>({
  dep: (state) => state.revisions.features,
  path: () => '/api/features',
})
const features = computed(() => featuresFeed.value.value ?? [])
const shownFeatures = computed(() => features.value.slice(0, CAP))

// `lib/featuredoc.ts`'s own document, ticked into a computed the same way
// `Plans.vue` ticks `lib/plandoc.ts`'s.
const docTick = ref(0)
subscribeFeatureDoc(() => void docTick.value++)
const brief = computed(() => (docTick.value, featureDocValue()))

const gate = computed(() => approvable(brief.value))

/** The feature opened by a user action, and waiting for its fetched detail. */
const focusPending = ref<string | null>(null)

function toggle(id: string): void {
  const opening = toggleFeature(id)
  focusPending.value = opening ? id : null
}

function closeDetail(): void {
  closeFeature()
  focusPending.value = null
}

const detailTitleEl = ref<HTMLElement | null>(null)

watch(brief, (view) => {
  if (view === null || focusPending.value !== view.brief.id) return
  focusPending.value = null
  void nextTick(() => detailTitleEl.value?.focus())
})

const { openApprove } = useFeatureApprove()

function ask(): void {
  if (!gate.value.can) return
  openApprove()
}
</script>

<template>
  <section id="panel-features" class="panel" aria-labelledby="panel-features-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-features-title">{{ t('panel.features.title') }}</h1>
        <p class="hint">{{ t('panel.features.help') }}</p>
      </div>
    </header>
    <p class="empty" id="features-empty" :hidden="features.length > 0">{{ t('features.empty') }}</p>

    <div class="plans-workspace" id="features-workspace" :data-detail-open="opened === null ? 'false' : 'true'">
      <div class="plans-master">
        <div class="plans" id="features-list">
          <FeatureRow v-for="feature in shownFeatures" :key="feature.id" :feature="feature" :open="opened === feature.id" @toggle="toggle" />
        </div>
        <p class="more" id="features-more" :hidden="shownFeatures.length >= features.length">
          {{ t('features.more', { shown: shownFeatures.length, total: features.length }) }}
        </p>
      </div>

      <section class="plan-detail block" id="feature-detail" :hidden="opened === null || brief === null">
        <template v-if="brief !== null">
          <header class="plan-detail-head">
            <button type="button" class="plan-back" @click="closeDetail">{{ t('features.back') }}</button>
            <h2 id="feature-detail-title" ref="detailTitleEl" tabindex="-1"><Bdi :value="brief.brief.title" /></h2>
          </header>
          <p class="record" id="feature-record">
            <!-- `revision` stays a number, not `String(...)`: the old page
                 passed `brief.revision` straight through `phrase()` →
                 `renderParam` → `Intl.NumberFormat`, and `String()` here
                 would take a different path through `t()`. Under the
                 registry's `ar` (not `ar-EG`/`ar-SA`), both paths happen to
                 print the same Latin digits on this ICU — the point is not
                 the digits, it is that a numeric hole resolves as bidi class
                 AN regardless of script, so it never forms a strong-LTR run
                 and never drags the sentence's punctuation around; a
                 `String()` value is prose and only avoids that by accident.
                 Keeping it a number matches the old page's exact call shape
                 rather than one that is merely equivalent today. `id` is the
                 Latin brief id, which does need `Tx`'s isolation. -->
            <Tx :key-name="`features.record.${brief.status}`" :params="{ id: brief.brief.id, revision: brief.brief.revision }" />
          </p>
          <p class="banner warn" id="feature-blocked" :hidden="gate.why === null">{{ gate.why === null ? '' : t(gate.why) }}</p>

          <div class="approve">
            <button
              type="button"
              class="primary"
              id="feature-approve"
              :hidden="brief.status !== 'draft'"
              :disabled="!gate.can"
              @click="ask"
            >
              {{ t('features.approve') }}
            </button>
          </div>

          <section class="block">
            <h3>{{ t('features.problem') }}</h3>
            <p class="excerpt" id="feature-problem" dir="auto"><Bdi :value="brief.brief.problem" /></p>
          </section>

          <section class="block" id="feature-acceptance-block">
            <h3>{{ t('features.acceptance') }}</h3>
            <p class="empty" id="feature-acceptance-empty" :hidden="brief.brief.acceptance.length > 0">{{ t('features.acceptanceEmpty') }}</p>
            <ul class="stories detail" id="feature-acceptance">
              <FeatureAcceptanceRow v-for="line in brief.brief.acceptance" :key="line" :line="line" />
            </ul>
          </section>

          <section class="block" id="feature-decisions-block" :hidden="brief.brief.decisions.length === 0">
            <h3>{{ t('features.decisions') }}</h3>
            <div id="feature-decisions">
              <FeatureDecisionRow v-for="decision in brief.brief.decisions" :key="decision.question" :decision="decision" />
            </div>
          </section>

          <dl class="facts">
            <div class="fact"><dt>{{ t('features.components') }}</dt><dd id="feature-components"><Bdi :value="brief.brief.affectedComponents.join(' ')" /></dd></div>
            <div class="fact"><dt>{{ t('features.tags') }}</dt><dd id="feature-tags"><Bdi :value="brief.brief.tags.join(' ')" /></dd></div>
            <div class="fact"><dt>{{ t('features.discovery') }}</dt><dd id="feature-discovery">{{ t(`features.discovery.${brief.brief.discovery.mode}`) }}</dd></div>
            <div class="fact"><dt>{{ t('features.created') }}</dt><dd id="feature-created"><Bdi :value="stamp(brief.brief.createdAt)" /></dd></div>
          </dl>

          <!-- Who signed it, when, and in their own words. `by` is derived from
               the account the server runs as and is never typed, which is the
               only reason it is worth showing at all. -->
          <section class="block" id="feature-approval-block" :hidden="brief.brief.approval === null">
            <h3>{{ t('features.approval') }}</h3>
            <dl class="facts">
              <div class="fact"><dt>{{ t('features.approvedBy') }}</dt><dd id="feature-approved-by"><Bdi :value="brief.brief.approval?.by ?? ''" /></dd></div>
              <div class="fact"><dt>{{ t('features.approvedAt') }}</dt><dd id="feature-approved-at"><Bdi :value="brief.brief.approval === null ? '' : stamp(brief.brief.approval.at)" /></dd></div>
              <div class="fact"><dt>{{ t('features.approvalNote') }}</dt><dd id="feature-approval-note"><Bdi :value="brief.brief.approval?.note ?? ''" /></dd></div>
            </dl>
          </section>

          <!-- The history *is* the audit trail: a revision is immutable, so
               every earlier one is still exactly what it was when it was
               written. `superseded` is derived here, never stored. -->
          <section class="block">
            <h3>{{ t('features.history') }}</h3>
            <div id="feature-revisions">
              <FeatureRevisionRow v-for="entry in brief.revisions" :key="entry.revision" :entry="entry" />
            </div>
          </section>
        </template>
      </section>
    </div>
  </section>
</template>
