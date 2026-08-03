<script setup lang="ts">
/**
 * The command bar — `panels/launcher.js`, ported.
 *
 * Every button on this page that starts work ends up here: it composes a
 * loop command and enqueues it. There is one execution model, not a second,
 * weaker one beside it.
 *
 * The input is **uncontrolled**, on purpose, the same as the old page: no
 * `v-model`, so a snapshot arriving mid-sentence cannot touch what is being
 * typed. Read through a template ref only at submit time, and cleared the
 * same way — the one write to `.value` anywhere in this component, and it
 * happens because the reader pressed Run.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usePane } from '../composables/usePane.js'
import { ready } from '../lib/stories.js'
import { send, snapshot } from '../stores/session.js'

const { t } = useI18n()
const pane = usePane()

const inputEl = ref<HTMLInputElement | null>(null)

/** A long list caps rather than virtualises — `ui/list.js`'s own rule. `launcher.js:64` capped this datalist at 50. */
const SUGGESTIONS_CAP = 50

/**
 * The build commands worth suggesting: the stories that are actually ready.
 *
 * "Actually ready" is `lib/stories.ts`'s rule, not a second copy of it — a
 * datalist offering a build the Plans panel refuses is the bug this shares
 * the rule to avoid.
 */
const suggestions = computed(() =>
  ready(snapshot.value?.plans ?? [])
    .map((story) => `/mjloop:build ${story.id}`)
    .slice(0, SUGGESTIONS_CAP),
)

function onSubmit(): void {
  const command = inputEl.value?.value.trim() ?? ''
  if (command.length === 0) return
  send({ type: 'enqueue', command, story: null })
  // Show what just happened to it. A command that vanishes into an unseen
  // queue is the single most common way this page used to look broken.
  pane.setView('queue')
  if (inputEl.value !== null) inputEl.value.value = ''
}
</script>

<template>
  <form class="command" id="command-form" @submit.prevent="onSubmit">
    <input
      id="command"
      ref="inputEl"
      name="command"
      list="command-suggestions"
      :placeholder="t('command.placeholder')"
      :aria-label="t('command.label')"
      autocomplete="off"
      spellcheck="false"
      dir="auto"
    />
    <datalist id="command-suggestions">
      <option v-for="command in suggestions" :key="command" :value="command">{{ command }}</option>
    </datalist>
    <button type="submit">{{ t('command.run') }}</button>
  </form>
</template>
