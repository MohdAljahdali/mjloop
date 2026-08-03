---
description: Provision .mjloop/ in this project and detect its verify commands
---

Set up the loop for this project.

1. Call `mjloop_init`.
2. Report what was created, and the verify commands that were detected.
3. If any of `test`, `lint`, or `build` came back null, ask the user **once** for the
   correct command and write it into `.mjloop/config.yaml`. Never invent a command —
   a fabricated verify command produces false passes.
4. Tell the user the loop is ready, and list what it offers — the same list `mjloop_init`
   writes into `CLAUDE.md`:
   - `/mjloop:edit <request>` — one scoped cycle
   - `/mjloop:plan <idea>` — turn an idea into an approved plan broken into stories
   - `/mjloop:build <what to build | P001-S02 | --next>` — as many verified cycles as it
     takes, optionally against a story from a plan
   - `/mjloop:fix <problem>` — reproduce the defect first, then fix the root cause
   - `/mjloop:run <track> <goal>` — run any track by name, including one created in the
     cockpit's Tracks tab
   - `/mjloop:status` — where the current run stands
   - `/mjloop:stop [reason]` — halt the run and write a report
   - `/mjloop:resume` — continue a run that was interrupted
   - `/mjloop:design-sync` — extract the project's design system for the UI agents
   - `/mjloop:config [get | set <key> <value>]` — read or change this project's
     orchestration settings
   - `/mjloop:web` — dashboard: queue runs and watch each one in a terminal
   - `/mjloop:add agent|skill|track <name>` — scaffold a new element

If `mjloop_init` reports `alreadyInitialised: true`, say so and stop. Do not reset state.
