import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, resolveProjectDir } from '../../src/mcp/server.js'
import { gateSet } from '../../src/ops/plan.js'
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
  it('exposes exactly the milestone-1 tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'loop_cycle_advance',
      'loop_gate_set',
      'loop_halt',
      'loop_index_render',
      'loop_init',
      'loop_memory_add',
      'loop_memory_get',
      'loop_memory_search',
      'loop_plan_create',
      'loop_roster_set',
      'loop_run_log',
      'loop_run_start',
      'loop_state_get',
      'loop_story_add',
      'loop_story_get',
      'loop_story_update',
    ])
  })
})

describe('tool behaviour', () => {
  it('runs init then reports a summary', async () => {
    const init = await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    expect(textOf(init)).toContain('.loop/state.json')

    const summary = await client.callTool({ name: 'loop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('idle')
  })

  it('drives a full passing edit cycle', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })
    await client.callTool({
      name: 'loop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor', 'verifier'], skipped: {} },
    })
    await client.callTool({
      name: 'loop_run_log',
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
      name: 'loop_cycle_advance',
      arguments: { project_dir: project.dir, agents: ['editor', 'verifier'], result: 'pass' },
    })
    expect(JSON.parse(textOf(advanced)).state.status).toBe('done')
  })

  it('returns a tool error, not a crash, when the roster drops verifier', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'loop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor'], skipped: {} },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('verifier')
  })

  it('refuses an agent name that would write outside the cycle directory', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })

    // `.loop/state.json` is three levels up from the cycle directory, and the
    // PreToolUse hook that guards it never sees an MCP write.
    const outcome = await client
      .callTool({
        name: 'loop_run_log',
        arguments: {
          project_dir: project.dir,
          agent: '../../../state',
          result: { status: 'pass', summary: 'x', evidence: [], findings: [], files_touched: [] },
        },
      })
      .then((result) => ((result as { isError?: boolean }).isError === true ? 'rejected' : 'accepted'), () => 'rejected')
    expect(outcome).toBe('rejected')

    const summary = await client.callTool({ name: 'loop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('running')
  })

  it('refuses a track name that would steer the run directory', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })

    // The track names the run directory alongside the story id, which this
    // surface has always constrained.
    const outcome = await client
      .callTool({
        name: 'loop_run_start',
        arguments: { project_dir: project.dir, track: '../../../tmp/victim', goal: 'Rename' },
      })
      .then((result) => ((result as { isError?: boolean }).isError === true ? 'rejected' : 'accepted'), () => 'rejected')
    expect(outcome).toBe('rejected')

    const summary = await client.callTool({ name: 'loop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('idle')
  })

  it('returns a tool error when an agent result breaks the contract', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'loop_run_log',
      arguments: { project_dir: project.dir, agent: 'editor', result: { status: 'pass' } },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('summary')
  })

  it('accepts an instance so parallel agents do not overwrite each other', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'fix', goal: 'Stale cache' },
    })
    const logged = await client.callTool({
      name: 'loop_run_log',
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
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'fix', goal: 'Stale cache' },
    })
    const result = await client.callTool({
      name: 'loop_run_log',
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
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })

    const created = await client.callTool({
      name: 'loop_plan_create',
      arguments: { project_dir: project.dir, slug: 'user-auth', title: 'User authentication' },
    })
    expect(JSON.parse(textOf(created)).id).toBe('P001')

    // gates.plan_approval defaults to "human", and this test is about the plan
    // tools rather than the gate, so the approval is recorded directly.
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'test' })

    await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form', acceptance: ['Shows an error'] },
    })
    await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] },
    })

    const next = await client.callTool({ name: 'loop_story_get', arguments: { project_dir: project.dir, next: true } })
    expect(JSON.parse(textOf(next)).story.frontmatter.id).toBe('P001-S01')

    await client.callTool({
      name: 'loop_story_update',
      arguments: { project_dir: project.dir, story: 'P001-S01', status: 'done', evidence: '.loop/runs/x' },
    })

    const after = await client.callTool({ name: 'loop_story_get', arguments: { project_dir: project.dir, next: true } })
    expect(JSON.parse(textOf(after)).story.frontmatter.id).toBe('P001-S02')

    const index = await client.callTool({ name: 'loop_index_render', arguments: { project_dir: project.dir } })
    expect(textOf(index)).toContain('User authentication')
  })

  it('records an approval and then allows a story', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_plan_create',
      arguments: { project_dir: project.dir, slug: 'user-auth', title: 'User authentication' },
    })

    const refused = await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form' },
    })
    expect((refused as { isError?: boolean }).isError).toBe(true)
    expect(textOf(refused)).toContain('loop_gate_set')

    await client.callTool({
      name: 'loop_gate_set',
      arguments: { project_dir: project.dir, plan: 'P001', decision: 'approved', by: 'mohd', note: 'Ship it.' },
    })

    const added = await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form' },
    })
    expect((added as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(textOf(added)).id).toBe('P001-S01')
  })

  it('returns a tool error for a story that does not exist', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'loop_story_get',
      arguments: { project_dir: project.dir, story: 'P001-S01' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it('records a memory and finds it again', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })

    const added = await client.callTool({
      name: 'loop_memory_add',
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
      name: 'loop_memory_search',
      arguments: { project_dir: project.dir, query: 'session store' },
    })
    const payload = JSON.parse(textOf(found))
    expect(payload.hits[0].id).toBe('M001')
    expect(payload.hits[0].excerpt).toContain('session store')

    const read = await client.callTool({
      name: 'loop_memory_get',
      arguments: { project_dir: project.dir, id: 'M001' },
    })
    expect(textOf(read)).toContain('no shared session store')
  })

  it('returns a tool error for a memory that does not exist', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    const result = await client.callTool({
      name: 'loop_memory_get',
      arguments: { project_dir: project.dir, id: 'M404' },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })
})
