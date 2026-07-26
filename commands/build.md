---
description: Build something through as many verified cycles as it takes
argument-hint: <what to build | P001-S02 | --next>
---

Run the `build` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, folding open findings into the next cycle, and committing
each cycle that passes.

Read the argument before anything else — it has three forms:

- **A story id** matching `P001-S02` — call `loop_story_get` with it, and run the track
  against that story's acceptance criteria.
- **`--next`** — call `loop_story_get` with `next: true`. If it returns no story, report
  the reason it gives and stop; there is nothing to build. "Every story is done" and
  "nothing is ready because S02 waits on S01" are different answers and the user needs
  the right one.
- **Anything else** — a direct goal, as before. No story is involved.

Unlike `/loop:edit`, this track does not stop after one cycle. A failing cycle produces
findings that become the next cycle's work, up to the track's cap — or until the run
stops making progress, at which point the engine halts it and writes `HALT.md`.
