---
description: Find and fix the root cause of a defect, reproduction first
argument-hint: <what is broken>
---

Run the `fix` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, and committing each cycle that passes.

This track has a gate. Nothing that changes implementation code can be recorded until
`reproducer` has produced a failing test and proven it fails — the engine rejects it,
and no instruction here can override that. If the defect does not reproduce, that is
the answer: report it and halt rather than fixing something nobody demonstrated.
