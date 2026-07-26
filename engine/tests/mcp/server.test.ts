import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, resolveProjectDir } from '../../src/mcp/server.js'
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
      'loop_halt',
      'loop_init',
      'loop_roster_set',
      'loop_run_log',
      'loop_run_start',
      'loop_state_get',
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
})
