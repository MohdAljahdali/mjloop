<script setup lang="ts">
/**
 * `tpl-decision`, ported: one question the interview asked, and what came
 * back.
 *
 * An unanswered question is a sentence, an answered one is the person's own
 * words — two different kinds of content in one slot, so the branch below
 * chooses which to draw rather than whether to.
 *
 * A recommendation the answer took is not worth a second line: the interview
 * very often records both, and they are then the same words, which would
 * render as the answer stated twice with nothing saying which is which. It is
 * worth a line when it was *not* taken, or when nothing has been decided yet
 * — and it is labelled either way, because an unlabelled sentence under an
 * answer reads as part of the answer.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import type { Decision } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ decision: Decision }>()

const { t } = useI18n()

const showRecommendation = computed(
  () => props.decision.recommendation !== null && props.decision.recommendation !== props.decision.answer,
)
</script>

<template>
  <div class="component">
    <h4 data-slot="question"><Bdi :value="decision.question" /></h4>
    <p data-slot="answer">
      <template v-if="decision.answer === null">{{ t('features.unanswered') }}</template>
      <Bdi v-else :value="decision.answer" />
    </p>
    <p class="hint" data-slot="recommendation" :hidden="!showRecommendation">
      {{ showRecommendation ? t('features.recommended', { what: decision.recommendation ?? '' }) : '' }}
    </p>
  </div>
</template>
