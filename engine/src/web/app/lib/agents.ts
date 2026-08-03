/**
 * The Agents tab's pure half — DOM-free, so it is testable without mounting a
 * component, the same split `lib/config.ts` already makes for the Config tab.
 */
import type { Config } from '../types/protocol.js'

export interface AgentUsage {
  track: string
  list: 'required' | 'available' | 'closing' | 'blocks' | 'gate' | 'map'
}

/**
 * Every place a track names this agent.
 *
 * This is what makes deleting an agent a decision rather than a gamble: the
 * server refuses the delete for exactly this reason, and showing the reason
 * before the button is pressed is the difference between a guard and a wall.
 * Track order is `Object.keys`'s, sorted, so the list does not reshuffle
 * between renders. The six lists checked here are exactly the six
 * `agentUsedByTrack` (`writes.ts`) checks server-side — required, available,
 * closing, gate.blocks, gate.proven_by, map.drafted_by — so a name this
 * function clears is a name the server will actually let go.
 */
export function usage(config: Config | null, name: string): AgentUsage[] {
  if (config === null) return []
  const out: AgentUsage[] = []
  for (const track of Object.keys(config.tracks).sort()) {
    const entry = config.tracks[track]
    if (entry === undefined) continue
    if (entry.required.includes(name)) out.push({ track, list: 'required' })
    if ((entry.available ?? []).includes(name)) out.push({ track, list: 'available' })
    if ((entry.closing ?? []).includes(name)) out.push({ track, list: 'closing' })
    if ((entry.gate?.blocks ?? []).includes(name)) out.push({ track, list: 'blocks' })
    if (entry.gate?.proven_by === name) out.push({ track, list: 'gate' })
    if (entry.map?.drafted_by === name) out.push({ track, list: 'map' })
  }
  return out
}

/**
 * Whether the body carries the output contract rather than a promise of one.
 *
 * The `mjloop-extend` skill records the measurement this exists to act on:
 * agents *pointing at* the contract violated it on their first attempt and
 * each cost a corrective retry, while agents carrying it inline complied first
 * time. So this looks for a fenced json block with the contract's own required
 * field in it, and deliberately does not accept a sentence about the contract.
 */
export function hasContract(body: string): boolean {
  for (const match of body.matchAll(/```json\s*([\s\S]*?)```/g)) {
    if (/"status"\s*:/.test(match[1] ?? '')) return true
  }
  return false
}

/**
 * `<source>-copy`, then `-2`, `-3` — the same shape `TrackEditor.vue`'s own
 * duplicate uses.
 *
 * Trailing `-` is stripped from `source` first: a bare `${source}-copy` on a
 * name already ending in `-` would embed `--`, which `AgentNameSchema`
 * (`schemas/contract.ts`) rejects outright — `--` is reserved to separate an
 * agent from its cycle instance. A round-1 review caught this as newly
 * reachable once derive stopped being a disabled button: `foo-` would have
 * produced `foo--copy`, a name `agent.create` would refuse in silence from
 * this form's point of view (the server drops a malformed frame rather than
 * answering it).
 */
export function copyName(taken: readonly string[], source: string): string {
  const base = source.replace(/-+$/, '')
  let candidate = `${base}-copy`
  let n = 2
  while (taken.includes(candidate)) candidate = `${base}-copy-${n++}`
  return candidate
}
