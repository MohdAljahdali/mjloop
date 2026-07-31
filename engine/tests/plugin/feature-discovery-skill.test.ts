import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../../src/mcp/server.js'
import { FeatureDiscoveryModeSchema, OrchestrationSchema } from '../../src/schemas/config.js'
import { acceptedRevisionFile } from '../../src/store/project-profile-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'

/**
 * The feature-discovery skill, asserted against the engine it is allowed to
 * touch — which is almost none of it.
 *
 * The second suite to read outside `engine/`, and it exists for the reason
 * `agents.test.ts` states in its own header: a tool a subagent was never
 * granted is *absent*, not an error, and a model that is told to call one
 * improvises instead. This skill is written before the records it will one day
 * write exist at all, so the failure it defends against is concrete: a sentence
 * naming `mjloop_feature_create` would read as instruction, resolve to nothing,
 * and be answered by a model inventing a file layout nobody designed.
 *
 * The rest of the suite defends the skill's boundary. Discovery interviews and
 * stops; the plan track's fit-check gate and human approval gate come after it.
 * A future edit that let this skill dispatch an agent, write a story, or open a
 * run would walk around both gates while every engine test stayed green,
 * because the engine is never called on that path.
 *
 * What this file does *not* claim: it cannot check that the skill's prose still
 * means what it meant. A rule can be reworded into uselessness with every
 * assertion here passing. So the wording is checked only where the text names
 * something the engine also names — a config key, a path, a tool, an agent, a
 * command, a field — and where it does not, the assertion is structural (the
 * rule is still a section, its bullets are still negations) and says so. An
 * assertion that pretended to read intent would be worse than an absent one.
 *
 * One structural check earns its place above the rest. The story's completion
 * evidence is that a test can reject an edit permitting this skill to plan,
 * route, or execute — and a heading that survives while its body is replaced
 * with the opposite instruction rejects nothing. So the boundary's bullets are
 * asserted to still be stated as prohibitions. That reads the shape of the
 * rule, not its meaning, and it does not stop a determined rewrite; it stops
 * the rewrite that actually happens.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SKILLS_DIR = path.join(REPO, 'skills')
const AGENTS_DIR = path.join(REPO, 'agents')
const COMMANDS_DIR = path.join(REPO, 'commands')
const SKILL_NAME = 'mjloop-feature-discovery'
const SKILL_FILE = path.join(SKILLS_DIR, SKILL_NAME, 'SKILL.md')
const PLAN_COMMAND = path.join(COMMANDS_DIR, 'plan.md')
const LEADER_SKILL = path.join(SKILLS_DIR, 'mjloop-leader', 'SKILL.md')

const skill = await fs.readFile(SKILL_FILE, 'utf8')
const planCommand = await fs.readFile(PLAN_COMMAND, 'utf8')
const leader = await fs.readFile(LEADER_SKILL, 'utf8')
const readme = await fs.readFile(path.join(REPO, 'README.md'), 'utf8')
const usage = {
  'docs/usage.md': await fs.readFile(path.join(REPO, 'docs', 'usage.md'), 'utf8'),
  'docs/usage.ar.md': await fs.readFile(path.join(REPO, 'docs', 'usage.ar.md'), 'utf8'),
}

/** Every agent this plugin can dispatch, from the directory rather than a list that drifts. */
const agentNames = (await fs.readdir(AGENTS_DIR))
  .filter((name) => name.endsWith('.md'))
  .map((name) => path.basename(name, '.md'))

/** Every slash command it can run, derived the same way and for the same reason. */
const commandNames = (await fs.readdir(COMMANDS_DIR))
  .filter((name) => name.endsWith('.md'))
  .map((name) => path.basename(name, '.md'))

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

/**
 * The `` `token` `` and `**token**` spans — both forms this repository's prose
 * uses to name a thing.
 *
 * Backticks alone were not enough: `commands/design-sync.md` writes "dispatch
 * the **ui-designer** agent", and `commands/plan.md` names its skills in bold
 * too, so bold is the shape a dispatch instruction actually takes here. A bare
 * word is deliberately not matched — `docs` is an agent, and this skill's own
 * "its usage docs" would read as one.
 */
function emphasisedIn(source: string): string[] {
  const spans = source.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)
  return [...new Set([...spans].map((match) => match[1] ?? match[2] ?? ''))]
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

/** A document without its fenced examples, which are configuration and are checked as such. */
const prose = (source: string): string => source.replace(/```[\s\S]*?```/g, '')

/**
 * The blocks a document reads as one statement: a paragraph, or a single table
 * row. A table is not one statement — every setting this project has is in one
 * table, and a claim about the question budget is in one row of it.
 */
function statements(source: string): string[] {
  return source
    .split(/\n\s*\n/)
    .flatMap((block) => (block.trimStart().startsWith('|') ? block.split('\n') : [block]))
}

/** Each markdown table, as the backticked keys in its first column. */
function tableKeys(source: string): string[][] {
  const tables: string[][] = []
  let current: string[] | null = null
  for (const line of source.split('\n')) {
    if (line.startsWith('|')) {
      current ??= []
      const key = /^\|\s*`([^`]+)`\s*\|/.exec(line)
      if (key !== null) current.push(key[1] ?? '')
    } else if (current !== null) {
      tables.push(current)
      current = null
    }
  }
  return current === null ? tables : [...tables, current]
}

describe('the feature discovery skill', () => {
  it('carries the frontmatter the plugin loader and its siblings require', async () => {
    // The convention is derived from the skills that already ship rather than
    // typed here: a loader that resolves a skill by directory silently loses
    // one whose `name` says something else.
    const dirs = (await fs.readdir(SKILLS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(dirs).toContain(SKILL_NAME)
    for (const dir of dirs) {
      const parsed = frontmatter(await fs.readFile(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8'))
      expect(parsed.name, dir).toBe(dir)
      expect(parsed.description ?? '', dir).toMatch(/^Use when /)
    }
  })

  it('names no MCP tool the engine does not register', () => {
    // The assertion that matters most, and the one that catches the S04 seam.
    // The feature-brief records and their MCP operations do not exist yet; a
    // skill that named `mjloop_feature_create` today would instruct a model to
    // call a tool it was never granted, and the tool would simply be missing.
    // When S04 registers them, this test goes green on its own and the author
    // finds the seam rather than the seam finding them.
    expect(toolsNamedIn(skill).filter((tool) => !registered.has(tool))).toEqual([])
  })

  it('names no engine tool at all, so it can neither plan, route, run, nor write', () => {
    // The tools that would break the boundary outright, named so that a reader
    // sees what is at stake and so that a rename in the engine fails here
    // rather than quietly emptying a filter.
    const anchors = ['mjloop_run_start', 'mjloop_cycle_advance', 'mjloop_roster_set', 'mjloop_gate_set', 'mjloop_verify_run', 'mjloop_halt', 'mjloop_plan_create', 'mjloop_story_add']
    for (const anchor of anchors) expect(registered, anchor).toContain(anchor)
    // The assertion itself is inverted, though, because enumerating what is
    // forbidden leaves everything nobody thought of permitted. The prefix-and-
    // anchor filter this replaces covered eleven of the registered tools and
    // left `mjloop_memory_add`, `mjloop_index_render` and `mjloop_init`
    // allowed — all three writers, and `memory_add` is the tempting one:
    // persisting a brief with it is exactly the shortcut this skill must not
    // take while the feature-brief records are unwritten.
    //
    // The skill's own sentence is the standard — it "reads files and asks
    // questions; it writes nothing" — so the allowlist is empty. S04 opens the
    // seam by adding to it deliberately rather than by finding a gap in it.
    const READ_ONLY_TOOLS: string[] = []
    expect(toolsNamedIn(skill).filter((tool) => !READ_ONLY_TOOLS.includes(tool))).toEqual([])
  })

  it('names no agent', () => {
    // Discovery ends by presenting a draft. It dispatches nobody, so it has no
    // reason to name anybody — and the check is symmetric on purpose: a
    // sentence saying "never dispatch `builder`" fails this too. That is the
    // price of an assertion that cannot read intent, and it is the right way
    // round, because the skill states its boundary without naming a roster.
    expect(emphasisedIn(skill).filter((token) => agentNames.includes(token))).toEqual([])
  })

  it('names no slash command', () => {
    // The execution surface neither check above can see. `/mjloop:build` holds
    // no `mjloop_` token and is not an agent, so "run `/mjloop:build` on the
    // draft once it is approved" reads as an instruction, starts a run, and
    // passes every other assertion in this file. Derived from `commands/`, so
    // a command added later is covered without this list being touched.
    expect(commandNames.filter((name) => skill.includes(`/mjloop:${name}`))).toEqual([])
  })

  it('names no mjloop-cli subcommand that writes', () => {
    // And the other one. `mjloop-cli profile accept` activates a component map
    // for every later run — `cli/index.ts` calls these the only way a person
    // decides what this project is made of, and `web/writes.ts` denies the same
    // class of write to the browser permanently. Discovery reads the map; it
    // does not get to accept one.
    //
    // The allowlist is hand-written and has to be: the engine carries no marker
    // saying which subcommand only reads. Adding to it is therefore a
    // deliberate act, which is the point of it.
    const READ_ONLY_CLI = ['config get', 'profile show']
    const invoked = [...new Set([...skill.matchAll(/mjloop-cli ([a-z-]+(?: [a-z-]+)?)/g)].map((match) => match[1] ?? ''))]
    expect(invoked.filter((command) => !READ_ONLY_CLI.includes(command))).toEqual([])
  })

  it('points at the records it must read before its first question', () => {
    // Paths and config keys are the one part of the prose a paraphrase cannot
    // defeat, and each is derived from the engine that owns it — so a skill
    // that documents a directory the engine does not write, or a setting the
    // schema does not have, fails here.
    const accepted = path.relative(REPO, acceptedRevisionFile(REPO, 1)).replace(/rev-\d+\.json$/, '')
    const config = path.relative(REPO, resolveLoopPaths(REPO).config)
    expect(skill).toContain(accepted)
    expect(skill).toContain(config)
    // The budget is a real setting: prove the engine has it, then prove the
    // skill names it by its dotted path rather than describing it.
    expect(typeof OrchestrationSchema.parse({}).discovery.question_budget).toBe('number')
    expect(skill).toContain('orchestration.discovery.question_budget')
  })

  it('still carries every rule the story requires, one section each', () => {
    // Structural, and deliberately not more: this proves each rule is still
    // present as its own section, and proves nothing about whether its prose
    // still says what it said. Deleting the interview's shape is what this
    // catches; hollowing it out is what no text assertion can.
    const rules = [...section(skill, '## The rules').matchAll(/^### (.+)$/gm)].map((match) => match[1] ?? '')
    expect(rules).toEqual([
      'Look up the facts, ask only the decisions',
      'One question per turn, each with a recommendation',
      'The question budget is a ceiling',
      'Do not plan, route, or execute',
      'The draft',
      'Stop until the user approves',
    ])
  })

  it('states its boundary as prohibitions rather than as permissions', () => {
    // The one rule whose body is read, because it is the rule the story's
    // completion evidence names. Heading equality alone let that body be
    // replaced with its exact opposite — draft the plan yourself, pick the
    // specialists, dispatch them, start the run — with the heading kept and
    // every assertion in this file still green, which is the edit the header
    // says this suite exists to reject.
    //
    // Structural like the assertion above, but over the polarity that carries
    // the rule instead of over a heading string. It pins these bullets to a
    // negative form, so a later author rewording one has to mean it; and it
    // does not stop a rewrite determined enough to negate the sentence and
    // then except its way out. It stops the rewrite that actually happens.
    const boundary = bullets(section(skill, '### Do not plan, route, or execute'))
    expect(boundary.length).toBeGreaterThan(0)
    expect(boundary.filter((rule) => !/^- No /.test(rule))).toEqual([])
  })

  it('shapes the draft with exactly the fields S04 will persist', () => {
    // S04 (`engine/src/schemas/feature.ts`) introduces `FeatureBrief` with
    // these five field names. They cannot be imported yet — the schema does not
    // exist — so they are written here, and this comment is the pointer that
    // makes the duplication findable when it does.
    const FEATURE_BRIEF_FIELDS = ['title', 'problem', 'decisions', 'acceptance', 'affectedComponents']
    const fence = [...skill.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? '')
      .find((body) => body.startsWith('Feature Brief Draft'))
    expect(fence, 'the skill has no named draft block').toBeDefined()
    const fields = [...(fence ?? '').matchAll(/^([A-Za-z]\w*):/gm)].map((match) => match[1] ?? '')
    // Ordered equality: an extra field is a record S04 cannot store, and a
    // missing one is an output the plan track will not receive.
    expect(fields).toEqual(FEATURE_BRIEF_FIELDS)
  })

  it('records where its behaviour came from', () => {
    // The master plan requires source attribution for the upstream skill this
    // adapts. Only the source is asserted — a licence claim is a legal
    // statement and belongs to whoever verified it, not to a substring match.
    expect(skill).toContain('mattpocock/skills')
    expect(skill).toContain('https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md')
  })
})

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
    const always = bullets(planCommand).find((rule) => rule.startsWith('- **`always`**')) ?? ''
    expect(always).toContain(SKILL_NAME)
  })

  it('branches on exactly the discovery modes the schema declares', () => {
    // Imported, not retyped, the way `locales.test.ts` asserts its families
    // against their engine schema: a fourth mode added to `config.ts` fails
    // here rather than being silently undocumented, and a mode documented
    // after the schema dropped it fails here too.
    const documented = [...planCommand.matchAll(/^- \*\*`([a-z-]+)`\*\* —/gm)].map((match) => match[1] ?? '')
    expect(documented.sort()).toEqual([...FeatureDiscoveryModeSchema.options].sort())
  })

  it("calls the engine's own default the default", () => {
    // The compatibility promise of this whole feature is that an existing
    // project's plan flow is unchanged. A command that documented a different
    // branch as the default would be describing a flow nobody configured.
    const fallback = OrchestrationSchema.parse({}).discovery.mode
    const line = planCommand.split('\n').find((text) => text.startsWith(`- **\`${fallback}\`**`)) ?? ''
    expect(line).toMatch(/default/)
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

describe('the leader skill', () => {
  it('names no MCP tool the engine does not register', () => {
    expect(toolsNamedIn(leader).filter((tool) => !registered.has(tool))).toEqual([])
  })

  it('takes an approved brief as the plan track input', () => {
    // `\s+` rather than a space: the phrase is hard-wrapped prose, and where a
    // line breaks is not a fact about what the leader was told to do.
    //
    // This proves the plan track's own section names the brief as its input. It
    // cannot prove the leader obeys — nothing outside a live run can — so the
    // enforceable half is the prohibition below, which is the form this file
    // states its rules in.
    expect(section(leader, '### 3d. Running the plan track')).toMatch(/approved\s+(feature\s+)?brief/i)
  })

  it('gained a prohibition naming feature discovery', () => {
    const forbidden = bullets(section(leader, '## What you never do'))
    expect(forbidden.length).toBeGreaterThan(0)
    expect(forbidden.filter((rule) => /discovery/i.test(rule) && /brief/i.test(rule))).not.toEqual([])
  })
})

describe('the usage documentation', () => {
  // The story asks for the same three modes in English and in Arabic, and a
  // parity check made by hand once is precisely what drifts: `locales.test.ts`
  // exists one directory over for that reason. Nothing here reads a heading or
  // a sentence — the tables are found by the mode ids and the setting keys the
  // engine owns — so the assertion holds for a language it cannot read, and a
  // fourth mode added to the schema fails in both files rather than in the one
  // whoever added it happened to update.
  const modes = [...FeatureDiscoveryModeSchema.options].sort()
  const defaults = OrchestrationSchema.parse({}).discovery

  /** The bounds the schema enforces, found by probing it rather than by reading its source. */
  const accepted = [...Array(64).keys()].filter(
    (budget) => OrchestrationSchema.safeParse({ discovery: { question_budget: budget } }).success,
  )
  const budget = [accepted[0] ?? 0, accepted[accepted.length - 1] ?? 0, defaults.question_budget]

  for (const [label, doc] of Object.entries(usage)) {
    it(`${label} documents exactly the modes the schema declares`, () => {
      // The mode table is the one whose first column holds the default mode;
      // the settings reference lists the same three again, in its own row, and
      // a second copy that nobody checks is a second copy that goes stale.
      const table = tableKeys(doc).find((keys) => keys.includes(defaults.mode))
      expect(table, `${label} has no table of discovery modes`).toBeDefined()
      expect([...new Set(table)].sort(), label).toEqual(modes)

      const row = doc.split('\n').find((line) => /^\|\s*`[a-z.]*discovery\.mode`/.test(line)) ?? ''
      const cells = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
      expect(cells[1], `${label}: the settings reference states the wrong default`).toBe(defaults.mode)
      expect([...new Set(cells.slice(2))].sort(), label).toEqual(modes)
    })

    it(`${label} states the question budget the schema enforces`, () => {
      // Every prose claim about the budget carries all three numbers the schema
      // decides — the bounds and the default — and nothing else, so a doc that
      // says 3–40 in one language and 1–20 in the other fails in the language
      // that drifted. The fenced examples are configuration and are checked as
      // configuration: they show the default, because that is what a project
      // that has not chosen gets.
      const claims = statements(prose(doc)).filter((block) => block.includes('question_budget'))
      expect(claims.length, `${label} never states the budget`).toBeGreaterThan(0)
      for (const claim of claims) {
        const numbers = [...new Set([...claim.matchAll(/\d+/g)].map((match) => Number(match[0])))]
        expect(numbers.sort((a, b) => a - b), claim).toEqual([...budget].sort((a, b) => a - b))
      }
      const shown = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
        .flatMap((fence) => [...(fence[1] ?? '').matchAll(/^\s*question_budget:\s*(\d+)/gm)])
        .map((match) => Number(match[1]))
      expect(shown.length, `${label} shows no example config`).toBeGreaterThan(0)
      expect([...new Set(shown)], label).toEqual([defaults.question_budget])
    })
  }

  it('names the discovery skill this plugin ships', () => {
    // The README is where a reader meets this feature first, and it names the
    // skill by name. What it cannot be asserted on is whether its summary of
    // each mode is still true — that is a claim about meaning, and this file
    // says why it does not pretend to check those.
    expect(readme).toContain(SKILL_NAME)
  })
})
