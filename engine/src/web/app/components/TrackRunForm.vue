<script setup lang="ts">
/**
 * One track's own "run it" button — the thing `/mjloop:run` exists to make
 * true: a track built from this tab had nothing that could open it, because
 * the four existing commands each pin their own track name in their own
 * text.
 *
 * Same execution path as `Launcher.vue`'s command bar, not a second one:
 * `send({ type: 'enqueue', ... })`, then `pane.setView('queue')` so the
 * command does not vanish into an unwatched queue — see that file's own
 * header for why that second call matters.
 *
 * The goal input is uncontrolled for the identical reason `Launcher.vue`'s
 * is: no `v-model`, so a snapshot landing mid-sentence cannot touch what is
 * being typed. Read through the template ref only at submit time, and
 * cleared the same way.
 */
import { ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usePane } from '../composables/usePane.js'
import { send } from '../stores/session.js'

const props = defineProps<{ track: string; enabled: boolean }>()
const { t } = useI18n()
const pane = usePane()

const goalEl = ref<HTMLInputElement | null>(null)

function onSubmit(): void {
  const goal = goalEl.value?.value.trim() ?? ''
  // An empty or whitespace-only goal enqueues nothing — the same rule
  // `Launcher.vue`'s own `onSubmit` applies to a blank command line, so a
  // stray Enter on this card cannot queue a run with nothing to do.
  if (goal.length === 0) return
  send({ type: 'enqueue', command: `/mjloop:run ${props.track} ${goal}`, story: null })
  pane.setView('queue')
  if (goalEl.value !== null) goalEl.value.value = ''
}
</script>

<template>
  <form class="track-run" @submit.prevent="onSubmit">
    <input
      ref="goalEl"
      class="track-run-goal"
      type="text"
      :disabled="!props.enabled"
      :placeholder="t('config.run.goalPlaceholder')"
      :aria-label="t('config.run.goalLabel', { track: props.track })"
      autocomplete="off"
      spellcheck="false"
      dir="auto"
    />
    <button type="submit" class="track-run-submit" :disabled="!props.enabled">{{ t('config.run.button') }}</button>
  </form>
</template>
