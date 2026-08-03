<script setup lang="ts">
/**
 * The agent editor: `agent.update` when it opened on a project agent's own
 * "Edit", `agent.create` when it opened as a derived copy — one form, because
 * an update and a fresh copy differ only in whether `name` is fixed and
 * whether a digest travels with the write, not in what the form asks for.
 *
 * **Round-1 fix.** This used to live inside `Agents.vue`, remounted per open
 * via `:key`. A review caught that its header argued from the wrong rule: it
 * treated "no live document to re-check" as license to sit inside the
 * kept-alive panel, when the actual rule (`useHalt.ts`'s own comment,
 * repeated verbatim by `useFeatureApprove.ts`) is about the `<dialog>`
 * element's *top-layer state*, not about whether anything underneath it is
 * still moving. A native `<dialog>` opened with `showModal()` loses that
 * state — backdrop, focus trap, `Escape` — the instant its subtree detaches
 * on a tab switch, because nothing re-opens it on `onActivated`. So this
 * component now follows `HaltDialog.vue`'s own shape exactly: a single
 * always-mounted instance, hosted in `App.vue` outside `<KeepAlive>`, driven
 * by `useAgentEditor.ts`'s module-level `open`/`subject` rather than by a
 * `v-if`/`:key` pair inside the panel that opens it.
 *
 * One document, not a shared draft: every field here is a plain `ref`, reset
 * from `props.state.subject` exactly once per open, in the `watch(state)`
 * handler below — the same moment `HaltDialog.vue` resets its own `reason`
 * and `FeatureApproveDialog.vue` its own `note`. `Config.vue` needs
 * `mutate()`/`draft`/`dirty` because many controls accumulate changes into
 * one document before a single save; this form has exactly one control
 * surface and calls `submit()` exactly once, from exactly one place, the
 * moment it is pressed.
 *
 * **Round-3 fix.** `open` and `subject` used to be two separate props, and
 * this file carried a runtime guard for the case where a caller set one
 * without the other — reachable only by a bug in `useAgentEditor.ts`'s two
 * setters, never by anything this component itself could do, but a review
 * correctly called that a self-healing trap rather than a fix that made the
 * bad state impossible to represent. `AgentEditorState` is now one
 * discriminated union (`useAgentEditor.ts`), so `props.state.open === true`
 * is the only condition under which `.subject` even exists on the type — the
 * guard below is gone because the compiler, not a runtime check, is what
 * rules the invalid pair out.
 */
import { ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { validAgent } from '../lib/config.js'
import { copyName, hasContract } from '../lib/agents.js'
import { submit } from '../stores/session.js'
import type { AgentEditorState } from '../composables/useAgentEditor.js'

const props = defineProps<{ state: AgentEditorState }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialog = ref<HTMLDialogElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const descriptionInput = ref<HTMLTextAreaElement | null>(null)

// The subject this instance is currently showing, frozen at the moment the
// dialog opened — see the `watch` below, the same freeze `HaltDialog.vue`
// gives its own `subject` from `props.runId`.
const mode = ref<'update' | 'create'>('update')
const originalName = ref('')
const name = ref('')
const description = ref('')
const tools = ref('')
const model = ref('')
const body = ref('')

/**
 * The digest this editor was shown, held untouched from the moment it opened.
 * `writes.ts`'s own header states the rule this exists to satisfy: the
 * compare-and-swap is checked inside the store's lock, so re-fetching this
 * "to be sure" before sending would defeat the entire mechanism — it would
 * let a click land on words nobody actually read.
 */
const digest = ref('')

/** `AgentNameSchema`, mirrored client-side — `lib/config.ts:90`'s own comment: never authoritative. */
const nameProblem = ref(false)
/** The same treatment as `nameProblem` above — a round-2 review found the invalid-name guard left a visible reason, and this one, silently, did not. */
const descriptionProblem = ref(false)

watch(
  () => props.state,
  (current) => {
    if (!current.open) {
      dialog.value?.close()
      return
    }
    // `current.subject` exists on the type here — `AgentEditorState`'s
    // `open: true` member requires it — so there is no null case left to
    // guard against; see this file's own header.
    const subject = current.subject
    mode.value = subject.mode
    originalName.value = subject.agent.name
    name.value = subject.mode === 'create' ? copyName(subject.takenNames, subject.agent.name) : subject.agent.name
    description.value = subject.agent.description
    tools.value = subject.agent.tools ?? ''
    model.value = subject.agent.model ?? ''
    body.value = subject.agent.body
    digest.value = subject.agent.digest
    nameProblem.value = false
    descriptionProblem.value = false
    dialog.value?.showModal()
    // The field the action actually requires focus on: in `update` mode
    // `name` is read-only, so landing a keyboard user there first would
    // make them tab past a field they cannot act on before reaching one
    // they can — `HaltDialog.vue:59-61`'s own rule, ported. `create` mode
    // keeps `name` as the first stop: it is the one field seeded from a
    // guess (`copyName`) the operator is most likely to want to check first.
    ;(mode.value === 'update' ? descriptionInput : nameInput).value?.focus()
  },
)

function cancel(): void {
  emit('close')
}

/**
 * The snapshot broadcast precedes the write's own receipt (`stores/session.ts`'s
 * `submit()` docstring), so by the time a receipt arrives the page already
 * shows whatever the server decided — there is nothing left for this dialog
 * to hold open for, win or refuse. It closes the same way `HaltDialog.vue`
 * and `FeatureApproveDialog.vue` both close: unconditionally, once every
 * client-side guard below has already passed — not before. A round-1 review
 * caught the previous ordering emitting `close` *first*, which silently threw
 * away a freshly rewritten body behind a whitespace-only description: the
 * form was already destroyed by the time the guard ran. Both guards below run
 * ahead of `emit('close')` now. A round-2 review caught the remaining half of
 * that same defect: moving the guard ahead of the close preserved the form,
 * but the empty-description case still failed with no visible reason at
 * all — `descriptionProblem` gives it the identical treatment
 * `nameProblem` already had, a banner naming what is wrong rather than a
 * button that does nothing.
 */
function onSubmit(): void {
  const trimmedDescription = description.value.trim()
  if (trimmedDescription.length === 0) {
    descriptionProblem.value = true
    return
  }
  if (mode.value === 'create' && !validAgent(name.value)) {
    nameProblem.value = true
    return
  }
  emit('close')
  const trimmedTools = tools.value.trim()
  const trimmedModel = model.value.trim()
  if (mode.value === 'update') {
    submit({
      kind: 'agent.update',
      name: originalName.value,
      digest: digest.value,
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
      <h2>{{ mode === 'update' ? t('agents.editTitle') : t('agents.deriveTitle') }}</h2>
      <label>
        <span>{{ t('agents.name') }}</span>
        <input
          id="agent-name"
          ref="nameInput"
          v-model="name"
          name="name"
          required
          maxlength="64"
          dir="ltr"
          autocomplete="off"
          :readonly="mode === 'update'"
          @input="nameProblem = false"
        />
      </label>
      <p v-if="mode === 'create' && nameProblem" id="agent-name-problem" class="banner warn">{{ t('agents.nameInvalid') }}</p>
      <label>
        <span>{{ t('agents.description') }}</span>
        <textarea
          id="agent-description"
          ref="descriptionInput"
          v-model="description"
          name="description"
          rows="2"
          required
          maxlength="500"
          dir="auto"
          @input="descriptionProblem = false"
        ></textarea>
      </label>
      <p v-if="descriptionProblem" id="agent-description-problem" class="banner warn">{{ t('agents.descriptionRequired') }}</p>
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
        <button type="submit" class="primary" id="agent-editor-submit">{{ mode === 'update' ? t('agents.save') : t('agents.create') }}</button>
      </div>
    </form>
  </dialog>
</template>
