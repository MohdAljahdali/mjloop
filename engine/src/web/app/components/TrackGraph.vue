<script setup lang="ts">
/**
 * TrackGraph — one track's agents and order constraints, drawn with
 * `@vue-flow/core` over the pure geometry `lib/trackgraph.ts` already
 * computes. Ported into the graph view `Tracks.vue`'s header promises
 * beside the list, never in place of it — see that file's own comment on
 * `view` for why the list stays reachable.
 *
 * Purely presentational, and purely an emitter: it takes `:track` and
 * `:name`, turns `layout(track)` into Vue Flow's own node/edge shape at the
 * fixed coordinates `{ x: layer * 220, y: index * 90 }`, and reports every
 * drag, edge deletion and node deletion upward as `connect`/`disconnect`/
 * `remove`. It never imports `mutate` or `submit` and holds no draft of its
 * own — `Tracks.vue` remains the sole owner of `mutate`, exactly as it does
 * for every list control on this panel (`Tracks.vue`'s own header), and is
 * the only listener wired to these three events. A connect is therefore
 * refused or applied by `Tracks.vue` itself — the one place that already
 * holds both `mutate` and the draft `wouldCycle` needs to check against —
 * rather than a second, independent copy of that check living here.
 */
import { computed } from 'vue'
import { Handle, Position, VueFlow, type Connection, type EdgeChange, type NodeChange } from '@vue-flow/core'
import { useI18n } from '../composables/useI18n.js'
import { layout } from '../lib/trackgraph.js'
import type { Track } from '../types/protocol.js'

const props = defineProps<{
  track: Track
  name: string
}>()

const emit = defineEmits<{
  connect: [{ source: string; target: string }]
  disconnect: [{ source: string; target: string }]
  remove: [{ agent: string }]
}>()

const { t } = useI18n()

const geometry = computed(() => layout(props.track))

// The brief's own coordinates: `layer * 220`, `index * 90`. Positions are
// derived every render, never stored — see `lib/trackgraph.ts`'s own header
// for why a coordinates field never reaches `config.yaml`.
const nodes = computed(() =>
  geometry.value.nodes.map((node) => ({
    id: node.id,
    type: 'agent',
    position: { x: node.layer * 220, y: node.index * 90 },
    data: { agent: node.agent, list: node.list, cyclic: node.cyclic },
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
        { id: edge.id, source: edge.source, target: edge.target, animated: false, selectable: false, class: 'edge-gate' }
      : { id: edge.id, source: edge.source, target: edge.target, animated: false, class: 'edge-order' },
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
    <VueFlow :nodes="nodes" :edges="edges" :nodes-draggable="false" fit-view-on-init @connect="onConnect" @edges-change="onEdgesChange" @nodes-change="onNodesChange">
      <template #node-agent="nodeProps">
        <div class="graph-node" :class="[`node-${nodeProps.data.list}`, { 'node-cyclic': nodeProps.data.cyclic }]" :data-graph-node="nodeProps.id">
          <Handle type="target" :position="Position.Left" />
          <span class="graph-node-name">{{ nodeProps.data.agent }}</span>
          <!-- The picture-that-lies defect `GraphNode.cyclic` exists to
               prevent: a starved node is never drawn as though it were
               merely "last" — its own visible badge says why. -->
          <span v-if="nodeProps.data.cyclic" class="graph-node-cyclic-badge">{{ t('config.graph.cyclic') }}</span>
          <Handle type="source" :position="Position.Right" />
        </div>
      </template>
    </VueFlow>
  </div>
</template>
