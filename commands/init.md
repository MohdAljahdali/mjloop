---
description: Provision .loop/ in this project and detect its verify commands
---

Set up the loop for this project.

1. Call `loop_init`.
2. Report what was created, and the verify commands that were detected.
3. If any of `test`, `lint`, or `build` came back null, ask the user **once** for the
   correct command and write it into `.loop/config.yaml`. Never invent a command —
   a fabricated verify command produces false passes.
4. Tell the user the loop is ready, and list what it offers — the same list `loop_init`
   writes into `CLAUDE.md`:
   - `/loop:edit <request>` — one scoped cycle
   - `/loop:plan <idea>` — turn an idea into an approved plan broken into stories
   - `/loop:build <what to build | P001-S02 | --next>` — as many verified cycles as it
     takes, optionally against a story from a plan
   - `/loop:fix <problem>` — reproduce the defect first, then fix the root cause
   - `/loop:status` — where the current run stands
   - `/loop:stop [reason]` — halt the run and write a report

If `loop_init` reports `alreadyInitialised: true`, say so and stop. Do not reset state.
