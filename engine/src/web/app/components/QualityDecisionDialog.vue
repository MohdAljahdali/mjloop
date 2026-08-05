<script setup lang="ts">
/**
 * The button a person presses to approve — or refuse — an irreversible
 * operation. `AgentDeleteDialog.vue`, ported to `useQualityDialogs.ts`.
 *
 * **No browser-side authority.** The run and the operation fingerprint are
 * displayed and submitted; there is no field for either, and no code path here
 * composes one. The decision this dialog can send is the decision it is showing
 * and nothing else — and because the subject is frozen at open
 * (`useQualityDialogs.ts`), a feed that swaps the pending request underneath
 * cannot re-aim it either. If the operation *has* moved, `decideDestructiveRequest`
 * refuses the write on the fingerprint it no longer matches, and the ordinary
 * stale-write notice says so; nothing is half-decided.
 *
 * **The operation is verbatim.** `web/read.ts` redacts a target's path and
 * deliberately leaves `operation` byte-exact — approving an abridged operation
 * would be approving something other than what runs — so it is printed as-is,
 * inside a `<code><bdi>` that cannot drag the sentence around it in Arabic.
 *
 * **Nothing is preselected.** Approve and Reject are two radios with no default
 * and a submit that stays disabled until one is chosen: the one thing worse
 * than the wrong decision here is a decision nobody made.
 *
 * A resume is sent only on an accepted receipt — see `confirm()`.
 */
import { ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { submit } from '../stores/session.js'
import { resumeRun, type DecisionState, type DecisionSubject } from '../composables/useQualityDialogs.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ state: DecisionState }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)

/** Frozen at open — see `useQualityDialogs.ts`. */
const subject = ref<DecisionSubject | null>(null)
const choice = ref<'approve' | 'reject' | null>(null)
const note = ref('')

/**
 * Where the keyboard came from, so it can be given back. A native modal
 * `<dialog>` restores focus itself in a browser; this restores it explicitly
 * because the same guarantee has to hold for the button that opened it even
 * when the dialog closes from a write rather than from `Escape`.
 */
let opener: HTMLElement | null = null

watch(
  () => props.state,
  (current) => {
    if (current.open) {
      opener = document.activeElement as HTMLElement | null
      subject.value = current.subject
      choice.value = null
      note.value = ''
      // `showModal()`, never `show()`: the focus trap, the backdrop and the
      // inertness of the page behind it are the browser's own.
      dialog.value?.showModal()
      cancelButton.value?.focus()
    } else {
      dialog.value?.close()
      opener?.focus()
      opener = null
    }
  },
)

function cancel(): void {
  emit('close')
}

function confirm(): void {
  const frozen = subject.value
  const decision = choice.value
  if (frozen === null || decision === null) return
  emit('close')
  const written = note.value.trim()
  submit(
    { kind: 'quality.decision', run: frozen.run, fingerprint: frozen.fingerprint, decision, note: written.length === 0 ? null : written },
    {
      settled(receipt) {
        // Only on an accepted receipt. A refused decision changed nothing, and
        // typing a resume into the terminal after one would restart a run the
        // engine is still holding.
        if (receipt.ok) resumeRun()
      },
    },
  )
}
</script>

<template>
  <dialog id="quality-decision-dialog" ref="dialog" @cancel.prevent="cancel">
    <form id="quality-decision-form" method="dialog" @submit.prevent="confirm">
      <h2>{{ t('quality.decisionTitle') }}</h2>
      <p class="hint">{{ t('quality.decisionExplain') }}</p>

      <dl v-if="subject !== null" class="facts">
        <div class="fact">
          <dt>{{ t('quality.decisionKindLabel') }}</dt>
          <dd>{{ t(`quality.decisionKind.${subject.kind}`) }}</dd>
        </div>
        <div class="fact">
          <dt>{{ t('quality.decisionOperation') }}</dt>
          <dd><code id="quality-decision-operation"><Bdi :value="subject.operation" /></code></dd>
        </div>
        <div class="fact">
          <dt>{{ t('quality.decisionTargets') }}</dt>
          <dd>
            <ul id="quality-decision-targets" class="quality-targets">
              <li v-for="target in subject.targets" :key="target"><code><Bdi :value="target" /></code></li>
            </ul>
          </dd>
        </div>
        <div v-if="subject.rollback !== null" class="fact">
          <dt>{{ t('quality.decisionRollback') }}</dt>
          <dd><Bdi :value="subject.rollback" /></dd>
        </div>
      </dl>
      <!-- What a rejection would mean: nothing to undo, or a revert somebody
           has to perform. The two are different decisions. -->
      <p v-if="subject !== null" id="quality-decision-applied" class="hint">
        {{ t(subject.applied ? 'quality.decisionApplied' : 'quality.decisionNotApplied') }}
      </p>

      <fieldset class="quality-choice">
        <legend>{{ t('quality.decisionChoice') }}</legend>
        <label>
          <input id="quality-decision-approve" v-model="choice" type="radio" name="quality_decision" value="approve" />
          <span>{{ t('quality.decisionApprove') }}</span>
        </label>
        <label>
          <input id="quality-decision-reject" v-model="choice" type="radio" name="quality_decision" value="reject" />
          <span>{{ t('quality.decisionReject') }}</span>
        </label>
      </fieldset>

      <label>
        <span>{{ t('quality.decisionNote') }}</span>
        <input id="quality-decision-note" v-model="note" name="note" maxlength="2000" dir="auto" autocomplete="off" />
      </label>

      <div class="dialog-actions">
        <button id="quality-decision-cancel" ref="cancelButton" type="button" @click="cancel">{{ t('quality.cancel') }}</button>
        <button type="submit" class="danger" :disabled="choice === null">{{ t('quality.decisionSubmit') }}</button>
      </div>
    </form>
  </dialog>
</template>
