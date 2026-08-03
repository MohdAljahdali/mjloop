import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentNameSchema } from '../schemas/contract.js'
import { writeTextAtomic } from './atomic.js'
import { parseFrontmatter, serialiseFrontmatter } from './frontmatter.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'

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

export type AgentWriteFailure = 'stale' | 'exists' | 'missing' | 'invalid' | 'reserved'

export class AgentWriteError extends Error {
  constructor(readonly kind: AgentWriteFailure, message: string) {
    super(message)
    this.name = 'AgentWriteError'
  }
}

export interface AgentInput {
  name: string
  description: string
  tools: string | null
  model: string | null
  extra: Record<string, unknown>
  body: string
}

/**
 * The whole path defence, in one place.
 *
 * The name is a token to be matched, never a path to be opened: it goes
 * through `AgentNameSchema` — the engine's own — and only then is it joined
 * onto the agents directory. `.` and `/` are outside that schema's character
 * class, so `..` and `a/b` cannot match, and this is the first write in the
 * server that lands outside `.mjloop/`.
 */
function agentFile(projectDir: string, name: string): string {
  if (!AgentNameSchema.safeParse(name).success) {
    throw new AgentWriteError('invalid', 'not an agent name')
  }
  return path.join(projectAgentsDir(projectDir), `${name}.md`)
}

function document(input: AgentInput): string {
  // Insertion order is the serialised order, and it matches what every agent
  // file in this plugin already opens with — a diff against a hand-written
  // file should be about what changed, not about four fields moving.
  const data: Record<string, unknown> = { name: input.name, description: input.description }
  if (input.tools !== null) data['tools'] = input.tools
  if (input.model !== null) data['model'] = input.model
  Object.assign(data, input.extra)
  return serialiseFrontmatter(data, input.body)
}

/**
 * @param options.expectDigest `null` creates; a digest replaces exactly that
 *   revision of the file and refuses anything else. A stale click is refused
 *   rather than obeyed — the same contract `mutateConfig` holds.
 * @param options.reserved The plugin's own agent names. A project agent
 *   shadows a plugin one of the same name, so this refuses to replace an agent
 *   carrying a system invariant with whatever somebody typed.
 */
export async function writeAgent(
  projectDir: string,
  input: AgentInput,
  options: { expectDigest: string | null; reserved: readonly string[] },
): Promise<{ digest: string }> {
  const file = agentFile(projectDir, input.name)
  if (options.reserved.includes(input.name)) {
    throw new AgentWriteError('reserved', 'that name shadows a plugin agent')
  }
  if (input.description.trim().length === 0) {
    throw new AgentWriteError('invalid', 'an agent needs a description')
  }

  // The project lock, not a lock of this file's own: an agent write and a
  // config write are two halves of one decision often enough — deleting an
  // agent a track names is refused by reading that config — that serialising
  // them against each other is worth more than the concurrency it costs.
  return withLock(resolveLoopPaths(projectDir).lock, async () => {
    let current: string | null = null
    try {
      current = await fs.readFile(file, 'utf8')
    } catch {
      current = null
    }
    if (options.expectDigest === null && current !== null) {
      throw new AgentWriteError('exists', 'that agent already exists')
    }
    if (options.expectDigest !== null) {
      if (current === null) throw new AgentWriteError('missing', 'that agent is gone')
      if (agentDigest(current) !== options.expectDigest) {
        throw new AgentWriteError('stale', 'the file moved underneath the editor')
      }
    }
    const next = document(input)
    await fs.mkdir(projectAgentsDir(projectDir), { recursive: true })
    await writeTextAtomic(file, next)
    return { digest: agentDigest(next) }
  })
}

/**
 * @param options.guard Run inside the same lock, after the digest check and
 *   immediately before the file is removed, and free to throw. This exists
 *   because the digest this function already checks cannot see a track: a
 *   caller that checked "does any track name this agent" *before* calling
 *   `deleteAgent` would be reading the config outside the lock this function
 *   takes — and that lock is the *project* lock precisely so a `config.patch`
 *   racing in cannot add this agent to a track between that check and the
 *   `fs.rm` below. Passed a callback rather than a config snapshot: the guard
 *   itself decides what "in use" means and how to signal it — this store has
 *   no opinion on tracks at all — so it re-reads whatever it needs from
 *   inside the same lock, at the moment that actually matters.
 */
export async function deleteAgent(
  projectDir: string,
  name: string,
  expectDigest: string,
  options?: { guard?: () => Promise<void> },
): Promise<void> {
  const file = agentFile(projectDir, name)
  await withLock(resolveLoopPaths(projectDir).lock, async () => {
    let current: string
    try {
      current = await fs.readFile(file, 'utf8')
    } catch {
      throw new AgentWriteError('missing', 'that agent is gone')
    }
    if (agentDigest(current) !== expectDigest) {
      throw new AgentWriteError('stale', 'the file moved underneath the editor')
    }
    if (options?.guard !== undefined) await options.guard()
    await fs.rm(file)
  })
}
