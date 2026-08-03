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
 * No button here is wired to a write yet — this task is read-only by
 * contract. The editor (project agents: edit, delete) and the copy-on-write
 * path (plugin agents: derive a copy, via `copyName`) both land in a later
 * task; these buttons are `disabled` placeholders for exactly what they will
 * become, not a fifth thing this task quietly finished early.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usage } from '../lib/agents.js'
import type { AgentView, Config } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ agent: AgentView; config: Config | null }>()
const { t } = useI18n()

const usedBy = computed(() => usage(props.config, props.agent.name))
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
      <button type="button" disabled>{{ t('agents.edit') }}</button>
      <button type="button" class="danger" disabled>{{ t('agents.delete') }}</button>
    </div>
    <div class="agent-actions" v-else>
      <button type="button" disabled>{{ t('agents.copy') }}</button>
    </div>
  </div>
</template>
