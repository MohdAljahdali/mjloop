# Loop — Milestone 6: UI and Specialists — Design

**Status:** approved, ready for planning
**Extends** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §4, §7, §10.

## 1. Purpose

Every track ships and every guard holds. What the loop still lacks is depth: a cycle can
prove the tests pass, but nothing in it asks whether the change is secure, documented,
fast, or consistent with how the product already looks.

This milestone adds the five conditional agents the base spec's roster lists and never
built — `ui-designer`, `ui-critic`, `security`, `docs`, `perf` — and the design system
they read from.

It also closes a promise the config has been making since milestone 1. `specialists`
accepts three modes, and only two of them do anything.

## 2. Scope

**In:**

- `.loop/design-system.md`, extracted from the project rather than invented.
- `/loop:design-sync` to produce and refresh it.
- Five agents: `ui-designer`, `ui-critic`, `security`, `docs`, `perf`.
- `specialists: never` enforced, closing the gap below.
- `stateSummary` reporting whether a design system exists.

**Out, and why:**

- **A design-system schema.** It is a document a person reads and corrects, not a
  structure the engine parses. Giving it a schema would mean the engine understanding
  design tokens, which buys nothing: no code branches on its contents.
- **Auto-detecting a UI project.** `/loop:init` will not guess whether a repository has a
  UI. `/loop:design-sync` is explicit, and a project without a UI simply never runs it.

## 3. A promise the config was not keeping

`SpecialistModeSchema` is `'auto' | 'always' | 'never'`, and `rosterSet` enforces exactly
one of them:

- `always` — `forcedSpecialists()` collects them and a roster omitting one is rejected.
- `auto` — the leader decides, which needs no enforcement.
- `never` — **nothing anywhere reads it.** A project that sets `security: never` gets a
  security agent whenever the leader feels like drafting one.

Milestone 6 closes it in `rosterSet`, beside the rule it mirrors: a roster *selecting* an
agent configured `never` is rejected, exactly as a roster *omitting* one configured
`always` is. Two symmetrical rules, one enforcement point, and the config finally means
what it says.

This is not new machinery. It is a one-sided invariant made whole, found by reading the
config schema rather than by a run failing — which is worth recording, because the review
lenses that have caught most defects in this project look for exactly this shape.

### Specialist keys are agent names

The base spec's §7 example groups the UI pair under a single `ui:` key. This design uses
agent names as keys instead — `ui-designer`, `ui-critic`, `security`, `docs`, `perf` —
and the reason is the project's central constraint rather than convenience.

A group key would require the engine to know that `ui` means `ui-designer` and
`ui-critic`. The engine does not know agent names; that is what makes a track data and
lets a new agent ship without touching code. A grouping would put two agent names into
`forcedSpecialists`, and the next agent added to the group would need an engine change.

The cost is that forcing the UI pair means two config lines rather than one. That is the
right trade.

## 4. The design system

### What it is

`.loop/design-system.md` is the single source of truth for how the product looks, so that
`ui-designer` produces a contract consistent with what exists and `ui-critic` has
something concrete to judge against. Without it, "does this match our design?" has no
answer and the pair is theatre.

It is **extracted, not invented**. A design system a model wrote from imagination would
be confidently wrong about the project it claims to describe, and every UI story built
against it would drift further from the real one.

### Shape

Frontmatter the engine reads, prose a person reads:

```markdown
---
extracted_at: 2026-07-27T14:00:00.000Z
sources:
  - src/styles/tokens.css
  - tailwind.config.ts
  - src/components/Button.tsx
---

# Design System

## Tokens
Colours, spacing scale, radii, shadows, z-layers — with the file each came from.

## Typography
Families, scale, weights.

## Components
Button(variants…) · Input · Card · Modal — paths and props.

## Patterns
Form layout, empty state, loading, error surface.

## States
hover / focus-visible / disabled / loading / error.

## A11y
Contrast floor, focus ring, target size, RTL.

## Forbidden
Hardcoded hex, arbitrary spacing, one-off duplicate components.
```

`sources` is the honest part: it names the files the extraction actually read, so a reader
can check the claim and a later sync can tell what changed. A section with nothing behind
it says so — "no shared spacing scale found" is more useful than an invented one.

### Who writes it and when

`/loop:design-sync` dispatches `ui-designer` with an extraction brief. It writes the file
directly, as `planner` writes `PLAN.md`: the content is prose and prose does not fit
through the agent contract's `summary`.

`/loop:init` does **not** create it. Milestone 1 deferred it for a reason that still
holds: an empty stub is a placeholder shipped in the product, and a project without a UI
should not carry one. The file appears when someone asks for it.

### When it is missing

`ui-designer` dispatched into a cycle with no design system returns `blocked`, saying so
and naming `/loop:design-sync`. No engine gate is added: the agent contract already has a
verdict that means "I need something that does not exist", and using it costs nothing.

`stateSummary` gains `design_system: boolean` so `/loop:status` and the leader can see the
answer without a filesystem probe of their own.

## 5. The five agents

| Agent | Tools | Role |
|---|---|---|
| `ui-designer` | `Read, Write, Grep, Glob` | Two jobs, clearly separated in its prompt. In a cycle: turn a UI story into a **binding contract** — which components, which tokens, which states, drawn from the design system and never invented. On `/loop:design-sync`: extract the design system from the code and write it. Returns `blocked` in a cycle when no design system exists. |
| `ui-critic` | `Read, Grep, Glob` | Judges the built UI against the design system: hardcoded values where a token exists, a one-off component duplicating a shared one, a missing focus or error state, a contrast or target-size floor breached. Never edits. Every finding cites the design-system rule it breaks. |
| `security` | `Read, Grep, Glob, Bash` | Reviews the cycle's change for injection, authentication and authorisation gaps, secret handling, and unsafe deserialisation. Reads and searches; never edits, and never runs anything that reaches the network. |
| `docs` | `Read, Write, Grep, Glob` | Updates the documentation the change makes stale — the README, the API reference, the comment that now lies. Writes docs and nothing else: a `docs` agent that edits implementation code has stopped being a docs agent. |
| `perf` | `Read, Grep, Glob, Bash` | Looks for the performance defects review catches cheaply: work in a loop that belongs outside it, an N+1, an unbounded cache, a synchronous call on a hot path. Measures where it can and says so where it cannot — a performance claim without a number is a hypothesis. |

All five carry the output contract inline, as established in milestone 1.

### How they reach a cycle

They are added to `build`'s `available` set, which is data:

```ts
build: {
  required: ['builder', 'verifier'],
  available: ['scout', 'critic', 'ui-designer', 'ui-critic', 'security', 'docs', 'perf'],
  max_cycles: 5,
}
```

`security` also joins `fix`'s available set: a defect being fixed is a reasonable moment
to ask whether the same class of defect is a vulnerability.

Every one of them is optional, so the roster invariant already covers them: the leader
must name a reason in `skipped` for each one it drafts past. That rule has been enforced
since milestone 1 and needs no extension — seven optional agents simply means seven
reasons, which is the point.

## 6. The leader

**Drafting the UI pair.** A story with `ui: true` draws `ui-designer` and `ui-critic` into
the cycle unless `specialists` says otherwise. That is the base spec's "auto also honours
`story.ui`", and it is leader judgement reading a story field — no engine change.

`ui-designer` runs before `builder`, because a contract written after the code is a
description, not a contract. `ui-critic` runs after `verifier`, because there is nothing
to judge until the change exists and passes.

**Drafting the rest.** `security` when the change touches authentication, input handling,
network, or secrets. `docs` when it changes something a reader was told. `perf` when it
touches a hot path or a data-access pattern. Each omission is a line in `skipped`, and
`critic` may challenge one — that has been true since milestone 2.

**Judging.** Nothing changes: `verifier` still owns the verdict, and a specialist's
findings are findings like any other, folded forward into the next cycle. A `high` from
`security` blocks a pass exactly as a `high` from anyone does.

## 7. Engine changes

| File | Change |
|---|---|
| `src/schemas/config.ts` | The five agents into `build.available`, `security` into `fix.available` |
| `src/ops/roster.ts` | Reject a roster selecting an agent configured `never` |
| `src/ops/summary.ts` | `design_system: boolean` |
| `agents/` | Five new agent files |
| `commands/design-sync.md` | `/loop:design-sync` |
| `skills/loop-leader/SKILL.md` | Drafting rules, and the UI ordering |
| `skills/loop-state/SKILL.md` | `design-system.md` in the layout |

The engine gains no knowledge of what a design system contains, what a token is, or what
any of the five agents do. It learns exactly one new rule — `never` — and that rule names
no agent.

## 8. Error handling

- **A roster selecting a `never` specialist** — rejected by `rosterSet` with the other
  violations, in the same aggregated message. Nothing is written.
- **An agent configured both `never` and listed in a track's `required`** — a config
  contradiction. `never` wins and `rosterSet` rejects every possible roster, so the
  contradiction is caught by a `TrackSchema`-level refinement at config-parse time
  instead, naming both places.
- **`ui-designer` in a cycle with no design system** — `blocked`, naming
  `/loop:design-sync`. The leader reports it and does not fabricate a contract.
- **`/loop:design-sync` on a project with no UI** — the agent returns `blocked` saying it
  found nothing to extract. Writing an empty design system would be worse than none.
- **A stale design system** — not detected, and deliberately so. Staleness is a judgement
  about whether the code moved, and `extracted_at` plus `sources` give a reader what they
  need to make it. A heuristic that guessed would be wrong in both directions.

## 9. Testing strategy

**Unit — `never` enforcement.** A roster selecting a `never` specialist is rejected; the
message names the agent and the setting; a roster omitting it is accepted; `auto` and
unset specialists are unaffected; the violation aggregates with others rather than
short-circuiting.

**Unit — the config contradiction.** A track whose `required` names an agent configured
`never` fails to parse, and the error names both the track and the specialist setting.

**Unit — track composition.** `build.available` contains all seven optional agents;
`fix.available` contains `security`; `edit.available` stays empty; every specialist named
in `DEFAULT_TRACKS` has an agent file, checked by reading the `agents/` directory.

**Unit — `design_system`.** `stateSummary` reports false with no file, true with one, and
false rather than throwing when `.loop` exists but is unreadable.

**Integration — a UI cycle.** A story with `ui: true`, a roster drafting the UI pair, a
`ui-critic` finding folded forward, and a second cycle that clears it. Asserts the roster
records why the other specialists were skipped.

**Integration — `never` holds.** A project configuring `security: never` cannot run a
cycle with `security` in the roster, and the run is otherwise unaffected.

**E2E.** `/loop:design-sync` against a fixture with a small UI, opt-in as before,
asserting `.loop/design-system.md` exists afterwards and names at least one real source
file from the fixture. The fixture needs a component and a token file to extract from,
which this milestone adds.

## 10. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Specialist keys | Agent names | The base spec's `ui:` grouping, which would put agent names inside the engine |
| The design system | Extracted from the code, by an agent | Generated from a template, which would confidently describe a project that does not exist |
| Who extracts it | `ui-designer`, with two clearly separated jobs | A sixth agent whose only job runs once |
| When it is created | On `/loop:design-sync`, never at init | A stub at init — milestone 1 refused that, and the reason has not changed |
| A missing design system | `ui-designer` returns `blocked` | A fourth engine gate — the contract already has a verdict for "I need something that does not exist" |
| Staleness | Reported honestly via `extracted_at` and `sources`, never guessed | A heuristic, which would be wrong in both directions |
| `never` | Enforced in `rosterSet`, mirroring `always` | Leaving it as documentation, which is what it has been since milestone 1 |

## 11. What this unlocks

Only milestone 7 remains: memory, `/loop:add`, and the extension skills. After it, every
element the base spec describes has shipped.
