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
 * Edit, derive and delete all live outside this component now — `edit` calls
 * `useAgentEditor.ts`'s `openEdit`, `derive` calls its `openDerive`, and
 * `delete` calls `useAgentDelete.ts`'s `askDelete`, each of which freezes a
 * subject and flips a module-level `open` ref that `AgentEditor.vue`/
 * `AgentDeleteDialog.vue` — hosted in `App.vue`, outside `<KeepAlive>` — read.
 * A round-1 review found the previous shape wrong on two counts at once: an
 * inline `<dialog>` right here read `props.agent` — a *live* prop — at
 * confirm time, so a snapshot arriving while the confirmation sat open could
 * swap in a new digest before the button was ever pressed; and the `<dialog>`
 * itself lived inside the kept-alive `Agents` panel, so it lost its
 * top-layer state (backdrop, focus trap, `Escape`) the moment a tab switch
 * detached the panel's subtree. `askDelete(props.agent)` below copies
 * `name`/`digest` out of this card's prop into a fresh object the instant the
 * button is pressed — see `useAgentDelete.ts`'s own header for why that alone
 * already fixes the first defect, and why hosting the dialog outside
 * `<KeepAlive>` fixes the second.
 *
 * The skills block below rides `/api/skills` (`revisions.skills`) — the same
 * feed `Skills.vue` reads, fetched again here rather than lifted to
 * `Agents.vue` and passed down as a prop: `lib/api.ts`'s `feed()` already
 * dedups a repeated subscription to one path, so a second `useFeed` costs
 * nothing a shared one would not, and it keeps this card self-contained the
 * same way `usage(config, ...)` already reads `config` straight off its own
 * prop rather than a value `Agents.vue` would otherwise have to derive twice.
 * Only *active* acceptances get a row: a disabled one already routes to
 * nobody, and offering a checkbox for it would let this card change `agents`
 * on a record `mjloop-cli skills disable` has deliberately taken out of
 * rotation. A plugin agent gets no row at all — see the `v-if` on the block
 * below, which is the one place that decision is made.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usage } from '../lib/agents.js'
import { useAgentDelete } from '../composables/useAgentDelete.js'
import { useFeed } from '../composables/useFeed.js'
import type { AgentView, Config, SkillsView } from '../types/protocol.js'
import Bdi from './Bdi.vue'
import AgentSkillRow from './AgentSkillRow.vue'

const props = defineProps<{ agent: AgentView; config: Config | null }>()
const emit = defineEmits<{ edit: [agent: AgentView]; derive: [agent: AgentView] }>()
const { t } = useI18n()

const usedBy = computed(() => usage(props.config, props.agent.name))

const { askDelete } = useAgentDelete()

const skillsFeed = useFeed<SkillsView>({
  dep: (state) => state.revisions.skills,
  path: () => '/api/skills',
})
// Active only — see the header above for why a disabled acceptance offers
// no row here.
const routableSkills = computed(() => (skillsFeed.value.value?.acceptances ?? []).filter((entry) => entry.status === 'active'))
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
    <!-- A project agent may be routed a skill from here; a plugin agent may
         not — this project cannot edit the file that skill would run
         against, so no checkbox is offered for one at all. -->
    <div class="agent-skills" v-if="props.agent.source === 'project'">
      <h4>{{ t('agents.skills') }}</h4>
      <p class="empty" v-if="routableSkills.length === 0">{{ t('agents.skillsNone') }}</p>
      <AgentSkillRow v-for="entry in routableSkills" :key="entry.skillId" :entry="entry" :agent-name="props.agent.name" />
    </div>
    <div class="agent-actions" v-if="props.agent.source === 'project'">
      <button type="button" class="agent-edit" @click="emit('edit', props.agent)">{{ t('agents.edit') }}</button>
      <button type="button" class="danger agent-delete" @click="askDelete(props.agent)">{{ t('agents.delete') }}</button>
    </div>
    <div class="agent-actions" v-else>
      <button type="button" class="agent-derive" @click="emit('derive', props.agent)">{{ t('agents.copy') }}</button>
    </div>
  </div>
</template>
