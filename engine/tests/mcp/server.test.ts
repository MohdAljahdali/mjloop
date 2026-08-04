import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, resolveProjectDir } from '../../src/mcp/server.js'
import { gateSet } from '../../src/ops/plan.js'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { readFeatureRevision } from '../../src/store/feature-store.js'
import { acceptProfile } from '../../src/store/project-profile-store.js'
import { readPolicy } from '../../src/store/quality-store.js'
import { writePackage } from '../../src/store/skill-library-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let client: Client

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer()
  const c = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)])
  return c
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.map((part) => part.text ?? '').join('')
}

function properties(inputSchema: unknown): Record<string, unknown> {
  return (inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

/** A passing `build` cycle, which is the only precondition of a closing pass. */
async function passingBuildRun(): Promise<{ runId: string; closingAgents: string[] }> {
  await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
  await client.callTool({
    name: 'mjloop_run_start',
    arguments: { project_dir: project.dir, track: 'build', goal: 'Add the export button' },
  })
  await client.callTool({
    name: 'mjloop_roster_set',
    arguments: {
      project_dir: project.dir,
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: {
        scout: 'One file, already read.',
        critic: 'The change is three lines.',
        'ui-designer': 'No new surface.',
        'ui-critic': 'No new surface.',
        security: 'No input crosses a boundary.',
        perf: 'No hot path.',
      },
    },
  })
  await client.callTool({
    name: 'mjloop_run_log',
    arguments: {
      project_dir: project.dir,
      agent: 'verifier',
      result: {
        status: 'pass',
        summary: 'The suite is green with the button in place.',
        evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
        findings: [],
        files_touched: ['src/Export.tsx'],
      },
    },
  })
  const advanced = await client.callTool({
    name: 'mjloop_cycle_advance',
    arguments: { project_dir: project.dir, agents: ['builder', 'verifier'], result: 'pass' },
  })
  const payload = JSON.parse(textOf(advanced))
  return { runId: payload.state.run_id, closingAgents: payload.closing_agents }
}

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  client = await connect()
})
afterEach(async () => {
  await client.close()
  await project.cleanup()
})

describe('resolveProjectDir', () => {
  it('prefers the explicit argument', () => {
    expect(resolveProjectDir('/tmp/explicit')).toBe('/tmp/explicit')
  })

  it('falls back to CLAUDE_PROJECT_DIR then cwd', () => {
    const previous = process.env.CLAUDE_PROJECT_DIR
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env'
    expect(resolveProjectDir()).toBe('/tmp/from-env')
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveProjectDir()).toBe(process.cwd())
    if (previous !== undefined) process.env.CLAUDE_PROJECT_DIR = previous
  })
})

describe('MCP surface', () => {
  // Every declaration here is a permanent per-turn cost, present in every
  // context this server is attached to, for the leader and every subagent. The
  // list is asserted exactly so that adding a tool is a deliberate edit to a
  // budget rather than a side effect of writing an op.
  it('exposes exactly the twenty-two tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mjloop_cycle_advance',
      'mjloop_feature_approve',
      'mjloop_feature_create',
      'mjloop_feature_get',
      'mjloop_feature_update',
      'mjloop_gate_set',
      'mjloop_halt',
      'mjloop_index_render',
      'mjloop_init',
      'mjloop_memory_add',
      'mjloop_memory_get',
      'mjloop_memory_search',
      'mjloop_plan_create',
      'mjloop_report_get',
      'mjloop_roster_set',
      'mjloop_run_log',
      'mjloop_run_start',
      'mjloop_state_get',
      'mjloop_story_add',
      'mjloop_story_get',
      'mjloop_story_update',
      'mjloop_verify_run',
    ])
  })

  // Telemetry and preflight are two projections of one `readRunHistory` walk,
  // so they share one tool. A test that only counted eighteen would pass if a
  // later edit split them back into two and dropped something else.
  it('serves both report projections through one tool', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names.filter((name) => name.startsWith('mjloop_report'))).toEqual(['mjloop_report_get'])
    expect(names).not.toContain('mjloop_telemetry_get')
    expect(names).not.toContain('mjloop_preflight_get')
  })

  // The feature-brief store has eight entry points and this surface has four,
  // so the same test the report projections get: a bare count of twenty-two
  // would still pass if a later edit split `create` back into two tools and
  // dropped something else to pay for it.
  it('serves the whole feature-brief lifecycle through four tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names.filter((name) => name.startsWith('mjloop_feature')).sort()).toEqual([
      'mjloop_feature_approve',
      'mjloop_feature_create',
      'mjloop_feature_get',
      'mjloop_feature_update',
    ])
    // The four that would have been five, six, seven and eight. Minting a
    // successor is a create, the three read projections are one walk over one
    // directory, and recording a decision is an update.
    expect(names).not.toContain('mjloop_feature_supersede')
    expect(names).not.toContain('mjloop_feature_list')
    expect(names).not.toContain('mjloop_feature_decision_add')
    expect(names).not.toContain('mjloop_feature_revision_get')
  })

  // Minting a successor is only reachable through `create`, so the argument
  // that selects it has to be declared there — the same rule the `run_id` and
  // `closing` assertions below apply, on the tool where forgetting it would
  // leave an approved brief with no way to be changed at all.
  it('lets a caller mint a successor through the tool that mints a draft', async () => {
    const { tools } = await client.listTools()
    const create = tools.find((t) => t.name === 'mjloop_feature_create')
    const declared = Object.keys(properties(create?.inputSchema))
    expect(declared).toContain('supersedes')
    expect(declared).toContain('expect_revision')
    expect(create?.inputSchema.required ?? []).not.toContain('supersedes')
  })

  // The rule `mjloop_gate_set` states, on the second tool in this file that
  // records a decision no engine check can make for the caller. A plan is
  // written *from* an approved brief, so an approval invented here authorises
  // work no person ever agreed to.
  it('tells the caller never to record an approval nobody gave', async () => {
    const { tools } = await client.listTools()
    const approve = tools.find((t) => t.name === 'mjloop_feature_approve')
    expect(approve?.description).toMatch(/[Nn]ever record an approval nobody gave/)
    expect(approve?.description).toMatch(/ask/i)
  })

  // A precondition on the revision number alone is not a precondition on a
  // draft: the number does not move while the record is editable, which is
  // exactly the window an approval waits in. Both are required, so an approval
  // cannot be built on a brief nobody read.
  it('makes an approval swap on what the brief said, not only on which revision it was', async () => {
    const { tools } = await client.listTools()
    const approve = tools.find((t) => t.name === 'mjloop_feature_approve')
    const required = approve?.inputSchema.required ?? []
    expect(required).toContain('expect_revision')
    expect(required).toContain('expect_digest')
  })

  // The other end of the same argument: a token nothing hands out cannot be
  // handed back. Every read projection carries the digest an approval needs.
  it('hands the approval token out on the read the approver made the decision from', async () => {
    await client.callTool({
      name: 'mjloop_feature_create',
      arguments: {
        project_dir: project.dir,
        title: 'Passwordless sign-in',
        problem: 'Members forget passwords and support resets them by hand.',
        discovery_mode: 'always',
        question_budget: 8,
      },
    })
    const read = await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: 'F001' },
    })
    expect(JSON.parse(textOf(read)).digest).toMatch(/^[a-f0-9]{64}$/)
  })

  // `mjloop_feature_create` refuses these alongside `supersedes` and names
  // `mjloop_feature_update` as where they belong, so this is the assertion that
  // keeps that sentence true.
  it('lets a caller correct the discovery policy through the tool the refusal names', async () => {
    const { tools } = await client.listTools()
    const declared = Object.keys(properties(tools.find((t) => t.name === 'mjloop_feature_update')?.inputSchema))
    for (const argument of ['discovery_mode', 'question_budget', 'discovery_complete']) {
      expect(declared, argument).toContain(argument)
    }
  })

  // A parameter the op accepts and the tool never declares is unreachable
  // machinery: `runLog` refuses a closing result whose run has been replaced
  // only when it is told which run the agent was dispatched under, and this
  // surface is the only caller that can tell it.
  it('lets a caller name the run a closing result belongs to', async () => {
    const { tools } = await client.listTools()
    const log = tools.find((t) => t.name === 'mjloop_run_log')
    expect(Object.keys(properties(log?.inputSchema))).toContain('run_id')
    expect(log?.inputSchema.required).not.toContain('run_id')
  })

  // Same reason, the other half of idea 9: a closing pass belongs to no cycle,
  // so a tool that demanded one could never declare it.
  it('lets a caller declare the closing pass rather than a cycle', async () => {
    const { tools } = await client.listTools()
    const roster = tools.find((t) => t.name === 'mjloop_roster_set')
    expect(Object.keys(properties(roster?.inputSchema))).toContain('closing')
    expect(roster?.inputSchema.required).not.toContain('cycle')
  })

  // `phase: 'queued'` is the one digest value whose meaning a caller cannot
  // guess: it looks like a state of the caller's own command and it is the
  // opposite — nothing ran. A caller that reads it as "still going" logs a pass
  // citing a command that never executed.
  it('tells the caller what a queued phase means', async () => {
    const { tools } = await client.listTools()
    const verify = tools.find((t) => t.name === 'mjloop_verify_run')
    expect(verify?.description).toMatch(/queued/)
    expect(verify?.description).toMatch(/nothing ran/)
    expect(verify?.description).toMatch(/lock/)
  })

  it('declares supervision on run start and defaults it to supervised', async () => {
    const { tools } = await client.listTools()
    const start = tools.find((tool) => tool.name === 'mjloop_run_start')
    expect(Object.keys(properties(start?.inputSchema))).toContain('supervision')
    expect(start?.inputSchema.required ?? []).not.toContain('supervision')

    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })
    expect(isError(result)).toBe(false)
    const state = await new StateStore(project.dir).get()
    expect((await readPolicy(project.dir, state)).supervision).toBe('supervised')
  })
})

describe('tool behaviour', () => {
  it('runs init then reports a summary', async () => {
    const init = await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    expect(textOf(init)).toContain('.mjloop/state.json')

    const summary = await client.callTool({ name: 'mjloop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('idle')
  })

  it('drives a full passing edit cycle', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })
    await client.callTool({
      name: 'mjloop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor', 'verifier'], skipped: {} },
    })
    await client.callTool({
      name: 'mjloop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'All tests pass after the rename.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
          findings: [],
          files_touched: ['src/Button.tsx'],
        },
      },
    })
    const advanced = await client.callTool({
      name: 'mjloop_cycle_advance',
      arguments: { project_dir: project.dir, agents: ['editor', 'verifier'], result: 'pass' },
    })
    expect(JSON.parse(textOf(advanced)).state.status).toBe('done')
  })

  // Review finding 4: `quality_dispatches`' full context packet — up to the
  // mode's own token ceiling per entry — must never cross the wire, since
  // nothing on the leader's side consumes it yet.
  it('summarizes quality_dispatches on the wire instead of shipping each context packet\'s full text', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })
    const roster = await client.callTool({
      name: 'mjloop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor', 'verifier'], skipped: {} },
    })
    const payload = JSON.parse(textOf(roster))
    expect(payload.quality_dispatches.length).toBeGreaterThan(0)
    for (const dispatch of payload.quality_dispatches) {
      expect(dispatch).not.toHaveProperty('context')
      expect(dispatch).toMatchObject({
        agent: expect.any(String),
        dimensions: expect.any(Array),
        inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        tokens: expect.objectContaining({ kind: expect.any(String) }),
      })
    }
    // The whole point: no context packet text anywhere in the reply.
    expect(textOf(roster)).not.toContain('Output contract:')
  })

  it('declares the closing pass and records the agent that ran it', async () => {
    const { runId, closingAgents } = await passingBuildRun()
    expect(closingAgents).toEqual(['docs'])

    const roster = await client.callTool({
      name: 'mjloop_roster_set',
      arguments: { project_dir: project.dir, closing: true, selected: ['docs'], skipped: {} },
    })
    expect(isError(roster)).toBe(false)
    // Outside every cycle directory, which is what keeps a pass already
    // recorded out of every reader that walks cycles.
    expect(JSON.parse(textOf(roster)).path).toContain('closing/roster.json')

    const logged = await client.callTool({
      name: 'mjloop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'docs',
        run_id: runId,
        result: {
          status: 'pass',
          summary: 'README documents the export button as it finally stands.',
          evidence: [{ kind: 'file', ref: 'README.md', excerpt: '## Export' }],
          // A finding here would contradict a verdict nobody can revisit, so
          // the branch files none — this asserts the count the tool reports.
          findings: [{ severity: 'low', file: 'docs/ui.png', line: 0, claim: 'The screenshot is stale.' }],
          files_touched: ['README.md'],
        },
      },
    })
    expect(isError(logged)).toBe(false)
    const payload = JSON.parse(textOf(logged))
    expect(payload.path).toContain('closing/docs.json')
    expect(payload.findingsAdded).toBe(0)
    expect(payload.gateOpened).toBe(false)

    const summary = await client.callTool({ name: 'mjloop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('done')
  })

  // The window the `run_id` exists for: a person starts the next run while the
  // closing agent is still working. Without it forwarded, the result lands in
  // the new run's findings under a name `permittedAgents` now accepts.
  it('refuses a closing result whose run has been replaced', async () => {
    const { runId } = await passingBuildRun()
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })

    const logged = await client.callTool({
      name: 'mjloop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'docs',
        run_id: runId,
        result: {
          status: 'pass',
          summary: 'README documents the export button.',
          evidence: [{ kind: 'file', ref: 'README.md', excerpt: '## Export' }],
          findings: [{ severity: 'high', file: 'README.md', line: 1, claim: 'The export path is undocumented.' }],
          files_touched: ['README.md'],
        },
      },
    })
    expect(isError(logged)).toBe(true)
    expect(textOf(logged)).toContain('replaced')

    const summary = await client.callTool({ name: 'mjloop_state_get', arguments: { project_dir: project.dir } })
    const state = JSON.parse(textOf(summary))
    expect(state.run_id).not.toBe(runId)
    // The high finding above would have armed the new run's guards and its
    // verdict; the refusal is what keeps the new run's tally at zero.
    expect(state.findings.high).toBe(0)
  })

  it('returns a tool error when a roster names neither a cycle nor the closing pass', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'mjloop_roster_set',
      arguments: { project_dir: project.dir, selected: ['editor', 'verifier'], skipped: {} },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('closing=true')
  })

  // Refused rather than ignored: a closing roster silently validated against a
  // cycle's arguments would report success for a composition nobody declared.
  it('refuses a closing roster that also names a cycle', async () => {
    await passingBuildRun()
    const result = await client.callTool({
      name: 'mjloop_roster_set',
      arguments: { project_dir: project.dir, closing: true, cycle: 1, selected: ['docs'], skipped: {} },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('no cycle')
  })

  // The one case worth writing down: the run shipped without its documentation,
  // and the stated reason is the only durable record of that decision.
  it('records a closing pass that dispatched nobody', async () => {
    await passingBuildRun()
    const roster = await client.callTool({
      name: 'mjloop_roster_set',
      arguments: {
        project_dir: project.dir,
        closing: true,
        selected: [],
        skipped: { docs: 'The change is internal and no documented behaviour moved.' },
      },
    })
    expect(isError(roster)).toBe(false)
    expect(JSON.parse(textOf(roster)).path).toContain('closing/roster.json')
  })

  it('returns a tool error, not a crash, when the roster drops verifier', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'mjloop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor'], skipped: {} },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('verifier')
  })

  it('refuses an agent name that would write outside the cycle directory', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })

    // `.mjloop/state.json` is three levels up from the cycle directory, and the
    // PreToolUse hook that guards it never sees an MCP write.
    const outcome = await client
      .callTool({
        name: 'mjloop_run_log',
        arguments: {
          project_dir: project.dir,
          agent: '../../../state',
          result: { status: 'pass', summary: 'x', evidence: [], findings: [], files_touched: [] },
        },
      })
      .then((result) => ((result as { isError?: boolean }).isError === true ? 'rejected' : 'accepted'), () => 'rejected')
    expect(outcome).toBe('rejected')

    const summary = await client.callTool({ name: 'mjloop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('running')
  })

  it('refuses a track name that would steer the run directory', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })

    // The track names the run directory alongside the story id, which this
    // surface has always constrained.
    const outcome = await client
      .callTool({
        name: 'mjloop_run_start',
        arguments: { project_dir: project.dir, track: '../../../tmp/victim', goal: 'Rename' },
      })
      .then((result) => ((result as { isError?: boolean }).isError === true ? 'rejected' : 'accepted'), () => 'rejected')
    expect(outcome).toBe('rejected')

    const summary = await client.callTool({ name: 'mjloop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('idle')
  })

  it('returns a tool error when an agent result breaks the contract', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'mjloop_run_log',
      arguments: { project_dir: project.dir, agent: 'editor', result: { status: 'pass' } },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('summary')
  })

  it('accepts an instance so parallel agents do not overwrite each other', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'fix', goal: 'Stale cache' },
    })
    const logged = await client.callTool({
      name: 'mjloop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'hypothesis-tester',
        instance: 'stale-cache',
        result: {
          status: 'fail',
          summary: 'Refuted: the cache is invalidated on write.',
          evidence: [{ kind: 'command', ref: 'npm test -- cache', excerpt: 'ordering is correct' }],
          findings: [],
          files_touched: [],
        },
      },
    })
    expect((logged as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(textOf(logged)).path).toContain('hypothesis-tester--stale-cache.json')
  })

  it('returns a tool error when the fixer runs before the defect is reproduced', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'fix', goal: 'Stale cache' },
    })
    const result = await client.callTool({
      name: 'mjloop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'fixer',
        result: {
          status: 'pass',
          summary: 'Invalidated the entry on write.',
          evidence: [{ kind: 'file', ref: 'src/cache.ts', excerpt: 'this.map.delete(key)' }],
          findings: [],
          files_touched: ['src/cache.ts'],
        },
      },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('reproducer')
  })

  it('drives a plan from creation to a resolved next story', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })

    const created = await client.callTool({
      name: 'mjloop_plan_create',
      arguments: { project_dir: project.dir, slug: 'user-auth', title: 'User authentication' },
    })
    expect(JSON.parse(textOf(created)).id).toBe('P001')

    // gates.plan_approval defaults to "human", and this test is about the plan
    // tools rather than the gate, so the approval is recorded directly.
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'test' })

    await client.callTool({
      name: 'mjloop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form', acceptance: ['Shows an error'] },
    })
    await client.callTool({
      name: 'mjloop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] },
    })

    const next = await client.callTool({ name: 'mjloop_story_get', arguments: { project_dir: project.dir, next: true } })
    expect(JSON.parse(textOf(next)).story.frontmatter.id).toBe('P001-S01')

    await client.callTool({
      name: 'mjloop_story_update',
      arguments: { project_dir: project.dir, story: 'P001-S01', status: 'done', evidence: '.mjloop/runs/x' },
    })

    const after = await client.callTool({ name: 'mjloop_story_get', arguments: { project_dir: project.dir, next: true } })
    expect(JSON.parse(textOf(after)).story.frontmatter.id).toBe('P001-S02')

    const index = await client.callTool({ name: 'mjloop_index_render', arguments: { project_dir: project.dir } })
    expect(textOf(index)).toContain('User authentication')
  })

  it('records an approval and then allows a story', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_plan_create',
      arguments: { project_dir: project.dir, slug: 'user-auth', title: 'User authentication' },
    })

    const refused = await client.callTool({
      name: 'mjloop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form' },
    })
    expect((refused as { isError?: boolean }).isError).toBe(true)
    expect(textOf(refused)).toContain('mjloop_gate_set')

    await client.callTool({
      name: 'mjloop_gate_set',
      arguments: { project_dir: project.dir, plan: 'P001', decision: 'approved', by: 'mohd', note: 'Ship it.' },
    })

    const added = await client.callTool({
      name: 'mjloop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form' },
    })
    expect((added as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(textOf(added)).id).toBe('P001-S01')
  })

  it('returns a tool error for a story that does not exist', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_story_get',
      arguments: { project_dir: project.dir, story: 'P001-S01' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it('records a memory and finds it again', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })

    const added = await client.callTool({
      name: 'mjloop_memory_add',
      arguments: {
        project_dir: project.dir,
        kind: 'decision',
        title: 'Session tokens rather than server sessions',
        body: 'The deployment target has no shared session store.',
        tags: ['auth'],
      },
    })
    expect(JSON.parse(textOf(added)).id).toBe('M001')

    const found = await client.callTool({
      name: 'mjloop_memory_search',
      arguments: { project_dir: project.dir, query: 'session store' },
    })
    const payload = JSON.parse(textOf(found))
    expect(payload.hits[0].id).toBe('M001')
    expect(payload.hits[0].excerpt).toContain('session store')

    const read = await client.callTool({
      name: 'mjloop_memory_get',
      arguments: { project_dir: project.dir, id: 'M001' },
    })
    expect(textOf(read)).toContain('no shared session store')
  })

  it('records a memory scoped to a plan and story', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })

    const added = await client.callTool({
      name: 'mjloop_memory_add',
      arguments: {
        project_dir: project.dir,
        kind: 'lesson',
        title: 'Timing needed runInBand',
        body: 'The suite was flaky under parallel workers.',
        plan: 'P001',
        story: 'P001-S02',
      },
    })
    expect(isError(added)).not.toBe(true)

    const read = await client.callTool({
      name: 'mjloop_memory_get',
      arguments: { project_dir: project.dir, id: JSON.parse(textOf(added)).id },
    })
    const memory = JSON.parse(textOf(read))
    expect(memory.frontmatter.plan).toBe('P001')
    expect(memory.frontmatter.story).toBe('P001-S02')
  })

  it('refuses a plan or story id that is not shaped like one, rather than dropping it', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_memory_add',
      arguments: {
        project_dir: project.dir,
        kind: 'lesson',
        title: 'x',
        body: 'y',
        plan: 'not-a-plan',
      },
    })
    expect(isError(result)).toBe(true)
  })

  it('refuses a memory body past the ceiling at the tool boundary', async () => {
    // The ceiling is legible to the caller before it writes a transcript that
    // every later search and add would then have to read.
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_memory_add',
      arguments: {
        project_dir: project.dir,
        kind: 'lesson',
        title: 'A pasted test log',
        body: 'x'.repeat(20_001),
      },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it('returns a tool error for a memory that does not exist', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_memory_get',
      arguments: { project_dir: project.dir, id: 'M404' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it('runs a verify slot and hands back a digest that reaches no verdict', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    // Rewritten before the run opens, because `runStart` pins the verify block:
    // an edit after that point is reported as drift and not obeyed, which would
    // leave this test executing the detected `npm test` — this suite, inside
    // itself.
    const config = await loadConfig(project.dir)
    config.verify.test = "printf 'hello\\n'"
    await writeConfig(project.dir, config)
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })

    const result = await client.callTool({
      name: 'mjloop_verify_run',
      arguments: { project_dir: project.dir, slot: 'test', wait_ms: 20_000 },
    })
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const digest = JSON.parse(textOf(result))
    expect(digest.phase).toBe('complete')
    expect(digest.exit_code).toBe(0)
    expect(digest.log).toContain('cycle-01')

    // The tool moves execution into the engine and no further. A digest that
    // carried a verdict would be the engine grading its own homework, and the
    // whole evidence rule rests on the verifier still being the one that reads
    // this and decides.
    expect(Object.values(digest)).not.toContain('pass')
    expect(Object.values(digest)).not.toContain('fail')
  })

  it('returns a tool error, not a crash, when there is no run to verify', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_verify_run',
      arguments: { project_dir: project.dir, slot: 'test' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('mjloop_run_start')
  })

  it('refuses a verify label that would write outside the cycle directory', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })

    // The label names a log file under the cycle, so it is the third string on
    // this surface that reaches the filesystem, after the agent name and the
    // track. All three are checked the same way for the same reason.
    const outcome = await client
      .callTool({
        name: 'mjloop_verify_run',
        arguments: { project_dir: project.dir, slot: 'test', label: '../../../escaped' },
      })
      .then((result) => ((result as { isError?: boolean }).isError === true ? 'rejected' : 'accepted'), () => 'rejected')
    expect(outcome).toBe('rejected')
  })

  it('serves a telemetry report for a project that has never run', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_report_get',
      arguments: { project_dir: project.dir, report: 'telemetry' },
    })
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const telemetry = JSON.parse(textOf(result))
    expect(telemetry.runs).toBe(0)
    expect(telemetry.specialists).toEqual([])
    expect(telemetry.flagged).toEqual([])
  })

  it('serves a preflight estimate before any run exists', async () => {
    // The estimate is asked at `status: 'idle'`, which is the only moment it is
    // useful, so init alone is the whole setup.
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_report_get',
      arguments: { project_dir: project.dir, report: 'preflight', track: 'edit' },
    })
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const preflight = JSON.parse(textOf(result))
    expect(preflight.track).toBe('edit')
    expect(preflight.dispatches_per_cycle).toBeGreaterThan(0)
    // No basis is an answer; an invented one is not.
    expect(preflight.comparable).toBeNull()
  })

  it('returns a tool error when preflight is asked without a track', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_report_get',
      arguments: { project_dir: project.dir, report: 'preflight' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('track')
  })

  it('returns a tool error for a track no config defines', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'mjloop_report_get',
      arguments: { project_dir: project.dir, report: 'preflight', track: 'invented' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  describe('skills projection', () => {
    const DIGEST_A = 'a'.repeat(64)

    function skillPackage(digest: string): SkillPackage {
      return {
        schema: 1,
        packageId: 'flutter-widgets',
        digest,
        source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'a1b2c3d' },
        license: { spdx: 'MIT', file: 'LICENSE' },
        skillName: 'Flutter Widgets',
        description: 'Shared widget kit conventions for the mobile component.',
        tags: ['flutter'],
        dependencies: { executables: [], packages: ['flutter'] },
        audit: { state: 'passed', findings: [], at: '2026-07-30T09:00:00.000Z' },
        guidance: 'Use the shared widget kit under lib/widgets.',
        importedAt: '2026-07-30T09:00:00.000Z',
      }
    }

    let dataHome: string
    let contentDir: string

    beforeEach(async () => {
      dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-library-'))
      process.env.MJLOOP_DATA_HOME = dataHome
      contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-content-'))
      await fs.writeFile(path.join(contentDir, 'SKILL.md'), '# Flutter Widgets\n', 'utf8')
    })

    afterEach(async () => {
      delete process.env.MJLOOP_DATA_HOME
      await fs.rm(dataHome, { recursive: true, force: true })
      await fs.rm(contentDir, { recursive: true, force: true })
    })

    it('is empty at no error on a machine with no library and a project with no acceptances', async () => {
      await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
      const result = await client.callTool({
        name: 'mjloop_report_get',
        arguments: { project_dir: project.dir, report: 'skills' },
      })
      expect((result as { isError?: boolean }).isError).not.toBe(true)
      const skills = JSON.parse(textOf(result))
      expect(skills.packages).toEqual([])
      expect(skills.unreadable).toEqual([])
      expect(skills.acceptances).toEqual([])
    })

    it('reports the library and this project\'s acceptances — a read of what mjloop-cli skills decided', async () => {
      await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
      await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)

      const result = await client.callTool({
        name: 'mjloop_report_get',
        arguments: { project_dir: project.dir, report: 'skills' },
      })
      expect((result as { isError?: boolean }).isError).not.toBe(true)
      const skills = JSON.parse(textOf(result))
      expect(skills.packages).toHaveLength(1)
      expect(skills.packages[0].digest).toBe(DIGEST_A)
      // No acceptance was ever made through mjloop-cli skills accept, so the
      // library holding a package must not, on its own, make it selectable —
      // this projection reports the library and the (empty) acceptance list
      // as two separate facts rather than inferring one from the other.
      expect(skills.acceptances).toEqual([])
    })

    it('reports an unreadable digest directory beside the packages it could read — evidence an import left behind', async () => {
      await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
      const corruptDigest = 'b'.repeat(64)
      const corruptDir = path.join(dataHome, 'packages', corruptDigest)
      await fs.mkdir(corruptDir, { recursive: true })
      await fs.writeFile(path.join(corruptDir, 'package.json'), '{"schema":1}', 'utf8')

      const result = await client.callTool({
        name: 'mjloop_report_get',
        arguments: { project_dir: project.dir, report: 'skills' },
      })
      expect((result as { isError?: boolean }).isError).not.toBe(true)
      const skills = JSON.parse(textOf(result))
      expect(skills.unreadable).toHaveLength(1)
      expect(skills.unreadable[0].digest).toBe(corruptDigest)
    })
  })
})

describe('feature briefs', () => {
  /** The interview's own call: a draft, plus the policy it actually ran under. */
  async function createDraft(overrides: Record<string, unknown> = {}): Promise<unknown> {
    return client.callTool({
      name: 'mjloop_feature_create',
      arguments: {
        project_dir: project.dir,
        title: 'Passwordless sign-in',
        problem: 'Members forget passwords and support resets them by hand.',
        discovery_mode: 'always',
        question_budget: 8,
        ...overrides,
      },
    })
  }

  /** An accepted component map, which is what `affected_components` is checked against. */
  async function acceptComponents(ids: string[]): Promise<void> {
    await acceptProfile(project.dir, {
      // Sorted, because an accepted profile insists on it.
      components: [...ids].sort().map((id) => ({
        id,
        root: id,
        technology: 'unknown' as const,
        verification: { test: null, lint: null, build: null },
        skillTags: [],
      })),
      by: 'mohd',
      generatedAt: '2026-07-30T09:00:00.000Z',
      expectRevision: null,
    })
  }

  /**
   * The precondition a caller that has just read the brief would present.
   *
   * Both halves come from the read, because that is where a real caller gets
   * them: `mjloop_feature_get` returns the revision list and the digest, and an
   * approval is refused unless it hands back the ones belonging to the record
   * it actually showed the user.
   */
  async function precondition(id: string): Promise<{ expect_revision: number; expect_digest: string }> {
    const read = JSON.parse(
      textOf(await client.callTool({ name: 'mjloop_feature_get', arguments: { project_dir: project.dir, feature: id } })),
    )
    return { expect_revision: read.brief.revision, expect_digest: read.digest }
  }

  /** A draft carrying the one thing approval refuses to do without. */
  async function approvableDraft(): Promise<string> {
    const created = await createDraft()
    const id = JSON.parse(textOf(created)).brief.id
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: {
        project_dir: project.dir,
        feature: id,
        acceptance: ['A member with no password signs in from an emailed link'],
      },
    })
    return id
  }

  it('mints a draft carrying the discovery policy the interview ran under', async () => {
    const created = await createDraft()
    expect(isError(created)).toBe(false)
    const record = JSON.parse(textOf(created))
    expect(record.brief.id).toBe('F001')
    expect(record.brief.revision).toBe(1)
    expect(record.brief.status).toBe('draft')
    // Recorded rather than defaulted: a brief must say which policy produced
    // it, and a project that switches discovery off next week must not make
    // this one look like it was never interviewed.
    expect(record.brief.discovery).toEqual({ mode: 'always', questionBudget: 8, completedAt: null })
    expect(record.brief.approval).toBeNull()
    // No tag is declared until a person names one during discovery.
    expect(record.brief.tags).toEqual([])
  })

  // Skill selection joins on this list, and the story is explicit that it
  // must be declared rather than derived — so the tool that lets an
  // interview record one is the only surface tested here; reading it back out
  // of `problem` or `acceptance` text is a defect this repository does not
  // ship.
  it('lets the interview declare a cross-cutting tag through mjloop_feature_update', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    const tagged = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, tags: ['security'] },
    })
    expect(isError(tagged)).toBe(false)
    expect(JSON.parse(textOf(tagged)).brief.tags).toEqual(['security'])

    const read = await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: id },
    })
    expect(JSON.parse(textOf(read)).brief.tags).toEqual(['security'])
  })

  it('replaces the declared tags rather than appending to them', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, tags: ['security', 'billing'] },
    })
    const replaced = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, tags: ['security'] },
    })
    expect(JSON.parse(textOf(replaced)).brief.tags).toEqual(['security'])
  })

  // A draft is assembled, so the first call cannot carry acceptance criteria.
  // The tool must therefore not demand them — and approval must.
  it('mints a draft with no acceptance criteria and refuses to approve it', async () => {
    const created = await createDraft()
    expect(JSON.parse(textOf(created)).brief.acceptance).toEqual([])

    const approved = await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: 'F001', ...(await precondition('F001')), by: 'mohd' },
    })
    expect(isError(approved)).toBe(true)
    expect(textOf(approved)).toContain('acceptance criteria')

    const onDisk = await readFeatureRevision(project.dir, 'F001', 1)
    expect(onDisk?.brief.status).toBe('draft')
  })

  it('refuses a create that names no policy to record', async () => {
    const created = await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, title: 'Passwordless sign-in', problem: 'Support resets by hand.' },
    })
    expect(isError(created)).toBe(true)
    expect(textOf(created)).toContain('discovery_mode')
    expect(textOf(created)).toContain('question_budget')
  })

  it('records a decision, the answer it produced, and the moment the interview stopped', async () => {
    const created = await createDraft()
    const id = JSON.parse(textOf(created)).brief.id

    const decided = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: {
        project_dir: project.dir,
        feature: id,
        question: 'Does a magic link expire after one use, or after fifteen minutes?',
        recommendation: 'One use, because a link in an inbox outlives the session that asked for it.',
        answer: 'One use.',
        acceptance: ['A used link cannot be used again'],
        discovery_complete: true,
      },
    })
    expect(isError(decided)).toBe(false)
    const brief = JSON.parse(textOf(decided)).brief
    expect(brief.decisions).toHaveLength(1)
    expect(brief.decisions[0].answer).toBe('One use.')
    // Stamped by the engine, exactly as `appendFeatureDecision` stamps `at`.
    expect(typeof brief.decisions[0].at).toBe('string')
    expect(brief.acceptance).toEqual(['A used link cannot be used again'])
    expect(typeof brief.discovery.completedAt).toBe('string')
  })

  // The budget running out is a real output. A decision with no answer says the
  // interview stopped before this one was settled, and dropping it would hand
  // planning a brief that looks more settled than it is.
  it('records an unresolved decision', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    const decided = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: {
        project_dir: project.dir,
        feature: id,
        question: 'Do we keep password sign-in alongside the link?',
        recommendation: 'Keep it until the link path has run for a release.',
      },
    })
    expect(isError(decided)).toBe(false)
    expect(JSON.parse(textOf(decided)).brief.decisions[0].answer).toBeNull()
  })

  it('refuses an answer that belongs to no question', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    const result = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, answer: 'One use.' },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('question')
    expect(JSON.parse(textOf(await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: id },
    }))).brief.decisions).toEqual([])
  })

  // Reporting success for a call that changed nothing tells the interview its
  // answer was written down when no file moved.
  it('refuses an update that changes nothing', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    const result = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('nothing to change')
  })

  it('approves a draft, recording the actor and the approver own words', async () => {
    const id = await approvableDraft()
    const approved = await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: {
        project_dir: project.dir,
        feature: id,
        ...(await precondition(id)),
        by: 'mohd',
        note: 'Ship the link, keep passwords for a release.',
      },
    })
    expect(isError(approved)).toBe(false)
    const brief = JSON.parse(textOf(approved)).brief
    expect(brief.status).toBe('approved')
    expect(brief.approval.by).toBe('mohd')
    expect(brief.approval.note).toBe('Ship the link, keep passwords for a release.')
    expect(typeof brief.approval.at).toBe('string')
  })

  // The 800ms-stale-screen case: the compare-and-swap is the whole reason
  // approval takes an expected revision rather than approving whatever is there.
  it('refuses an approval built on a revision that has moved on', async () => {
    const id = await approvableDraft()
    const stale = await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), expect_revision: 2, by: 'mohd' },
    })
    expect(isError(stale)).toBe(true)
    expect(textOf(stale)).toContain('moved on')

    const onDisk = await readFeatureRevision(project.dir, id, 1)
    expect(onDisk?.brief.status).toBe('draft')
  })

  // The case the revision number cannot see, and the one the skill tells the
  // model to expect: it read a brief, showed it, waited, and something changed
  // it in the meantime. The revision is still 1 the whole time — a draft's
  // number does not move while it is a draft — so the digest is what carries
  // the refusal.
  it('refuses an approval built on words that changed after they were read', async () => {
    const id = await approvableDraft()
    const read = await precondition(id)
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: {
        project_dir: project.dir,
        feature: id,
        question: 'Should a session expire after thirty days?',
        answer: 'Yes, expire it.',
      },
    })

    const stale = await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...read, by: 'mohd' },
    })
    expect(isError(stale)).toBe(true)
    expect(textOf(stale)).toContain('moved on')
    // Still a draft, so the way forward is reading it again rather than
    // re-sending the call with a higher number.
    expect((await readFeatureRevision(project.dir, id, 1))?.brief.status).toBe('draft')
  })

  // `mjloop_feature_create` refuses `discovery_mode` and `question_budget`
  // alongside `supersedes` and names this tool as where they belong. They have
  // to be reachable here, or that refusal points at a dead end — and the
  // successor would record the policy its *predecessor's* interview ran under
  // for as long as the feature lives.
  it('lets the interview behind a successor record its own policy', async () => {
    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd' },
    })
    await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id, expect_revision: 1 },
    })

    const corrected = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, discovery_mode: 'ask', question_budget: 3 },
    })
    expect(isError(corrected)).toBe(false)
    expect(JSON.parse(textOf(corrected)).brief.discovery).toMatchObject({ mode: 'ask', questionBudget: 3 })
    // …and revision 1 still records the policy *its* interview ran under.
    expect((await readFeatureRevision(project.dir, id, 1))?.brief.discovery.mode).toBe('always')
  })

  it('refuses every edit to an approved revision, and names supersede as the way forward', async () => {
    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd' },
    })

    const edited = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, title: 'Passwordless sign-in, take two' },
    })
    expect(isError(edited)).toBe(true)
    expect(textOf(edited)).toContain('Supersede')

    const decided = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, question: 'Should the link work on mobile?' },
    })
    expect(isError(decided)).toBe(true)

    const onDisk = await readFeatureRevision(project.dir, id, 1)
    expect(onDisk?.brief.title).toBe('Passwordless sign-in')
    expect(onDisk?.brief.decisions).toEqual([])
  })

  it('mints a successor through create, leaving the approved revision untouched', async () => {
    const id = await approvableDraft()
    const approved = await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd', note: 'Ship it.' },
    })
    const first = JSON.parse(textOf(approved)).brief

    const successor = await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id, expect_revision: 1 },
    })
    expect(isError(successor)).toBe(false)
    const second = JSON.parse(textOf(successor)).brief
    expect(second.revision).toBe(2)
    expect(second.status).toBe('draft')
    expect(second.approval).toBeNull()
    expect(second.supersedes).toEqual({ id, revision: 1 })
    // The content carries forward, so a successor starts from what was agreed.
    expect(second.acceptance).toEqual(first.acceptance)

    const onDisk = await readFeatureRevision(project.dir, id, 1)
    expect(onDisk?.brief).toEqual(first)
    // Never stored, always derived: the word appears because revision 2 exists.
    expect(onDisk?.status).toBe('superseded')
  })

  // Silently ignoring content passed alongside `supersedes` would report
  // success for a title nobody wrote down — the same refusal a closing roster
  // that also names a cycle gets.
  it('refuses a supersede that also carries content', async () => {
    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, expect_revision: 1, by: 'mohd' },
    })
    const result = await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id, expect_revision: 1, title: 'Something else' },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('mjloop_feature_update')
    expect(await readFeatureRevision(project.dir, id, 2)).toBeNull()
  })

  it('refuses a supersede that names no revision to swap on', async () => {
    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, expect_revision: 1, by: 'mohd' },
    })
    const result = await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('expect_revision')
  })

  it('serves the three read projections through one tool', async () => {
    const empty = await client.callTool({ name: 'mjloop_feature_get', arguments: { project_dir: project.dir } })
    expect(isError(empty)).toBe(false)
    expect(JSON.parse(textOf(empty)).features).toEqual([])

    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd' },
    })
    await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id, expect_revision: 1 },
    })

    const listed = await client.callTool({ name: 'mjloop_feature_get', arguments: { project_dir: project.dir } })
    const summaries = JSON.parse(textOf(listed)).features
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ id, latestRevision: 2, approvedRevision: 1, revisions: [1, 2] })

    const latest = await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: id },
    })
    expect(JSON.parse(textOf(latest)).brief.revision).toBe(2)
    // The revision list travels with the read, because it is what a caller
    // needs before it can name an `expect_revision` for anything.
    expect(JSON.parse(textOf(latest)).revisions).toEqual([1, 2])

    const pinned = await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: id, revision: 1 },
    })
    expect(JSON.parse(textOf(pinned)).brief.revision).toBe(1)
    expect(JSON.parse(textOf(pinned)).status).toBe('superseded')
  })

  it('returns a tool error for a feature that does not exist', async () => {
    const result = await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: 'F404' },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('F404')
  })

  it('names the revisions that do exist when asked for one that does not', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    const result = await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir, feature: id, revision: 7 },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('no revision 7')
    // "It has 1" is the actionable half: a caller that guessed a revision
    // number needs the list, not a bare denial.
    expect(textOf(result)).toMatch(/it has 1$/)
  })

  // An expectation with nothing to swap on is a caller that thinks it is
  // replacing something. Answering it with a brand new F002 would be the
  // silent wrong outcome.
  it('refuses a first revision that names a revision to swap on', async () => {
    const result = await createDraft({ expect_revision: 1 })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('supersedes')
    expect(JSON.parse(textOf(await client.callTool({
      name: 'mjloop_feature_get',
      arguments: { project_dir: project.dir },
    }))).features).toEqual([])
  })

  it('reopens an interview that was marked complete', async () => {
    const id = JSON.parse(textOf(await createDraft())).brief.id
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, discovery_complete: true },
    })
    const reopened = await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, discovery_complete: false },
    })
    expect(isError(reopened)).toBe(false)
    expect(JSON.parse(textOf(reopened)).brief.discovery.completedAt).toBeNull()
  })

  it('accepts an affected component the accepted map names', async () => {
    await acceptComponents(['mobile', 'admin'])
    const created = await createDraft({ affected_components: ['mobile'] })
    expect(isError(created)).toBe(false)
    expect(JSON.parse(textOf(created)).brief.affectedComponents).toEqual(['mobile'])
  })

  it('refuses an affected component the accepted map has never heard of', async () => {
    await acceptComponents(['mobile', 'admin'])
    const created = await createDraft({ affected_components: ['ghost'] })
    expect(isError(created)).toBe(true)
    expect(textOf(created)).toContain('ghost')
    expect(await readFeatureRevision(project.dir, 'F001', 1)).toBeNull()
  })

  // The third string on this surface that names a directory, after the agent
  // name and the track, and it is checked the same way and for the same reason.
  it('refuses a feature id that would steer a path out of .mjloop/features', async () => {
    const outcome = await client
      .callTool({
        name: 'mjloop_feature_get',
        arguments: { project_dir: project.dir, feature: '../../../etc' },
      })
      .then((result) => (isError(result) ? 'rejected' : 'accepted'), () => 'rejected')
    expect(outcome).toBe('rejected')
  })

  // Rollback is reselection: the content of an earlier revision approved as a
  // *new* one. Nothing is mutated and nothing is deleted, so the record still
  // shows every position the project held and the order it held them in.
  it('rolls back by approving an earlier revision content as a new revision', async () => {
    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd', note: 'The link only.' },
    })
    const original = (await readFeatureRevision(project.dir, id, 1))?.brief

    await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id, expect_revision: 1 },
    })
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, acceptance: ['A one-time code arrives by SMS'] },
    })
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd', note: 'SMS instead.' },
    })

    await client.callTool({
      name: 'mjloop_feature_create',
      arguments: { project_dir: project.dir, supersedes: id, expect_revision: 2 },
    })
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, acceptance: original?.acceptance },
    })
    const rolled = await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd', note: 'Back to the link.' },
    })
    expect(isError(rolled)).toBe(false)

    const third = JSON.parse(textOf(rolled)).brief
    expect(third.revision).toBe(3)
    expect(third.acceptance).toEqual(original?.acceptance)
    // Neither predecessor moved, and both still say what they said.
    expect((await readFeatureRevision(project.dir, id, 1))?.brief).toEqual(original)
    expect((await readFeatureRevision(project.dir, id, 2))?.brief.acceptance).toEqual(['A one-time code arrives by SMS'])
  })

  // `mjloop_run_start` is the only surface in the product that opens a run —
  // the cockpit denies `runStart` permanently (`web/writes.ts`), `/mjloop:resume`
  // is told not to call it, and the CLI registers no subcommand for it. So a
  // `feature` the tool does not accept is a `feature` nothing can ever reach,
  // and the manifest `runStart` was extended to pin would be pinned only by
  // tests while three documents and the leader skill described it as shipping
  // behaviour. Worse than dead: the SDK drops an unknown argument silently, so
  // a leader that passed one would get a normal-looking run and no manifest.
  it('lets a run be started against an approved feature, and pins the manifest for it', async () => {
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    await acceptComponents(['mobile'])
    const id = await approvableDraft()
    await client.callTool({
      name: 'mjloop_feature_update',
      arguments: { project_dir: project.dir, feature: id, affected_components: ['mobile'] },
    })
    await client.callTool({
      name: 'mjloop_feature_approve',
      arguments: { project_dir: project.dir, feature: id, ...(await precondition(id)), by: 'mohd' },
    })

    const started = await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Add link login', feature: id },
    })
    expect(isError(started)).toBe(false)

    const state = JSON.parse(textOf(started))
    const dir = path.join(project.dir, '.mjloop', 'runs', `${state.run_id}--adhoc--edit`)
    expect((await fs.readdir(dir)).sort()).toEqual([
      'quality-ledger.json', 'quality-policy.json', 'skill-selection.json', 'verify-pinned.json',
    ])
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'skill-selection.json'), 'utf8'))
    expect(manifest.sourceBrief).toEqual({ id, revision: 1 })
  })

  it('refuses a feature id that is not shaped like one, rather than dropping it', async () => {
    // The failure mode the nullish argument has to avoid: an unparseable id
    // that reaches `runStart` anyway would half-start a run, and one silently
    // ignored would start a run the caller believes is routed and is not.
    await client.callTool({ name: 'mjloop_init', arguments: { project_dir: project.dir } })
    const started = await client.callTool({
      name: 'mjloop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'x', feature: 'not-a-feature' },
    })
    expect(isError(started)).toBe(true)
  })
})
