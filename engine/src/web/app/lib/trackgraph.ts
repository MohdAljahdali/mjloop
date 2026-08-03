/**
 * Trackgraph — the pure geometry Task 12's graph view draws: which layer an
 * agent lands on, one edge per predecessor, and whether a proposed edge would
 * close a cycle. DOM-free and Vue-free, like `lib/config.ts` beside it —
 * tested without mounting anything.
 *
 * **Positions are derived, never stored.** `layout()` below returns `layer`
 * and `index`; Task 12's component turns those into coordinates. Nothing
 * here writes a coordinates field into `config.yaml` — that file is a
 * document a person reads and reviews in git, and a coordinates field would
 * be litter in it.
 *
 * **Kept in step with the engine, not merely "similar to" it.** The layer
 * loop below (`layersOf`) is `dispatchWaves` (`schemas/config.ts`) with its
 * `selected` parameter fixed to a track's own `required ∪ available` and its
 * `RangeError` softened to "stop where you are" — see that function's own
 * comment for why a `Track` that parsed can never actually cycle here. The
 * two must keep matching wave-for-wave, or this graph draws layers the
 * engine would never dispatch together. They are not imported from one
 * another: `lib/config.ts` beside this file already chose, for
 * `findOrderCycle`, to mirror the schema module's function rather than
 * import across the server/web bundle boundary, with the same "mirrored,
 * never authoritative" comment this file repeats. The mechanism that keeps
 * the two from drifting is the same one that file relies on — a comment
 * naming the exact function and file to re-check on any change to either
 * side's ordering rules, not a runtime import. If `dispatchWaves`'s wave loop
 * ever changes shape, this file's `layersOf` must change with it.
 *
 * `wouldCycle` is a separate, narrower question from `findOrderCycle`: not
 * "does this track already cycle" but "would drawing one more edge make it
 * cycle" — a depth-first search from the proposed edge's target, over
 * `order` edges alone (not the gate), looking for the proposed edge's
 * source. A gate is not drawn by dragging in the graph view, so it plays no
 * part in this refusal.
 */
import type { Track } from '../types/protocol.js'

export interface GraphNode {
  id: string
  agent: string
  list: 'required' | 'available' | 'closing'
  layer: number
  index: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: 'order' | 'gate'
}

/** A gate folded into an edge, `blocks after proven_by` — the same fold `dispatchWaves` applies beside `track.order`. */
function gateEdges(track: Track): { agent: string; after: string[] }[] {
  return track.gate === undefined
    ? []
    : track.gate.blocks.map((agent) => ({ agent, after: [(track.gate as { proven_by: string }).proven_by] }))
}

/**
 * `dispatchWaves`'s own wave loop, restricted to `agents` (a track's
 * `required ∪ available`, never `closing` — see this module's own header).
 * Returns each agent's wave index, which is its layer.
 *
 * A cycle among `agents` cannot happen for a `Track` `TrackSchema.superRefine`
 * accepted — see `dispatchWaves`'s own comment for why restricting to a
 * subset can only remove constraints. A hand-built fixture could still starve
 * this loop, so it stops rather than throws: a graph view should still draw
 * something for a track a test built by hand, not crash the tab a user is
 * editing in.
 */
function layersOf(track: Track, agents: readonly string[]): Map<string, number> {
  const isChosen = new Set(agents)
  const remaining = new Map<string, Set<string>>()
  for (const agent of agents) remaining.set(agent, new Set())
  for (const edge of [...track.order, ...gateEdges(track)]) {
    if (!isChosen.has(edge.agent)) continue
    for (const pred of edge.after) {
      if (!isChosen.has(pred)) continue // vacuous: predecessor is not part of this layering — same rule `dispatchWaves` applies
      remaining.get(edge.agent)?.add(pred)
    }
  }

  const layer = new Map<string, number>()
  const done = new Set<string>()
  let pending = [...agents]
  let wave = 0
  while (pending.length > 0) {
    const ready = pending.filter((agent) => [...(remaining.get(agent) ?? [])].every((dep) => done.has(dep)))
    if (ready.length === 0) break // unreachable for a schema-valid track; see this function's own comment
    for (const agent of ready) {
      layer.set(agent, wave)
      done.add(agent)
    }
    pending = pending.filter((agent) => !done.has(agent))
    wave++
  }
  return layer
}

/**
 * The graph a track implies: every agent as a node on the layer
 * `layersOf` assigns it, `closing` agents pushed one layer past everything
 * else because a closing agent closes the run rather than the cycle, and one
 * edge per predecessor an agent's `order` entry or the track's `gate` names.
 *
 * Node and edge order is fixed by traversal order alone — `required`, then
 * `available`, then `closing`, each in the track's own array order, and
 * `index` counted up within a layer in that same walk — so two calls over
 * the same track produce the same array, never a reshuffled one.
 */
export function layout(track: Track): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nonClosing = [...track.required, ...track.available]
  const layer = layersOf(track, nonClosing)
  const maxLayer = Math.max(-1, ...layer.values())
  const closingLayer = maxLayer + 1

  const nodes: GraphNode[] = []
  const nextIndex = new Map<number, number>()
  const place = (agent: string, list: GraphNode['list'], atLayer: number): void => {
    const index = nextIndex.get(atLayer) ?? 0
    nextIndex.set(atLayer, index + 1)
    nodes.push({ id: agent, agent, list, layer: atLayer, index })
  }
  for (const agent of track.required) place(agent, 'required', layer.get(agent) ?? 0)
  for (const agent of track.available) place(agent, 'available', layer.get(agent) ?? 0)
  for (const agent of track.closing) place(agent, 'closing', closingLayer)

  const edges: GraphEdge[] = []
  for (const edge of track.order) {
    for (const pred of edge.after) {
      edges.push({ id: `order:${pred}->${edge.agent}`, source: pred, target: edge.agent, kind: 'order' })
    }
  }
  if (track.gate !== undefined) {
    for (const agent of track.gate.blocks) {
      edges.push({ id: `gate:${track.gate.proven_by}->${agent}`, source: track.gate.proven_by, target: agent, kind: 'gate' })
    }
  }

  return { nodes, edges }
}

/**
 * Whether drawing an edge from `from` to `to` — "`to` after `from`" — would
 * close a cycle through the track's existing `order` edges, or name an agent
 * as its own predecessor. A depth-first search from `to` over the existing
 * predecessor→successor direction, looking for `from`: finding it means a
 * path already runs `to` → … → `from`, and the new edge would close it into
 * `from` → `to` → … → `from`.
 */
export function wouldCycle(track: Track, from: string, to: string): boolean {
  if (from === to) return true // an agent cannot be its own predecessor

  const successors = new Map<string, string[]>()
  for (const edge of track.order) {
    for (const pred of edge.after) {
      const list = successors.get(pred) ?? []
      list.push(edge.agent)
      successors.set(pred, list)
    }
  }

  const seen = new Set<string>()
  const stack = [to]
  while (stack.length > 0) {
    const node = stack.pop() as string
    if (node === from) return true
    if (seen.has(node)) continue
    seen.add(node)
    for (const next of successors.get(node) ?? []) stack.push(next)
  }
  return false
}
