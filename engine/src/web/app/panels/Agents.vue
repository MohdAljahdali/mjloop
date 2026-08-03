<script setup lang="ts">
/**
 * The Agents tab — every agent a run can draft, and where each one is used.
 *
 * `panels/Skills.vue`, ported to a narrower question: not what this project
 * has accepted, but what it can dispatch at all, and which tracks name it.
 * Project and plugin agents ride the same `/api/agents` feed
 * (`revisions.agents`) but are drawn in two separate sections rather than
 * merged — a project agent shadows a plugin one of the same name, and one
 * list would hide exactly that, the same call `Skills.vue`'s own header
 * makes about `AgentsView.project`/`.plugin`.
 *
 * `/api/config` (`revisions.config`) rides alongside it only so `AgentCard`
 * can call `usage(config, name)` — the track membership that makes deleting
 * an agent a decision rather than a gamble.
 *
 * This panel owns the one `AgentEditor.vue` instance every card shares:
 * `edit` opens it in `update` mode on the card's own agent, `derive` opens it
 * in `create` mode seeded from that agent but under a free name. `:key` below
 * forces a fresh instance on every open — including opening a second agent
 * while one is already open — so the editor's own fields, seeded once at
 * setup from its `agent` prop, are never asked to reseed themselves against a
 * document that changed out from under them. See `AgentEditor.vue`'s own
 * header for why this editor lives inside the panel rather than beside
 * `HaltDialog`/`FeatureApproveDialog` outside `<KeepAlive>`.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import type { AgentsView, AgentView, ConfigView } from '../types/protocol.js'
import AgentCard from '../components/AgentCard.vue'
import AgentEditor from '../components/AgentEditor.vue'
import Bdi from '../components/Bdi.vue'

const { t } = useI18n()

const agentsFeed = useFeed<AgentsView>({
  dep: (state) => state.revisions.agents,
  path: () => '/api/agents',
})
const agents = computed(() => agentsFeed.value.value)
// `readAgentsView` always answers with a body — an empty pair of directories
// and a project nothing has ever added an agent to both come back as empty
// arrays, never a 404 — so "settled" is simply "the feed has a value", the
// same reading `Skills.vue`'s `onDisk` block gives its own always-answering feed.
const answered = computed(() => agents.value !== null)
const project = computed(() => agents.value?.project ?? [])
const plugin = computed(() => agents.value?.plugin ?? [])
const unreadable = computed(() => agents.value?.unreadable ?? [])

const configFeed = useFeed<ConfigView>({
  dep: (state) => state.revisions.config,
  path: () => '/api/config',
})
// `usage()` takes the parsed document, not the wrapper — a config that is
// missing or fails to parse gives `usage()` `null`, which it already reads
// as "nothing names this agent" rather than throwing.
const config = computed(() => configFeed.value.value?.parsed ?? null)

// Every name already in use, project and plugin alike — `copyName`
// (`AgentEditor.vue`) needs the whole set, not just one side, since a derived
// copy must avoid shadowing *and* colliding either way.
const takenNames = computed(() => [...project.value, ...plugin.value].map((entry) => entry.name))

const editing = ref<{ mode: 'update' | 'create'; agent: AgentView } | null>(null)

function openEdit(agent: AgentView): void {
  editing.value = { mode: 'update', agent }
}

function openDerive(agent: AgentView): void {
  editing.value = { mode: 'create', agent }
}

function closeEditor(): void {
  editing.value = null
}
</script>

<template>
  <section id="panel-agents" class="panel" aria-labelledby="panel-agents-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-agents-title">{{ t('panel.agents.title') }}</h1>
        <p class="hint">{{ t('panel.agents.help') }}</p>
      </div>
    </header>

    <section class="block">
      <h2>{{ t('agents.project') }}</h2>
      <p class="hint">{{ t('agents.projectWhy') }}</p>
      <p class="empty" id="agents-project-empty" :hidden="!answered || project.length > 0">{{ t('agents.projectNone') }}</p>
      <div id="agents-project">
        <AgentCard v-for="agent in project" :key="agent.name" :agent="agent" :config="config" @edit="openEdit" @derive="openDerive" />
      </div>
    </section>

    <section class="block">
      <h2>{{ t('agents.plugin') }}</h2>
      <p class="hint">{{ t('agents.pluginWhy') }}</p>
      <p class="empty" id="agents-plugin-empty" :hidden="!answered || plugin.length > 0">{{ t('agents.pluginNone') }}</p>
      <div id="agents-plugin">
        <AgentCard v-for="agent in plugin" :key="agent.name" :agent="agent" :config="config" @edit="openEdit" @derive="openDerive" />
      </div>
    </section>

    <section class="block">
      <h2>{{ t('agents.unreadable') }}</h2>
      <p class="hint">{{ t('agents.unreadableWhy') }}</p>
      <!-- `entry.path` is a basename already — `readAgentsView` never hands
           this page an absolute path to begin with, so there is nothing to
           redact here. -->
      <div id="agents-unreadable">
        <p class="banner warn" v-for="entry in unreadable" :key="entry.path"><Bdi :value="entry.path" /></p>
      </div>
    </section>

    <!-- `:key` forces a fresh instance per open — see this file's own header. -->
    <AgentEditor
      v-if="editing !== null"
      :key="`${editing.mode}-${editing.agent.name}-${editing.agent.digest}`"
      :mode="editing.mode"
      :agent="editing.agent"
      :taken-names="takenNames"
      @close="closeEditor"
    />
  </section>
</template>
