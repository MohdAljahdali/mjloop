# Loop — Milestone 4a: Plans and Stories as Data — Design

> **Renamed after this document was written.** The plugin ships as `mjloop`: the `loop_*` MCP tools named here are `mjloop_*`, commands are `/mjloop:*`, skills are `mjloop-*`, and plans, stories, and the rest of project state live under `.mjloop/`. `loop` collided with a command Claude Code already provides. This document predates the rename and uses the old identifiers throughout; the code is authoritative.

**Status:** approved, ready for planning
**Extends** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §6, §9.

## 1. Why this is its own milestone

The roadmap's "milestone 4 — plan track" is two systems wearing one name.

One is the **artifact model**: where a plan lives on disk, what a story is, how status
and dependencies are tracked, how `INDEX.md` is produced, and how the build track
consumes a story instead of a sentence. The other is the **plan track**: five agents
that turn an idea into that artifact model, plus a human approval gate.

They separate cleanly. The artifact model ships working software on its own — write a
plan directory by hand and `/loop:build P001-S02` runs against it, with status tracked
and `INDEX.md` generated. The plan track then automates producing what you would
otherwise write by hand, and every one of its agents writes through the tools this
milestone defines.

This milestone is the first. The plan track follows as 4b.

## 2. Scope

**In:**

- The plan directory: `plans/P00N-<slug>/` with `PLAN.md`, `manifest.json`, `stories/`.
- The story file format and its schema.
- Five MCP tools: `loop_plan_create`, `loop_story_add`, `loop_story_update`,
  `loop_story_get`, `loop_index_render`.
- `manifest.json` as a derived index, rebuildable from the story files.
- `INDEX.md` generation.
- `/loop:build P001-S02` and `/loop:build --next`: the build track consuming a story,
  and writing its evidence path back on success.

**Out, and why:**

- **The plan track and its five agents.** Milestone 4b. Nothing here needs them: a
  story is a file, and this milestone is about what that file means.
- **`loop_gate_set` and `gates.plan_approval`.** The gate approves a plan that the plan
  track produces. With no generation flow to gate, the tool would have no caller and no
  test that means anything.
- **`REVIEW.md`.** It is `plan-critic`'s output. It arrives with the agent that writes it.
- **`loop_task_update`.** The roadmap lists it, but "tasks" appear nowhere in the design
  — stories carry acceptance criteria, not tasks. It is replaced by `loop_story_get`,
  which the design does need and never listed: the build track cannot consume `P001-S02`
  or `--next` without a way to read a story.

## 3. One fact, one owner

The base spec describes `manifest.json` as holding "story order, deps, status" (§6) and
the story file's frontmatter as holding `status`, `depends_on`, and the rest (§6). That
puts the same fact in two places, which is the drift class this project has spent two
milestones eliminating.

**The story file is the sole source of truth for its own story. `manifest.json` is an
index derived from the story files.** The relationship is the one `INDEX.md` already has
to the manifests, one level down:

```
story files  ──derive──▶  manifest.json  ──derive──▶  INDEX.md
(authored)                 (generated)                (generated)
```

Consequences that make this worth it:

- No synchronisation step exists, so no synchronisation bug exists.
- A lost or corrupt manifest is rebuilt by rereading the story directory. It is a cache,
  and losing a cache is not losing data.
- `manifest.json` is already in `PROTECTED_BASENAMES`, so the `PreToolUse` hook has been
  denying hand-edits to it since milestone 1. That protection now matches its meaning:
  editing a derived file is always a mistake.
- Story order comes from the story ids, and dependencies from each file's `depends_on`.
  Neither needs a second home.

Story files are markdown with frontmatter, and agents write them through
`loop_story_add` and `loop_story_update` rather than with `Write`. That is not enforced
by a hook — a story is prose and prose is editable — but every tool that touches one
regenerates the manifest, so the derived state cannot fall behind through the supported
path.

## 4. The artifacts

### Plan directory

```
plans/P001-user-auth/
├── PLAN.md              the plan itself, human-readable, authored
├── manifest.json        derived index — never hand-edited
└── stories/
    ├── P001-S01-login-form.md
    ├── P001-S02-session-token.md
    └── P001-S03-logout.md
```

`P001` is the plan id; `user-auth` is a slug. Both appear in the directory name so the
directory is identifiable without opening anything.

### `PLAN.md`

Frontmatter plus prose. The engine reads only the frontmatter:

```markdown
---
id: P001
slug: user-auth
title: User authentication
created_at: 2026-07-27T09:00:00.000Z
---

Prose: the problem, the approach, the constraints. The engine does not parse this.
```

### Story file

```markdown
---
id: P001-S02
plan: P001
title: Session token issuance
status: todo
ui: false
depends_on: [P001-S01]
acceptance:
  - Tokens expire after 24h
  - Refresh rotates the token
evidence: null
---

Prose: any context the story needs beyond its acceptance criteria.
```

`status` is `todo | doing | done | blocked`. `evidence` is null until a build run passes,
then it holds the run directory path — so a done story carries the proof of its own
completion, and `/loop:status` can point at it.

Opening the file alone tells you its plan, its order, its acceptance criteria, what it
waits on, and where the proof lives. That is the property the base spec asked for, and
making the file authoritative is what actually delivers it.

### `manifest.json`

```json
{
  "schema": 1,
  "plan": "P001",
  "slug": "user-auth",
  "title": "User authentication",
  "generated_at": "2026-07-27T09:14:00.000Z",
  "stories": [
    { "id": "P001-S01", "title": "Login form", "status": "done", "ui": true, "depends_on": [], "file": "stories/P001-S01-login-form.md" },
    { "id": "P001-S02", "title": "Session token issuance", "status": "todo", "ui": false, "depends_on": ["P001-S01"], "file": "stories/P001-S02-session-token.md" }
  ]
}
```

Sorted by story id, which is the order. Regenerated whole on every write — a partial
update of a derived file is a bug waiting to happen.

### `INDEX.md`

Generated across all manifests, at `.loop/INDEX.md`:

```markdown
<!-- generated by loop_index_render — do not edit -->

| Plan | Title                 | Stories | Done | Status      |
|------|-----------------------|---------|------|-------------|
| P001 | User authentication   | 3       | 1    | in-progress |
| P002 | Billing               | 5       | 0    | planned     |
```

A plan's status is derived, not stored: `planned` when no story has started, `done` when
every story is done, `blocked` when no story can proceed and at least one is blocked,
`in-progress` otherwise.

## 5. The five tools

| Tool | Does |
|---|---|
| `loop_plan_create` | Allocates the next plan id, creates the directory, writes `PLAN.md`, generates an empty manifest. Returns the id and paths. |
| `loop_story_add` | Allocates the next story id within a plan, writes the story file, regenerates the manifest. |
| `loop_story_update` | Changes a story's `status`, `evidence`, `acceptance`, `ui`, or `depends_on` in its file, then regenerates the manifest. |
| `loop_story_get` | Reads one story by id, or resolves `--next`: the lowest-id story whose status is `todo` and whose every dependency is `done`. Returns the story and, for `--next`, why it was chosen. |
| `loop_index_render` | Regenerates `.loop/INDEX.md` from every manifest. |

`loop_story_get` with `--next` returning nothing is a normal answer, not an error: it
means every story is done, or every remaining one is blocked on something. It says which.

### Id allocation

Plan ids are `P` plus three digits, allocated by scanning `plans/` for the highest
existing id — the same approach `nextRunId` already uses for run ids, including its
lesson: the allocation happens inside the write so two concurrent creates cannot collide.

Story ids are `<plan>-S` plus two digits, allocated by scanning the plan's `stories/`
directory the same way.

Both are validated by the existing `IdSchema` (`/^[A-Za-z0-9_-]+$/`), which milestone 2
added after a review found a story id could steer a run directory outside `.loop/runs`.
Slugs are validated the same way — they reach the filesystem too.

## 6. The build track consuming a story

`runStart` already accepts `plan` and `story` and already names the run directory
`<run_id>--<story>--<track>`. Three things are missing:

**Validation.** A run started against a story id that does not exist should fail at
`runStart`, not silently produce a run directory named after nothing.

**The brief.** The leader loads the story with `loop_story_get` and briefs agents with
its acceptance criteria. A build cycle against a story is judged against those criteria,
not against a sentence someone typed.

**Writing evidence back.** When a build run on a story reaches `done`, the leader calls
`loop_story_update` with `status: "done"` and `evidence` set to the run directory. The
story then carries the path to its own proof, and the manifest and `INDEX.md` follow.

`/loop:build` therefore takes three forms:

- `/loop:build <goal>` — a direct goal, exactly as it works today. Unchanged.
- `/loop:build P001-S02` — that story.
- `/loop:build --next` — the next story the dependency graph allows.

The engine distinguishes them by shape: an argument matching `/^P\d{3}-S\d{2}$/` is a
story id, `--next` is the selector, anything else is a goal. That rule lives in the
command's prompt, not in the engine — the engine's `runStart` takes an explicit `story`
parameter and does not parse user text.

## 7. Error handling

- **A story id that does not exist** — `StoryNotFoundError` from `loop_story_get` and
  from `runStart`, naming the plan directory it looked in.
- **A dependency on a story that does not exist** — rejected by `loop_story_add` and
  `loop_story_update`. A graph with a dangling edge would make `--next` unanswerable.
- **A dependency cycle** — rejected at the same point, naming the cycle. `--next` would
  otherwise return nothing forever with no explanation.
- **A corrupt or missing manifest** — regenerated from the story files on the next tool
  call. It is derived; it does not need recovery machinery.
- **A story file that fails its schema** — surfaced with the file path and
  `z.prettifyError`. The other stories in the plan still parse, and the manifest records
  what it could read rather than failing whole.
- **Two plans with the same slug** — allowed. The id disambiguates, and forbidding it
  would mean scanning every plan on every create for no real benefit.

## 8. Testing strategy

**Unit — schemas.** Story frontmatter round-trips through parse and serialise unchanged;
an unknown frontmatter key is rejected; `status` outside the four values is rejected;
`evidence` is nullable; `depends_on` defaults to empty.

**Unit — id allocation.** The first plan is `P001`; the next is `P002`; a gap does not
renumber; concurrent creates do not collide; the same for story ids within a plan.

**Unit — the manifest is derived.** Adding a story regenerates it; updating a story's
status regenerates it; deleting the manifest and calling any tool rebuilds it exactly;
a hand-corrupted manifest is overwritten rather than merged.

**Unit — `--next`.** Picks the lowest-id `todo` story with all dependencies `done`;
skips one whose dependency is not done; returns nothing when all are done; returns
nothing with a reason when the remainder is blocked; ignores `doing` and `blocked`.

**Unit — dependency validation.** A dangling dependency is rejected; a two-story cycle is
rejected; a three-story cycle is rejected; a diamond is accepted.

**Unit — `INDEX.md`.** Renders one row per plan with correct counts; derives each of the
four plan statuses; is byte-identical when regenerated from unchanged input.

**Integration — a story-driven build.** Create a plan, add three stories with
dependencies, resolve `--next`, run a build against it, mark it done with evidence, and
assert the manifest, `INDEX.md`, and the story file all agree — and that `--next` now
returns the second story.

**E2E.** `/loop:build --next` against a fixture with a hand-written plan, opt-in as in
earlier milestones, asserting the story ends `done` with an evidence path that exists.

## 9. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Milestone shape | Split: artifact model now, plan track next | One milestone — two subsystems, and the second is far easier to design once the first has run |
| Source of truth | The story file; the manifest is derived | Manifest authoritative with the file as a projection, or both authoritative — the same fact in two places is the drift class this project keeps removing |
| Manifest updates | Regenerated whole on every write | Patched in place — a partial update of a derived file is a bug waiting to happen |
| The sixth tool | `loop_story_get` | `loop_task_update` — "tasks" appear nowhere in the design, while reading a story is something the build track cannot work without |
| Argument parsing | In the command prompt | In `runStart` — the engine takes an explicit story parameter and does not parse user text |
| Duplicate slugs | Allowed; the id disambiguates | Rejected — a scan of every plan on every create, to prevent nothing harmful |

## 10. What this unlocks

Milestone 4b adds the five plan-track agents, `/loop:plan`, and the approval gate. Every
one of them writes through the tools defined here, so that milestone is about judgement
and prompts rather than about data. After it, all four tracks are shipped and the
remaining milestones are guards, specialists, and extension.
