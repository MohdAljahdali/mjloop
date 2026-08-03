<script setup lang="ts">
/**
 * The `tracks:` fieldset — one `TrackEditor.vue` card per track, ported from
 * `config.js`'s own `config-track-editors` host.
 *
 * `draft` is nullable and the fieldset is always rendered regardless: an
 * unparseable `config.yaml` empties the card list (nothing to draft cards
 * from) but does not remove the legend, the hint, the add box or the
 * warning — `index.html` ships this fieldset unconditionally, and
 * `config.js`'s `drawStructured` only ever empties `#config-track-editors`
 * on its `model === null` branch, never the section around it.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { NAME, type Draft } from '../lib/config.js'
import type { Config } from '../types/protocol.js'
import TrackEditor from './TrackEditor.vue'

const props = defineProps<{
  draft: Draft | null
  baseline: Config | null
  rawText: string | null
  enabled: boolean
  mutate: (change: (model: Draft) => boolean | void) => void
}>()
const { t } = useI18n()

const names = computed(() => (props.draft === null ? [] : Object.keys(props.draft.tracks).sort()))

const newTrack = ref('')
function add(): void {
  const name = newTrack.value.trim()
  if (!NAME.test(name)) return
  props.mutate((model) => {
    if (name in model.tracks) return false
    model.tracks[name] = { required: [], available: [], closing: [], order: [], max_cycles: 5 }
  })
  newTrack.value = ''
}
</script>

<template>
  <fieldset>
    <legend>{{ t('config.tracks') }}</legend>
    <p class="hint">{{ t('config.tracksHelp') }}</p>
    <div id="config-track-editors" class="track-editors">
      <template v-if="props.draft !== null">
        <TrackEditor
          v-for="name in names"
          :key="name"
          :name="name"
          :draft="props.draft"
          :baseline="props.baseline"
          :raw-text="props.rawText"
          :enabled="props.enabled"
          :mutate="props.mutate"
        />
      </template>
    </div>
    <div class="rule-add">
      <input
        id="config-track-new"
        v-model="newTrack"
        dir="ltr"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('config.trackName')"
        :aria-label="t('config.trackName')"
        :disabled="!props.enabled"
        @keydown.enter.prevent="add"
      />
      <button type="button" :disabled="!props.enabled" @click="add">{{ t('config.add') }}</button>
    </div>
    <p class="hint">{{ t('config.trackNewWarning') }}</p>
  </fieldset>
</template>
