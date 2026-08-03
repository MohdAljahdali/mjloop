<script setup lang="ts">
/**
 * One agent, as a card. `Agents.vue` draws one of these per entry in both
 * `AgentsView.project` and `AgentsView.plugin` — the same component either
 * way, since the only thing that differs by source is which actions apply.
 *
 * `usage(config, agent.name)` is what turns "delete" from a gamble into a
 * decision: every track that names this agent shows up here, before any
 * button is pressed, because the server (`writes.ts`'s `agentUsedByTrack`)
 * refuses the delete for exactly the same reason.
 *
 * Edit and derive open `AgentEditor.vue` (see `Agents.vue`, which owns the one
 * instance every card shares); delete asks its own confirmation right here,
 * because the confirmation names *this* card's agent and digest and nothing
 * upstream needs to coordinate that. Its shape follows `HaltDialog.vue` and
 * `FeatureApproveDialog.vue`: a native `<dialog>` opened with `showModal()`,
 * so focus trapping, the backdrop and `Escape` are the browser's job, and the
 * subject (name, digest) is frozen the moment it opens rather than re-read at
 * confirm time — this write has no live document behind it to re-check
 * against, unlike the feature brief's.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usage } from '../lib/agents.js'
import { submit } from '../stores/session.js'
import type { AgentView, Config } from '../types/protocol.js'
import Bdi from './Bdi.vue'
import Tx from './Tx.vue'

const props = defineProps<{ agent: AgentView; config: Config | null }>()
const emit = defineEmits<{ edit: [agent: AgentView]; derive: [agent: AgentView] }>()
const { t } = useI18n()

const usedBy = computed(() => usage(props.config, props.agent.name))

const deleteDialog = ref<HTMLDialogElement | null>(null)

function askDelete(): void {
  deleteDialog.value?.showModal()
}

function cancelDelete(): void {
  deleteDialog.value?.close()
}

function confirmDelete(): void {
  deleteDialog.value?.close()
  submit({ kind: 'agent.delete', name: props.agent.name, digest: props.agent.digest })
}
</script>

<template>
  <div class="component" :data-agent="props.agent.name">
    <h3 data-slot="name"><Bdi :value="props.agent.name" /></h3>
    <p data-slot="description" dir="auto"><Bdi :value="props.agent.description" /></p>
    <dl class="facts">
      <div class="fact">
        <dt>{{ t('agents.tools') }}</dt>
        <!-- null means every tool, not "no tools" — the same reading
             `AgentDoc`'s own frontmatter gives an absent `tools:` line. -->
        <dd data-slot="tools"><template v-if="props.agent.tools === null">{{ t('agents.toolsAll') }}</template><Bdi v-else :value="props.agent.tools" /></dd>
      </div>
      <div class="fact">
        <dt>{{ t('agents.model') }}</dt>
        <dd data-slot="model"><template v-if="props.agent.model === null">{{ t('agents.modelDefault') }}</template><Bdi v-else :value="props.agent.model" /></dd>
      </div>
    </dl>
    <div class="agent-usage">
      <h4>{{ t('agents.usage') }}</h4>
      <p class="empty" v-if="usedBy.length === 0">{{ t('agents.usageNone') }}</p>
      <ul v-else class="detail">
        <li v-for="entry in usedBy" :key="`${entry.track}-${entry.list}`">
          <Bdi :value="entry.track" /> — {{ t(`agents.usage.${entry.list}`) }}
        </li>
      </ul>
    </div>
    <div class="agent-actions" v-if="props.agent.source === 'project'">
      <button type="button" class="agent-edit" @click="emit('edit', props.agent)">{{ t('agents.edit') }}</button>
      <button type="button" class="danger agent-delete" @click="askDelete">{{ t('agents.delete') }}</button>
    </div>
    <div class="agent-actions" v-else>
      <button type="button" class="agent-derive" @click="emit('derive', props.agent)">{{ t('agents.copy') }}</button>
    </div>

    <dialog v-if="props.agent.source === 'project'" class="agent-delete-dialog" ref="deleteDialog" @cancel.prevent="cancelDelete">
      <form method="dialog" @submit.prevent="confirmDelete">
        <h2>{{ t('agents.deleteConfirmTitle') }}</h2>
        <p class="hint">{{ t('agents.deleteConfirmExplain') }}</p>
        <p class="record"><Tx key-name="agents.deleteConfirmSubject" :params="{ name: props.agent.name }" /></p>
        <div class="dialog-actions">
          <button type="button" @click="cancelDelete">{{ t('agents.deleteCancel') }}</button>
          <button type="submit" class="danger">{{ t('agents.deleteConfirm') }}</button>
        </div>
      </form>
    </dialog>
  </div>
</template>
