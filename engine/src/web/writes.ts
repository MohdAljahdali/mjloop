import os from 'node:os'
import * as z from 'zod'
import { ApprovalDecisionSchema, PlanIdSchema, StoryIdSchema, StoryStatusSchema } from '../schemas/plan.js'
import { gateSet } from '../ops/plan.js'
import { storyUpdate } from '../ops/plan.js'
import { halt } from '../ops/run.js'
import { StalePreconditionError } from '../store/precondition.js'
import type { WebCode } from './codes.js'

/**
 * The only three engine writes the browser can reach, and the only door they
 * come through.
 *
 * Everything else on the page either reads, or composes a loop command and
 * enqueues it — there is one execution model and not a second, weaker one
 * beside it. These three cannot be expressed as a command, and each is
 * something a person is stuck on today:
 *
 *  - **Plan approval.** `gates.plan_approval` defaults to `human` and the build
 *    is refused until somebody decides. Spawning a whole `claude` session to
 *    flip one frontmatter field is absurd.
 *  - **Requeue a story.** A run cancelled mid-story leaves it `doing`, which
 *    makes it invisible to `--next` forever. The documented repair is a text
 *    editor.
 *  - **Halt a run.** Stop kills the pty and leaves `state.json` saying
 *    `running` with no `HALT.md`. That is not a halt.
 *
 * `runStart`, `rosterSet`, `runLog` and `cycleAdvance` are forbidden from the
 * browser **permanently**. `runLog` opens a gated track's gate from the
 * payload's evidence array alone, so a browser that could call it could let a
 * click "prove" a reproduction nobody ran. `runStart` wipes findings, history,
 * guard counters and the reproduction. `cycleAdvance` is the only writer of
 * terminal status. Those four are how the loop *reports what it did*; a browser
 * that can write them can claim work nobody performed.
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
 *     exactly the three ops; `server.ts` may import none.
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
}

export async function applyWrite(projectDir: string, write: Write): Promise<WriteResult> {
  try {
    await HANDLERS[write.kind](projectDir, write as never)
    return { ok: true }
  } catch (error) {
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
} as const satisfies Record<string, WebCode>
