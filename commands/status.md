---
description: Show the current loop track, cycle, and latest evidence
---

Call `loop_state_get` and report it in a compact form:

- track, run id, cycle out of the cap, stage
- goal, and plan/story when set
- finding counts by severity
- the halt reason when the run is halted
- whether a design system exists (`design_system`). When it does not, say so and name
  `/loop:design-sync` — a UI story run without one stops on a `blocked` `ui-designer`,
  and this is where that is cheap to learn.

If the run is halted, also read `HALT.md` from the run directory and summarise the
recommended next step. If the project has no `.loop/`, say so and offer `/loop:init`.
