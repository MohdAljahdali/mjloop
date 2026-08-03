<script setup lang="ts">
/**
 * Tracks — the structured half of `config.yaml`: `specialists:` and
 * `tracks:`. Split out of `Config.vue` in the task that split
 * `collectConfigChanges` into `collectSettingsChanges`/`collectTrackChanges`
 * — see `lib/config.ts`'s own header for why the split line runs exactly
 * where `draft` stops being read alongside `form`.
 *
 * This panel reads the same `/api/config` feed and the same revision
 * `Config.vue` does, and seeds its own independent `baseline`/`draft`/
 * `editorRevision`/`conflict` from it — two editors, one document. That is
 * also why this panel cannot skip the revision-conflict machinery `Config.vue`
 * already carries just because its own half of the document "only" touches
 * `specialists:`/`tracks:`: a save from this tab still carries the revision
 * the *other* tab's edits might have already moved past, and the server's
 * own `write.stale.config` refusal is what stops either tab's write from
 * silently clobbering a change the other tab made first. See
 * `panel-tracks.test.ts`'s own two-tab test for the write this protects.
 *
 * **The invariant this panel exists to protect**: every control on this page
 * writes to `draft` and nothing else. `mutate()` below is the one function
 * allowed to touch `draft`; `save()` is the one function that ever calls
 * `submit()`, and it is the only place `collectTrackChanges` is called
 * outside a test. No child component imports `submit` or `feed` —
 * `SpecialistEditor.vue` and every track-card component only ever receive
 * `mutate` as a prop and call it.
 *
 * `specialists:` and `tracks:` were two JSON textareas before the Vue
 * rewrite. The DOM seam that needed — hidden `*_json` fields feeding the
 * collector — does not exist here: `draft` below is already the object
 * `collectTrackChanges` reads, because Vue's own reactivity is the seam.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { submit } from '../stores/session.js'
import { broken, collectTrackChanges, knownAgents, seedDraft, type Draft } from '../lib/config.js'
import type { Config, ConfigView } from '../types/protocol.js'
import SpecialistEditor from '../components/SpecialistEditor.vue'
import TrackEditors from '../components/TrackEditors.vue'

const { t } = useI18n()

const configFeed = useFeed<ConfigView>({ dep: (state) => state.revisions.config, path: () => '/api/config' })
const view = computed(() => configFeed.value.value)
const parsed = computed(() => view.value?.parsed ?? null)
const enabled = computed(() => parsed.value !== null && view.value?.revision != null)

/** The document this editor was last seeded from, and its own revision hash. */
const baseline = ref<Config | null>(null)
const editorRevision = ref<string | null>(null)
/** `config.yaml`'s own text for that same revision — see `trackCommentLoss`'s only caller, `TrackEditor.vue`. */
const rawText = ref<string | null>(null)

const dirty = ref(false)
const saving = ref(false)
const conflict = ref(false)

const draft = ref<Draft | null>(null)

// Same reseed guard `Config.vue` carries, and the same reason an epoch
// counter is not needed beside it — see that file's own comment. A revision
// that moves while this tab is dirty shows the conflict banner rather than
// clobbering the draft, exactly the same as it does there; the two panels
// share the rule because they share the document.
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
  },
  { immediate: true },
)

function markDirty(): void {
  if (!enabled.value) return
  dirty.value = true
}

/**
 * A draft mutation: apply it and mark dirty. Every structured editor action
 * goes through here — the one place "the draft moved" and "the tab is
 * dirty" cannot disagree. See this file's own header.
 */
function mutate(change: (model: Draft) => boolean | void): void {
  if (!enabled.value || draft.value === null) return
  if (change(draft.value) === false) return
  markDirty()
}

const agentNames = computed(() => (draft.value === null ? [] : knownAgents(draft.value)))

/** Why the editor banner is showing — unavailable/invalid first, then a conflicting revision, mirroring `Config.vue`'s own `stateKey` priority minus the orchestration refusals, which are that panel's own half. */
const stateKey = computed<string | null>(() => {
  if (!enabled.value) return view.value?.invalid === true ? 'config.editorInvalid' : 'config.editorUnavailable'
  if (conflict.value) return 'config.editorChanged'
  return null
})

const saveDisabled = computed(() => !enabled.value || !dirty.value || saving.value || conflict.value || broken(draft.value))
const resetDisabled = computed(() => !enabled.value || (!dirty.value && !conflict.value) || saving.value)

const formEl = ref<HTMLFormElement | null>(null)

function save(): void {
  if (!enabled.value || baseline.value === null || editorRevision.value === null || saving.value || conflict.value) return
  // `TrackEditor.vue`'s `max_cycles` box is `required min="1"` — the one
  // native-validated control this half of the document carries. `Config.vue`
  // gates on this same check; a form with no such gate lets an empty or
  // out-of-range required box sit on screen with Save enabled, silently
  // sending whatever `onCyclesChange` last accepted rather than the value
  // the box currently (and visibly) shows.
  // `TrackEditor.vue`'s `max_cycles` box is `required min="1"` — the one
  // native-validated control this half of the document carries. `Config.vue`
  // gates on this same check; a form with no such gate lets an empty or
  // out-of-range required box sit on screen with Save enabled, silently
  // sending whatever `onCyclesChange` last accepted rather than the value
  // the box currently (and visibly) shows.
  if (formEl.value !== null && !formEl.value.reportValidity()) return
  if (draft.value === null) return
  const changes = collectTrackChanges(draft.value, baseline.value)
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
  dirty.value = false
  conflict.value = false
}
</script>

<template>
  <section id="panel-tracks" class="panel" aria-labelledby="panel-tracks-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-tracks-title">{{ t('panel.tracks.title') }}</h1>
        <p class="hint">{{ t('panel.tracks.help') }}</p>
      </div>
    </header>

    <form id="tracks-editor" ref="formEl" class="config-editor" @submit.prevent="save" @input="markDirty" @change="markDirty">
      <div class="config-editor-head">
        <div>
          <h2>{{ t('config.tracksEditorTitle') }}</h2>
          <p class="hint">{{ t('config.tracksEditorHelp') }}</p>
        </div>
        <div class="config-editor-actions">
          <button type="button" id="tracks-reset" :disabled="resetDisabled" @click="reset">{{ t('config.reset') }}</button>
          <button type="submit" class="primary" id="tracks-save" :disabled="saveDisabled">{{ t('config.save') }}</button>
        </div>
      </div>
      <p v-if="stateKey !== null" id="tracks-editor-state" class="banner warn">{{ t(stateKey) }}</p>

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
  </section>
</template>
