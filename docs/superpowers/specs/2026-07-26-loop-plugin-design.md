# Loop — Design Document

**Date:** 2026-07-26
**Status:** Approved (design phase)

---

## 1. Purpose

`loop` is a Claude Code CLI plugin, installed once and invoked from any project. It
provides a **cycle engine** driven by a *leader* running in the main session, which
dispatches work to isolated subagents and persists all state under `.loop/` in the
host project via atomic MCP tools.

One engine, four tracks: **plan**, **build**, **fix**, **edit**. The tracks differ only
in their pipeline and stop condition; everything else is shared.

### Non-goals

- Not a CI system. It runs inside a Claude Code session.
- Not a project management tool. `.loop/` is execution state, not a roadmap product.
- Not autonomous by default. Unattended operation is opt-in and bounded.

---

## 2. Architecture

```
Invocation   /loop:plan   /loop:build   /loop:fix   /loop:edit   /loop:run <track>
                                  |
Leadership   skill: loop-leader          (main session — visible, resumable)
                                  |  Agent tool
Execution    19 agents                   (isolated contexts, contract-bound)
                                  |  MCP
State        .loop/                      loop_state_* / loop_memory_*
```

### Why the leader is a skill, not an agent

The leader must live in the session the user watches: its reasoning is the audit
trail, and the `Stop` hook can only re-ignite the main session. Subagents run in
clean contexts so the leader's context does not grow with implementation detail.

### Design principles

1. **State has one owner.** Only the MCP server writes `state.json` / `manifest.json`.
   A `PreToolUse` hook enforces this — it is a rule, not a convention.
2. **Agents are interchangeable.** A single input brief and a single output shape.
   The leader never knows what an agent does internally.
3. **Tracks are data.** Rosters live in `config.yaml`. Adding a track requires no code.
4. **The leader composes the cycle; invariants constrain it.** Each track declares a
   `required` set the leader cannot drop and an `available` set it may draft from, sized
   to the task. The one hard invariant in the whole system: **`verifier` always runs, and
   no success is declared without its evidence.**
5. **Every selection is declared.** Before executing a cycle the leader writes
   `roster.json` naming the agents chosen and the reason each omission was safe. The
   decision is auditable, not hidden.
6. **Every loop is bounded.** Cycle caps, stagnation detection, and halt reports are
   part of the engine, not optional extras.
7. **Nothing is aggregated.** One plan = one directory. One story = one file.

---

## 3. Tracks

Each track declares a **required** set (the leader cannot drop these) and an
**available** set (drafted per task). The diagrams below show the full shape; agents
in brackets are optional and selected by the leader.

### 3.1 Plan — `/loop:plan <idea>`

```
idea
 └─ planner          drafts the core plan
 └─ [plan-critic]    reviews: gaps, contradictions, YAGNI   ──┐ fail → back to planner
 └─ fit-checker      validates fit with the actual project  ──┘ (architecture, patterns, deps)
 └─ GATE: plan approval (human by default) → plans/P00N/PLAN.md
 └─ story-writer     plan → implementation stories with acceptance criteria
 └─ [story-critic]   per story: atomic? verifiable? dependencies correct?
                       └─ fail → story rewritten
 └─ next story … until all stories pass
```

Output: `plans/P00N-<slug>/PLAN.md`, `REVIEW.md`, `manifest.json`, `stories/*.md`.

### 3.2 Build — `/loop:build [P001-S02 | P001 | --next]`

No planning. Consumes a story (or a direct goal) and cycles on it:

```
[scout]                        only when knowledge is missing
 └─ [ui-designer]              when story.ui = true
 └─ builder                    required
 └─ verifier                   required — always, no exception
 └─ [ui-critic]                when story.ui = true
 └─ [critic]
 └─ [security | docs | perf]
 └─ leader judgement
      pass → commit + next story
      fail → findings become next cycle's tasks
```

### 3.3 Fix — `/loop:fix <problem>`

Scientific method. No fix before reproduction is proven.

```
reproducer               required — failing test that proves the problem
                           └─ GATE: no reproduction → halt, do not proceed
 └─ [investigator]        evidence + ranked hypotheses (must not fix)
 └─ [hypothesis-tester]   ×N in parallel — one hypothesis each, verdict with evidence
 └─ fixer                 required — root cause, not the symptom
 └─ verifier              required — failing test passes + no regression
 └─ [critic]              other sites with the same defect?
```

When the cause is already evident from the reproduction, the leader may go straight from
`reproducer` to `fixer`. It may never skip the reproduction gate or `verifier`.

### 3.4 Edit — `/loop:edit <request>`

Deliberately lightweight. One cycle, no critique, no specialists.

```
editor → verifier (lint + affected tests only) → done
```

**Escalation guard:** if `editor` finds the change touches more than 3 files or alters
a public interface, it stops and recommends `/loop:build` rather than proceeding.

---

## 4. Agent Roster (19)

| Agent | Track | Role |
|---|---|---|
| `planner` | plan | Drafts the core plan |
| `plan-critic` | plan | Reviews the plan |
| `fit-checker` | plan | Plan ↔ project compatibility |
| `story-writer` | plan | Plan → stories; sets the `ui` flag |
| `story-critic` | plan | Reviews each story |
| `scout` | build | Read-only exploration; returns a focused map |
| `builder` | build | Writes code and tests; atomic commits |
| `reproducer` | fix | Failing test that proves the defect |
| `investigator` | fix | Evidence + ranked hypotheses |
| `hypothesis-tester` | fix | Tests one hypothesis, returns evidence |
| `fixer` | fix | Root-cause fix |
| `editor` | edit | Fast single-agent edit |
| `verifier` | shared | Judges with evidence; never edits code |
| `critic` | shared | Severity-classified defects |
| `ui-designer` | conditional | Binding UI contract from the design system |
| `ui-critic` | conditional | Conformance to the design system |
| `security` | conditional | Security review |
| `docs` | conditional | Documentation |
| `perf` | conditional | Performance |

`verifier` and `critic` are shared across tracks — no duplication.

Required per track: `plan` → planner, fit-checker, story-writer · `build` → builder,
verifier · `fix` → reproducer, fixer, verifier · `edit` → editor, verifier.
Everything else is drafted by the leader per task (see §7).

### Cycle composition — `roster.json`

Before executing a cycle the leader records its selection, so the decision is
reviewable rather than hidden:

```json
{
  "cycle": 1,
  "selected": ["builder", "verifier", "ui-critic"],
  "skipped": {
    "scout": "story references known files only",
    "critic": "single-file change, no new interface",
    "security": "no auth, network, or input-handling code"
  }
}
```

Written via `loop_roster_set`, which rejects any roster missing a `required` agent.
`/loop:status` displays it, and `critic` in a later cycle may challenge an unsafe
omission — a wrongly skipped agent becomes a finding like any other defect.

### Agent contract

Every agent receives a uniform brief and returns exactly one shape:

```json
{
  "status": "pass | fail | blocked",
  "summary": "one paragraph",
  "evidence": [{ "kind": "command|file|test", "ref": "...", "excerpt": "..." }],
  "findings": [{ "severity": "high|medium|low", "file": "...", "line": 0, "claim": "..." }],
  "files_touched": ["..."],
  "next_hint": "optional"
}
```

Validated against a shared zod schema. Malformed output → one corrective retry, then
counted as a cycle failure (it does not kill the loop).

---

## 5. Skills (5)

| Skill | Contents |
|---|---|
| `loop-leader` | Cycle logic, gates, judgement, limit enforcement |
| `loop-tracks` | Track definitions and pipeline resolution |
| `loop-contract` | Brief format and mandatory output shape |
| `loop-state` | Working with `.loop/` and MCP tools |
| `loop-extend` | Adding an agent, skill, or track |

---

## 6. Project Layout (`.loop/`)

```
.loop/
├── config.yaml
├── state.json                              # MCP-owned
├── design-system.md                        # single source of truth for UI
├── INDEX.md                                # generated from manifests
├── plans/
│   └── P001-user-auth/
│       ├── PLAN.md
│       ├── REVIEW.md
│       ├── manifest.json                   # story order, deps, status
│       └── stories/
│           ├── P001-S01-login-form.md
│           ├── P001-S02-session-token.md
│           └── P001-S03-logout.md
├── runs/
│   └── 2026-07-26-003--P001-S02--build/    # roster.json, brief, per-agent output, verify.log
├── memory/                                 # decisions and extracted lessons
└── agents/  skills/                        # project-local extensions (optional)
```

### Global identifiers

`P001-S02` appears in the filename, the frontmatter, the commit message, the run
directory name, and `state.json`. Any artifact in the repository can be traced back
to its story.

### Story file — self-identifying

```markdown
---
id: P001-S02
plan: P001-user-auth
title: Session token issuance
status: doing            # todo | doing | done | blocked
ui: false
depends_on: [P001-S01]
acceptance:
  - Tokens expire after 24h
  - Refresh rotates the token
evidence: runs/2026-07-26-003--P001-S02--build/verify.log
---
```

Opening the file alone tells you its plan, order, acceptance criteria, and where the
proof of success lives. No second file required.

### `INDEX.md` — generated, never hand-edited

```markdown
| Plan | Title     | Stories | Done | Status      |
|------|-----------|---------|------|-------------|
| P001 | User auth | 3       | 1    | in-progress |
| P002 | Billing   | 5       | 0    | planned     |
```

---

## 7. Configuration

```yaml
version: 1
autonomous: false                # Stop-hook self-restart — opt-in

limits:
  max_parallel_agents: 4
  no_progress_strikes: 2

verify:                          # detected by /loop:init, editable
  test:  "npm test"
  lint:  "npm run lint"
  build: "npm run build"

tracks:                          # required = leader cannot drop; available = drafted per task
  plan:
    required:  [planner, fit-checker, story-writer]
    available: [plan-critic, story-critic]
    max_cycles: 6
  build:
    required:  [builder, verifier]
    available: [scout, critic, ui-designer, ui-critic, security, docs, perf]
    max_cycles: 10
  fix:
    required:  [reproducer, fixer, verifier]
    available: [investigator, hypothesis-tester, critic]
    max_cycles: 8
  edit:
    required:  [editor, verifier]
    available: []
    max_cycles: 1

specialists:                     # auto = leader decides | always = forced | never
  ui: auto                       # auto also honours story.ui
  security: auto
  docs: auto
  perf: auto

gates:
  plan_approval: human           # human | auto
  commit: auto

custom_dirs:
  agents: .loop/agents
  skills: .loop/skills
```

---

## 8. State

```json
{
  "schema": 1,
  "run_id": "2026-07-26-003",
  "track": "build",
  "status": "running",
  "cycle": 2,
  "goal": "...",
  "current": { "plan": "P001", "story": "P001-S02", "stage": "verify" },
  "findings": [],
  "no_progress_count": 0,
  "history": [
    { "cycle": 1, "agents": ["builder", "verifier"], "result": "fail", "ref": "runs/2026-07-26-002--P001-S02--build" }
  ],
  "updated_at": "2026-07-26T10:36:00Z"
}
```

Every write goes through an MCP tool that validates the schema, writes atomically
(`temp → rename`), and keeps a `.bak`. This prevents the most common cause of loop
failure: a model corrupting JSON and losing the run.

`loop_state_get` returns a **compact summary**, not the full file, so the leader's
context does not inflate as cycles accumulate.

---

## 9. MCP Server

**State:** `loop_init` · `loop_state_get` · `loop_run_start` · `loop_cycle_advance` ·
`loop_plan_create` · `loop_story_add` · `loop_story_update` · `loop_task_update` ·
`loop_finding_add` · `loop_gate_set` · `loop_roster_set` · `loop_run_log` ·
`loop_index_render` · `loop_halt`

**Memory:** `loop_memory_record` · `loop_memory_search`
(built over `runs/` and `memory/`; searched at the start of every track — "have we
tried this before?")

---

## 10. Design System Support

`/loop:init` generates `.loop/design-system.md` by extracting from the project itself
(Tailwind config, token files, component library, CSS variables, existing component
patterns). If nothing is found, it asks once and writes the baseline.
`/loop:design-sync` refreshes it as the system evolves.

```markdown
# Design System (extracted 2026-07-26)
## Tokens        colors, spacing scale, radii, shadows, z-layers
## Typography    families, scale, weights
## Components    Button(variants…) · Input · Card · Modal — paths + props
## Patterns      form layout, empty state, loading, error surface
## States        hover / focus-visible / disabled / loading / error
## A11y          contrast floor, focus ring, target size, RTL
## Forbidden     hardcoded hex, arbitrary spacing, one-off duplicate components
```

- **`ui-designer`** runs *before* `builder`: reads the design system and produces a
  binding UI contract for that story — components to reuse, tokens by name, layout and
  responsive behaviour, required states, accessibility conditions. It writes no code.
- **`ui-critic`** runs *after* `verifier`: checks conformance, not aesthetics — no
  hardcoded colors, no arbitrary spacing, no new component duplicating an existing one,
  all states implemented, contrast/focus/RTL correct. Every finding cites a line in the
  design system.

`story.ui` — set by `story-writer` at creation time and editable by hand — is the signal
the leader routes on: when it is true, omitting the UI agents must be justified in
`roster.json`. Setting `specialists.ui: always` forces them regardless.

---

## 11. Hooks (3)

| Hook | Behaviour |
|---|---|
| `SessionStart` | If `.loop/` exists, injects two lines: current plan, story, status. Any session is loop-aware without being asked. |
| `PreToolUse` (Write/Edit) | Rejects manual writes to `state.json` / `manifest.json` and points at the MCP tool. Enforces state ownership. |
| `Stop` | Autonomous guard. Inactive unless `autonomous: true`. Reads state, applies all guards; if legitimate work remains, blocks the stop and injects the next cycle's instruction. |

---

## 12. Guards

An unguarded loop is a token bill and broken code.

| Guard | Mechanism |
|---|---|
| Verifier invariant | No cycle may complete and no success may be declared without `verifier` evidence. `loop_roster_set` rejects a roster missing it |
| Required set | `loop_roster_set` rejects any roster omitting a track's `required` agents, so leader composition cannot erode the track's guarantees |
| Cycle cap | Per-track cap; on reach → `halted` + report |
| Stagnation | Per-cycle fingerprint (failing tests + files touched + findings hash). Repeat fingerprint = strike; 2 strikes → halt |
| Same error | Verification failing with the identical error message twice → halt and request human input |
| Write lock | Lock on `state.json` prevents parallel-agent collisions |
| Reproduction gate | `fix` cannot advance without a failing test proving the problem |
| Edit escalation | `edit` stops if >3 files touched or a public interface changes |
| Autonomy | `Stop` hook requires `autonomous: true` and remains bound by all guards above |

On any halt: `.loop/runs/00N/HALT.md` — what was tried, what failed, the evidence, and
the recommendation.

### Error handling

- **Agent failed or returned an invalid shape** → one corrective retry, then counted as
  a cycle failure.
- **Corrupted state** → restore from `.bak` and notify.
- **Verify commands missing** → the leader never invents commands; it asks once and
  updates `config.yaml`.
- **Session interrupted** → `/loop:resume` reads state and continues from the same stage.

---

## 13. Commands

| Command | Purpose |
|---|---|
| `/loop:init` | Provision `.loop/`, detect verify commands, extract design system, add a section to `CLAUDE.md` |
| `/loop:plan <idea>` | Plan track |
| `/loop:build [id \| --next]` | Build track |
| `/loop:fix <problem>` | Fix track |
| `/loop:edit <request>` | Edit track |
| `/loop:run <track>` | Generic runner — the four above are thin wrappers |
| `/loop:status` | Current plan, story, cycle, latest evidence |
| `/loop:resume` | Continue after an interruption |
| `/loop:stop` | Clean halt with report |
| `/loop:design-sync` | Refresh `.loop/design-system.md` |
| `/loop:add agent\|skill\|track <name>` | Scaffold a new element |

---

## 14. Extensibility

**Tracks are data.** Adding a track is a few lines of YAML:

```yaml
tracks:
  refactor:
    required:  [builder, verifier]
    available: [scout, critic, perf]
    max_cycles: 5
```

**Adding an agent** — `/loop:add agent db-reviewer` generates the agent file with
frontmatter and output contract in place, installs it into `.loop/agents/`
(project-scoped) or the plugin (global), and adds it to a track's `required` or
`available` set. The leader is never modified: it does not know agent names ahead of
time, it reads them from the track and composes the cycle from what it finds.

---

## 15. Repository Layout

```
loop/
├── .claude-plugin/plugin.json
├── commands/            init, plan, build, fix, edit, run, status, resume, stop,
│                        design-sync, add
├── agents/              19 agent definitions
├── skills/              loop-leader, loop-tracks, loop-contract, loop-state, loop-extend
├── hooks/
│   ├── hooks.json
│   └── scripts/         session-start, state-guard, stop-guard
├── mcp/loop-server/     TypeScript MCP server
├── packages/schemas/    shared zod schemas (MCP + hooks)
├── tests/fixtures/      tiny repos for E2E
├── docs/
└── README.md
```

**Language:** all plugin files, prompts, and documentation in English. Conversation
with the user in Arabic.

---

## 16. Technology

TypeScript · Node 20+ · **zod** for schemas · **vitest** for tests.

Schemas are exported as a shared package used by both the MCP server and the hooks
(via a small CLI), so validation exists once and cannot drift between them.

---

## 17. Testing Strategy

- **Unit (MCP):** state transitions, schema rejection, atomic writes, locking,
  `INDEX.md` generation.
- **Unit (guards):** given a state → continue or halt; especially stagnation detection
  and repeated-error detection.
- **Unit (roster):** a roster omitting a `required` agent — above all `verifier` — is
  rejected; `specialists: always` cannot be overridden by the leader.
- **Contract:** malformed / incomplete / over-specified agent output → is it rejected
  and corrected?
- **E2E:** a small fixture repo under `tests/fixtures/`, driven non-interactively
  (`claude -p`) through `/loop:edit` and `/loop:fix`, asserting final state and commits.
  This is the real proof the loop works.

Temp directories over filesystem mocks.

---

## 18. Build Order

1. zod schemas + MCP server — state first; everything rests on it.
2. `/loop:init` + agent contract + `loop-leader` skill.
3. `edit` track (smallest) — first loop that actually turns end to end.
4. `build`, then `fix`, then `plan`.
5. Guards and hooks.
6. Autonomous `Stop` hook — last, after the guards have proven themselves.
