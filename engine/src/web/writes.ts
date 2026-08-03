import os from 'node:os'
import * as z from 'zod'
import { AgentNameSchema } from '../schemas/contract.js'
import { FeatureIdSchema } from '../schemas/feature.js'
import { ApprovalDecisionSchema, PlanIdSchema, StoryIdSchema, StoryStatusSchema } from '../schemas/plan.js'
import { IdSchema } from '../schemas/state.js'
import { gateSet } from '../ops/plan.js'
import { storyUpdate } from '../ops/plan.js'
import { halt } from '../ops/run.js'
import { stateSummary } from '../ops/summary.js'
import {
  ConfigChangeSchema,
  ConfigMutationError,
  mutateConfig,
} from '../store/config-mutation.js'
import { loadConfig } from '../store/config-store.js'
import {
  ApprovedRevisionImmutableError,
  StaleFeatureContentError,
  StaleFeatureRevisionError,
  approveFeatureBrief,
} from '../store/feature-store.js'
import {
  AgentWriteError,
  deleteAgent,
  listAgents,
  readAgent,
  writeAgent,
  type AgentWriteFailure,
} from '../store/agent-store.js'
import { setAcceptanceAgents } from '../store/skill-acceptance-store.js'
import { PLUGIN_AGENTS_DIR } from './read.js'
import { StalePreconditionError, type PreconditionSubject } from '../store/precondition.js'
import type { WebCode } from './codes.js'

/**
 * The only engine writes the browser can reach, and the only door they
 * come through.
 *
 * Everything else on the page either reads, or composes a loop command and
 * enqueues it — there is one execution model and not a second, weaker one
 * beside it. Nine doors reach past that model. The original four cannot be
 * expressed as a command, and each is something a person is stuck on today:
 *
 *  - **Plan approval.** `gates.plan_approval` defaults to `human` and the build
 *    is refused until somebody decides. Spawning a whole `claude` session to
 *    flip one frontmatter field is absurd.
 *  - **Requeue a story.** A run cancelled mid-story leaves it `doing`, which
 *    makes it invisible to `--next` forever. The documented repair is a text
 *    editor.
 *  - **Halt a run.** Stop kills the pty and leaves `state.json` saying
 *    `running` with no `HALT.md`. That is not a halt.
 *  - **Feature-brief approval.** The same shape of problem as plan approval, one
 *    step earlier: the discovery interview finishes and the brief waits for a
 *    person, and `orchestration.discovery.completion: review` means it waits
 *    indefinitely. `.mjloop/features/` is a protected directory, so there is no
 *    text-editor repair here at all.
 *
 * `runStart`, `rosterSet`, `runLog` and `cycleAdvance` are forbidden from the
 * browser **permanently**. `runLog` opens a gated track's gate from the
 * payload's evidence array alone, so a browser that could call it could let a
 * click "prove" a reproduction nobody ran. `runStart` wipes findings, history,
 * guard counters and the reproduction. `cycleAdvance` is the only writer of
 * terminal status. Those four are how the loop *reports what it did*; a browser
 * that can write them can claim work nobody performed.
 *
 * A feature brief is denied everything except that one approval, for the same
 * family of reasons stated against the record it is:
 *
 *  - **Creating and editing one** is the discovery interview writing down what
 *    it asked and what came back. A page that could author a brief would be a
 *    second, weaker discovery flow beside the skill that exists to run one, and
 *    the brief it produced would carry decisions nobody was ever asked about.
 *  - **Superseding one** mints a successor draft carrying an approved brief's
 *    content forward, which is authoring under another name.
 *  - **Routing or executing one** — turning a brief into a plan or a run — is
 *    `/mjloop:plan` and `/mjloop:build`, which the page composes as commands
 *    like every other loop command. `runStart` being forbidden above is what
 *    makes that structural rather than a convention.
 *
 * Approval is the exception because it is the one of those a *person* performs
 * rather than the loop: the words being approved were written by the interview,
 * and all the button adds is that somebody read them and said yes. That is also
 * exactly why it is compare-and-swap on the revision *and on what that revision
 * said* — see `gateSet`'s rule about never recording an approval nobody gave,
 * which applies here with more force, because a plan is written *from* an
 * approved brief. "Somebody read them" is only true of the words the page was
 * actually showing, and a draft's revision number does not move when those
 * words do.
 *
 * **The three agent doors** — `agent.create`, `agent.update`, `agent.delete`
 * — are the other four, and a different class from the original four above:
 * not a repair for something the loop leaves broken, but `config.patch`'s
 * class restated for a different file. `config.patch` is an operator's own
 * decision about `config.yaml`, recorded compare-and-swap; these are the same
 * decision about a file under `.claude/agents/`. Never `runStart`'s class —
 * nothing here reports work the loop did, wipes history, or claims a cycle
 * happened — which is exactly why they get two refusals of their own rather
 * than none:
 *
 *  - **While a run is open.** Checked in `applyWrite`, before any handler
 *    runs, via `stateSummary` (already read elsewhere under `src/web/`, so
 *    importing it here does not open a new door of its own). The roster is
 *    pinned and the briefs are already sent once a run starts, so an agent
 *    edited mid-run would make what ran and what is recorded two different
 *    things.
 *  - **When a track still names the agent being deleted.** `agentUsedByTrack`
 *    reads the same config `config.patch` already reads (`loadConfig`, same
 *    story as `stateSummary` above on the import). It runs as `deleteAgent`'s
 *    own `guard` — *inside* the project lock that write already takes, after
 *    the digest check and before the file is removed — because the check and
 *    the delete have to be atomic against a `config.patch` racing in between
 *    them; a check made before calling `deleteAgent` would be reading the
 *    config outside the very lock `agent-store.ts` takes to prevent that.
 *
 * **The fourth door**, `skill.agents`, is `setAcceptanceAgents`'s only caller
 * and sets exactly the one field that store function lets it set — an
 * acceptance's `agents`, never its status, its components, its update policy
 * or the digest of the package it pins. It joins the two agent-door refusals
 * above rather than getting a fresh pair: `GUARDED_WHILE_RUNNING` (renamed
 * from `AGENT_KINDS` for exactly this reason) now names all four kinds this
 * class shares, so it is refused while a run is open the same way an agent
 * edit is — a run's pinned skill manifest is frozen at `runStart`, so an
 * acceptance's routing edited mid-run would make what a cycle was actually
 * offered and what is recorded two different things, the identical hazard an
 * agent file edited mid-run is refused for. It has no in-use guard of its own:
 * unlike deleting an agent a track still names, narrowing which agents a
 * skill routes to never leaves a track pointing at a file that stopped
 * existing.
 *
 * These are also the first writes anywhere in this server to land outside
 * `.mjloop/` at all — into `.claude/agents/`. That is confined at exactly one
 * seam: the name arrives typed as `AgentNameSchema` (`schemas/contract.ts`),
 * which admits only `[A-Za-z0-9_-]`, and `agent-store.ts`'s `agentFile`
 * (`agent-store.ts:143-148`) is the only place that name is ever joined onto
 * a path, and only onto the agents directory — `.` and `/` sit outside the
 * schema's character class, so `..` and `a/b` can never reach it. A project
 * agent may also shadow a plugin agent of the same name; `reservedAgentNames`
 * below reads `PLUGIN_AGENTS_DIR` fresh rather than a hard-coded list, and
 * `writeAgent`'s `reserved` option refuses the collision outright.
 *
 * This path bypasses the `PreToolUse` state guard entirely — it is the server
 * process, not a `claude` tool call — so the boundary is structural rather than
 * a hook. Four layers hold it:
 *
 *  1. **Compile.** `HANDLERS` is `{ [K in Write['kind']]: … }`: a new kind does
 *     not compile until it is handled, and a handler with no kind does not
 *     compile either.
 *  2. **Schema.** `strictObject` throughout, so an undeclared wire field is
 *     rejected before `applyWrite` is reached.
 *  3. **An import allowlist**, asserted from source text: this file may import
 *     the three original ops, the guarded config mutator, the agent store's
 *     two writers (`writeAgent`, `deleteAgent`), the skill acceptance store's
 *     one writer for this door (`setAcceptanceAgents`), and the two reads the
 *     agent doors need above (`stateSummary`, `loadConfig`) — the last two
 *     already imported elsewhere under `src/web/` with no single-importer
 *     assertion to widen; `server.ts` may import none.
 *  4. **A forbidden list**, asserted to appear nowhere under `src/web/`.
 */

/**
 * Every write carries what was on record when the button was pressed. The
 * precondition is evaluated inside the lock the op already takes, so an
 * 800ms-stale page can be trusted: a stale click is *refused* rather than
 * obeyed, and the UI needs no optimistic render and no rollback.
 *
 * Ids go through the engine's own schemas rather than being retyped.
 * `schemas/plan.ts:6-10` records that these were constrained after a review
 * found a story id could steer a write outside `.mjloop`; reusing them means
 * the wire validation *is* that defence.
 *
 * `note` and `reason` are free text and that is not a violation of the no-prose
 * rule: that rule constrains *server-authored* prose. These are the user's own
 * words travelling into a project file, the same category as `job.command` and
 * `state.goal`, which the snapshot already carries.
 */
export const WriteSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('gate'),
    plan: PlanIdSchema,
    from: ApprovalDecisionSchema.nullable(),
    to: ApprovalDecisionSchema,
    note: z.string().max(2000).nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('story.status'),
    story: StoryIdSchema,
    from: StoryStatusSchema,
    to: StoryStatusSchema,
  }),
  z.strictObject({
    kind: z.literal('halt'),
    run: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal('config.patch'),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    changes: z.array(ConfigChangeSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal('feature.approve'),
    feature: FeatureIdSchema,
    /**
     * The revision the operator was looking at when they decided.
     *
     * Bounded exactly as the store bounds a revision — a positive integer — and
     * no more narrowly, because a ceiling this side invented would lock the
     * browser out of a revision the store can legitimately reach. It never
     * becomes a path: `approveFeatureBrief` finds the latest revision from the
     * directory itself and compares this against it, so this is a token to be
     * matched, not a file to be opened.
     */
    revision: z.number().int().positive(),
    /**
     * What the brief said on the screen the decision was made from.
     *
     * The revision above cannot answer that on its own: a draft holds one
     * revision number for the whole of its editable life, so a page open while
     * the interview appends one last decision would still be pointing at
     * "revision 1" and would approve words nobody read. Same shape and same
     * job as `config.patch`'s `revision` — a sha256 the server produced,
     * handed straight back — and it is checked inside the store's lock.
     */
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    note: z.string().max(2000).nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('agent.create'),
    name: AgentNameSchema,
    description: z.string().min(1).max(500),
    tools: z.string().max(500).nullable(),
    model: z.string().max(100).nullable(),
    /**
     * The agent's own prompt. Free text, and that is not a violation of the
     * no-prose rule: that rule constrains *server-authored* prose. This is the
     * user's own words travelling into a project file, the same category as
     * `note` and `reason` above.
     */
    body: z.string().max(100000),
  }),
  z.strictObject({
    kind: z.literal('agent.update'),
    name: AgentNameSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().min(1).max(500),
    tools: z.string().max(500).nullable(),
    model: z.string().max(100).nullable(),
    body: z.string().max(100000),
  }),
  z.strictObject({
    kind: z.literal('agent.delete'),
    name: AgentNameSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal('skill.agents'),
    skill: IdSchema,
    /** `AcceptanceView.recordDigest` (`web/read.ts`) — the compare-and-swap token this write checks inside the store's lock. */
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    agents: z.array(AgentNameSchema).max(50),
  }),
])

export type Write = z.infer<typeof WriteSchema>

export type WriteResult = { ok: true } | { ok: false; code: WebCode }

/**
 * Computed here and never sent by the browser.
 *
 * `schemas/plan.ts:29` already says the engine cannot verify who made a
 * decision and that pretending otherwise would be worse. A `by` the page could
 * type would be a forgeable audit record, which is worse still.
 */
function decidedBy(): string {
  let who = 'unknown'
  try {
    who = os.userInfo().username
  } catch {
    // No passwd entry — a container, usually. The prefix is the honest part.
  }
  return `dashboard:${who}`
}

/**
 * Every write kind refused while a run is open — the three agent doors, and
 * `skill.agents` beside them for the identical reason: a run's roster and its
 * pinned skill manifest are both frozen at `runStart`, so any of the four
 * edited mid-run would make what a cycle actually ran and what is recorded
 * two different things.
 */
const GUARDED_WHILE_RUNNING: readonly Write['kind'][] = ['agent.create', 'agent.update', 'agent.delete', 'skill.agents']

/**
 * The plugin's own agent names — a project agent may not shadow one of these.
 *
 * Read fresh from `PLUGIN_AGENTS_DIR` rather than hard-coded: the reserved set
 * is exactly what `readAgentsView` already lists as `plugin`, and duplicating
 * it here as a literal array would be a second place for a new plugin agent
 * to go unreserved.
 */
async function reservedAgentNames(): Promise<string[]> {
  const { agents } = await listAgents(PLUGIN_AGENTS_DIR, 'plugin')
  return agents.map((agent) => agent.name)
}

/**
 * Which tracks name an agent, and in which list.
 *
 * Read from the config rather than remembered: an agent's membership is the
 * track's business, and a cached answer here is one that can be wrong at
 * exactly the moment it matters — when somebody is deleting the agent.
 */
async function agentUsedByTrack(projectDir: string, name: string): Promise<boolean> {
  const config = await loadConfig(projectDir)
  return Object.values(config.tracks).some((track) =>
    [
      ...track.required,
      ...(track.available ?? []),
      ...(track.closing ?? []),
      ...(track.gate?.blocks ?? []),
      track.gate?.proven_by ?? '',
      track.map?.drafted_by ?? '',
    ].includes(name),
  )
}

/**
 * Raised inside a handler and translated to `write.refused.agent.inUse` in the
 * `catch` below — not an `AgentWriteError` kind, because the store has no
 * opinion on tracks at all; that reasoning belongs to this layer, the same way
 * `agentUsedByTrack` above reads the config this layer already reads for
 * `config.patch`.
 */
class AgentInUseError extends Error {}

type Handlers = {
  [K in Write['kind']]: (projectDir: string, write: Extract<Write, { kind: K }>) => Promise<void>
}

const HANDLERS: Handlers = {
  gate: async (projectDir, write) => {
    await gateSet(
      projectDir,
      { plan: write.plan, decision: write.to, by: decidedBy(), note: write.note },
      undefined,
      { expect: write.from },
    )
  },
  'story.status': async (projectDir, write) => {
    // `status` only. The browser has no business rewriting a title, an
    // acceptance list or an evidence pointer — those are the loop's own record
    // of what it did.
    await storyUpdate(projectDir, write.story, { status: write.to }, undefined, { expectStatus: write.from })
  },
  halt: async (projectDir, write) => {
    // Authoritative on state and best-effort on the session: `HALT.md` is
    // written first, and only on success does the queue type `/exit`. If this
    // throws, the pty is untouched and nothing happened.
    await halt(projectDir, write.reason, undefined, { expectRun: write.run })
  },
  'config.patch': async (projectDir, write) => {
    await mutateConfig(projectDir, { revision: write.revision, changes: write.changes })
  },
  'feature.approve': async (projectDir, write) => {
    // `by` is `decidedBy()` here for the same reason the gate's is, and it
    // matters more: a plan is built from an approved brief, so an approver the
    // page could type would be a forgeable authorisation for work nobody
    // agreed to. Approval is also the *only* thing this reaches — the store
    // refuses to touch an approved revision ever again, so there is no edit
    // hiding behind this call.
    await approveFeatureBrief(projectDir, {
      id: write.feature,
      expectRevision: write.revision,
      expectDigest: write.digest,
      by: decidedBy(),
      note: write.note,
    })
  },
  'agent.create': async (projectDir, write) => {
    // `extra` is always empty on a create: there is no existing file for an
    // unknown field to have come from.
    await writeAgent(
      projectDir,
      { name: write.name, description: write.description, tools: write.tools, model: write.model, extra: {}, body: write.body },
      { expectDigest: null, reserved: await reservedAgentNames() },
    )
  },
  'agent.update': async (projectDir, write) => {
    // The browser never sends `extra`: a field it has never heard of is read
    // from the file here and carried forward unchanged. This read is not
    // inside `writeAgent`'s own lock, but that is not a race — `expectDigest`
    // below is a hash of the *whole* file, `extra` included, so if the file
    // moved between this read and the write landing, the digest check inside
    // `writeAgent` refuses the write outright rather than letting a stale
    // `extra` land.
    const existing = await readAgent(projectDir, write.name)
    await writeAgent(
      projectDir,
      {
        name: write.name,
        description: write.description,
        tools: write.tools,
        model: write.model,
        extra: existing?.extra ?? {},
        body: write.body,
      },
      { expectDigest: write.digest, reserved: await reservedAgentNames() },
    )
  },
  'agent.delete': async (projectDir, write) => {
    // The in-use check runs as `deleteAgent`'s `guard`, *inside* its lock and
    // after the digest check, not before this handler calls it. Checking here
    // first would read the config outside the very lock `agent-store.ts`
    // takes to prevent this exact race: a `config.patch` naming this agent
    // into a track between an outside check and the `fs.rm` would leave the
    // config pointing at a file that no longer exists, and nothing — there is
    // no digest over the config — would ever catch that.
    await deleteAgent(projectDir, write.name, write.digest, {
      guard: async () => {
        if (await agentUsedByTrack(projectDir, write.name)) throw new AgentInUseError()
      },
    })
  },
  'skill.agents': async (projectDir, write) => {
    // The one field this door may set. Not the status, the components, the
    // update policy, or the digest of the package it pins — those are
    // `mjloop-cli skills accept|disable`'s decisions, not the dashboard's.
    await setAcceptanceAgents(projectDir, write.skill, write.agents, write.digest)
  },
}

export async function applyWrite(projectDir: string, write: Write): Promise<WriteResult> {
  if (GUARDED_WHILE_RUNNING.includes(write.kind)) {
    // Refused while a run is open, for a reason the config editor does not
    // have: the roster and the skill manifest are both pinned once a run
    // starts, so an agent or a skill's routing edited mid-run makes what ran
    // and what is recorded two different things.
    const state = await stateSummary(projectDir)
    if (state.status === 'running') return { ok: false, code: 'write.refused.running' }
  }
  try {
    await HANDLERS[write.kind](projectDir, write as never)
    return { ok: true }
  } catch (error) {
    if (error instanceof AgentInUseError) {
      return { ok: false, code: 'write.refused.agent.inUse' }
    }
    if (error instanceof AgentWriteError) {
      const code = {
        stale: 'write.stale.agent',
        exists: 'write.invalid.agent',
        // For the browser this is one fact, not three: the screen the click
        // was made from is out of date and nothing was changed. `stale` and
        // `missing` share a code for the same reason `write.stale.feature`
        // folds three store distinctions into one above.
        missing: 'write.stale.agent',
        invalid: 'write.invalid.agent',
        reserved: 'write.refused.agent.shadow',
      } as const satisfies Record<AgentWriteFailure, WebCode>
      return { ok: false, code: code[error.kind] }
    }
    if (error instanceof ConfigMutationError) {
      return {
        ok: false,
        code: error.kind === 'stale' ? 'write.stale.config' : 'write.invalid.config',
      }
    }
    // Caught by name and *ahead* of the generic branch below, the way
    // `ConfigMutationError` is. `StaleFeatureRevisionError` subclasses
    // `StalePreconditionError` without widening `PreconditionSubject` — that
    // type is the key of the `STALE` map, so widening it would oblige this map
    // to grow in the same change — and its inherited `subject` is a placeholder
    // that is never read.
    //
    // `StaleFeatureContentError` and `ApprovedRevisionImmutableError` join it,
    // and the three are not the same refusal to the store: the revision moved,
    // the words of this revision moved, or this exact draft was approved by
    // somebody else first. The store separates them because it has to name the
    // way forward. To a browser they are one fact — the screen the decision was
    // made from is out of date, and nothing was changed — and inventing three
    // codes would put the store's reasoning on a wire that carries no prose.
    if (
      error instanceof StaleFeatureRevisionError ||
      error instanceof StaleFeatureContentError ||
      error instanceof ApprovedRevisionImmutableError
    ) {
      return { ok: false, code: 'write.stale.feature' }
    }
    // Deliberately *not* given a code of their own: an approval refused because
    // the brief has no acceptance criteria, or because a component it names has
    // since left the accepted map, falls to `write.failed` with the diagnosis on
    // the server's terminal. Neither is something the page can fix — one is the
    // interview's work and the other is `mjloop-cli profile accept` — and a code
    // exists to tell the operator which button to press again, not to narrate a
    // refusal that has nothing to do with the button.
    if (error instanceof StalePreconditionError) {
      return { ok: false, code: STALE[error.subject] }
    }
    // The diagnosis goes to the terminal the server was launched from.
    // `error.message` never crosses the wire.
    process.stderr.write(`mjloop web: write failed: ${String(error)}\n`)
    return { ok: false, code: 'write.failed' }
  }
}

const STALE = {
  plan: 'write.stale.plan',
  story: 'write.stale.story',
  run: 'write.stale.run',
  skill: 'write.stale.skill',
} as const satisfies Record<PreconditionSubject, WebCode>
