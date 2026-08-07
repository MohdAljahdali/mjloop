/**
 * Agentcard — the pure derivations behind the rich graph card: what a card
 * shows for an agent name (`cardInfo`), and how the running cycle colours it
 * (`liveStatus`). DOM-free and Vue-free like `trackgraph.ts` beside it.
 *
 * `cardInfo` resolves project-over-plugin because that is the shadowing rule
 * `readAgentsView` documents: the two directories are listed side by side and
 * never merged, precisely so a project agent of the same name wins.
 *
 * `liveStatus` reads only the intra-cycle signal that actually exists —
 * `RosterView`'s selected-vs-landed diff (see its own comment: stages
 * `execute`/`judge` are never written by the engine, so nothing here promises
 * one). Findings carry no agent name (`FindingSchema`), so a per-agent
 * findings state is deliberately absent.
 */
import type { AgentsView, RosterView, StateSummary } from '../types/protocol.js'

export interface CardInfo {
  name: string
  description: string | null
  tools: string[]
  model: string | null
  /** `null`: the track names an agent no definition file provides — drawn as a warning card, never hidden. */
  source: 'project' | 'plugin' | null
}

export function cardInfo(name: string, agents: AgentsView | null): CardInfo {
  const found = agents?.project.find((agent) => agent.name === name) ?? agents?.plugin.find((agent) => agent.name === name)
  if (found === undefined) return { name, description: null, tools: [], model: null, source: null }
  const tools = (found.tools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0)
  return { name, description: found.description.length > 0 ? found.description : null, tools, model: found.model, source: found.source }
}

export type LiveStatus = 'running' | 'landed' | 'idle'

export function liveStatus(
  agent: string,
  trackName: string,
  state: Pick<StateSummary, 'status' | 'track'>,
  roster: RosterView | null,
): LiveStatus {
  if (state.status !== 'running' || state.track !== trackName || roster === null) return 'idle'
  if (roster.landed.includes(agent)) return 'landed'
  if (roster.selected.includes(agent)) return 'running'
  return 'idle'
}
