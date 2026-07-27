# Loop — Milestone 4b: The Plan Track — Design

**Status:** approved, ready for planning
**Extends** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §3.1, §4.
**Builds on** `docs/superpowers/specs/2026-07-27-loop-milestone-4a-plans-and-stories-design.md`.

## 1. Purpose

Milestone 4a made a plan a real thing on disk. This milestone produces one from an idea.

`/loop:plan <idea>` drafts a plan, has it criticised, checks it against the project it
will actually be built in, waits for a human to approve it, and then breaks it into
stories with acceptance criteria. Every artefact it produces is written through the tools
4a defined, so this milestone is about judgement rather than about data.

It also completes the fourth track. After it, `/loop:plan` produces stories and
`/loop:build --next` consumes them: the loop closes.

## 2. Scope

**In:**

- The `plan` track and its five agents: `planner`, `plan-critic`, `fit-checker`,
  `story-writer`, `story-critic`.
- `/loop:plan <idea>`.
- The plan approval gate: `loop_gate_set`, and enforcement of `gates.plan_approval`.
- `REVIEW.md` as `plan-critic`'s output.
- Frontmatter repair for `PLAN.md`, because agents now write into that file.

**Out, and why:**

- **`loop_plan_update`.** Considered and dropped. The plan body is prose, and prose does
  not fit through the agent contract's `summary` field — so the agent that authors it
  writes the file, exactly as it would any other source file. A tool whose only job is
  to relay text the leader never saw is machinery for its own sake.
- **Re-planning an approved plan.** Changing a plan after approval invalidates the
  approval, and the right answer is a new plan that supersedes the old one. That needs a
  supersedes relationship the artifact model does not have. Out of scope, and named here
  so the omission is deliberate.

## 3. The plan track

```
planner              required — drafts PLAN.md from the idea
 └─ [plan-critic]    gaps, contradictions, YAGNI → REVIEW.md
                       └─ fail → next cycle returns to planner with the findings
 └─ fit-checker      required — does this plan fit the project that exists?
                       └─ GATE: story-writer cannot run until fit-checker passes
 └─ GATE: plan approval (human by default)
 └─ story-writer     required — plan → stories with acceptance criteria
 └─ [story-critic]   per story: atomic? verifiable? dependencies right?
```

Track definition:

```ts
plan: {
  required: ['planner', 'fit-checker', 'story-writer'],
  available: ['plan-critic', 'story-critic'],
  max_cycles: 6,
  gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
}
```

The multi-cycle machinery is already built: findings carry forward, the stagnation guard
applies, the cycle cap applies. A plan that `plan-critic` keeps rejecting for the same
reasons halts on the same guard that stops a stuck build.

## 4. Two kinds of gate

This milestone puts a second gate on a track, and it is worth being precise about why it
is not the same mechanism as the first.

**The fit-check gate is an evidence gate.** Whether a plan fits the project is a fact
about the world, and `fit-checker` demonstrates it by reading the code and reporting what
it found. That is exactly milestone 3's mechanism, reused with no change:
`gate: { proven_by, blocks }`, enforced in `runLog`, opened by an evidenced pass. Nothing
new is built for it — which is the point, and the proof that the mechanism generalised.

**The approval gate is a decision gate.** Whether a human approves a plan is not a fact
to be demonstrated; it is a decision, and a decision has no evidence beyond having been
made. Milestone 2 rejected `loop_finding_resolve` and milestone 3 rejected
`loop_reproduction_set` on the grounds that a tool taking the leader's word for a fact is
an assertion with no evidence. That objection does not apply here, because there is no
underlying fact being asserted — the record *is* the thing.

So `loop_gate_set` is the right tool where those two would have been wrong, and the
difference is worth stating rather than leaving as an inconsistency for a reviewer to
find.

### What the engine can and cannot enforce

It **can** enforce ordering: `storyAdd` refuses to add a story to a plan whose approval
gate is unset while `gates.plan_approval` is `human`. That is mechanical, at the write
point, exactly like the reproduction gate.

It **cannot** verify that a human made the decision. No engine can: the leader calls the
tool either way, and there is no signal that distinguishes a person's answer from a
model's. Pretending otherwise would be the worst outcome — a gate that looks enforced and
is not.

What it does instead:

- Records `by` and `at` and the decision's `note` — the approver's own words — in the
  plan, so an approval is an auditable artefact rather than a transient event.
- Surfaces the approval state in `/loop:status` and in `INDEX.md`, so an unapproved plan
  with stories is visible after the fact.
- Provides `gates.plan_approval: auto` as an explicit setting. Its existence is what
  makes self-approval under `human` a violation rather than a workaround: a project that
  does not want a human in the loop says so in config, and a leader that approves its own
  plan under `human` is disobeying an instruction it can read.

The leader's instruction is correspondingly blunt: under `human`, ask the user and record
what they said. Never record an approval nobody gave.

### Where the approval lives

In `PLAN.md`'s frontmatter, because it is a fact about that plan rather than about the
track or the run:

```yaml
approval:
  decision: approved        # approved | rejected | changes_requested
  by: mohd
  at: 2026-07-27T11:20:00.000Z
  note: "Ship it, but keep the token TTL configurable."
```

`rejected` and `changes_requested` are recorded too. A rejection is information — it says
the plan was seen and turned down, which is different from never having been reviewed —
and only `approved` opens the gate.

## 5. Agents write prose; the engine owns structure

`story-writer` calls `loop_story_add`: a title, acceptance criteria, and dependencies all
fit through a tool comfortably.

`planner` and `plan-critic` do not have that option. A plan is prose, and prose does not
fit through the agent contract's one-paragraph `summary`. So they write their files
directly — `planner` writes `PLAN.md`'s body, `plan-critic` writes `REVIEW.md` — exactly
as any agent writes any other source file, and report the paths in `files_touched`.

This creates one new risk: an agent writing `PLAN.md` can clobber the frontmatter the
engine depends on.

**Frontmatter repair** answers it. The plan directory is named `P001-user-auth`, so the
id and the slug are durably encoded in the directory name itself. When `readPlan` finds
`PLAN.md`'s frontmatter missing or invalid, it reconstructs `id` and `slug` from the
directory name, recovers `title` and `created_at` from the manifest when one exists,
falls back to the slug for the title when one does not, rewrites the file with the body
intact, and returns the repaired plan.

The alternative — failing loudly — would mean one careless `Write` bricks a plan
directory that still contains every story. Repair is cheap here precisely because the
identifying facts were never stored in only one place.

## 6. The five agents

| Agent | Tools | Role |
|---|---|---|
| `planner` | `Read, Write, Grep, Glob` | Drafts `PLAN.md`: the problem, the approach, what is explicitly out of scope, and the constraints. Writes below the frontmatter and never touches it. On a cycle after the first it works the carried findings — `plan-critic`'s objections are the task list, not background reading. No `Bash`: planning is reading and writing, and a planner that runs things starts building. |
| `plan-critic` | `Read, Grep, Glob` | Reviews the plan for gaps, internal contradictions, and scope that YAGNI would cut. Writes `REVIEW.md` and returns one `findings` entry per objection. Never edits `PLAN.md` — an author who takes their own notes is not a review. |
| `fit-checker` | `Read, Grep, Glob, Bash` | Checks the plan against the project that actually exists: do the patterns it assumes exist, are the dependencies present, does it contradict how the codebase already does this? Opens the track's gate with an evidenced pass. `Bash` to inspect the tree and read dependency manifests, never to change anything. |
| `story-writer` | `Read, Grep, Glob` | Turns an approved plan into stories through `loop_story_add`. Each story is independently shippable, carries acceptance criteria that are checkable rather than aspirational, and declares its dependencies. Sets `ui: true` when the story changes what a user sees. |
| `story-critic` | `Read, Grep, Glob` | Reviews each story: is it atomic, is every acceptance criterion verifiable, are its dependencies right and acyclic? Returns findings; the leader applies them with `loop_story_update`. |

`plan-critic` and `story-critic` are `available`, not `required`. A three-line plan does
not need a critic, and the leader must state in `skipped` why it dropped one — the roster
invariant from milestone 1 has been enforcing that since the beginning.

## 7. The leader

**Ordering.** Create the plan with `loop_plan_create` first, so `planner` has a directory
and frontmatter to write into. Then `planner`, then `plan-critic` if drafted, then
`fit-checker`. `story-writer` cannot be dispatched until `runLog` reports the fit-check
gate open — the engine will refuse its result otherwise.

**Approval.** After `fit-checker` passes, read `gates.plan_approval`. Under `human`, show
the user the plan and ask; record their answer with `loop_gate_set`, including their own
words in `note`. Under `auto`, record the decision itself and say in the report that no
human reviewed it. `changes_requested` sends the next cycle back to `planner` with the
note as a finding.

**Stories.** Dispatch `story-writer` once the gate is open. Then `story-critic` per story
if drafted, and apply what it finds with `loop_story_update`. Render `INDEX.md` at the
end — milestone 4a's review found nothing was calling it, and the plan track is where a
new plan first appears in it.

**Judging.** The plan track has no `verifier`: there is no suite to run against a
document. Its cycle passes when `fit-checker` passes, the approval gate is open, and
every story `story-critic` examined came back clean. That is the one place this track
differs from the others, and the leader is told so explicitly rather than left to infer
that a missing `verifier` means a missing verdict.

## 8. Engine changes

| File | Change |
|---|---|
| `src/schemas/config.ts` | `DEFAULT_TRACKS.plan`, with the fit-check gate |
| `src/schemas/plan.ts` | `ApprovalSchema`; `PlanFrontmatterSchema.approval` nullable with a null default |
| `src/store/plan-store.ts` | Frontmatter repair in `readPlan` |
| `src/ops/plan.ts` | `gateSet`; `storyAdd` refuses an unapproved plan under `gates.plan_approval: human` |
| `src/ops/index-render.ts` | An `Approved` column |
| `src/ops/summary.ts` | Nothing — the approval belongs to a plan, not to a run |
| `src/mcp/server.ts` | `loop_gate_set` |
| `agents/` | Five new agent files |
| `commands/plan.md` | `/loop:plan <idea>` |
| `skills/loop-leader/SKILL.md` | Plan-track ordering, approval, and the verifier-free verdict |

`PlanFrontmatterSchema.approval` takes `.default(null)` for the same load-bearing reason
`last_fingerprint` and `reproduction` did: the schema is strict, and without it every
`PLAN.md` written by milestone 4a would fail validation on read.

## 9. Error handling

- **A story added to an unapproved plan under `human`** — `ApprovalRequiredError`, naming
  the plan and what would open the gate. Nothing is written.
- **`loop_gate_set` on a plan that does not exist** — `PlanNotFoundError`, as elsewhere.
- **An approval recorded twice** — the later one wins and is timestamped. Re-approving
  after `changes_requested` is the normal path, not an anomaly.
- **`PLAN.md` frontmatter clobbered** — repaired from the directory name and the manifest,
  as §5 describes. The repair is reported in the tool result so it is not silent.
- **`story-writer` dispatched before the fit-check gate** — `runLog` refuses the result
  with the milestone 3 gate error. The leader should not have sent it, and the engine
  does not rely on the leader not having.
- **A plan with no stories after `story-writer`** — a legitimate `fail` for the cycle: the
  plan produced nothing to build, which the next cycle must address.

## 10. Testing strategy

**Unit — the approval gate.** `storyAdd` refuses an unapproved plan under `human`;
accepts it under `auto`; accepts it once approved; a `rejected` or `changes_requested`
decision does not open it; the error names the plan.

**Unit — `gateSet`.** Records decision, `by`, `at`, and `note` in the frontmatter;
re-recording overwrites with a new timestamp; an unknown plan throws.

**Unit — frontmatter repair.** A `PLAN.md` with its frontmatter deleted is repaired from
the directory name; with an unparseable block, likewise; the body survives; `title` comes
from the manifest when one exists and from the slug when none does; a valid `PLAN.md` is
returned untouched and not rewritten.

**Unit — the plan track.** `DEFAULT_TRACKS.plan` has the expected required, available,
cap, and gate; `rosterSet` rejects a plan roster missing `story-writer`; the config parses
with three gated and ungated tracks side by side.

**Unit — `INDEX.md`.** The approved column renders for approved, unapproved, and
`changes_requested` plans.

**Integration — an idea to stories.** Create a plan, log `planner`, log `plan-critic`
with findings, advance the cycle, confirm the findings carry forward, log `fit-checker`
with an evidenced pass, confirm the gate opens, confirm `storyAdd` still refuses before
approval, record approval, add two stories, and assert `INDEX.md` shows the plan approved
with two stories.

**Integration — the gate holds both ways.** `story-writer`'s result is refused before
`fit-checker` passes, and `storyAdd` is refused before approval. Neither writes anything.

**E2E.** `/loop:plan` against a fixture with `gates.plan_approval: auto`, opt-in as in
earlier milestones, asserting `PLAN.md`, `REVIEW.md`, at least one story, and an
`INDEX.md` row exist afterwards. The `human` path cannot be exercised non-interactively,
which is exactly what makes it a gate.

## 11. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| The fit-check gate | Milestone 3's track gate, unchanged | A bespoke check — the mechanism generalising is the evidence it was designed right |
| The approval gate | `loop_gate_set`, recorded on the plan | A track gate — no agent proves a human's decision; and refusing any tool on the milestone-2 grounds, which do not apply because a decision has no underlying fact to demonstrate |
| Enforcement | Ordering only, at `storyAdd`, plus an audit record | Claiming to verify a human is present — no engine can, and a gate that looks enforced and is not is worse than none |
| Plan prose | The authoring agent writes the file | A relay tool for text the leader never saw |
| Clobbered frontmatter | Repaired from the directory name and manifest | Failing loudly — one careless `Write` would brick a directory full of intact stories |
| Re-planning after approval | Out of scope, named as such | Silently allowing it, which would leave an approval attached to a plan nobody approved |

## 12. What this unlocks

All four tracks ship. `/loop:plan` produces stories and `/loop:build --next` consumes
them, so the loop closes end to end for the first time. What remains is guards, the
autonomous `Stop` hook, the UI and specialist agents, and memory — each an addition to a
machine that already turns.
