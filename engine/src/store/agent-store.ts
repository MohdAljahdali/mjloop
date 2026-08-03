import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'

/**
 * One agent file, as a document this layer does not interpret.
 *
 * The engine does not know agent names — that is the rule the whole track
 * design rests on (see the `mjloop-extend` skill). So nothing here branches on
 * a name, and `extra` exists so a field this layer has never heard of survives
 * a round trip: dropping it would mean saving from the dashboard silently
 * erases what somebody wrote by hand.
 */
export interface AgentDoc {
  name: string
  source: 'project' | 'plugin'
  description: string
  tools: string | null
  model: string | null
  extra: Record<string, unknown>
  body: string
  digest: string
  path: string
}

export interface UnreadableAgent {
  path: string
}

/** sha256 over the file's own bytes — the same shape, and the same job, as `configRevision`. */
export function agentDigest(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * `.claude/agents/`, and nowhere else.
 *
 * Claude Code reads project subagents from this directory and from no other,
 * whatever a config might suggest — `schemas/config.ts:490-491` records the
 * same fact against a `custom_dirs` setting that used to claim otherwise.
 */
export function projectAgentsDir(projectDir: string): string {
  return path.join(projectDir, '.claude', 'agents')
}

const KNOWN = ['name', 'description', 'tools', 'model'] as const

function toDoc(name: string, raw: string, file: string, source: 'project' | 'plugin'): AgentDoc {
  const { data, body } = parseFrontmatter(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('frontmatter is not a mapping')
  }
  const record = data as Record<string, unknown>
  const text = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null)
  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => !KNOWN.includes(key as (typeof KNOWN)[number])),
  )
  return {
    // The filename wins over a `name:` that disagrees with it: the filename is
    // what Claude Code dispatches on, so trusting the field would show a name
    // no track can ever draft.
    name,
    source,
    description: text('description') ?? '',
    tools: text('tools'),
    model: text('model'),
    extra,
    body,
    digest: agentDigest(raw),
    path: file,
  }
}

export async function listAgents(
  dir: string,
  source: 'project' | 'plugin',
): Promise<{ agents: AgentDoc[]; unreadable: UnreadableAgent[] }> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort()
  } catch {
    // A project with no `.claude/agents/` is the ordinary case, not a fault.
    return { agents: [], unreadable: [] }
  }
  const agents: AgentDoc[] = []
  const unreadable: UnreadableAgent[] = []
  for (const entry of names) {
    const file = path.join(dir, entry)
    try {
      agents.push(toDoc(entry.slice(0, -3), await fs.readFile(file, 'utf8'), file, source))
    } catch {
      // Reported rather than dropped: a file that vanishes from the list is a
      // file nobody knows is broken.
      unreadable.push({ path: file })
    }
  }
  return { agents, unreadable }
}

export async function readAgent(projectDir: string, name: string): Promise<AgentDoc | null> {
  const file = path.join(projectAgentsDir(projectDir), `${name}.md`)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  return toDoc(name, raw, file, 'project')
}
