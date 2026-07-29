import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, resolveProjectDir } from '../../src/mcp/server.js'
import { gateSet } from '../../src/ops/plan.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
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
  it('exposes exactly the eighteen tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mjloop_cycle_advance',
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
})
