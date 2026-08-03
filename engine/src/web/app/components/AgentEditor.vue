<script setup lang="ts">
/**
 * The agent editor: `agent.update` when it opened on a project agent's own
 * "Edit", `agent.create` when it opened as a derived copy — one form, because
 * an update and a fresh copy differ only in whether `name` is fixed and
 * whether a digest travels with the write, not in what the form asks for.
 *
 * `AgentCard.vue`'s header asks the question this file answers: inline on the
 * card, or a dialog outside the kept-alive panel like `HaltDialog.vue` and
 * `FeatureApproveDialog.vue`? Those two live outside `<KeepAlive>` because the
 * document behind them keeps moving while they sit open — `FeatureApproveDialog`
 * re-reads the live brief at confirm time for exactly that reason — and a
 * panel swap would otherwise cut a subscription a still-open dialog depends on.
 * Nothing here re-reads anything: `digest` is a value this component was
 * *handed*, not a feed it watches, and the global rule above is explicit that
 * it must go back exactly as shown, never refreshed "to be sure". So there is
 * no live document whose subscription would break if this dialog's parent
 * panel were swapped out from under it, and `Agents.vue` mounting one of these
 * itself — rather than `App.vue` reaching past the panel boundary the way it
 * does for the other two — is the simpler, equally correct choice. It is also
 * the only choice this task's own test harness (`panel-agents.test.ts`, which
 * boots `Agents.vue` alone, never `App.vue`) can reach at all.
 *
 * One document, not a shared draft: every field here is a plain `ref` seeded
 * once from the `agent` prop at open time (`Agents.vue` gives this component a
 * fresh `:key` per open, so "seeded once" really does mean once). `Config.vue`
 * needs `mutate()`/`draft`/`dirty` because many controls accumulate changes
 * into one document before a single save; this form has exactly one control
 * surface and calls `submit()` exactly once, from exactly one place, the
 * moment it is pressed.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { copyName, hasContract } from '../lib/agents.js'
import { submit } from '../stores/session.js'
import type { AgentView } from '../types/protocol.js'

const props = defineProps<{
  mode: 'update' | 'create'
  /** The card this editor was opened from. Read once, below, at setup — never watched. */
  agent: AgentView
  /** Every name already in use — `create` mode seeds a free one from this. */
  takenNames: readonly string[]
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

// Seeded once from the prop this component was mounted with. `Agents.vue`
// remounts this component (via `:key`) on every open, so there is no second
// agent this instance will ever need to reseed for. `create` mode starts from
// `copyName`'s own free suggestion — `<source>-copy`, then `-2`, `-3` — rather
// than the source's own name, which a bare create would collide on immediately.
const name = ref(props.mode === 'create' ? copyName(props.takenNames, props.agent.name) : props.agent.name)
const description = ref(props.agent.description)
const tools = ref(props.agent.tools ?? '')
const model = ref(props.agent.model ?? '')
const body = ref(props.agent.body)

/**
 * The digest this editor was shown, held untouched from the moment it opened.
 * `writes.ts`'s own header states the rule this exists to satisfy: the
 * compare-and-swap is checked inside the store's lock, so re-fetching this
 * "to be sure" before sending would defeat the entire mechanism — it would
 * let a click land on words nobody actually read.
 */
const digest = props.agent.digest

// This instance is freshly mounted per open (`Agents.vue` keys it by the
// agent it opened on), so `showModal()` belongs in `onMounted` rather than
// behind a watched `open` prop the way `HaltDialog.vue`'s does — there is no
// "closed but present" state for this component to sit in.
onMounted(() => {
  dialog.value?.showModal()
  nameInput.value?.focus()
})

function cancel(): void {
  emit('close')
}

/**
 * The snapshot broadcast precedes the write's own receipt (`stores/session.ts`'s
 * `submit()` docstring), so by the time a receipt arrives the page already
 * shows whatever the server decided — there is nothing left for this dialog
 * to hold open for, win or refuse. It closes the same way `HaltDialog.vue`
 * and `FeatureApproveDialog.vue` both close: unconditionally, the instant the
 * button is pressed, before the outcome is known. A refusal still reaches the
 * reader — `settle()` announces every receipt, `ok` or not — it just does not
 * do it through this dialog staying open.
 */
function onSubmit(): void {
  const trimmedDescription = description.value.trim()
  emit('close')
  if (trimmedDescription.length === 0) return
  const trimmedTools = tools.value.trim()
  const trimmedModel = model.value.trim()
  if (props.mode === 'update') {
    submit({
      kind: 'agent.update',
      name: props.agent.name,
      digest,
      description: trimmedDescription,
      tools: trimmedTools.length === 0 ? null : trimmedTools,
      model: trimmedModel.length === 0 ? null : trimmedModel,
      body: body.value,
    })
  } else {
    submit({
      kind: 'agent.create',
      name: name.value,
      description: trimmedDescription,
      tools: trimmedTools.length === 0 ? null : trimmedTools,
      model: trimmedModel.length === 0 ? null : trimmedModel,
      body: body.value,
    })
  }
}
</script>

<template>
  <dialog id="agent-editor" ref="dialog" @cancel.prevent="cancel">
    <form id="agent-form" method="dialog" @submit.prevent="onSubmit">
      <h2>{{ props.mode === 'update' ? t('agents.editTitle') : t('agents.deriveTitle') }}</h2>
      <label>
        <span>{{ t('agents.name') }}</span>
        <input
          id="agent-name"
          ref="nameInput"
          v-model="name"
          name="name"
          required
          maxlength="64"
          pattern="[A-Za-z0-9_-]+"
          dir="ltr"
          autocomplete="off"
          :readonly="props.mode === 'update'"
        />
      </label>
      <label>
        <span>{{ t('agents.description') }}</span>
        <textarea id="agent-description" v-model="description" name="description" rows="2" required maxlength="500" dir="auto"></textarea>
      </label>
      <label>
        <span>{{ t('agents.tools') }}</span>
        <input id="agent-tools" v-model="tools" name="tools" maxlength="500" dir="ltr" autocomplete="off" />
      </label>
      <p class="hint">{{ t('agents.toolsHint') }}</p>
      <label>
        <span>{{ t('agents.model') }}</span>
        <input id="agent-model" v-model="model" name="model" maxlength="100" dir="ltr" autocomplete="off" />
      </label>
      <p class="hint">{{ t('agents.modelHint') }}</p>
      <label>
        <span>{{ t('agents.body') }}</span>
        <textarea id="agent-body" v-model="body" name="body" rows="12" required maxlength="100000" dir="ltr"></textarea>
      </label>
      <!-- `hasContract` reads live off the textarea's own model, so typing the
           contract in makes the warning disappear without a second submit. -->
      <p v-if="!hasContract(body)" id="agent-contract-warning" class="banner warn">{{ t('agents.contractWarning') }}</p>
      <div class="dialog-actions">
        <button type="button" id="agent-editor-cancel" @click="cancel">{{ t('agents.cancel') }}</button>
        <button type="submit" class="primary" id="agent-editor-submit">{{ props.mode === 'update' ? t('agents.save') : t('agents.create') }}</button>
      </div>
    </form>
  </dialog>
</template>
