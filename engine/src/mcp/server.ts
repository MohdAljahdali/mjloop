#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { AgentResultSchema } from '../schemas/contract.js'
import { IdSchema, ResultSchema } from '../schemas/state.js'
import { initLoop } from '../ops/init.js'
import { runLog } from '../ops/log.js'
import { rosterSet } from '../ops/roster.js'
import { cycleAdvance, halt, runStart } from '../ops/run.js'
import { stateSummary } from '../ops/summary.js'
import { isEntrypoint } from '../util/entrypoint.js'

/** MCP servers are launched with the project as cwd; the argument is an escape hatch. */
export function resolveProjectDir(projectDir?: string): string {
  if (projectDir !== undefined && projectDir.length > 0) return projectDir
  const fromEnv = process.env.CLAUDE_PROJECT_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return process.cwd()
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function ok(payload: unknown): ToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text', text }] }
}

/** Operational failures are tool errors the leader can read and react to. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true }
  }
}

const projectDirArg = z.string().optional().describe('Project root. Defaults to CLAUDE_PROJECT_DIR or cwd.')

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'loop', version: '0.1.0' })

  server.registerTool(
    'loop_init',
    {
      title: 'Initialise loop',
      description: 'Provision .loop/ in the project, detect verify commands, and register loop in CLAUDE.md. Idempotent.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) =>
      guard(async () => {
        const result = await initLoop(resolveProjectDir(project_dir))
        return ok(result)
      }),
  )

  server.registerTool(
    'loop_state_get',
    {
      title: 'Get loop state',
      description: 'Compact summary of the current run: track, cycle, cap, stage, findings, halt reason.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) => guard(async () => ok(await stateSummary(resolveProjectDir(project_dir)))),
  )

  server.registerTool(
    'loop_run_start',
    {
      title: 'Start a run',
      description: 'Open a new run on a track. Resets cycle, findings, and history.',
      inputSchema: {
        project_dir: projectDirArg,
        track: z.string().min(1).describe('Track name as defined in .loop/config.yaml'),
        goal: z.string().min(1).describe('What this run must achieve'),
        plan: IdSchema.nullish().describe('Plan id, e.g. P001'),
        story: IdSchema.nullish().describe('Story id, e.g. P001-S02'),
      },
    },
    async ({ project_dir, track, goal, plan, story }) =>
      guard(async () =>
        ok(
          await runStart(resolveProjectDir(project_dir), {
            track,
            goal,
            plan: plan ?? null,
            story: story ?? null,
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_roster_set',
    {
      title: 'Declare the cycle roster',
      description:
        'Record which agents this cycle runs and why each omission is safe. Rejected if a required agent — verifier above all — is missing.',
      inputSchema: {
        project_dir: projectDirArg,
        cycle: z.number().int().positive(),
        selected: z.array(z.string().min(1)).min(1),
        skipped: z.record(z.string().min(1), z.string().min(1)).default({}).describe('agent -> why omitting it is safe'),
      },
    },
    async ({ project_dir, cycle, selected, skipped }) =>
      guard(async () => ok(await rosterSet(resolveProjectDir(project_dir), { cycle, selected, skipped }))),
  )

  server.registerTool(
    'loop_run_log',
    {
      title: 'Log an agent result',
      description: 'Validate an agent result against the contract, persist it under the cycle, and fold findings into state.',
      inputSchema: {
        project_dir: projectDirArg,
        agent: z.string().min(1),
        result: AgentResultSchema,
      },
    },
    async ({ project_dir, agent, result }) =>
      guard(async () => ok(await runLog(resolveProjectDir(project_dir), { agent, result }))),
  )

  server.registerTool(
    'loop_cycle_advance',
    {
      title: 'Close the cycle',
      description: 'Record the cycle outcome. pass finishes the run; otherwise the next cycle opens unless the cap is reached.',
      inputSchema: {
        project_dir: projectDirArg,
        agents: z.array(z.string().min(1)).min(1),
        result: ResultSchema,
      },
    },
    async ({ project_dir, agents, result }) =>
      guard(async () => ok(await cycleAdvance(resolveProjectDir(project_dir), { agents, result }))),
  )

  server.registerTool(
    'loop_halt',
    {
      title: 'Halt the run',
      description: 'Stop the run and write HALT.md with the evidence gathered so far.',
      inputSchema: { project_dir: projectDirArg, reason: z.string().min(1) },
    },
    async ({ project_dir, reason }) => guard(async () => ok(await halt(resolveProjectDir(project_dir), reason))),
  )

  return server
}

if (await isEntrypoint(import.meta.url)) {
  const server = buildServer()
  await server.connect(new StdioServerTransport())
}
