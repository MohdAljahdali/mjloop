<script setup lang="ts">
/**
 * The `specialists:` fieldset — a structured editor over the draft's own
 * `specialists` map, ported from the two JSON textareas `config.js`'s own
 * header describes. Every control here writes through `mutate`, the one
 * function `Config.vue` hands down that is allowed to touch the draft; this
 * component never reaches the server.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { validAgent, type Draft } from '../lib/config.js'
import SpecialistRuleRow from './SpecialistRuleRow.vue'

const props = defineProps<{
  draft: Draft | null
  agentNames: string[]
  enabled: boolean
  mutate: (change: (model: Draft) => boolean | void) => void
}>()
const { t } = useI18n()

// `?? 'auto'` for the type checker rather than for the data: the keys come
// from this very object, so the lookup cannot miss — but an index signature
// says `string | undefined`.
const rules = computed(() => {
  const specialists = props.draft?.specialists
  if (specialists === undefined) return []
  return Object.keys(specialists)
    .sort()
    .map((agent) => ({ agent, mode: specialists[agent] ?? 'auto' }))
})

// `config.specialistsEmpty` says "no rules — the leader composes every cycle
// on its own", which is a claim about the *document*. A `draft === null`
// config never made that claim; it made none at all, because it never
// parsed. `config.js`'s own `drawStructured` keeps this hidden in exactly
// that case (`flag(specialistEmpty, 'hidden', true)` on its `model === null`
// branch) rather than defaulting to the empty-document message — see
// `Config.vue`'s own comment on why `draft === null` is carried rather than
// defaulted away.
const showEmpty = computed(() => props.draft !== null && rules.value.length === 0)

const newAgent = ref('')
function add(): void {
  const agent = newAgent.value.trim()
  if (!validAgent(agent)) return
  props.mutate((model) => {
    if (agent in model.specialists) return false
    model.specialists[agent] = 'auto'
  })
  newAgent.value = ''
}
function setMode(agent: string, mode: string): void {
  props.mutate((model) => {
    if (!(agent in model.specialists)) return false
    model.specialists[agent] = mode
  })
}
function remove(agent: string): void {
  props.mutate((model) => {
    if (!(agent in model.specialists)) return false
    delete model.specialists[agent]
  })
}
</script>

<template>
  <fieldset>
    <legend>{{ t('config.specialists') }}</legend>
    <p class="hint">{{ t('config.specialistsHelp') }}</p>
    <p v-if="showEmpty" id="config-specialists-empty" class="empty">{{ t('config.specialistsEmpty') }}</p>
    <div id="config-specialist-rules" class="rules">
      <SpecialistRuleRow
        v-for="rule in rules"
        :key="rule.agent"
        :agent="rule.agent"
        :mode="rule.mode"
        :enabled="props.enabled"
        @update:mode="(mode) => setMode(rule.agent, mode)"
        @remove="remove(rule.agent)"
      />
    </div>
    <div class="rule-add">
      <input
        id="config-specialist-new"
        v-model="newAgent"
        list="config-agent-names"
        dir="ltr"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('config.agentName')"
        :aria-label="t('config.agentName')"
        :disabled="!props.enabled"
        @keydown.enter.prevent="add"
      />
      <button type="button" :disabled="!props.enabled" @click="add">{{ t('config.add') }}</button>
    </div>
  </fieldset>
</template>
