---
description: Build something through as many verified cycles as it takes
argument-hint: <what to build | P001-S02 | --next>
---

Run the `build` track for: $ARGUMENTS

Use the **mjloop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, folding open findings into the next cycle, and committing
each cycle that passes.

Read the argument before anything else — it has three forms:

- **A story id** — `P` and three digits, `-S`, two digits, and nothing else: `P001-S02`.
  Call `mjloop_story_get` with it, and run the track against that story's acceptance
  criteria.
- **`--next`** — call `mjloop_story_get` with `next: true`. If it returns no story, report
  the reason it gives. "Every story is done" and "nothing is ready because S02 waits on
  S01" are different answers and the user needs the right one. If the reason is that the
  remainder is `doing` or `blocked`, do not report that there is nothing to build: name
  those stories and offer to requeue one with `mjloop_story_update` and `status: "todo"` —
  a story left `doing` by a cancelled run is invisible to `--next` until someone does.
- **Anything else** — a direct goal, as before. No story is involved.

An argument that looks like a plan or story id but does not match exactly — `P001`,
`P001-S2`, `p001-s02` — is a mistake, not a goal. Say so rather than opening an adhoc run
named after the literal text; the engine does not re-check the shape. For a bare plan id,
offer `mjloop_story_get` with `next: true` and that `plan`.

## Before the first dispatch

Read `gates.preflight` from `.mjloop/config.yaml`.

- **`auto`** — the default. Start the run. An estimate shown before every run that then
  always proceeds is a prompt nobody reads.
- **`human`** — call `mjloop_report_get` with `report: "preflight"`, `track: "build"`, and
  the story id when the argument named one. Report it in a few lines and wait for the
  person to answer before the first `mjloop_roster_set`.

Report three things and no more: `dispatches_per_cycle` with the agents that make it up,
the `ceiling` this track allows, and `comparable` — what past runs of this same kind
actually took, in cycles, dispatches and minutes. `comparable: null` means the project has
never run this track this way; say *no basis* rather than inventing one, and note that
`minutes` stays null until a run has been timed end to end.

The estimate names no price and no model — the engine cannot see which model an agent
runs on, and a currency figure built on that would be a guess wearing an estimate's
clothes. The actionable number is `dispatches_per_cycle`: one specialist removed from the
track's `available` is one dispatch fewer in every cycle of the run.

## What the run does

Unlike `/mjloop:edit`, this track does not stop after one cycle. A failing cycle produces
findings that become the next cycle's work, up to the track's cap — or until the run
stops making progress, at which point the engine halts it and writes `HALT.md`.

A cycle that passes ends the run, and `mjloop_cycle_advance` returns `closing_agents` —
the agents that run once against the code as it finally stands. Dispatch them, then
commit.
