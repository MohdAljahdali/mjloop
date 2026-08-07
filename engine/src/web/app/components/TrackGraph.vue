<script setup lang="ts">
/**
 * TrackGraph — one track's agents and order constraints, drawn with
 * `@vue-flow/core` over the pure geometry `lib/trackgraph.ts` already
 * computes. Ported into the graph view `Tracks.vue`'s header promises
 * beside the list, never in place of it — see that file's own comment on
 * `view` for why the list stays reachable.
 *
 * Purely presentational, and purely an emitter: it takes `:track`, `:name`
 * and `:agents`, turns `layout(track)` into Vue Flow's own node/edge shape
 * at the fixed coordinates `{ x: index * 260, y: layer * 170 }` — a wave is
 * a *row* now, growing downward as the track's layers advance, and a
 * layer's own agents spread left-to-right across it by `index` — and
 * reports every drag, edge deletion, node deletion and node/pane click
 * upward as `connect`/`disconnect`/`remove`/`select` (Task 4). It never
 * imports `mutate` or `submit`
 * and holds no draft of its own — `Tracks.vue` remains the sole owner of
 * `mutate`, exactly as it does for every list control on this panel
 * (`Tracks.vue`'s own header), and is the only listener wired to these
 * three events. A connect is therefore refused or applied by `Tracks.vue`
 * itself — the one place that already holds both `mutate` and the draft
 * `wouldCycle` needs to check against — rather than a second, independent
 * copy of that check living here.
 *
 * `:agents` feeds `cardInfo` (`lib/agentcard.ts`) so every node can draw a
 * rich card — description, tools, model, role badge — instead of a bare
 * name box. `cardInfo` never throws and answers a name no definition file
 * provides with an all-empty card whose `source` is `null`; that card is
 * still drawn, as `.node-missing`, because a track that names an agent with
 * no definition is exactly the state a reader most needs to see, not one
 * this view is allowed to hide.
 *
 * `:live` (Task 5) is the same kind of pass-through as `:agents`: a plain
 * `Record<agent, LiveStatus>` (or `null`) this component only reads, never
 * computes. It cannot compute it itself — that would need the `snapshot`
 * store, and this component's own "purely an emitter" promise above is
 * specifically that it never imports `submit`, `feed` or `snapshot` — so
 * `Tracks.vue` derives the map once per track and hands it down exactly as
 * it does `agents`. `idle` (`liveStatus`'s own default) draws no class at
 * all; only `running`/`landed` reach `.graph-node` as `node-live-<status>`.
 */
import { computed } from 'vue'
import { Background } from '@vue-flow/background'
import { Handle, Position, VueFlow, type Connection, type EdgeChange, type NodeChange } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'
import { useI18n } from '../composables/useI18n.js'
import { cardInfo, type LiveStatus } from '../lib/agentcard.js'
import { layout } from '../lib/trackgraph.js'
import type { AgentsView, Track } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{
  track: Track
  name: string
  agents: AgentsView | null
  // Task 5: read-only display, computed and owned entirely by `Tracks.vue`
  // (its own `liveByTrack` comment says why) — this component only turns a
  // status this map already decided into a class, exactly the way `:agents`
  // above only turns `cardInfo`'s own verdict into card content. `null`
  // covers both "no run is going" and "a run is going, but on a different
  // track", the same two cases `liveStatus` itself already collapses into
  // `'idle'` for a track that is not the one running.
  live?: Record<string, LiveStatus> | null
}>()

const emit = defineEmits<{
  connect: [{ source: string; target: string }]
  disconnect: [{ source: string; target: string }]
  remove: [{ agent: string }]
  // Task 4: which card the reader last clicked, for `TrackSidePanel.vue`'s
  // own detail view — `agent` is the node id (`onNodesChange`'s own
  // `change.id` above draws from the same id), and `null` is a click on the
  // empty canvas itself, the side panel's own cue to fall back to its
  // settings/add-agent view rather than staying pinned to a card that lost
  // focus.
  select: [{ agent: string | null }]
}>()

const { t } = useI18n()

const geometry = computed(() => layout(props.track))

// This task's own coordinates: `index * 260`, `layer * 170` — a vertical
// wave flow, each layer a row rather than a column, wide enough
// (`260`/`170`) for the rich card `70-graph.css`'s `.graph-node` now draws
// instead of the old single-line name box. Positions are derived every
// render, never stored — see `lib/trackgraph.ts`'s own header for why a
// coordinates field never reaches `config.yaml`.
const nodes = computed(() =>
  geometry.value.nodes.map((node) => ({
    id: node.id,
    type: 'agent',
    position: { x: node.index * 260, y: node.layer * 170 },
    data: {
      agent: node.agent,
      list: node.list,
      cyclic: node.cyclic,
      card: cardInfo(node.agent, props.agents),
      // `?? 'idle'`, not a bare lookup: `props.live` is `null` outside a run
      // on this track, and an agent this track names may still be absent
      // from the map's own keys the moment a run *does* start elsewhere —
      // both read the same as `liveStatus`'s own `'idle'` for "nothing to
      // show", never as a missing card.
      status: props.live?.[node.agent] ?? 'idle',
    },
  })),
)

const edges = computed(() =>
  geometry.value.edges.map((edge) =>
    edge.kind === 'gate'
      ? // A gate is drawn, never dragged: `selectable: false` keeps it out of
        // Vue Flow's own click-to-select and delete-key paths, and
        // `animated: false` keeps it visually distinct from the order edges a
        // drag can actually produce. Conflating the two would let a reader
        // delete "blocks after proven_by" the same way they delete an
        // ordinary wait — two refusals the schema applies under different
        // conditions (`TrackSchema`'s gate checks vs. its order-cycle check).
        // The label repeats that same distinction in words, not only in the
        // dashed/orange line style below (`70-graph.css`'s `.edge-gate`): a
        // reader who cannot tell the two strokes apart still reads "gate ·
        // proven by X" instead of an ordinary "after X".
        { id: edge.id, source: edge.source, target: edge.target, animated: false, selectable: false, class: 'edge-gate', label: t('config.graph.gateEdge', { agent: edge.source }) }
      : { id: edge.id, source: edge.source, target: edge.target, animated: false, class: 'edge-order', label: t('config.graph.orderEdge', { agent: edge.source }) },
  ),
)

/** A drag's own end: Vue Flow only calls this with both handles resolved. */
function onConnect(connection: Connection): void {
  if (connection.source === null || connection.target === null) return
  emit('connect', { source: connection.source, target: connection.target })
}

// Only an order edge can ever be selected in the first place (a gate's own
// `selectable: false` above), so nothing here has to re-check `kind` before
// treating a removal as an order edge coming off.
function onEdgesChange(changes: EdgeChange[]): void {
  for (const change of changes) {
    if (change.type !== 'remove') continue
    const edge = geometry.value.edges.find((candidate) => candidate.id === change.id)
    if (edge === undefined) continue
    emit('disconnect', { source: edge.source, target: edge.target })
  }
}

function onNodesChange(changes: NodeChange[]): void {
  for (const change of changes) {
    if (change.type === 'remove') emit('remove', { agent: change.id })
  }
}
</script>

<template>
  <div class="track-graph" :data-track-graph="props.name">
    <!-- `:nodes-draggable="false"`: `lib/trackgraph.ts` derives `{ x, y }`
         from `layer`/`index` on every render and nothing here ever writes a
         moved position back — the same "positions are derived, never
         stored" rule that file's own header states. Vue Flow drags nodes by
         default; left on, a reader could drag a node, watch it hold, and
         then have it silently snap back the next time `draft` changes
         (any other edit re-renders this component with the same layout
         coordinates). Turning dragging off makes that contract visible
         instead of surprising. -->
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      fit-view-on-init
      @connect="onConnect"
      @edges-change="onEdgesChange"
      @nodes-change="onNodesChange"
      @node-click="(e) => emit('select', { agent: e.node.id })"
      @pane-click="emit('select', { agent: null })"
    >
      <!-- Chrome, not content: a dotted pane so the canvas reads as an
           editor surface rather than empty white space, and a zoom/fit
           control bar in the corner a reader can find without hunting for
           scroll-wheel zoom. `:show-interactive="false"` drops Vue Flow's own
           lock-toggle button — nothing here is draggable in the first place
           (`:nodes-draggable="false"` above), so a control that toggles that
           off would offer a choice this view never honours. -->
      <Background :gap="16" :size="1" pattern-color="var(--line)" />
      <Controls :show-interactive="false" position="bottom-right" />
      <template #node-agent="nodeProps">
        <div
          class="graph-node"
          :class="[
            `node-${nodeProps.data.list}`,
            {
              'node-cyclic': nodeProps.data.cyclic,
              'node-missing': nodeProps.data.card.source === null,
              // `idle` draws nothing extra — the card already looks exactly
              // as it did before this task the moment no run touches it,
              // which is most of the time this panel is open.
              [`node-live-${nodeProps.data.status}`]: nodeProps.data.status !== 'idle',
            },
          ]"
          :data-graph-node="nodeProps.id"
        >
          <!-- Handles flip with the layout: a wave flows downward now, not
               rightward, so a predecessor's edge enters the top and a
               successor's edge leaves the bottom, matching the `y` a node's
               own `layer` produces above. -->
          <Handle type="target" :position="Position.Top" />
          <div class="graph-node-head">
            <!-- The name is a Latin agent id inside an otherwise-Arabic
                 card in the `ar` locale — the same isolation `AgentCard.vue`
                 already applies to this exact string (`agent.name`) and
                 `Tracks.vue` applies to `graphRefusal`'s `{from}`/`{to}`
                 holes, so a Latin run here does not drag the punctuation
                 around it to the wrong end of the line. -->
            <span class="graph-node-name"><Bdi :value="nodeProps.data.agent" /></span>
            <span class="graph-node-role" :class="`role-${nodeProps.data.list}`">{{ t(`config.graph.role.${nodeProps.data.list}`) }}</span>
          </div>
          <div class="graph-node-body">
            <!-- `cardInfo`'s own two `null`s are two different facts, drawn
                 two different ways: an agent that defines itself with no
                 description text still gets no `<p>` at all, but an agent
                 this track names with no definition file *must* say so —
                 `.node-missing`'s own text, not a silently empty card. The
                 missing-agent message is translated UI copy, not
                 model-authored text, so it is the one string here left
                 outside `Bdi` — same split `AgentCard.vue` draws between its
                 own `t(...)` labels and the `Bdi`-wrapped facts beside them. -->
            <p v-if="nodeProps.data.card.description !== null" class="graph-node-desc" dir="auto"><Bdi :value="nodeProps.data.card.description" /></p>
            <p v-else-if="nodeProps.data.card.source === null" class="graph-node-desc">{{ t('config.graph.missingAgent') }}</p>
            <div v-if="nodeProps.data.card.tools.length > 0" class="graph-node-tools">
              <span v-for="tool in nodeProps.data.card.tools" :key="tool" class="graph-node-tool"><Bdi :value="tool" /></span>
            </div>
            <div class="graph-node-meta">
              <span v-if="nodeProps.data.card.model !== null" class="graph-node-model"><Bdi :value="nodeProps.data.card.model" /></span>
              <span v-if="nodeProps.data.card.source === 'project'" class="graph-node-source">{{ t('config.graph.sourceProject') }}</span>
            </div>
          </div>
          <!-- The picture-that-lies defect `GraphNode.cyclic` exists to
               prevent: a starved node is never drawn as though it were
               merely "last" — its own visible badge says why. -->
          <span v-if="nodeProps.data.cyclic" class="graph-node-cyclic-badge">{{ t('config.graph.cyclic') }}</span>
          <Handle type="source" :position="Position.Bottom" />
        </div>
      </template>
    </VueFlow>
  </div>
</template>
