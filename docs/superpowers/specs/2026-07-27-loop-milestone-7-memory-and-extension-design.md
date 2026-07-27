# Loop — Milestone 7: Memory and Extension — Design

**Status:** approved, ready for planning
**Extends** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §6, §13, §14.

## 1. Purpose

The loop turns, and every guard holds. What it does not do is remember.

Each run starts from nothing. A decision made in one run — why this pattern, why not that
dependency — is gone by the next. A lesson from a halt is written into `HALT.md` and read
once. The project's `.loop/memory/` directory has existed since milestone 1 and has never
held a file.

This milestone gives the loop a memory it can consult, and gives the user a way to extend
it: `/loop:add` scaffolds a new agent, skill, or track, and two skills explain the system
well enough that extending it does not require reading the engine.

It is the last milestone. After it every element the base spec describes has shipped.

## 2. Scope

**In:**

- Memory entries in `.loop/memory/`, with `loop_memory_add`, `loop_memory_search`, and
  `loop_memory_get`.
- `/loop:add agent|skill|track <name>`.
- `stateSummary.config_error`, so a broken config stops being silent.
- The `loop-tracks` and `loop-extend` skills, deferred since milestone 1.
- Removing `custom_dirs`, which cannot work — see §3.

**Out, and why:**

- **Automatic memory injection.** Nothing puts memory into a session or a brief without
  being asked. A memory that grows unboundedly and is prepended to every cycle is a
  context tax that rises forever and degrades the loop it was meant to improve.
- **Semantic search.** Keyword ranking over a few dozen markdown files is enough and has
  no dependency, no index to rebuild, and no embedding to go stale. If a project ever
  accumulates thousands of memories, that is the moment to reconsider — and it will be
  obvious.
- **Memory pruning or expiry.** A memory that is wrong should be deleted by a person who
  knows it is wrong. A heuristic that expires memories by age would delete the durable
  ones first, since those are the oldest.

## 3. `custom_dirs` cannot work, so it goes

The base spec §7 defines:

```yaml
custom_dirs:
  agents: .loop/agents
  skills: .loop/skills
```

The intent was project-scoped extensions. Checked against the official documentation, the
mechanism does not exist:

- Claude Code loads project subagents from **`.claude/agents/`** and project skills from
  **`.claude/skills/<name>/SKILL.md`**.
- There is **no setting** — in `settings.json`, in a plugin manifest, or anywhere else —
  that redirects that discovery to another directory. `permissions.additionalDirectories`
  grants file access and loads nothing.

So an agent written to `.loop/agents/` is a file that is never read. `custom_dirs` is a
configuration knob whose every non-default value, and whose default, produce a feature
that appears to work and does nothing.

It is removed rather than corrected. Correcting the defaults to `.claude/agents` would
leave a knob that silently breaks the moment anyone turns it, and a knob nobody may turn
is not configuration.

**Migration.** `.loop/config.yaml` files written by milestones 1 through 6 all contain
`custom_dirs`, and `ConfigSchema` is strict, so removing the field would make every
existing project fail to load. `loadConfig` therefore strips known-legacy keys before
parsing — one preprocessing step, named and commented, so an old project keeps working
and its next write drops the field.

The M4a review flagged `custom_dirs` as unused and rejected it as a defect, on the grounds
that it was a forward declaration for this milestone. That was the right call on the
evidence then. The evidence now is that the thing it declared cannot be built.

## 4. Memory

### An entry

`.loop/memory/<id>-<slug>.md`, where the id is `M` plus three digits — the same shape as
plan ids, allocated the same way, under the same lock:

```markdown
---
id: M001
kind: decision
title: Session tokens rather than server sessions
at: 2026-07-27T15:00:00.000Z
tags: [auth, architecture]
run: 2026-07-27-003
---

We chose stateless tokens because the deployment target has no shared session store, and
adding one would have meant a new dependency for a single feature. Revisit if we ever run
more than one region.
```

`kind` is `decision`, `lesson`, or `pattern`:

- **decision** — a choice made and the reasoning behind it. The thing a reader six months
  later needs and cannot reconstruct from the diff.
- **lesson** — something the loop learned the hard way, usually from a halt. "The fix
  track cannot reproduce timing bugs in this suite without `--runInBand`."
- **pattern** — how this project does a recurring thing, so the next cycle does it the
  same way.

`run` links the entry to the run that produced it, or is null when a person wrote it
directly.

The file is authored markdown, like `PLAN.md`: the frontmatter is structure the engine
reads, the body is prose a person reads and may correct.

### The three tools

| Tool | Does |
|---|---|
| `loop_memory_add` | Allocates the next id, writes the entry. Returns the id and path. |
| `loop_memory_search` | Ranks entries against a query and returns the best few with excerpts — never the whole corpus. |
| `loop_memory_get` | Reads one entry in full, by id. |

**Search is keyword ranking, not semantics.** A query is split into terms; an entry scores
by term hits weighted by where they land — title and tags above body — and ties break by
recency. It returns at most `limit` entries, default 5, each with the title, kind, tags,
and the two lines around the best hit.

That cap is the design's most important line. Memory is only useful if consulting it costs
less than not having it, and a tool that can return an unbounded corpus into a leader's
context is a slow way to make every later cycle worse.

### Who writes and who reads

The **leader** writes at the end of a run: a decision it made that the diff will not
explain, or a lesson from a halt. One entry, not a diary — a memory per cycle would bury
the entries that matter.

The **leader** reads when composing a cycle, by searching the goal's terms. A hit changes
how it briefs the agents; no hit costs one tool call.

Nothing reads memory automatically. The `SessionStart` hook stays as it is: one line of
state, not a digest of everything the project has ever learned.

## 5. `/loop:add`

Three kinds, and they are not alike.

### `agent <name>`

Writes `.claude/agents/<name>.md` — the directory Claude Code actually reads — scaffolded
with the frontmatter and the full output contract inline, so a new agent starts contract-
correct rather than being corrected on its first run.

**It refuses to shadow a shipped agent.** Project agents take precedence over plugin
agents, so `/loop:add agent verifier` would silently replace the agent that carries the
system's hardest invariant with an empty scaffold. The command checks the plugin's agent
names and refuses, naming what would have been shadowed. Overriding deliberately is still
possible — by writing the file by hand, which is a decision nobody takes by accident.

It then reminds the user to add the agent to a track's `required` or `available` set,
because an agent no track offers can never be drafted.

### `skill <name>`

Writes `.claude/skills/<name>/SKILL.md` with the frontmatter Claude Code requires. Skill
precedence runs the other way — personal overrides project — and plugin skills are
namespaced, so there is no shadowing hazard to guard.

### `track <name>`

Adds a track to `.loop/config.yaml`. A track is data and the config is explicitly
hand-editable, so this needs no tool: the command writes the YAML and then validates by
reading the config back.

Validation is why this milestone adds `config_error` to `stateSummary`. Today a config
that fails to parse degrades silently — `stateSummary` catches the failure and reports
`max_cycles: null`, and the user sees nothing. After a scaffold has just edited that file,
silence is the wrong answer.

### A note the command must make

Claude Code watches `.claude/agents/` and `.claude/skills/` and picks up changes within
seconds — **unless the directory did not exist when the session started**, in which case
the session must restart. A scaffold that creates the first agent in a fresh project hits
exactly that case, so the command says so rather than leaving the user wondering why
their new agent is not there.

## 6. The two deferred skills

Milestone 1 deferred these with a reason: "With one track defined, track resolution is
three lines inside `loop-leader`." Four tracks, two kinds of gate, and three specialist
modes later, that reason has expired.

**`loop-tracks`** — how a cycle is composed from data. What `required` and `available`
mean and why the distinction is enforced rather than advisory; the two gate kinds and
which is right for what; the three specialist modes and that all three are now enforced;
the cycle caps and the guards that end a run before them.

**`loop-extend`** — how to add an agent, a skill, or a track without touching the engine.
Where each lives and why; the contract a new agent must return; how a track's sets and
gate wire it in; and the constraint that explains the whole design — the engine does not
know agent names, so nothing you add requires changing it.

Both are documentation of decisions this project already made. Writing them is the last
test of whether those decisions were coherent.

## 7. Engine changes

| File | Change |
|---|---|
| `src/schemas/memory.ts` | **New.** `MemoryKindSchema`, `MemoryIdSchema`, `MemoryFrontmatterSchema` |
| `src/store/memory-store.ts` | **New.** Read, write, and list memory entries |
| `src/ops/memory.ts` | **New.** `memoryAdd`, `memorySearch`, `memoryGet` |
| `src/schemas/config.ts` | Remove `custom_dirs` |
| `src/store/config-store.ts` | Strip legacy keys before parsing |
| `src/ops/summary.ts` | `config_error: string \| null` |
| `src/mcp/server.ts` | Three memory tools |
| `commands/add.md` | **New.** `/loop:add` |
| `skills/loop-tracks/SKILL.md`, `skills/loop-extend/SKILL.md` | **New.** |
| `skills/loop-leader/SKILL.md` | When to consult and when to record memory |

Sixteen MCP tools when this lands.

## 8. Error handling

- **A memory entry whose frontmatter is invalid** — skipped by `listMemories` with the
  others still readable, exactly as an invalid story file is. One bad file must not make
  the corpus unreadable.
- **A search that matches nothing** — an empty result and a reason, not an error. "No
  memory matches" is an answer.
- **`loop_memory_get` on an unknown id** — `MemoryNotFoundError`, naming the directory.
- **A config carrying a legacy `custom_dirs`** — stripped silently on read. It is not a
  user error; it is a file the project itself wrote in an earlier version.
- **A config that fails to parse** — `stateSummary` still degrades rather than throwing,
  but now reports `config_error` with the prettified message, so `/loop:status` and
  `/loop:add track` can surface it.
- **`/loop:add agent` colliding with a shipped agent** — refused, naming the agent. The
  user can still override by hand.
- **`/loop:add` into a directory that did not exist this session** — succeeds, and the
  command says a restart is needed for it to load.

## 9. Testing strategy

**Unit — the memory schema.** Frontmatter round-trips; an unknown key is rejected; `kind`
outside the three values is rejected; `tags` defaults to empty; `run` is nullable; a
memory id that could steer a path is rejected.

**Unit — id allocation.** The first is `M001`; the next is `M002`; a gap does not
renumber; concurrent adds do not collide.

**Unit — search.** Ranks a title hit above a body hit; ranks a tag hit above a body hit;
breaks ties by recency; respects `limit`; returns an empty result with a reason for no
match; is case-insensitive; ignores a term shorter than two characters; returns excerpts
rather than whole bodies.

**Unit — the legacy strip.** A config containing `custom_dirs` parses and the field is
gone; a config without it parses unchanged; an unrelated unknown key is still rejected,
because the strip is a named migration and not a hole in the strict object.

**Unit — `config_error`.** Null for a sound config; the prettified message for an invalid
one; null rather than a message when there is no config at all, since a project without a
loop has no config error.

**Integration — a run that remembers.** Record a decision at the end of one run, search
for it while composing the next, and assert the entry is found by a term from its title
and that the search result carries an excerpt rather than the whole body.

**E2E.** `/loop:add agent` against a fixture, opt-in as before, asserting the file lands
in `.claude/agents/`, carries valid frontmatter, and that adding one named after a shipped
agent is refused.

## 10. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| `custom_dirs` | Removed, with a migration that strips it on read | Correcting its defaults — a knob that breaks whenever it is turned is not configuration |
| Where `/loop:add` writes | `.claude/agents/` and `.claude/skills/` | `.loop/agents/`, which the base spec specified and Claude Code never reads |
| Shadowing a shipped agent | Refused by name | Allowed — it would silently replace the agent carrying the system's hardest invariant |
| Memory search | Keyword ranking with a hard result cap | Semantic search, which adds a dependency and an index to go stale; and an uncapped return, which makes every later cycle worse |
| Memory injection | Only when asked | Automatic, which taxes every session with a corpus that only grows |
| Adding a track | A command that edits config and validates | A `loop_track_add` tool — the config is hand-editable by design, and a tool to edit a text file the user owns is machinery |
| Config errors | Surfaced in `stateSummary` | Left silent, which is what they have been for six milestones |

## 11. After this

Every element of the base spec has shipped: four tracks, nineteen agents, five skills,
sixteen MCP tools, three hooks, and eight guards. What is left is not a milestone but a
judgement — running the loop on real work and finding out which of these decisions were
right.
