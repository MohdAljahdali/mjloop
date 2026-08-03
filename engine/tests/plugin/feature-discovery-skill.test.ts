import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../../src/mcp/server.js'
import { DiscoveryCompletionSchema, FeatureDiscoveryModeSchema, OrchestrationSchema } from '../../src/schemas/config.js'
import { FeatureBriefSchema } from '../../src/schemas/feature.js'
import { acceptedRevisionFile } from '../../src/store/project-profile-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'

/**
 * The feature-discovery skill, asserted against the engine it is allowed to
 * touch — which is almost none of it.
 *
 * The second suite to read outside `engine/`, and it exists for the reason
 * `agents.test.ts` states in its own header: a tool a subagent was never
 * granted is *absent*, not an error, and a model that is told to call one
 * improvises instead. That was the whole of it while the feature-brief records
 * were unwritten — a sentence naming `mjloop_feature_create` resolved to
 * nothing and was answered by a model inventing a file layout nobody designed.
 * S04 registered those four operations, so the danger inverted rather than
 * going away: the skill names tools now, every name in it resolves, and the
 * question this file answers is whether the ones it names are the four its
 * boundary admits. A fifth would not fail silently — it would work.
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
    // Still the first thing asked, and it now bites on a real name rather than
    // on the absence of all of them: a skill that told a model to call
    // `mjloop_feature_upsert` would be naming an operation this project
    // considered and did not build, and the model would improvise the nearest
    // thing it could reach.
    expect(toolsNamedIn(skill).filter((tool) => !registered.has(tool))).toEqual([])
  })

  it('names only the four feature-brief tools, so it can neither plan, route, nor run', () => {
    // The tools that would break the boundary outright, named so that a reader
    // sees what is at stake and so that a rename in the engine fails here
    // rather than quietly emptying a filter.
    const anchors = ['mjloop_run_start', 'mjloop_cycle_advance', 'mjloop_roster_set', 'mjloop_gate_set', 'mjloop_verify_run', 'mjloop_halt', 'mjloop_plan_create', 'mjloop_story_add']
    for (const anchor of anchors) expect(registered, anchor).toContain(anchor)
    // The assertion itself is inverted, though, because enumerating what is
    // forbidden leaves everything nobody thought of permitted. The prefix-and-
    // anchor filter this replaces covered eleven of the registered tools and
    // left `mjloop_memory_add`, `mjloop_index_render` and `mjloop_init`
    // allowed — all three writers, and `memory_add` is still the tempting one:
    // a brief persisted there is a record with no revision, no approval and no
    // immutability, which is every property `.mjloop/features/` exists to give
    // it.
    //
    // The allowlist was empty until S04, because the skill wrote nothing. It is
    // now exactly the four operations that open a brief, fill it in, read one
    // back and record the user's approval of it — hand-written for the reason
    // the CLI allowlist below is hand-written: the engine carries no marker
    // saying which of its tools this skill's boundary admits, so a fifth is a
    // deliberate edit here rather than a gap somebody found in a prefix match.
    // Why each is on it:
    //
    // - `_get` — the interview reads earlier briefs before its first question.
    //   A decision the user already made is a fact, and this is the only way to
    //   see one.
    // - `_create` — the brief is the skill's entire output. Writing down what
    //   the user decided is not planning, routing or executing: the record
    //   names no approach, no agent, no skill and no command.
    // - `_update` — a decision is recorded as it is made rather than batched at
    //   the end, so an interrupted interview resumes instead of being re-asked.
    // - `_approve` — approval is the user's word in this conversation, and this
    //   skill is the only thing present to hear it. The leader is forbidden it
    //   (asserted below) and the cockpit's copy is a person clicking, so a
    //   skill that could not record an approval would leave the browser as the
    //   only way an approved brief ever comes into existence.
    const FEATURE_BRIEF_TOOLS = ['mjloop_feature_approve', 'mjloop_feature_create', 'mjloop_feature_get', 'mjloop_feature_update']
    // Proved against the server, so a rename there fails here instead of
    // widening the allowlist to a tool nobody registers.
    for (const tool of FEATURE_BRIEF_TOOLS) expect(registered, tool).toContain(tool)
    expect(toolsNamedIn(skill).filter((tool) => !FEATURE_BRIEF_TOOLS.includes(tool)), 'a tool this skill may not call').toEqual([])
    // And exactly those four, not some subset of them. A skill that stopped
    // naming `_approve` would present a draft nobody can approve, and one that
    // stopped naming `_get` would ask the user a question they answered in an
    // earlier brief — both read as tidying, and each re-opens a debt S04 closed.
    expect(toolsNamedIn(skill), 'the four it must name').toEqual(FEATURE_BRIEF_TOOLS)
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

  it('shapes the draft with exactly the fields a stored brief carries', () => {
    // The previous version of this test retyped the field list and left a
    // comment saying why: `engine/src/schemas/feature.ts` did not exist. It
    // does now, so the list is imported from the schema that stores it and the
    // duplication is closed.
    //
    // Seven of the thirteen fields are minted by the engine, and a draft
    // presented in a conversation cannot know them: it has no id or revision
    // until `mjloop_feature_create` returns, its status and approval are the
    // engine's answer rather than its own claim, and `schema`, `supersedes` and
    // `createdAt` are bookkeeping nobody approves. They are excluded by name,
    // so a field added to the schema later fails here until somebody decides
    // which of the two lists it joins.
    const stored = Object.keys(FeatureBriefSchema.shape)
    const MINTED = ['schema', 'id', 'revision', 'status', 'approval', 'supersedes', 'createdAt']
    expect(stored.filter((field) => MINTED.includes(field)), 'a minted field the schema no longer has').toEqual(MINTED)

    const fence = [...skill.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? '')
      .find((body) => body.startsWith('Feature Brief Draft'))
    expect(fence, 'the skill has no named draft block').toBeDefined()
    const fields = [...(fence ?? '').matchAll(/^([A-Za-z]\w*):/gm)].map((match) => match[1] ?? '')
    // Ordered equality, in the schema's own order: an extra field is a record
    // the engine cannot store, and a missing one is an output the plan track
    // will not receive. `discovery` is the field S04 added — it is where a
    // per-feature override of the project's mode is written down, and without
    // it in this block the interview has nowhere to put one.
    expect(fields).toEqual(stored.filter((field) => !MINTED.includes(field)))
  })

  it('tells the interview that a tag is declared by the user and never inferred from prose', () => {
    // The field-list assertion above proves `tags` is *presented*. It cannot
    // prove the interview ever produces one, and a field nobody is told to ask
    // about is a field that stays empty forever: `tags` is the only join key
    // that can reach a cross-cutting skill — a component's `skillTags` are
    // derived from its technology and can never carry `security` — so a
    // discovery skill that never elicits one makes that whole branch of
    // selection unreachable through the only surface allowed to write a brief.
    //
    // The polarity is asserted as well as the presence, because the wrong way
    // to fill this field is worse than leaving it empty: a skill that inferred
    // a tag from the `problem` text would be making exactly the free-form model
    // claim `ops/skill-selection.ts` refuses to route on.
    const rules = section(skill, '### The draft')
    expect(rules, 'the draft section says nothing about tags').toMatch(/\btags\b/)
    expect(rules).toMatch(/never inferred|not inferred|never infer/)
    // And it has to be writable: `mjloop_feature_update` is the only call that
    // takes `tags`, so the step that lists that call's fields must name it or
    // an interview that decided on a tag has nowhere to put it.
    expect(section(skill, '## The record this writes')).toMatch(/`tags`/)
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

  /**
   * `## What you never do`, read the way the skill's own boundary is read.
   *
   * A filter on the words a rule contains is not enough here, and the proof is
   * cheap: rewriting *Never approve a feature brief* into *Approve the feature
   * brief when it looks right* leaves both words in place, and a
   * contains-check goes green on the exact edit the rule exists to reject. So
   * the polarity is asserted over the whole list — it is titled "what you never
   * do", every one of its eighteen entries is stated that way, and a bullet
   * that stopped being a prohibition would be in the wrong list even if its
   * advice were sound.
   */
  const neverDo = (): string[] => {
    const forbidden = bullets(section(leader, '## What you never do'))
    expect(forbidden.length, 'the leader has no list of prohibitions').toBeGreaterThan(0)
    expect(forbidden.filter((rule) => !/^- (\*\*)?Never /.test(rule)), 'stated as permission').toEqual([])
    return forbidden
  }

  it('gained a prohibition naming feature discovery', () => {
    expect(neverDo().filter((rule) => /discovery/i.test(rule) && /brief/i.test(rule))).not.toEqual([])
  })

  it('tells the leader to pass plan and story into the memory it records', () => {
    // The cockpit's Plan Memory drawer (`panels/plans.js`'s `planMemories`)
    // joins a memory to a plan on the memory's own `plan`/`story` fields, not
    // on a text match — but `mjloop_memory_add` defaults both to null, and the
    // leader is the only caller of it. A `### Memory` section that forgot to
    // say "pass them" is a drawer with a join and no producer, which is
    // exactly the defect this test exists to keep fixed: it went unnoticed
    // once already, because nothing outside a live run can prove the leader
    // obeys prose, only that the prose still says it.
    const memory = section(leader, '### Memory')
    expect(memory).toMatch(/\bmjloop_run_start\b/)
    expect(memory).toMatch(/\bplan\b/)
    expect(memory).toMatch(/\bstory\b/)
  })

  it('is forbidden from approving a brief itself', () => {
    // The prohibition S04 adds, and the reason it has to be written down: the
    // leader holds `mjloop_feature_approve` — every tool this server registers
    // is in its context — and the brief it would approve is the input to the
    // plan it is about to write. Unlike `gates.plan_approval` there is no
    // `auto` here that would make doing it honest, so the rule is absolute and
    // the assertion is separate from the discovery one above: they forbid two
    // different acts, and a rewrite that merged them into one bullet would be
    // dropping one of them.
    expect(neverDo().filter((rule) => /brief/i.test(rule) && /approv/i.test(rule))).not.toEqual([])
  })

  it('dispatches the waves mjloop_roster_set returns', () => {
    // C2's whole leader-facing half is prose nothing asserted: a revert of the
    // dispatch step back to a hardcoded ordering left the full suite green
    // (the reviewer that found this proved it by reverting the file wholesale
    // and re-running the suite). This is the emission-side guard the finding
    // asked for — it fails the moment step 4 stops presenting `waves` as the
    // dispatch order, the same way the section below fails the moment ordering
    // prose about a specific agent creeps back in.
    expect(section(leader, '### 4. Dispatch')).toMatch(/\bwaves\b/)
  })

  it('names no agent-to-agent ordering in prose — that lives in `config.yaml` now', () => {
    // The other half of the same guard: C2's point was that a project renames
    // or drops `ui-designer`/`ui-critic`/`verifier` by editing
    // `DEFAULT_TRACKS`, not by editing English the engine cannot check. A
    // sentence of the shape "X runs before/after Y" naming one of the three
    // agents `order` now encodes is exactly the prose C2 deleted from these
    // two sections — its return is undetectable by every other test in this
    // file, which only check that tools and headings still exist.
    const orderingProse = /\b(ui-designer|ui-critic|verifier)\b[^.\n]*\bruns\s+(before|after)\b/i
    expect(section(leader, '### 4. Dispatch')).not.toMatch(orderingProse)
    expect(section(leader, '### Drafting the specialists')).not.toMatch(orderingProse)
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
