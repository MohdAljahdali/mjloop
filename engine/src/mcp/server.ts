#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { AgentNameSchema, AgentResultSchema } from '../schemas/contract.js'
import { MemoryBodySchema, MemoryKindSchema, MemoryTagsSchema, MemoryTitleSchema } from '../schemas/memory.js'
import { ApprovalDecisionSchema, StoryStatusSchema } from '../schemas/plan.js'
import { IdSchema, ResultSchema } from '../schemas/state.js'
import { VerifySlotSchema } from '../schemas/verify.js'
import { initLoop } from '../ops/init.js'
import { renderIndex } from '../ops/index-render.js'
import { runLog } from '../ops/log.js'
import { memoryAdd, memoryGet, memorySearch } from '../ops/memory.js'
import { gateSet, planCreate, storyAdd, storyGet, storyNext, storyUpdate } from '../ops/plan.js'
import { preflightEstimate } from '../ops/preflight.js'
import { rosterSet } from '../ops/roster.js'
import { cycleAdvance, halt, runStart } from '../ops/run.js'
import { stateSummary } from '../ops/summary.js'
import { readTelemetry } from '../ops/telemetry.js'
import { verifyRun } from '../ops/verify.js'
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
  const server = new McpServer({ name: 'mjloop', version: '0.1.0' })

  server.registerTool(
    'mjloop_init',
    {
      title: 'Initialise mjloop',
      description: 'Provision .mjloop/ in the project, detect verify commands, and register mjloop in CLAUDE.md. Idempotent.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) =>
      guard(async () => {
        const result = await initLoop(resolveProjectDir(project_dir))
        return ok(result)
      }),
  )

  server.registerTool(
    'mjloop_state_get',
    {
      title: 'Get loop state',
      description: 'Compact summary of the current run: track, cycle, cap, stage, findings, halt reason.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) => guard(async () => ok(await stateSummary(resolveProjectDir(project_dir)))),
  )

  server.registerTool(
    'mjloop_run_start',
    {
      title: 'Start a run',
      description: 'Open a new run on a track. Resets cycle, findings, and history.',
      inputSchema: {
        project_dir: projectDirArg,
        track: IdSchema.describe('Track name as defined in .mjloop/config.yaml'),
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
    'mjloop_roster_set',
    {
      title: 'Declare the cycle roster',
      description:
        'Record which agents this cycle runs and why each omission is safe. Rejected if any agent the track marks required is missing, or if an optional agent is omitted without a stated reason. With closing=true it records the run closing pass instead, drawn from the closing set mjloop_cycle_advance reported on the pass.',
      inputSchema: {
        project_dir: projectDirArg,
        closing: z
          .literal(true)
          .optional()
          .describe(
            'Declares the run closing pass rather than a working cycle. Set it only after mjloop_cycle_advance returned "pass" and its closing_agents.',
          ),
        cycle: z.number().int().positive().optional().describe('The working cycle this roster composes. Omitted only for a closing roster'),
        // `min(1)` lives in `RosterSchema` rather than here because the two
        // kinds disagree about it: a working cycle must dispatch someone, and a
        // closing pass that dispatched nobody is the one case worth writing
        // down — it is the durable record that the run shipped without its
        // documentation, and why. A wire-level floor would make it unwritable.
        selected: z.array(z.string().min(1)).describe('Agents dispatched. At least one for a working cycle'),
        skipped: z.record(z.string().min(1), z.string().min(1)).default({}).describe('agent -> why omitting it is safe'),
      },
    },
    async ({ project_dir, closing, cycle, selected, skipped }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)
        if (closing !== true) {
          if (cycle === undefined) {
            throw new Error("give a cycle number, or set closing=true to declare the run's closing pass")
          }
          return ok(await rosterSet(dir, { cycle, selected, skipped }))
        }
        // Refused rather than ignored. A closing pass belongs to no cycle, and a
        // caller that names one is answering a question this call does not ask —
        // most likely a leader declaring the closing pass with the cycle roster's
        // arguments, which would record the wrong composition against the wrong
        // set of agents and read as accepted.
        if (cycle !== undefined) {
          throw new Error('a closing roster belongs to no cycle — it records the pass that ended the run; drop the cycle argument')
        }
        return ok(await rosterSet(dir, { closing: true, selected, skipped }))
      }),
  )

  server.registerTool(
    'mjloop_run_log',
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
        run_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The run this agent was dispatched under — the run_id mjloop_cycle_advance returned in its state. ' +
              'Pass it for a closing agent: it is refused if the run has since been replaced, which is the only ' +
              'thing keeping a late result out of the next run findings.',
          ),
        result: AgentResultSchema,
      },
    },
    async ({ project_dir, agent, instance, run_id, result }) =>
      guard(async () =>
        ok(
          await runLog(resolveProjectDir(project_dir), {
            agent,
            ...(instance === undefined ? {} : { instance }),
            ...(run_id === undefined ? {} : { run_id }),
            result,
          }),
        ),
      ),
  )

  server.registerTool(
    'mjloop_verify_run',
    {
      title: 'Run a verify command',
      description:
        "Run one verify slot from the run's pinned verify block, write the whole log under the cycle, and return a bounded digest: exit code, headline, capped failures, and no verdict — the verifier still decides. phase running means the child outlived wait_ms; phase queued means nothing ran at all because another verify command in this project holds the lock. Call again for either.",
      inputSchema: {
        project_dir: projectDirArg,
        slot: VerifySlotSchema,
        label: z.string().min(1).optional().describe('Distinguishes two runs of one slot in a cycle'),
        wait_ms: z.number().int().positive().optional().describe('How long to wait before returning phase running. Default 45000'),
      },
    },
    // The only tool that takes the callback's second argument. `extra.signal`
    // fires when the client cancels or times out the request, and it is passed
    // as `waitSignal` — which abandons *this call's wait* and never the child.
    // A client-side MCP_TIMEOUT that killed the suite would make the next call
    // re-run a four-minute command from zero, which is the exact outcome
    // `phase: 'running'` exists to prevent. Only verify.timeout_ms kills.
    async ({ project_dir, slot, label, wait_ms }, extra) =>
      guard(async () =>
        ok(
          await verifyRun(
            resolveProjectDir(project_dir),
            {
              slot,
              ...(label === undefined ? {} : { label }),
              ...(wait_ms === undefined ? {} : { wait_ms }),
            },
            undefined,
            extra.signal,
          ),
        ),
      ),
  )

  server.registerTool(
    'mjloop_cycle_advance',
    {
      title: 'Close the cycle',
      description:
        'Record the cycle outcome. pass finishes the run; otherwise the next cycle opens unless the cap is reached. Returns the new state plus carried_findings — the closed cycle findings, which are the next cycle task list — and closing_agents, the agents to dispatch now that the run has passed, empty on any other outcome.',
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
    'mjloop_halt',
    {
      title: 'Halt the run',
      description: 'Stop the run and write HALT.md with the evidence gathered so far.',
      inputSchema: { project_dir: projectDirArg, reason: z.string().min(1) },
    },
    async ({ project_dir, reason }) => guard(async () => ok(await halt(resolveProjectDir(project_dir), reason))),
  )

  server.registerTool(
    'mjloop_plan_create',
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
    'mjloop_gate_set',
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
    'mjloop_story_add',
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
    'mjloop_story_update',
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
    'mjloop_story_get',
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
    'mjloop_index_render',
    {
      title: 'Regenerate INDEX.md',
      description: 'Rebuild .mjloop/INDEX.md from every plan manifest. Returns the rendered markdown.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) => guard(async () => ok(await renderIndex(resolveProjectDir(project_dir)))),
  )

  server.registerTool(
    'mjloop_memory_add',
    {
      title: 'Record a memory',
      description:
        'Record a decision, a lesson, or a pattern this project should not have to relearn. Write one at the end of a run — a decision the diff will not explain, or a lesson from a halt. Not a diary: a memory per cycle buries the entries that matter.',
      inputSchema: {
        project_dir: projectDirArg,
        kind: MemoryKindSchema,
        title: MemoryTitleSchema.describe('One line, specific enough to find later'),
        // Bounded here as well as in the schema so the ceiling is legible to the
        // caller before it writes a transcript it will have to write again.
        body: MemoryBodySchema.describe('The reasoning — the conclusion and why, not the transcript'),
        tags: MemoryTagsSchema.optional(),
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
    'mjloop_memory_search',
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
    'mjloop_memory_get',
    {
      title: 'Read a memory',
      description: 'Read one memory entry in full, by id, after a search surfaced it.',
      inputSchema: { project_dir: projectDirArg, id: z.string().min(1).describe('Memory id, e.g. M001') },
    },
    async ({ project_dir, id }) => guard(async () => ok(await memoryGet(resolveProjectDir(project_dir), id))),
  )

  // One tool, two projections, and the arithmetic is the point: telemetry and
  // preflight are both pure projections of the one bounded `readRunHistory`
  // walk, so a second tool would buy a discriminator's worth of clarity and
  // charge every context this server is attached to for a whole extra
  // declaration on every turn. Neither can be served by the cockpit alone —
  // the leader needs the preflight estimate under gates.preflight: human, and
  // a slash command cannot make an HTTP request to a server that may not be
  // running. Eighteen tools, not nineteen and not seventeen.
  server.registerTool(
    'mjloop_report_get',
    {
      title: 'Read a report over past runs',
      description:
        'Two projections of one bounded walk over past runs. telemetry: what every specialist this project drafted actually returned, so a mode or an available list can be pruned on evidence — a report, never a rule. preflight: the shape of a run on a track before it starts — roster, dispatches per cycle, ceiling, and what comparable past runs took. Neither is folded into routine output; ask for it.',
      inputSchema: {
        project_dir: projectDirArg,
        report: z.enum(['telemetry', 'preflight']),
        track: IdSchema.optional().describe('preflight only, and required for it. Track name as in .mjloop/config.yaml'),
        story: IdSchema.nullish().describe('preflight only. Compares story-bound runs against story-bound runs'),
        limit: z.number().int().positive().max(200).optional().describe('telemetry only: past runs to walk. Default 50'),
      },
    },
    async ({ project_dir, report, track, story, limit }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)
        if (report === 'preflight') {
          // The estimate is per track by construction — it takes a track name
          // rather than a state, because idle is when it is asked.
          if (track === undefined) throw new Error('preflight needs a track — the estimate is per track, and is asked before a run exists')
          return ok(await preflightEstimate(dir, { track, story: story ?? null }))
        }
        return ok(await readTelemetry(dir, limit === undefined ? {} : { limit }))
      }),
  )

  return server
}

if (await isEntrypoint(import.meta.url)) {
  const server = buildServer()
  await server.connect(new StdioServerTransport())
}
