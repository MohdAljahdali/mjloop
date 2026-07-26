---
description: Build something through as many verified cycles as it takes
argument-hint: <what to build>
---

Run the `build` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, folding open findings into the next cycle, and committing
each cycle that passes.

Unlike `/loop:edit`, this track does not stop after one cycle. A failing cycle produces
findings that become the next cycle's work, up to the track's cap — or until the run
stops making progress, at which point the engine halts it and writes `HALT.md`.

Story ids (`/loop:build P001-S02`) arrive with the plan track. For now the argument is
the goal itself.
