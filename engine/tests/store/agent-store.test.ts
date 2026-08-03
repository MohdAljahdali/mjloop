import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentDigest, listAgents, projectAgentsDir, readAgent } from '../../src/store/agent-store.js'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mjloop-agents-'))
  await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true })
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
