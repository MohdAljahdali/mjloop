---
name: loop-tracks
description: Use when composing a loop cycle or changing how a track behaves - explains required and available sets, the two kinds of gate, the three specialist modes, and the guards that end a run
---

# Loop Tracks

A track is data in `.loop/config.yaml`. The engine does not know agent names, so adding a
track or an agent to one changes no code.

## Required and available

```yaml
build:
  required:  [builder, verifier]
  available: [scout, critic, ui-designer, ui-critic, security, docs, perf]
  max_cycles: 5
```

**`required`** is a guarantee, not a default. `loop_roster_set` rejects a roster that
omits any of them, so a track's promise cannot erode one cycle at a time. `verifier` is
required on three tracks for exactly this reason: no success is declared without evidence.

**`available`** is what the leader may draft — and every one it drafts past needs a stated
reason in `skipped`. Silence is not an answer, and `critic` in a later cycle may challenge
an omission it thinks was unsafe.

**`max_cycles`** is a ceiling, not a target. The guards below usually end a run first.

## Two kinds of gate

A gate is an ordering constraint the engine enforces at logging, not a suggestion.

**An evidence gate** blocks agents until a designated agent proves something:

```yaml
gate: { proven_by: reproducer, blocks: [fixer] }
```

`loop_run_log` refuses a result from anything in `blocks` until `proven_by` returns
`status: "pass"` carrying command or test evidence. The `fix` track uses it so no fix is
recorded for a defect nobody demonstrated; the `plan` track uses it so no story is written
for a plan nobody checked against the code.

**A decision gate** is different in kind and lives on the artefact, not the track. The
plan approval gate is recorded on a plan by `loop_gate_set` and enforced when a story is
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

That is the whole change. `/loop:add track <name>` writes it and validates by reading the
config back — see the **loop-extend** skill for what else a new element needs.
