<script setup lang="ts">
/**
 * Raise one ceiling for one suspended run — `QualityDecisionDialog.vue`'s
 * sibling, and the second of the two doors that resume a run.
 *
 * **Only upward, and only one of four.** The field is a closed list
 * (`QualityBudgetFieldSchema`'s own four), the current value is displayed
 * rather than typed, and the new one is a `number` input whose `min` is the
 * current value plus one: a decrease is not a refused input here, it is an
 * input the form never offers. The reason is required — an amendment is a
 * record that a person decided to spend more, and one with no stated why is a
 * record of nothing. The mode is not a field at all: a run that changed modes
 * halfway would have no single policy its evidence was measured against.
 *
 * The `from` value is frozen at open (`useQualityDialogs.ts`) and travels on
 * the write, which is what makes this compare-and-swap: a ceiling that moved
 * while the dialog sat open is refused by `amendQualityBudget` rather than
 * quietly overwritten.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { submit } from '../stores/session.js'
import { QUALITY_BUDGET_FIELDS } from '../composables/useQuality.js'
import { resumeRun, type BudgetState, type BudgetSubject } from '../composables/useQualityDialogs.js'
import Bdi from './Bdi.vue'
import type { QualityBudgetField } from '../types/protocol.js'

const props = defineProps<{ state: BudgetState }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const toInput = ref<HTMLInputElement | null>(null)
const reasonInput = ref<HTMLTextAreaElement | null>(null)

const subject = ref<BudgetSubject | null>(null)
const field = ref<QualityBudgetField>('max_dispatches')
const to = ref<number | null>(null)
const reason = ref('')
/** The one refusal this form makes itself — shown beside the field, and announced by focusing it. */
const problem = ref<string | null>(null)

const from = computed(() => subject.value?.budget[field.value] ?? null)

let opener: HTMLElement | null = null

watch(
  () => props.state,
  (current) => {
    if (current.open) {
      opener = document.activeElement as HTMLElement | null
      subject.value = current.subject
      field.value = 'max_dispatches'
      to.value = null
      reason.value = ''
      problem.value = null
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
  const current = from.value
  const next = to.value
  const written = reason.value.trim()
  if (subject.value === null || current === null) return
  if (next === null || !Number.isInteger(next) || next <= current) {
    problem.value = 'quality.budgetIncreaseOnly'
    toInput.value?.focus()
    return
  }
  if (written.length === 0) {
    problem.value = 'quality.budgetReasonRequired'
    reasonInput.value?.focus()
    return
  }
  const run = subject.value.run
  const chosen = field.value
  emit('close')
  submit(
    { kind: 'quality.budget', run, field: chosen, from: current, to: next, reason: written },
    {
      settled(receipt) {
        if (receipt.ok) resumeRun()
      },
    },
  )
}
</script>

<template>
  <dialog id="quality-budget-dialog" ref="dialog" @cancel.prevent="cancel">
    <form id="quality-budget-form" method="dialog" @submit.prevent="confirm">
      <h2>{{ t('quality.budgetTitle') }}</h2>
      <p class="hint">{{ t('quality.budgetExplain') }}</p>

      <label>
        <span>{{ t('quality.budgetPick') }}</span>
        <select id="quality-budget-field" v-model="field" name="field">
          <option v-for="name in QUALITY_BUDGET_FIELDS" :key="name" :value="name">{{ t(`quality.budgetField.${name}`) }}</option>
        </select>
      </label>

      <!-- The ceiling as it stands, shown and never typed: it is the write's
           compare-and-swap half, so an operator who could edit it could write
           an amendment against a ceiling that was never there. -->
      <p class="record">
        <span>{{ t('quality.budgetFrom') }}</span>
        <span id="quality-budget-from"><Bdi :value="from === null ? '' : String(from)" /></span>
      </p>

      <label>
        <span>{{ t('quality.budgetTo') }}</span>
        <input
          id="quality-budget-to"
          ref="toInput"
          v-model.number="to"
          type="number"
          name="to"
          :aria-describedby="problem === null ? undefined : 'quality-budget-problem'"
          step="1"
          required
          :min="from === null ? 1 : from + 1"
        />
      </label>

      <label>
        <span>{{ t('quality.budgetReason') }}</span>
        <textarea
          id="quality-budget-reason"
          ref="reasonInput"
          v-model="reason"
          name="reason"
          rows="2"
          maxlength="2000"
          dir="auto"
          required
          :aria-describedby="problem === null ? undefined : 'quality-budget-problem'"
        ></textarea>
      </label>

      <!-- Not a live region. This page keeps exactly two (`Toasts.vue` and
           `Banners.vue` — see `discipline.test.ts`), and a third would
           double-announce every write receipt. The refusal is announced by
           *moving focus* to the field it is about, which carries this line as
           its description. -->
      <p v-if="problem !== null" id="quality-budget-problem" class="hint">{{ t(problem) }}</p>

      <div class="dialog-actions">
        <button id="quality-budget-cancel" ref="cancelButton" type="button" @click="cancel">{{ t('quality.cancel') }}</button>
        <button type="submit" class="primary">{{ t('quality.budgetSubmit') }}</button>
      </div>
    </form>
  </dialog>
</template>
