import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../../src/mcp/server.js'
import { DiscoveryCompletionSchema, FeatureDiscoveryModeSchema, OrchestrationSchema } from '../../src/schemas/config.js'

/**
 * The plugin's slash commands, asserted against the engine and against each
 * other's frontmatter — not the feature-discovery skill's boundary, which is
 * `feature-discovery-skill.test.ts`'s own job.
 *
 * `commands/plan.md`'s checks moved here whole, and `commands/run.md`'s
 * frontmatter check — added when `/mjloop:run` shipped so a track built from
 * the dashboard's Tracks tab had something to open it by name, and dropped at
 * the time into the feature-discovery file because `/mjloop:plan`'s own
 * frontmatter check already lived there — moved with them. Neither is a check
 * on discovery: a command's frontmatter is what the plugin loader reads to
 * register it at all, and `/mjloop:run` does not name the feature-discovery
 * skill, dispatch it, or read its output. A file whose header says it defends
 * one skill's boundary is the wrong place for either.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const COMMANDS_DIR = path.join(REPO, 'commands')
const SKILL_NAME = 'mjloop-feature-discovery'
const PLAN_COMMAND = path.join(COMMANDS_DIR, 'plan.md')

/**
 * The plan command's two policy branches, by heading.
 *
 * They are read separately because they are different settings that happen to
 * be documented in the same bullet shape: one decides whether an interview
 * happens, the other decides what happens to what it produced. A scan over the
 * whole document would read `always | ask | off | auto-plan | review |
 * save-only` as one list and match neither schema.
 */
const DISCOVERY_SECTION = '## Before the plan track: the discovery branch'
const COMPLETION_SECTION = '## After the brief: the completion branch'

const planCommand = await fs.readFile(PLAN_COMMAND, 'utf8')

async function registeredTools(): Promise<Set<string>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([buildServer().connect(serverTransport), client.connect(clientTransport)])
  const { tools } = await client.listTools()
  return new Set(tools.map((tool) => tool.name))
}

const registered = await registeredTools()

/** Every engine tool a document names, however it is quoted. */
function toolsNamedIn(source: string): string[] {
  return [...new Set([...source.matchAll(/mjloop_[a-z_]+/g)].map((match) => match[0]))].sort()
}

/** The frontmatter block, parsed as the flat `key: value` map the plugin loader reads. */
function frontmatter(source: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** The body under one heading, up to the next heading of the same or higher level. */
function section(source: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2
  const start = source.indexOf(`${heading}\n`)
  if (start < 0) return ''
  const rest = source.slice(start + heading.length)
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/**
 * Whole bullets, continuation lines included.
 *
 * A single-line match would make every assertion below depend on where the
 * prose happens to wrap, which is not a fact about the rule it states.
 * Sub-bullets are indented and so do not split.
 */
const bullets = (source: string): string[] => source.split(/^- /m).slice(1).map((entry) => `- ${entry.trimEnd()}`)

describe('the plan command', () => {
  it('names no MCP tool the engine does not register', () => {
    expect(toolsNamedIn(planCommand).filter((tool) => !registered.has(tool))).toEqual([])
  })

  it('enters discovery by the name of a skill this plugin ships', () => {
    // The header's failure one level up from tools: a command that names a
    // skill no directory provides does not error either. The model improvises
    // an interview with none of the rules the skill states, and every assertion
    // about the skill's text keeps passing, because the skill is still there —
    // it is simply not what ran.
    //
    // `always` is the branch that enters discovery, so the name has to be in
    // that bullet and not merely somewhere in the file. That the directory
    // exists is proved by the module-level read of `SKILL_FILE` above: a
    // renamed skill makes this whole suite fail to load.
    const always = bullets(section(planCommand, DISCOVERY_SECTION)).find((rule) => rule.startsWith('- **`always`**')) ?? ''
    expect(always).toContain(SKILL_NAME)
  })

  it('branches on exactly the discovery modes the schema declares', () => {
    // Imported, not retyped, the way `locales.test.ts` asserts its families
    // against their engine schema: a fourth mode added to `config.ts` fails
    // here rather than being silently undocumented, and a mode documented
    // after the schema dropped it fails here too.
    //
    // Read from the discovery branch's own section rather than from the whole
    // file, because the completion branch below states its three settings in
    // the same bullet shape and a document-wide scan would read the two lists
    // as one six-valued setting. A renamed heading empties the match and fails
    // here, which is the right outcome for a document whose two branches this
    // suite is asserting separately.
    const documented = [...section(planCommand, DISCOVERY_SECTION).matchAll(/^- \*\*`([a-z-]+)`\*\* —/gm)].map((match) => match[1] ?? '')
    expect(documented.sort()).toEqual([...FeatureDiscoveryModeSchema.options].sort())
  })

  it('branches on exactly the completion settings the schema declares', () => {
    // `orchestration.discovery.completion` was dead policy when S03 landed:
    // the schema had it, the docs listed it, and nothing read it. This is the
    // assertion that says it is a branch of this command now, and it is
    // derived from the same schema for the same reason as the modes above.
    const documented = [...section(planCommand, COMPLETION_SECTION).matchAll(/^- \*\*`([a-z-]+)`\*\* —/gm)].map((match) => match[1] ?? '')
    expect(documented.sort()).toEqual([...DiscoveryCompletionSchema.options].sort())
  })

  it('starts auto-plan only against an approved brief', () => {
    // The one completion branch that begins work without asking, and so the
    // one sentence in this file whose loss would let a plan track open against
    // decisions nobody agreed to. Structural, like the skill's boundary
    // assertion: it reads that the bullet still turns on approval, not that
    // the prose around it still means what it means.
    const autoPlan = bullets(section(planCommand, COMPLETION_SECTION)).find((rule) => rule.startsWith('- **`auto-plan`**')) ?? ''
    expect(autoPlan, 'auto-plan no longer names approval').toMatch(/approved/)
  })

  it("calls the engine's own default the default, in both branches", () => {
    // The compatibility promise of this whole feature is that an existing
    // project's plan flow is unchanged. A command that documented a different
    // branch as the default would be describing a flow nobody configured —
    // and that holds for what happens after a brief exactly as it holds for
    // whether one is produced at all.
    const { mode, completion } = OrchestrationSchema.parse({}).discovery
    for (const fallback of [mode, completion]) {
      const line = planCommand.split('\n').find((text) => text.startsWith(`- **\`${fallback}\`**`)) ?? ''
      expect(line, fallback).toMatch(/default/)
    }
  })

  it('keeps both existing gates and its frontmatter', () => {
    // This file was added to, not rewritten. The two gates are the plan track's
    // safety, and discovery is explicitly not a third one.
    expect(planCommand).toContain('The fit-check gate')
    expect(planCommand).toContain('The approval gate')
    const parsed = frontmatter(planCommand)
    expect(parsed.description ?? '').not.toBe('')
    expect(parsed['argument-hint'] ?? '').not.toBe('')
  })
})

describe('the run command', () => {
  it('carries the frontmatter every command needs, the same way the plan command does', async () => {
    // `/mjloop:run` is the command this task adds so a track built from the
    // dashboard has something to open it. The plugin loader reads every
    // command the same way, so the check is the same one `commands/plan.md`
    // already gets above — this file just points it at the new file.
    const runCommand = await fs.readFile(path.join(COMMANDS_DIR, 'run.md'), 'utf8')
    const parsed = frontmatter(runCommand)
    expect(parsed.description ?? '').not.toBe('')
    expect(parsed['argument-hint'] ?? '').not.toBe('')
  })
})
