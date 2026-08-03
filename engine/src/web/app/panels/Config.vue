<script setup lang="ts">
/**
 * Config — a typed editor in front of the guarded config mutator.
 * `panels/config.js`, ported; the pure half — the change vocabulary, the
 * order-graph refusals, the change-impact preview — lives in `lib/config.ts`
 * so it is testable without a DOM.
 *
 * The browser never sends a YAML path or a replacement document. It compares
 * `form` and `draft` — the state every control on this page writes to —
 * against `baseline`, the parsed document this editor was last seeded from,
 * and sends a closed list of typed changes plus that document's revision.
 *
 * **The invariant this panel exists to protect**: every control on this page
 * writes to `form` or `draft` and nothing else. `mutate()` below is the one
 * function allowed to touch `draft`; `save()` is the one function that ever
 * calls `submit()`, and it is the only place `collectConfigChanges` is
 * called outside a test. No child component imports `submit` or `feed` —
 * `SpecialistEditor.vue` and every track-card component only ever receive
 * `mutate` as a prop and call it.
 *
 * `specialists:` and `tracks:` were two JSON textareas before this rewrite.
 * The DOM seam `config.js` needed to keep that surface change off the
 * wire — hidden `*_json` fields feeding `collectConfigChanges` — does not
 * exist here: `draft` below is already the object `collectConfigChanges`
 * reads, because Vue's own reactivity is the seam.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { snapshot, submit } from '../stores/session.js'
import { pluralKey } from '../lib/i18n.js'
import {
  broken,
  collectConfigChanges,
  commandRows,
  knownAgents,
  orchestrationProblem,
  policyRows,
  seedDraft,
  seedFormValues,
  type ConfigFormValues,
  type Draft,
} from '../lib/config.js'
import type { Config, ConfigView, Telemetry } from '../types/protocol.js'
import Bdi from '../components/Bdi.vue'
import Tx from '../components/Tx.vue'
import ConfigFactRow from '../components/ConfigFactRow.vue'
import ConfigTelemetryRow from '../components/ConfigTelemetryRow.vue'
import SpecialistEditor from '../components/SpecialistEditor.vue'
import TrackEditors from '../components/TrackEditors.vue'

const { t, tn, locale } = useI18n()

const BLANK_FORM: ConfigFormValues = {
  autonomous: false,
  verifyCache: false,
  maxParallelAgents: 1,
  noProgressStrikes: 1,
  planApproval: 'human',
  commit: 'human',
  preflight: 'human',
  verifyTest: '',
  verifyLint: '',
  verifyBuild: '',
  timeoutMs: 900000,
  lockTimeoutMs: 1800000,
  patternsTest: '',
  patternsLint: '',
  patternsBuild: '',
  orchProfileAutoAccept: false,
  orchDiscoveryMode: 'off',
  orchDiscoveryQuestionBudget: 8,
  orchDiscoveryCompletion: 'review',
  orchExecutionAfterPlanApproval: 'manual',
  orchExecutionUncertainConcurrency: 'sequential',
  orchExecutionRepairAttempts: 1,
  orchQualityIndependentPlanReview: false,
  orchQualityIndependentVerification: false,
  orchSkillsSourceGithub: false,
  orchSkillsSourceRegistry: false,
  orchSkillsSourceWeb: false,
  orchSkillsTrustedRegistries: '',
  orchSkillsUpdateMode: 'review',
}

const configFeed = useFeed<ConfigView>({ dep: (state) => state.revisions.config, path: () => '/api/config' })
const view = computed(() => configFeed.value.value)
const parsed = computed(() => view.value?.parsed ?? null)
const enabled = computed(() => parsed.value !== null && view.value?.revision != null)

/**
 * `revisions.runs` alone, and not the cycle tick — see `config.js`'s own
 * comment: that revision is the run-directory listing plus its own mtime, so
 * this table goes stale during a live run and refreshes when the next one
 * opens, which is the right trade for a report over the last fifty runs.
 */
const telemetryFeed = useFeed<Telemetry>({ dep: (state) => state.revisions.runs, path: () => '/api/telemetry' })
const telemetry = computed(() => telemetryFeed.value.value)

/** The document this editor was last seeded from, and its own revision hash. */
const baseline = ref<Config | null>(null)
const editorRevision = ref<string | null>(null)
/** `config.yaml`'s own text for that same revision — see `trackCommentLoss`'s only caller, `TrackEditor.vue`. */
const rawText = ref<string | null>(null)

const dirty = ref(false)
const saving = ref(false)
const conflict = ref(false)

const form = ref<ConfigFormValues>({ ...BLANK_FORM })
const draft = ref<Draft | null>(null)

// No `seedEpoch` here, unlike `config.js`'s own `max_cycles` box: that
// counter existed purely to stop its imperative renderer from clobbering a
// caret mid-keystroke by re-running `cycles.value = String(track.max_cycles)`
// on every redraw, poll included. Vue's own patcher already only writes a
// bound `.value` when it actually differs from the DOM's current one, and
// the reseed guard just below (`revision !== editorRevision`, skipped while
// dirty and not conflicting) is what stops the poll from reaching a draft a
// reader is mid-edit on — the two together make the epoch redundant rather
// than merely hidden.
watch(
  view,
  (current) => {
    if (!enabled.value) return
    const revision = current?.revision ?? null
    const config = current?.parsed
    if (revision === editorRevision.value || config === null || config === undefined) return

    // Decided before `editorRevision` moves: the question is about the *old*
    // baseline a dirty draft was diffing against, not the one this frame is
    // about to install.
    const conflicting = editorRevision.value !== null && dirty.value && !saving.value

    baseline.value = config
    editorRevision.value = revision
    rawText.value = current?.raw ?? null

    if (conflicting) {
      conflict.value = true
      return
    }
    conflict.value = false
    dirty.value = false
    draft.value = seedDraft(config)
    form.value = seedFormValues(config)
  },
  { immediate: true },
)

function markDirty(): void {
  if (!enabled.value) return
  dirty.value = true
}

/**
 * A draft mutation: apply it and mark the form dirty. Every structured
 * editor action goes through here — the one place "the draft moved" and
 * "the form is dirty" cannot disagree. See this file's own header.
 */
function mutate(change: (model: Draft) => boolean | void): void {
  if (!enabled.value || draft.value === null) return
  if (change(draft.value) === false) return
  markDirty()
}

const agentNames = computed(() => (draft.value === null ? [] : knownAgents(draft.value)))

const problem = computed(() => (enabled.value ? orchestrationProblem(form.value) : null))

/** Why the editor banner is showing, in the priority order `config.js`'s own `updateEditor`/`updateEditorActions` apply — unavailable/invalid first, then a conflicting revision, then a whole-document orchestration refusal. */
const stateKey = computed<string | null>(() => {
  if (!enabled.value) return view.value?.invalid === true ? 'config.editorInvalid' : 'config.editorUnavailable'
  if (conflict.value) return 'config.editorChanged'
  if (problem.value !== null) return problem.value
  return null
})

const saveDisabled = computed(
  () => !enabled.value || !dirty.value || saving.value || conflict.value || broken(draft.value) || problem.value !== null,
)
const resetDisabled = computed(() => !enabled.value || (!dirty.value && !conflict.value) || saving.value)

const formEl = ref<HTMLFormElement | null>(null)

function save(): void {
  if (!enabled.value || baseline.value === null || editorRevision.value === null || saving.value || conflict.value) return
  if (formEl.value !== null && !formEl.value.reportValidity()) return
  if (draft.value === null) return
  const changes = collectConfigChanges(form.value, draft.value, baseline.value)
  if (changes.length === 0) {
    dirty.value = false
    return
  }
  saving.value = true
  submit(
    { kind: 'config.patch', revision: editorRevision.value, changes },
    {
      settled(receipt) {
        saving.value = false
        if (receipt.ok) dirty.value = false
      },
    },
  )
}

function reset(): void {
  if (!enabled.value || baseline.value === null) return
  draft.value = seedDraft(baseline.value)
  form.value = seedFormValues(baseline.value)
  dirty.value = false
  conflict.value = false
}

/* ── read-only facts ──────────────────────────────────────────────────── */

const verifyRows = computed(() => (parsed.value === null ? [] : commandRows(parsed.value.verify)))
const policyRows_ = computed(() => (parsed.value === null ? [] : policyRows(parsed.value.verify)))

const telemetryRows = computed(() => telemetry.value?.specialists ?? [])
const telemetryTruncated = computed(() => telemetry.value?.truncated ?? 0)
const flagged = computed(() => telemetry.value?.flagged ?? [])
// Plural category resolved against *this* language, re-resolved on every
// locale switch: `locale.value` is read here so the computed depends on
// `useI18n`'s own epoch, the same dependency `t()`/`tn()` establish
// themselves. `telemetry.flagged` carries a non-count hole (`agents`), so it
// goes through `Tx` rather than `tn()` alone — see `config.js`'s own
// `drawTelemetry`, which used `phrase()` (this page's `Tx`) here and `tn()`'s
// vanilla equivalent for the count-only `telemetry.truncated` beside it.
const flaggedKey = computed(() => (locale.value, pluralKey('telemetry.flagged', flagged.value.length)))
</script>

<template>
  <section id="panel-config" class="panel" aria-labelledby="panel-config-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-config-title">{{ t('panel.config.title') }}</h1>
        <p class="hint">{{ t('panel.config.help') }}</p>
      </div>
    </header>

    <dl class="facts">
      <div class="fact">
        <dt>{{ t('config.designSystem') }}</dt>
        <dd id="config-design">{{ t(snapshot?.state.design_system ? 'config.design.present' : 'config.design.missing') }}</dd>
      </div>
      <div class="fact">
        <dt>{{ t('config.project') }}</dt>
        <!-- An absolute path: an identifier, and one that must not be mirrored. -->
        <dd id="config-project"><Bdi :value="snapshot?.project ?? ''" /></dd>
      </div>
    </dl>

    <form id="config-editor" ref="formEl" class="config-editor" @submit.prevent="save" @input="markDirty" @change="markDirty">
      <div class="config-editor-head">
        <div>
          <h2>{{ t('config.editorTitle') }}</h2>
          <p class="hint">{{ t('config.editorHelp') }}</p>
        </div>
        <div class="config-editor-actions">
          <button type="button" id="config-reset" :disabled="resetDisabled" @click="reset">{{ t('config.reset') }}</button>
          <button type="submit" class="primary" id="config-save" :disabled="saveDisabled">{{ t('config.save') }}</button>
        </div>
      </div>
      <p v-if="stateKey !== null" id="config-editor-state" class="banner warn">{{ t(stateKey) }}</p>

      <fieldset id="config-editor-fields" :disabled="!enabled">
        <legend>{{ t('config.behavior') }}</legend>
        <div class="config-fields">
          <label class="check-field">
            <input id="config-autonomous-input" v-model="form.autonomous" name="autonomous" type="checkbox" :aria-label="t('config.autonomous')" :disabled="!enabled" />
            <span>{{ t('config.autonomous') }}</span>
          </label>
          <label class="check-field">
            <input id="config-verify-cache-input" v-model="form.verifyCache" name="verify_cache" type="checkbox" :aria-label="t('config.verifyCache')" :disabled="!enabled" />
            <span>{{ t('config.verifyCache') }}</span>
          </label>
          <label>
            <span>{{ t('config.maxParallel') }}</span>
            <input id="config-max-parallel-input" v-model.number="form.maxParallelAgents" name="max_parallel_agents" type="number" min="1" step="1" required :aria-label="t('config.maxParallel')" :disabled="!enabled" />
          </label>
          <label>
            <span>{{ t('config.strikes') }}</span>
            <input id="config-strikes-input" v-model.number="form.noProgressStrikes" name="no_progress_strikes" type="number" min="1" step="1" required :aria-label="t('config.strikes')" :disabled="!enabled" />
          </label>
          <label>
            <span>{{ t('config.planApproval') }}</span>
            <select id="config-plan-gate-input" v-model="form.planApproval" name="plan_approval" :aria-label="t('config.planApproval')" :disabled="!enabled">
              <option value="human">{{ t('config.gateValue.human') }}</option>
              <option value="auto">{{ t('config.gateValue.auto') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('config.commitGate') }}</span>
            <select id="config-commit-gate-input" v-model="form.commit" name="commit" :aria-label="t('config.commitGate')" :disabled="!enabled">
              <option value="human">{{ t('config.gateValue.human') }}</option>
              <option value="auto">{{ t('config.gateValue.auto') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('config.preflightGate') }}</span>
            <select id="config-preflight-gate-input" v-model="form.preflight" name="preflight" :aria-label="t('config.preflightGate')" :disabled="!enabled">
              <option value="human">{{ t('config.gateValue.human') }}</option>
              <option value="auto">{{ t('config.gateValue.auto') }}</option>
            </select>
          </label>
        </div>
      </fieldset>

      <!-- Orchestration: `auto-plan`+`off` and `registry`+no-trusted-registry
           are each refused as a pair — see `orchestrationProblem` — so the two
           halves of each pair sit next to each other here. -->
      <fieldset :disabled="!enabled">
        <legend>{{ t('config.orchestration') }}</legend>
        <p class="hint">{{ t('config.orchestrationWhy') }}</p>
        <div class="config-fields">
          <label class="check-field">
            <input id="config-auto-accept-input" v-model="form.orchProfileAutoAccept" name="orch_profile_auto_accept" type="checkbox" :aria-label="t('config.autoAccept')" :disabled="!enabled" />
            <span>{{ t('config.autoAccept') }}</span>
          </label>
          <label>
            <span>{{ t('config.discoveryMode') }}</span>
            <select id="config-discovery-mode-input" v-model="form.orchDiscoveryMode" name="orch_discovery_mode" :aria-label="t('config.discoveryMode')" :disabled="!enabled">
              <option value="off">{{ t('config.discoveryValue.off') }}</option>
              <option value="ask">{{ t('config.discoveryValue.ask') }}</option>
              <option value="always">{{ t('config.discoveryValue.always') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('config.questionBudget') }}</span>
            <input id="config-question-budget-input" v-model.number="form.orchDiscoveryQuestionBudget" name="orch_discovery_question_budget" type="number" min="1" max="20" step="1" required :aria-label="t('config.questionBudget')" :disabled="!enabled" />
          </label>
          <label>
            <span>{{ t('config.discoveryCompletion') }}</span>
            <select id="config-discovery-completion-input" v-model="form.orchDiscoveryCompletion" name="orch_discovery_completion" :aria-label="t('config.discoveryCompletion')" :disabled="!enabled">
              <option value="auto-plan">{{ t('config.completionValue.autoPlan') }}</option>
              <option value="review">{{ t('config.completionValue.review') }}</option>
              <option value="save-only">{{ t('config.completionValue.saveOnly') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('config.afterPlanApproval') }}</span>
            <select id="config-after-approval-input" v-model="form.orchExecutionAfterPlanApproval" name="orch_execution_after_plan_approval" :aria-label="t('config.afterPlanApproval')" :disabled="!enabled">
              <option value="manual">{{ t('config.afterApprovalValue.manual') }}</option>
              <option value="auto">{{ t('config.afterApprovalValue.auto') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('config.uncertainConcurrency') }}</span>
            <select id="config-concurrency-input" v-model="form.orchExecutionUncertainConcurrency" name="orch_execution_uncertain_concurrency" :aria-label="t('config.uncertainConcurrency')" :disabled="!enabled">
              <option value="sequential">{{ t('config.concurrencyValue.sequential') }}</option>
              <option value="ask">{{ t('config.concurrencyValue.ask') }}</option>
              <option value="parallel">{{ t('config.concurrencyValue.parallel') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('config.repairAttempts') }}</span>
            <input id="config-repair-attempts-input" v-model.number="form.orchExecutionRepairAttempts" name="orch_execution_repair_attempts" type="number" min="0" max="5" step="1" required :aria-label="t('config.repairAttempts')" :disabled="!enabled" />
          </label>
          <label class="check-field">
            <input id="config-plan-review-input" v-model="form.orchQualityIndependentPlanReview" name="orch_quality_independent_plan_review" type="checkbox" :aria-label="t('config.independentPlanReview')" :disabled="!enabled" />
            <span>{{ t('config.independentPlanReview') }}</span>
          </label>
          <label class="check-field">
            <input id="config-independent-verify-input" v-model="form.orchQualityIndependentVerification" name="orch_quality_independent_verification" type="checkbox" :aria-label="t('config.independentVerification')" :disabled="!enabled" />
            <span>{{ t('config.independentVerification') }}</span>
          </label>
          <label class="check-field">
            <input id="config-source-github-input" v-model="form.orchSkillsSourceGithub" name="orch_skills_sources_github" type="checkbox" :aria-label="t('config.skillSource.github')" :disabled="!enabled" />
            <span>{{ t('config.skillSource.github') }}</span>
          </label>
          <label class="check-field">
            <input id="config-source-registry-input" v-model="form.orchSkillsSourceRegistry" name="orch_skills_sources_registry" type="checkbox" :aria-label="t('config.skillSource.registry')" :disabled="!enabled" />
            <span>{{ t('config.skillSource.registry') }}</span>
          </label>
          <label class="check-field">
            <input id="config-source-web-input" v-model="form.orchSkillsSourceWeb" name="orch_skills_sources_web" type="checkbox" :aria-label="t('config.skillSource.web')" :disabled="!enabled" />
            <span>{{ t('config.skillSource.web') }}</span>
          </label>
          <label>
            <span>{{ t('config.skillUpdateMode') }}</span>
            <select id="config-update-mode-input" v-model="form.orchSkillsUpdateMode" name="orch_skills_update_mode" :aria-label="t('config.skillUpdateMode')" :disabled="!enabled">
              <option value="review">{{ t('config.updateModeValue.review') }}</option>
              <option value="auto">{{ t('config.updateModeValue.auto') }}</option>
              <option value="pinned">{{ t('config.updateModeValue.pinned') }}</option>
            </select>
          </label>
        </div>
        <div class="config-fields config-fields-wide">
          <label>
            <span>{{ t('config.trustedRegistries') }}</span>
            <textarea id="config-registries-input" v-model="form.orchSkillsTrustedRegistries" name="orch_skills_trusted_registries" rows="3" dir="ltr" :aria-label="t('config.trustedRegistries')" :disabled="!enabled"></textarea>
          </label>
        </div>
        <p class="hint">{{ t('config.trustedRegistriesHelp') }}</p>
      </fieldset>

      <fieldset :disabled="!enabled">
        <legend>{{ t('config.verify') }}</legend>
        <p class="hint">{{ t('config.verifyWhy') }}</p>
        <div class="config-fields config-fields-wide">
          <label>
            <span>verify.test</span>
            <input id="config-test-input" v-model="form.verifyTest" name="verify_test" dir="ltr" autocomplete="off" :aria-label="t('config.verifyTestLabel')" :disabled="!enabled" />
          </label>
          <label>
            <span>verify.lint</span>
            <input id="config-lint-input" v-model="form.verifyLint" name="verify_lint" dir="ltr" autocomplete="off" :aria-label="t('config.verifyLintLabel')" :disabled="!enabled" />
          </label>
          <label>
            <span>verify.build</span>
            <input id="config-build-input" v-model="form.verifyBuild" name="verify_build" dir="ltr" autocomplete="off" :aria-label="t('config.verifyBuildLabel')" :disabled="!enabled" />
          </label>
          <label>
            <span>verify.timeout_ms</span>
            <input id="config-timeout-input" v-model.number="form.timeoutMs" name="timeout_ms" type="number" min="1" step="1" required :aria-label="t('config.timeoutLabel')" :disabled="!enabled" />
          </label>
          <label>
            <span>verify.lock_timeout_ms</span>
            <input id="config-lock-timeout-input" v-model.number="form.lockTimeoutMs" name="lock_timeout_ms" type="number" min="1" step="1" required :aria-label="t('config.lockTimeoutLabel')" :disabled="!enabled" />
          </label>
        </div>
      </fieldset>

      <fieldset :disabled="!enabled">
        <legend>{{ t('config.failurePatterns') }}</legend>
        <p class="hint">{{ t('config.failurePatternsHelp') }}</p>
        <div class="config-fields config-fields-wide">
          <label>
            <span>verify.failure_patterns.test</span>
            <textarea id="config-patterns-test-input" v-model="form.patternsTest" name="patterns_test" rows="3" dir="ltr" :aria-label="t('config.patternsTestLabel')" :disabled="!enabled"></textarea>
          </label>
          <label>
            <span>verify.failure_patterns.lint</span>
            <textarea id="config-patterns-lint-input" v-model="form.patternsLint" name="patterns_lint" rows="3" dir="ltr" :aria-label="t('config.patternsLintLabel')" :disabled="!enabled"></textarea>
          </label>
          <label>
            <span>verify.failure_patterns.build</span>
            <textarea id="config-patterns-build-input" v-model="form.patternsBuild" name="patterns_build" rows="3" dir="ltr" :aria-label="t('config.patternsBuildLabel')" :disabled="!enabled"></textarea>
          </label>
        </div>
      </fieldset>

      <!-- `draft` is passed through as-is, not defaulted to an empty
           document: `null` and "the document has zero specialists/tracks"
           are two different states `config.js` distinguishes on purpose, and
           collapsing them here would make an unparseable `config.yaml` read
           as a project with no rules at all. See `SpecialistEditor.vue`'s
           and `TrackEditors.vue`'s own comments. -->
      <SpecialistEditor :draft="draft" :agent-names="agentNames" :enabled="enabled" :mutate="mutate" />

      <TrackEditors :draft="draft" :baseline="baseline" :raw-text="rawText" :enabled="enabled" :mutate="mutate" />

      <datalist id="config-agent-names">
        <option v-for="name in agentNames" :key="name" :value="name"></option>
      </datalist>
    </form>

    <section class="block">
      <h2>{{ t('config.currentVerify') }}</h2>
      <dl class="facts" id="config-verify">
        <ConfigFactRow v-for="row in verifyRows" :key="row.key" :config-key="row.key" :value="row.value" />
      </dl>
    </section>

    <section class="block">
      <h2>{{ t('config.verifyPolicy') }}</h2>
      <p class="hint">{{ t('config.verifyPolicyWhy') }}</p>
      <dl class="facts" id="config-verify-policy">
        <ConfigFactRow v-for="row in policyRows_" :key="row.key" :config-key="row.key" :value="row.value" />
      </dl>
    </section>

    <section class="block" id="config-telemetry">
      <h2>{{ t('telemetry.title') }}</h2>
      <p class="hint">{{ t('telemetry.why') }}</p>
      <p v-if="telemetry !== null && telemetryRows.length === 0" id="telemetry-empty" class="empty">{{ t('telemetry.empty') }}</p>
      <p v-if="flagged.length > 0" id="telemetry-flagged" class="hint">
        <Tx :key-name="flaggedKey" :params="{ count: flagged.length, agents: flagged.join(', ') }" />
      </p>
      <div v-if="telemetryRows.length > 0" id="telemetry-table" class="scroller">
        <div class="grid grid-telemetry" role="table">
          <div class="grid-head" role="row">
            <span role="columnheader">{{ t('telemetry.agent') }}</span>
            <span role="columnheader">{{ t('telemetry.mode') }}</span>
            <span role="columnheader">{{ t('telemetry.drafted') }}</span>
            <span role="columnheader">{{ t('telemetry.skipped') }}</span>
            <span role="columnheader">{{ t('telemetry.landed') }}</span>
            <span role="columnheader">{{ t('telemetry.results') }}</span>
            <span role="columnheader">{{ t('telemetry.findings') }}</span>
            <span role="columnheader">{{ t('telemetry.runs') }}</span>
            <span role="columnheader">{{ t('telemetry.lastRun') }}</span>
          </div>
          <div id="telemetry-list" role="rowgroup" class="grid-body">
            <ConfigTelemetryRow v-for="row in telemetryRows" :key="row.agent" :row="row" />
          </div>
        </div>
      </div>
      <p v-if="telemetryTruncated > 0" id="telemetry-more" class="more">{{ tn('telemetry.truncated', telemetryTruncated) }}</p>
    </section>

    <details v-if="view?.raw !== null && view?.raw !== undefined" id="config-raw-details">
      <summary>{{ t('config.raw') }}</summary>
      <pre class="excerpt" id="config-raw"><Bdi :value="view?.raw ?? ''" /></pre>
    </details>
  </section>
</template>
