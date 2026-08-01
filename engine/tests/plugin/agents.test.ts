import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../../src/mcp/server.js'
import { DEFAULT_TRACKS } from '../../src/schemas/config.js'
import { ComponentTechnologySchema } from '../../src/schemas/project-profile.js'

/**
 * The plugin's agent frontmatter, asserted against the engine it calls.
 *
 * The only suite here that reads outside `engine/`, and it exists because
 * nothing else can notice the failure it defends. The engine never reads
 * `agents/` (`ops/preflight.ts:12`), and a tool a subagent was not granted is
 * simply absent rather than an error: an agent whose `tools:` line omits
 * `mjloop_verify_run`, or spells it under a server id this plugin does not
 * have, falls back to `Bash` and produces a green nobody can check. No test of
 * the engine's own behaviour would fail, because the engine behaves correctly
 * throughout — it is never called.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const AGENTS_DIR = path.join(REPO, 'agents')

/** The prefix Claude Code gives this plugin's MCP server. See `docs/install.md`. */
const SERVER_PREFIX = 'mcp__plugin_mjloop_mjloop__'
const VERIFY_TOOL = `${SERVER_PREFIX}mjloop_verify_run`

const files = (await fs.readdir(AGENTS_DIR)).filter((name) => name.endsWith('.md')).sort()

/** The `tools:` line, split the way the frontmatter writes it. */
function toolsOf(source: string): string[] {
  const line = /^tools:(.*)$/m.exec(source)
  return line === null ? [] : (line[1] ?? '').split(',').map((tool) => tool.trim()).filter((tool) => tool !== '')
}

const tools = new Map<string, string[]>()
for (const file of files) {
  tools.set(path.basename(file, '.md'), toolsOf(await fs.readFile(path.join(AGENTS_DIR, file), 'utf8')))
}

async function registeredTools(): Promise<Set<string>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([buildServer().connect(serverTransport), client.connect(clientTransport)])
  const { tools: registered } = await client.listTools()
  return new Set(registered.map((tool) => tool.name))
}

describe('the plugin agents', () => {
  it('grants the verify tool to every closing agent', () => {
    // Derived from the tracks rather than from the name `docs`: a closing agent
    // edits the tree the leader commits, and one that cannot re-run the suite
    // leaves the commit resting on a digest taken before its edits.
    const closing = [...new Set(Object.values(DEFAULT_TRACKS).flatMap((track) => track.closing))]
    expect(closing).not.toEqual([])
    for (const agent of closing) {
      expect(tools.get(agent), agent).toContain(VERIFY_TOOL)
    }
  })

  it('grants the verify tool to the verifying agent', () => {
    expect(tools.get('verifier')).toContain(VERIFY_TOOL)
  })

  it('grants it to nobody else', () => {
    // The engine's ledger is what makes a `pass` checkable, and it is a receipt
    // for what the *verdict* rests on. An agent that both edits and verifies
    // outside the closing pass would be judging its own work.
    const holders = [...tools].filter(([, granted]) => granted.includes(VERIFY_TOOL)).map(([name]) => name)
    expect(holders.sort()).toEqual(['docs', 'verifier'])
  })

  it('names no agent for a technology', () => {
    // S05's hard stop condition: dynamic skill selection changes what guidance
    // a fixed role receives, never the role itself. A `flutter-builder` or
    // `nextjs-builder` file is the one thing that could quietly undo that —
    // and nothing else would notice, because a technology-named agent is a
    // perfectly valid agent file on its own. Derived from
    // `ComponentTechnologySchema` rather than a hand-typed list here, so a
    // technology the schema gains later is covered without editing this test,
    // and one that never becomes real never manufactures a false failure.
    //
    // Matched as a *token* of the name rather than as a leading prefix, because
    // the stop condition forbids the duplicate agent and not one spelling of
    // it: `flutter-builder` is the obvious form, but `flutter_builder` and
    // `builder-flutter` are the same file under a different separator and the
    // same violation, and a guard that only saw the prefix would wave both
    // through. Splitting on the three separators an agent filename can carry
    // costs no false positive — no shipped role holds a technology name as a
    // token — while closing every rearrangement of one.
    for (const technology of ComponentTechnologySchema.options) {
      for (const agent of tools.keys()) {
        const named = agent.split(/[-_.]/).includes(technology)
        expect(named, `${agent} is named for the "${technology}" technology`).toBe(false)
      }
    }
  })

  it("names every MCP tool under the plugin's own server id", async () => {
    // The prefix hard-codes the server id the plugin install assigns. Attached
    // under any other id the name resolves to nothing, silently — which is why
    // `docs/install.md` states that mjloop must be installed as a plugin.
    const registered = await registeredTools()
    for (const [agent, granted] of tools) {
      for (const tool of granted) {
        if (!tool.startsWith('mcp__')) continue
        expect(tool.startsWith(SERVER_PREFIX), `${agent}: ${tool}`).toBe(true)
        expect(registered, `${agent}: ${tool}`).toContain(tool.slice(SERVER_PREFIX.length))
      }
    }
  })
})
