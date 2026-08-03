import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentDigest,
  AgentWriteError,
  deleteAgent,
  listAgents,
  projectAgentsDir,
  readAgent,
  writeAgent,
} from '../../src/store/agent-store.js'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mjloop-agents-'))
  await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true })
  // `withLock` mkdir's its lock directory inside `.mjloop/`, which fails with
  // ENOENT (not the EEXIST it retries on) if the parent is missing — so a
  // guarded write needs this directory even though nothing in it is read.
  await fs.mkdir(path.join(dir, '.mjloop'), { recursive: true })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, '.claude', 'agents', `${name}.md`), body, 'utf8')
}

const SAMPLE = `---
name: scribe
description: Writes notes.
tools: Read, Write
model: sonnet
color: blue
---

You write notes. You never edit code.
`

describe('reading agent files', () => {
  // Folds the brief's separate "reads frontmatter/body/digest", "lists in name
  // order and ignores non-markdown", and "empty listing for a missing dir"
  // cases: all three exercise the same happy path from different angles, so
  // one test walks it once instead of three times.
  it('reads a project agent and lists a directory in name order, ignoring non-markdown entries', async () => {
    await write('zulu', SAMPLE.replace('scribe', 'zulu'))
    await write('alpha', SAMPLE.replace('scribe', 'alpha'))
    await fs.writeFile(path.join(dir, '.claude', 'agents', 'notes.txt'), 'ignored', 'utf8')

    const doc = await readAgent(dir, 'alpha')
    expect(doc?.name).toBe('alpha')
    expect(doc?.description).toBe('Writes notes.')
    expect(doc?.tools).toBe('Read, Write')
    expect(doc?.model).toBe('sonnet')
    expect(doc?.body).toBe('You write notes. You never edit code.')
    expect(doc?.source).toBe('project')
    expect(doc?.digest).toBe(agentDigest(SAMPLE.replace('scribe', 'alpha')))

    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents.map((agent) => agent.name)).toEqual(['alpha', 'zulu'])

    expect(await listAgents(path.join(dir, 'nowhere'), 'project')).toEqual({ agents: [], unreadable: [] })
  })

  it('keeps a frontmatter field it does not know about', async () => {
    // Dropping it would mean saving from the dashboard silently erases what a
    // person wrote by hand.
    await write('scribe', SAMPLE)
    const doc = await readAgent(dir, 'scribe')
    expect(doc?.extra).toEqual({ color: 'blue' })
  })

  it('answers null for an agent that is not there', async () => {
    expect(await readAgent(dir, 'nobody')).toBeNull()
  })

  it('reports an unparseable file rather than dropping it', async () => {
    await write('broken', 'no frontmatter at all\n')
    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents).toEqual([])
    expect(listing.unreadable).toEqual([{ path: path.join(projectAgentsDir(dir), 'broken.md') }])
  })
})

const INPUT = {
  name: 'scribe',
  description: 'Writes notes.',
  tools: 'Read, Write',
  model: 'sonnet',
  extra: {},
  body: 'You write notes.',
}

describe('writing agent files', () => {
  // Folds the brief's separate "creates and answers its digest" and "keeps an
  // unknown frontmatter field through a round trip" cases: both are the same
  // happy path, read back through the same `readAgent`, from different angles.
  it('creates a file, answers its digest, and keeps an unknown field through the round trip', async () => {
    const { digest } = await writeAgent(dir, { ...INPUT, extra: { color: 'blue' } }, { expectDigest: null, reserved: [] })
    const doc = await readAgent(dir, 'scribe')
    expect(doc?.digest).toBe(digest)
    expect(doc?.body).toBe('You write notes.')
    expect(doc?.extra).toEqual({ color: 'blue' })
  })

  it('refuses an update whose digest has moved underneath it, changing nothing on disk', async () => {
    await writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })
    await expect(
      writeAgent(dir, { ...INPUT, body: 'edited' }, { expectDigest: agentDigest('something else'), reserved: [] }),
    ).rejects.toMatchObject({ kind: 'stale' } satisfies Partial<AgentWriteError>)
    expect((await readAgent(dir, 'scribe'))?.body).toBe('You write notes.')
  })

  it('refuses a name that would shadow a plugin agent, changing nothing on disk', async () => {
    await expect(
      writeAgent(dir, { ...INPUT, name: 'verifier' }, { expectDigest: null, reserved: ['verifier'] }),
    ).rejects.toMatchObject({ kind: 'reserved' } satisfies Partial<AgentWriteError>)
    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents).toEqual([])
  })

  it.each(['../escape', 'a/b', 'Has Space'])('refuses the name %j, writing nothing anywhere', async (name) => {
    await expect(
      writeAgent(dir, { ...INPUT, name }, { expectDigest: null, reserved: [] }),
    ).rejects.toMatchObject({ kind: 'invalid' } satisfies Partial<AgentWriteError>)
    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents).toEqual([])
  })

  it('deletes only the digest it was shown, refusing a stale one without changing anything', async () => {
    const { digest } = await writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })
    await expect(deleteAgent(dir, 'scribe', agentDigest('stale'))).rejects.toMatchObject({
      kind: 'stale',
    } satisfies Partial<AgentWriteError>)
    expect(await readAgent(dir, 'scribe')).not.toBeNull()
    await deleteAgent(dir, 'scribe', digest)
    expect(await readAgent(dir, 'scribe')).toBeNull()
  })
})
