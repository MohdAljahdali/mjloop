<script setup lang="ts">
/**
 * The feature-approval confirmation: `ui/dialog.js` + `panels/features.js`'s
 * `ask`/`dismiss`/`confirm`, ported.
 *
 * The one control on the Features panel that gets a confirmation, and for a
 * reason `plans.js`'s gate decision does not have: `approveFeatureBrief`
 * refuses to touch an approved revision ever again, so unlike a plan gate
 * there is no re-decision and no undo to offer — `Features.vue`'s own file
 * comment, and `stores/session.ts`'s `settle()` bears it out: a write
 * submitted with no `undo` announces its result with nothing to press.
 *
 * A native `<dialog>` opened with `showModal()` — `HaltDialog.vue`'s own
 * shape, and this component's, for the same reason: focus trapping, the
 * backdrop, `Escape` and inertness of the rest of the page are the browser's
 * job, not this component's.
 *
 * **The write is re-checked live, not from a frozen subject.** The subject
 * line is read once, when the dialog opens, purely to say what is about to
 * become permanent — the same as `panels/features.js:ask()`. But the feed
 * behind `lib/featuredoc.ts` keeps running while the dialog sits open, so the
 * brief on screen behind it can be approved elsewhere, or gain another
 * decision, before the reader presses confirm. `confirm()` below re-reads the
 * live document and re-runs `approvable()` against it — the digest carried on
 * the write would refuse a stale one either way, but this avoids sending a
 * frame whose answer is already known, exactly as `panels/features.js:confirm()`
 * reasoned about its own re-check.
 */
import { ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { approvable } from '../lib/features.js'
import { value as featureDocValue } from '../lib/featuredoc.js'
import { submit } from '../stores/session.js'
import Tx from './Tx.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
const noteInput = ref<HTMLInputElement | null>(null)
// Written once, on open, by a user action — never by a renderer, the same
// contract `HaltDialog.vue`'s own `reason` keeps.
const note = ref('')

/**
 * What the confirmation sentence names — read once, when the dialog opens,
 * from the same document `confirm()` below re-reads live. Freezing this
 * (rather than binding the sentence to the feed directly) matches the old
 * page: `ask()` wrote the subject once with `phrase()`, and nothing repainted
 * it while the dialog stayed open.
 */
const subject = ref<{ id: string; revision: number; n: number } | null>(null)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      const view = featureDocValue()
      subject.value = view === null ? null : { id: view.brief.id, revision: view.brief.revision, n: view.brief.acceptance.length }
      note.value = ''
      dialog.value?.showModal()
      noteInput.value?.focus()
    } else {
      dialog.value?.close()
    }
  },
)

function cancel(): void {
  emit('close')
}

function confirm(): void {
  const view = featureDocValue()
  emit('close')
  if (!approvable(view).can || view === null) return
  const written = note.value.trim()
  submit({
    kind: 'feature.approve',
    feature: view.brief.id,
    revision: view.brief.revision,
    // What the screen the decision was made from actually said. A draft
    // holds one revision number for the whole of its editable life, so the
    // digest — not the revision — is the field that moves when the words do.
    digest: view.digest,
    note: written.length === 0 ? null : written,
  })
}
</script>

<template>
  <dialog id="feature-dialog" ref="dialog" @cancel.prevent="cancel">
    <form id="feature-form" method="dialog" @submit.prevent="confirm">
      <h2>{{ t('features.confirmTitle') }}</h2>
      <p class="hint">{{ t('features.confirmExplain') }}</p>
      <p class="record" id="feature-dialog-subject">
        <!-- `revision` stays a number: it travels the old page's
             `renderParam` path, exactly as `Features.vue`'s own comment on
             `features.record.*` explains — see the AN rule in
             `lib/i18n.ts`'s `renderParam()` docstring for why that path,
             not any particular digit shape, is what a number is kept for.
             `id` is the Latin brief id, which does need `Tx`'s isolation. -->
        <Tx v-if="subject !== null" key-name="features.confirmSubject" :params="{ id: subject.id, revision: subject.revision, n: subject.n }" />
      </p>
      <label>
        <span>{{ t('features.note') }}</span>
        <input id="feature-note" ref="noteInput" v-model="note" name="note" maxlength="2000" dir="auto" autocomplete="off" />
      </label>
      <div class="dialog-actions">
        <button type="button" @click="cancel">{{ t('features.cancel') }}</button>
        <button type="submit" class="primary">{{ t('features.confirm') }}</button>
      </div>
    </form>
  </dialog>
</template>
