#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { AgentNameSchema, AgentResultSchema } from '../schemas/contract.js'
import { MemoryKindSchema } from '../schemas/memory.js'
import { ApprovalDecisionSchema, StoryStatusSchema } from '../schemas/plan.js'
import { IdSchema, ResultSchema } from '../schemas/state.js'
import { initLoop } from '../ops/init.js'
import { renderIndex } from '../ops/index-render.js'
import { runLog } from '../ops/log.js'
import { memoryAdd, memoryGet, memorySearch } from '../ops/memory.js'
import { gateSet, planCreate, storyAdd, storyGet, storyNext, storyUpdate } from '../ops/plan.js'
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
        track: IdSchema.describe('Track name as defined in .loop/config.yaml'),
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
        'Record which agents this cycle runs and why each omission is safe. Rejected if any agent the track marks required is missing, or if an optional agent is omitted without a stated reason.',
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
        agent: AgentNameSchema.describe('Agent name as it appears in the track roster'),
        instance: z
          .string()
          .min(1)
          .optional()
          .describe('Distinguishes parallel runs of the same agent, e.g. one hypothesis-tester per hypothesis'),
        result: AgentResultSchema,
      },
    },
    async ({ project_dir, agent, instance, result }) =>
      guard(async () =>
        ok(
          await runLog(resolveProjectDir(project_dir), {
            agent,
            ...(instance === undefined ? {} : { instance }),
            result,
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_cycle_advance',
    {
      title: 'Close the cycle',
      description:
        'Record the cycle outcome. pass finishes the run; otherwise the next cycle opens unless the cap is reached. Returns the new state plus carried_findings — the closed cycle findings, which are the next cycle task list.',
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

  server.registerTool(
    'loop_plan_create',
    {
      title: 'Create a plan',
      description: 'Allocate the next plan id, create its directory with PLAN.md, and generate an empty manifest.',
      inputSchema: {
        project_dir: projectDirArg,
        slug: z.string().min(1).describe('Short filename-safe name, e.g. user-auth'),
        title: z.string().min(1),
        body: z.string().optional().describe('Prose for PLAN.md — the problem, the approach, the constraints'),
      },
    },
    async ({ project_dir, slug, title, body }) =>
      guard(async () =>
        ok(
          await planCreate(resolveProjectDir(project_dir), {
            slug,
            title,
            ...(body === undefined ? {} : { body }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_gate_set',
    {
      title: 'Record a decision about a plan',
      description:
        'Record a plan approval decision. Under gates.plan_approval: human this is what lets stories be added — ask the user and record their answer, including their own words in note. Never record an approval nobody gave.',
      inputSchema: {
        project_dir: projectDirArg,
        plan: z.string().min(1).describe('Plan id, e.g. P001'),
        decision: ApprovalDecisionSchema,
        by: z.string().min(1).describe('Who decided. Use the user name or identifier, not the agent'),
        note: z.string().min(1).nullish().describe("The approver's own words"),
      },
    },
    async ({ project_dir, plan, decision, by, note }) =>
      guard(async () =>
        ok(
          await gateSet(resolveProjectDir(project_dir), {
            plan,
            decision,
            by,
            ...(note === undefined ? {} : { note }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_story_add',
    {
      title: 'Add a story to a plan',
      description: 'Allocate the next story id in a plan, write the story file, and regenerate the manifest.',
      inputSchema: {
        project_dir: projectDirArg,
        plan: z.string().min(1).describe('Plan id, e.g. P001'),
        title: z.string().min(1),
        acceptance: z.array(z.string().min(1)).optional().describe('Checkable conditions this story must meet'),
        ui: z.boolean().optional(),
        depends_on: z.array(z.string().min(1)).optional().describe('Story ids that must be done first'),
        body: z.string().optional(),
      },
    },
    async ({ project_dir, plan, title, acceptance, ui, depends_on, body }) =>
      guard(async () =>
        ok(
          await storyAdd(resolveProjectDir(project_dir), {
            plan,
            title,
            ...(acceptance === undefined ? {} : { acceptance }),
            ...(ui === undefined ? {} : { ui }),
            ...(depends_on === undefined ? {} : { depends_on }),
            ...(body === undefined ? {} : { body }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_story_update',
    {
      title: 'Update a story',
      description: 'Change a story status, evidence, acceptance, ui flag, dependencies, or title, then regenerate the manifest.',
      inputSchema: {
        project_dir: projectDirArg,
        story: z.string().min(1).describe('Story id, e.g. P001-S02'),
        status: StoryStatusSchema.optional(),
        evidence: z.string().min(1).nullish().describe('Run directory holding the proof this story is done'),
        acceptance: z.array(z.string().min(1)).optional(),
        ui: z.boolean().optional(),
        depends_on: z.array(z.string().min(1)).optional(),
        title: z.string().min(1).optional(),
      },
    },
    async ({ project_dir, story, status, evidence, acceptance, ui, depends_on, title }) =>
      guard(async () =>
        ok(
          await storyUpdate(resolveProjectDir(project_dir), story, {
            ...(status === undefined ? {} : { status }),
            ...(evidence === undefined ? {} : { evidence }),
            ...(acceptance === undefined ? {} : { acceptance }),
            ...(ui === undefined ? {} : { ui }),
            ...(depends_on === undefined ? {} : { depends_on }),
            ...(title === undefined ? {} : { title }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_story_get',
    {
      title: 'Read a story',
      description: 'Read one story by id, or with next=true resolve the lowest-id story that is ready to start.',
      inputSchema: {
        project_dir: projectDirArg,
        story: z.string().min(1).optional().describe('Story id. Omit and set next=true to resolve the next ready story'),
        next: z.boolean().optional(),
        plan: z.string().min(1).optional().describe('Restrict a next=true search to one plan'),
      },
    },
    async ({ project_dir, story, next, plan }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)
        if (next === true) return ok(await storyNext(dir, plan))
        if (story === undefined) {
          throw new Error('give a story id, or set next=true to resolve the next ready story')
        }
        return ok({ story: await storyGet(dir, story), reason: 'read by id' })
      }),
  )

  server.registerTool(
    'loop_index_render',
    {
      title: 'Regenerate INDEX.md',
      description: 'Rebuild .loop/INDEX.md from every plan manifest. Returns the rendered markdown.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) => guard(async () => ok(await renderIndex(resolveProjectDir(project_dir)))),
  )

  server.registerTool(
    'loop_memory_add',
    {
      title: 'Record a memory',
      description:
        'Record a decision, a lesson, or a pattern this project should not have to relearn. Write one at the end of a run — a decision the diff will not explain, or a lesson from a halt. Not a diary: a memory per cycle buries the entries that matter.',
      inputSchema: {
        project_dir: projectDirArg,
        kind: MemoryKindSchema,
        title: z.string().min(1).describe('One line, specific enough to find later'),
        body: z.string().min(1).describe('The reasoning, at whatever length it needs'),
        tags: z.array(z.string().min(1)).optional(),
        run: z.string().min(1).nullish().describe('The run that produced it, when there is one'),
      },
    },
    async ({ project_dir, kind, title, body, tags, run }) =>
      guard(async () =>
        ok(
          await memoryAdd(resolveProjectDir(project_dir), {
            kind,
            title,
            body,
            ...(tags === undefined ? {} : { tags }),
            ...(run === undefined ? {} : { run }),
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_memory_search',
    {
      title: 'Search memory',
      description:
        'Rank recorded memories against a query and return the best few with excerpts. Consult it when composing a cycle: a hit changes how you brief the agents, and no hit costs one call. Never returns the whole corpus.',
      inputSchema: {
        project_dir: projectDirArg,
        query: z.string().min(1),
        limit: z.number().int().positive().max(20).optional().describe('Default 5'),
      },
    },
    async ({ project_dir, query, limit }) =>
      guard(async () => ok(await memorySearch(resolveProjectDir(project_dir), query, limit))),
  )

  server.registerTool(
    'loop_memory_get',
    {
      title: 'Read a memory',
      description: 'Read one memory entry in full, by id, after a search surfaced it.',
      inputSchema: { project_dir: projectDirArg, id: z.string().min(1).describe('Memory id, e.g. M001') },
    },
    async ({ project_dir, id }) => guard(async () => ok(await memoryGet(resolveProjectDir(project_dir), id))),
  )

  return server
}

if (await isEntrypoint(import.meta.url)) {
  const server = buildServer()
  await server.connect(new StdioServerTransport())
}
