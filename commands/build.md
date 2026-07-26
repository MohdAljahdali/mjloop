---
description: Build something through as many verified cycles as it takes
argument-hint: <what to build | P001-S02 | --next>
---

Run the `build` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, folding open findings into the next cycle, and committing
each cycle that passes.

Read the argument before anything else — it has three forms:

- **A story id** — `P` and three digits, `-S`, two digits, and nothing else: `P001-S02`.
  Call `loop_story_get` with it, and run the track against that story's acceptance
  criteria.
- **`--next`** — call `loop_story_get` with `next: true`. If it returns no story, report
  the reason it gives. "Every story is done" and "nothing is ready because S02 waits on
  S01" are different answers and the user needs the right one. If the reason is that the
  remainder is `doing` or `blocked`, do not report that there is nothing to build: name
  those stories and offer to requeue one with `loop_story_update` and `status: "todo"` —
  a story left `doing` by a cancelled run is invisible to `--next` until someone does.
- **Anything else** — a direct goal, as before. No story is involved.

An argument that looks like a plan or story id but does not match exactly — `P001`,
`P001-S2`, `p001-s02` — is a mistake, not a goal. Say so rather than opening an adhoc run
named after the literal text; the engine does not re-check the shape. For a bare plan id,
offer `loop_story_get` with `next: true` and that `plan`.

Unlike `/loop:edit`, this track does not stop after one cycle. A failing cycle produces
findings that become the next cycle's work, up to the track's cap — or until the run
stops making progress, at which point the engine halts it and writes `HALT.md`.
