---
description: Find and fix the root cause of a defect, reproduction first
argument-hint: <what is broken>
---

Run the `fix` track for: $ARGUMENTS

Use the **mjloop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, and committing each cycle that passes.

This track has a gate. `fixer`'s result cannot be logged until `reproducer` returns
`pass` carrying `command` or `test` evidence — the engine rejects it, and no instruction
here can override that.

The engine gates the record, not the editing. It refuses the agents the track names in
`gate.blocks` and never inspects `files_touched`, so keeping every other agent off
implementation code until the gate opens is yours to enforce. If the defect does not
reproduce, that is the answer: report it and halt rather than fixing something nobody
demonstrated.
