<script setup lang="ts">
/**
 * One `orchestration.quality.mode` choice, as a card.
 *
 * A native radio input inside the card, not an ARIA-only widget:
 * arrow-key selection, the group's single tab stop, its roving focus and the
 * "radio, checked, 2 of 3" a screen reader announces are all the browser's
 * own, and reimplementing them is how they end up subtly wrong.
 *
 * The radio carries an explicit `aria-label` because the `<label>` wraps the
 * whole card — without it the accessible name would swallow the trade-off
 * sentence too, and the sentence is a *description*, which is what
 * `aria-describedby` says it is.
 *
 * Both `change` and `click` emit the same one choice. A pointer and an arrow
 * key each raise both, and the emit is idempotent — it names the mode rather
 * than reading `checked` back — so the pair is one intent, not two.
 *
 * The recommendation is a word on the card and a word in the name, never a
 * colour: `Recommended` reads the same to a screen reader and on a monochrome
 * screen. It is a label and nothing else — this card never selects itself.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import type { QualityMode } from '../lib/config.js'

const props = defineProps<{
  mode: QualityMode
  checked: boolean
  name: string
  recommended: boolean
  disabled: boolean
}>()

const emit = defineEmits<{ select: [QualityMode] }>()

const { t } = useI18n()

const label = computed(() => t(`config.qualityValue.${props.mode}`))
const accessibleName = computed(() =>
  props.recommended ? t('config.qualityRecommendedFor', { mode: label.value }) : label.value,
)
const helpId = computed(() => `config-quality-help-${props.mode}`)
</script>

<template>
  <label class="quality-card" :data-quality-card="mode" :data-selected="checked">
    <input
      class="quality-radio"
      type="radio"
      :name="name"
      :value="mode"
      :checked="checked"
      :disabled="disabled"
      :data-quality-mode="mode"
      :aria-label="accessibleName"
      :aria-describedby="helpId"
      @change="emit('select', mode)"
      @click="emit('select', mode)"
    />
    <span class="quality-card-body">
      <span class="quality-card-title">
        <span class="quality-card-name">{{ label }}</span>
        <span v-if="recommended" class="tag recommended">{{ t('config.qualityRecommended') }}</span>
      </span>
      <span :id="helpId" class="quality-card-help">{{ t(`config.qualityHelp.${mode}`) }}</span>
    </span>
  </label>
</template>
