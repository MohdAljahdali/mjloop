#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { FeatureDiscoveryModeSchema } from '../schemas/config.js'
import { AgentNameSchema, AgentResultSchema } from '../schemas/contract.js'
import { FeatureIdSchema } from '../schemas/feature.js'
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
// The only store this file reaches for directly, and deliberately so: the
// feature-brief store already *is* the operation. It takes the write lock,
// writes atomically, compares and swaps on the expected revision, and validates
// `affectedComponents` against the accepted profile — so an `ops/feature.ts`
// between here and there would be a file of eight one-line pass-throughs, which
// is a layer that can only ever be wrong about something.
import {
  appendFeatureDecision,
  approveFeatureBrief,
  createFeatureBrief,
  listFeatureRevisions,
  listFeatureSummaries,
  readFeatureBrief,
  readFeatureRevision,
  supersedeFeatureBrief,
  updateFeatureDraft,
  type FeatureDraftPatch,
} from '../store/feature-store.js'
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
        feature: FeatureIdSchema.nullish().describe(
          'Approved feature brief id, e.g. F001. Pins this run\'s skill manifest from that brief and the accepted ' +
            'component map. Omit it and the run behaves exactly as it always has.',
        ),
      },
    },
    async ({ project_dir, track, goal, plan, story, feature }) =>
      guard(async () =>
        ok(
          await runStart(resolveProjectDir(project_dir), {
            track,
            goal,
            plan: plan ?? null,
            story: story ?? null,
            // Validated by `FeatureIdSchema` on the way in rather than left to
            // `readFeatureBrief` to reject: this is the only surface that opens
            // a run, so a shape refused here is refused before anything is
            // read, and the caller is told which argument it got wrong.
            feature: feature ?? null,
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

  // Four tools over eight store entry points, and the arithmetic is the one
  // `mjloop_report_get` does below: a declaration is not paid for once, it is
  // paid for on every turn in every context this server is attached to, so the
  // question is never "is this tool useful" but "is it worth what every future
  // turn pays for it". Each merge below is an operation that shares a *record
  // and a moment* with the one it joins, not merely a prefix.
  //
  // create ← create + supersede. Both mint a draft revision of a feature; the
  //   only difference is where its content comes from — a blank one, or the
  //   approved revision it replaces. Splitting them buys a discriminator and
  //   charges a whole declaration for it.
  // get ← read one revision + read the latest + list features. Three
  //   projections of one walk over one directory, exactly as telemetry and
  //   preflight are two projections of one walk over run history. The arguments
  //   discriminate on their own: no feature means list, no revision means latest.
  // update ← set fields + append a decision. One act, not two: the interview
  //   learns something and writes down both what it asked and what that settled.
  // approve stands alone, and that is the point of it. It is the only
  //   irreversible write here — the revision it lands on is never rewritten
  //   again — and the only one a person rather than a model decides. Folded
  //   into `update` it would be reachable by a mistyped argument.
  //
  // Twenty-two tools. `tests/mcp/server.test.ts` asserts the list exactly, so
  // the twenty-third is an edit to a budget rather than a side effect.
  server.registerTool(
    'mjloop_feature_create',
    {
      title: 'Open a feature brief',
      description:
        'Mint a draft feature brief — what discovery decided, written down so a plan is built on a record rather than on chat scrollback. Returns its id and revision; fill it in with mjloop_feature_update and record the decision with mjloop_feature_approve. With supersedes it instead opens the next revision of an existing feature as a draft, carrying the approved content forward: that is the only way to change an approved brief, and it leaves the approved revision saying exactly what it always said.',
      inputSchema: {
        project_dir: projectDirArg,
        title: z.string().min(1).max(200).optional().describe('One line naming the feature. Omitted only with supersedes'),
        problem: z
          .string()
          .min(1)
          .max(20000)
          .optional()
          .describe('What is wrong today and for whom, in the words of the person who asked. Omitted only with supersedes'),
        // Recorded rather than read off `.mjloop/config.yaml` here, because the
        // record must say which policy this interview ran under and the live
        // config answers a question about the present. A per-feature override
        // is exactly the case that would otherwise be lost.
        discovery_mode: FeatureDiscoveryModeSchema.optional().describe(
          'The discovery policy this brief was produced under — orchestration.discovery.mode, or the per-feature choice that overrode it',
        ),
        question_budget: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('The question ceiling the interview ran under, from orchestration.discovery.question_budget or its override'),
        acceptance: z
          .array(z.string().min(1))
          .optional()
          .describe('Checkable conditions. May be empty on a draft; approval refuses a brief that still has none'),
        affected_components: z
          .array(IdSchema)
          .optional()
          .describe('Component ids from the accepted map in .mjloop/profile/accepted/. Empty is legal; an unknown id is refused'),
        supersedes: FeatureIdSchema.optional().describe('Feature id whose approved revision this one replaces, e.g. F001'),
        expect_revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('With supersedes: the approved revision you read. Refused if the feature has moved on since'),
      },
    },
    async ({ project_dir, title, problem, discovery_mode, question_budget, acceptance, affected_components, supersedes, expect_revision }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)

        if (supersedes !== undefined) {
          if (expect_revision === undefined) {
            throw new Error(
              'superseding is compare-and-swap: name expect_revision, the approved revision you read. Without it this ' +
                'would replace whatever happens to be there now, which may be a revision somebody else approved while ' +
                'you were reading',
            )
          }
          // Refused rather than ignored, for the reason a closing roster that
          // also names a cycle is refused: a successor copies its predecessor's
          // content by definition, so content passed here is an answer to a
          // question this call does not ask. Accepting and dropping it would
          // report success for a title nobody wrote down.
          const carried = { title, problem, discovery_mode, question_budget, acceptance, affected_components }
          const named = Object.entries(carried)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key)
          if (named.length > 0) {
            throw new Error(
              `a successor carries its predecessor's content forward, so it takes none of its own — drop ${named.join(', ')} ` +
                'and change the draft this returns with mjloop_feature_update',
            )
          }
          return ok(await supersedeFeatureBrief(dir, { id: supersedes, expectRevision: expect_revision }))
        }

        if (expect_revision !== undefined) {
          throw new Error('expect_revision belongs to supersedes — a first revision replaces nothing, so there is no revision to swap on')
        }
        if (title === undefined || problem === undefined) {
          throw new Error('a new brief needs a title and a problem, or a supersedes naming the feature whose next revision this is')
        }
        // Demanded rather than defaulted: a brief that recorded a policy nobody
        // chose would read, months later, as evidence of an interview that
        // never happened.
        if (discovery_mode === undefined || question_budget === undefined) {
          throw new Error(
            'a brief records the policy it was produced under — give discovery_mode and question_budget, reading ' +
              'orchestration.discovery.mode and orchestration.discovery.question_budget from .mjloop/config.yaml unless ' +
              'this feature was given its own',
          )
        }

        return ok(
          await createFeatureBrief(dir, {
            title,
            problem,
            discovery: { mode: discovery_mode, questionBudget: question_budget },
            ...(acceptance === undefined ? {} : { acceptance }),
            ...(affected_components === undefined ? {} : { affectedComponents: affected_components }),
          }),
        )
      }),
  )

  server.registerTool(
    'mjloop_feature_get',
    {
      title: 'Read a feature brief',
      description:
        'Read the latest revision of one feature, or with revision the exact one a plan was built on, or with no feature at all a summary of every feature this project has raised. A single read also returns the revision list and a digest of the record, which are what an expect_revision and an expect_digest are taken from. status is superseded when a higher revision exists — it is derived here and never stored.',
      inputSchema: {
        project_dir: projectDirArg,
        feature: FeatureIdSchema.optional().describe('Feature id, e.g. F001. Omit to list every feature'),
        revision: z.number().int().positive().optional().describe('Read this exact revision instead of the latest'),
      },
    },
    async ({ project_dir, feature, revision }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)
        if (feature === undefined) {
          if (revision !== undefined) throw new Error('a revision belongs to a feature — name one, or drop revision to list every feature')
          // An empty project is an answer, not an error: nothing has been
          // raised yet, and that is exactly what the caller asked.
          return ok({ features: await listFeatureSummaries(dir) })
        }

        // The store reads a missing feature as null, which is right for a read
        // model that wants a cheap 404. A model asking this question needs the
        // opposite: an absent answer it can act on, naming what does exist.
        const revisions = await listFeatureRevisions(dir, feature)
        if (revisions.length === 0) {
          throw new Error(`no feature ${feature} in this project — call mjloop_feature_get with no feature to see which exist`)
        }
        const record = revision === undefined ? await readFeatureBrief(dir, feature) : await readFeatureRevision(dir, feature, revision)
        if (record === null) {
          throw new Error(`${feature} has no revision ${String(revision)} — it has ${revisions.join(', ')}`)
        }
        return ok({ ...record, revisions })
      }),
  )

  server.registerTool(
    'mjloop_feature_update',
    {
      title: 'Update a feature draft',
      description:
        'Record what the interview just learned: a question with the recommendation you made and the answer that came back, and the acceptance criteria, components, title or problem that answer settled. A question with no answer is a real record — it is the decision the budget ran out on, and dropping it would make the brief look more settled than it is. Draft only: an approved revision is never rewritten, and mjloop_feature_create with supersedes is the way to change one.',
      inputSchema: {
        project_dir: projectDirArg,
        feature: FeatureIdSchema.describe('Feature id, e.g. F001'),
        question: z.string().min(1).max(2000).optional().describe('A decision question the interview asked'),
        recommendation: z.string().min(1).max(2000).nullish().describe('What you recommended, and why, when you asked it'),
        answer: z.string().min(1).max(4000).nullish().describe("The answer in the user's own words. Omit for a question the budget ran out on"),
        title: z.string().min(1).max(200).optional(),
        problem: z.string().min(1).max(20000).optional(),
        acceptance: z.array(z.string().min(1)).optional().describe('Replaces the list; approval refuses a brief with none'),
        affected_components: z.array(IdSchema).optional().describe('Replaces the list. Every id must be in the accepted component map'),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Replaces the list. What the brief declares itself to be about, beyond its component ids — joined ' +
              "against a component's skillTags by skill selection, for a cross-cutting concern like an " +
              'authentication boundary. Name a tag only because a person decided it belonged during discovery; never ' +
              'infer one from problem or acceptance text',
          ),
        // A successor inherits its predecessor's discovery block along with the
        // rest of its content, and the interview behind revision 2 is not the
        // interview behind revision 1: it may run under a mode the project has
        // since moved to, or under an override stated for this request alone.
        // `mjloop_feature_create` refuses these alongside `supersedes` and names
        // this tool as where they belong, so they have to be reachable here or
        // that refusal points at nothing.
        discovery_mode: FeatureDiscoveryModeSchema.optional().describe(
          'The discovery policy this revision\'s own interview ran under, when it is not the one carried forward',
        ),
        question_budget: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('The question ceiling this revision\'s own interview ran under'),
        discovery_complete: z
          .boolean()
          .optional()
          .describe('true when the interview has stopped asking, false to reopen it. The engine stamps the time'),
      },
    },
    async ({ project_dir, feature, question, recommendation, answer, title, problem, acceptance, affected_components, tags, discovery_mode, question_budget, discovery_complete }) =>
      guard(async () => {
        const dir = resolveProjectDir(project_dir)
        if (question === undefined && (recommendation !== undefined || answer !== undefined)) {
          throw new Error('a recommendation and an answer belong to a question — name the question this decision answers')
        }

        const patch: FeatureDraftPatch = {
          ...(title === undefined ? {} : { title }),
          ...(problem === undefined ? {} : { problem }),
          ...(acceptance === undefined ? {} : { acceptance }),
          ...(affected_components === undefined ? {} : { affectedComponents: affected_components }),
          ...(tags === undefined ? {} : { tags }),
          ...(discovery_mode === undefined ? {} : { discoveryMode: discovery_mode }),
          ...(question_budget === undefined ? {} : { discoveryQuestionBudget: question_budget }),
          // The timestamp is the engine's, exactly as a decision's `at` is. A
          // caller asked for an ISO string invents one, and a brief's only
          // claim about when its interview ended would then be a guess.
          ...(discovery_complete === undefined
            ? {}
            : { discoveryCompletedAt: discovery_complete ? new Date().toISOString() : null }),
        }

        const patched = Object.keys(patch).length === 0 ? null : await updateFeatureDraft(dir, feature, patch)
        if (question === undefined) {
          // Reporting success for a call that moved no file would tell the
          // interview its answer was written down when nothing was.
          if (patched === null) throw new Error('nothing to change — pass a question to record a decision, or a field to set')
          return ok(patched)
        }
        // The append runs last on purpose. Setting a field is idempotent and
        // appending a decision is not, so a call that fails part-way is safe to
        // retry: the patch re-applies to the same value and the decision is
        // recorded once. The other order would duplicate the decision.
        return ok(
          await appendFeatureDecision(dir, feature, {
            question,
            recommendation: recommendation ?? null,
            answer: answer ?? null,
          }),
        )
      }),
  )

  server.registerTool(
    'mjloop_feature_approve',
    {
      title: 'Record a decision about a feature brief',
      description:
        'Approve a draft brief, which is what lets a plan be built on it and is the last write that revision ever takes. Ask the user and record their answer, including their own words in note. Never record an approval nobody gave. Refused unless expect_revision and expect_digest are the revision and the digest of the brief you actually showed them, so a brief that was changed while you were waiting is refused rather than approved unread, and refused if the brief still has no acceptance criteria.',
      inputSchema: {
        project_dir: projectDirArg,
        feature: FeatureIdSchema.describe('Feature id, e.g. F001'),
        expect_revision: z
          .number()
          .int()
          .positive()
          .describe('The revision you read and showed the user. Refused if the brief has moved on since'),
        // The revision number alone is not a precondition on a draft: it does
        // not move while the record is editable, which is the whole of the
        // window an approval waits in. The digest does, so it is required
        // rather than optional — an approval that could omit it would be an
        // approval that could be built on a brief nobody read.
        expect_digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .describe('The digest returned beside the brief you showed the user. Refused if a word of it has changed since'),
        by: z.string().min(1).describe('Who decided. Use the user name or identifier, not the agent'),
        note: z.string().min(1).nullish().describe("The approver's own words"),
      },
    },
    async ({ project_dir, feature, expect_revision, expect_digest, by, note }) =>
      guard(async () =>
        ok(
          await approveFeatureBrief(resolveProjectDir(project_dir), {
            id: feature,
            expectRevision: expect_revision,
            expectDigest: expect_digest,
            by,
            ...(note === undefined ? {} : { note }),
          }),
        ),
      ),
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
  // running. Eighteen tools when this was written, not nineteen and not
  // seventeen; `tests/mcp/server.test.ts` keeps the running count, because a
  // total stated here goes stale the moment a later story adds one.
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
