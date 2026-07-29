---
name: mjloop-tracks
description: Use when composing a loop cycle or changing how a track behaves - explains the required, available and closing sets, the mapping agent, the two kinds of gate, the three specialist modes, and the guards that end a run
---

# Loop Tracks

A track is data in `.mjloop/config.yaml`. The engine does not know agent names, so adding a
track or an agent to one changes no code.

## Required, available and closing

```yaml
build:
  required:  [builder, verifier]
  available: [scout, critic, ui-designer, ui-critic, security, perf]
  closing:   [docs]
  max_cycles: 5
  map: { drafted_by: scout }
```

**`required`** is a guarantee, not a default. `mjloop_roster_set` rejects a roster that
omits any of them, so a track's promise cannot erode one cycle at a time. `verifier` is
required on three tracks for exactly this reason: no success is declared without evidence.

**`available`** is what the leader may draft — and every one it drafts past needs a stated
reason in `skipped`. Silence is not an answer, and `critic` in a later cycle may challenge
an omission it thinks was unsafe.

**`closing`** is the third set: agents that run once, after the run passes, and never
inside a working cycle. `mjloop_cycle_advance` names them in `closing_agents` on the pass
and nowhere else. `mjloop_roster_set` demands no skip reason for one — that is what the set
is for — and it **refuses** one drafted into a cycle. Documentation written against cycle
2's code and rewritten in cycle 4 is the defect `closing` exists to remove, and permitting
it while recommending against it would have left the defect in place.

The decision to skip one still has to be recorded somewhere, because moving an agent out of
`available` removes it from the demand that every omission be explained. So the closing pass
has a roster of its own: `mjloop_roster_set` with `closing: true` and no cycle number writes
`closing/roster.json`, and it demands a reason for every closing agent that was not
dispatched. Without it a run could pass and ship with its documentation silently never
regenerated, and nothing anywhere saying so.

**`map`** names the agent whose passing result becomes the run's map — track data for the
same reason the gate is, since the engine knows no agent names. `mjloop_run_log` writes
`map.md` into the run directory from that agent's own result, and every later brief carries
the path instead of re-deriving the ground. The named agent must be one the leader can
actually draft in a cycle: a map drafted by a closing agent, or by one a specialist rule
sets to `never`, is a document no run ever writes, so the config refuses to parse rather
than leaving a permanent silent absence.

**`max_cycles`** is a ceiling, not a target. The guards below usually end a run first.

`closing` and `map` are both optional. A track that declares neither behaves exactly as
tracks always have, which is what an existing `config.yaml` gets: `initLoop` never rewrites
one, so a project whose `build` track still lists `docs` under `available` keeps drafting it
per cycle, with a skip reason required, until a person moves the line by hand. New projects
get `docs` under `closing` and `map: { drafted_by: scout }` on `build` from the defaults.

## Two kinds of gate

A gate is an ordering constraint the engine enforces at logging, not a suggestion.

**An evidence gate** blocks agents until a designated agent proves something:

```yaml
gate: { proven_by: reproducer, blocks: [fixer] }
```

`mjloop_run_log` refuses a result from anything in `blocks` until `proven_by` returns
`status: "pass"` carrying command or test evidence. The `fix` track uses it so no fix is
recorded for a defect nobody demonstrated; the `plan` track uses it so no story is written
for a plan nobody checked against the code.

**A decision gate** is different in kind and lives on the artefact, not the track. The
plan approval gate is recorded on a plan by `mjloop_gate_set` and enforced when a story is
added. There is no evidence a person's decision could carry — the record is the thing —
which is why a tool records it here and no tool records the other.

## The three specialist modes

```yaml
specialists:
  security: always    # in every cycle; a roster omitting it is rejected
  perf: never         # a roster drafting it is rejected
  docs: auto          # the leader decides — the default
```

All three are enforced, and the keys are agent names rather than groups, because a group
would require the engine to know which agents belong to it.

A track cannot both require an agent and forbid it: the config refuses to parse, naming
both places, rather than accepting a track for which every possible roster is invalid.

`always` and `never` reach a closing agent where it actually runs, which is the closing
pass rather than a cycle. `always` means the closing roster cannot drop it — it never
forces the agent into a cycle, because a roster that drafted it there would be refused
anyway. `never` on a closing agent is the same contradiction as `never` on a required one,
and the config refuses it for a sharper reason: a closing agent needs no skip reason, so a
forbidden one is a step that never happens with nothing anywhere recording that it did not.

## The guards that end a run

In the order `cycleAdvance` checks them:

1. **pass** — the run is done.
2. **repeated error** — the same verification failure twice running. Halts at the second
   occurrence, because an identical command failing identically is strong evidence.
3. **stagnation** — the same work remaining for N consecutive cycles, N from
   `limits.no_progress_strikes`.
4. **cycle cap** — the track's `max_cycles`.

Each writes a distinct reason into `HALT.md`, because "the loop is stuck", "the same thing
keeps failing", and "out of budget" send a reader to three different places.

## Adding a track

```yaml
tracks:
  refactor:
    required:  [builder, verifier]
    available: [scout, critic, perf]
    max_cycles: 5
```

That is the whole change. `/mjloop:add track <name>` writes it and validates by reading the
config back — see the **mjloop-extend** skill for what else a new element needs.
