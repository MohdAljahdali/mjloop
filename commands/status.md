---
description: Show the current loop track, cycle, and latest evidence
---

Call `mjloop_state_get` and report it in a compact form:

- track, run id, cycle out of the cap, stage
- goal, and plan/story when set
- finding counts by severity
- the halt reason when the run is halted
- whether a design system exists (`design_system`). When it does not, say so and name
  `/mjloop:design-sync` — a UI story run without one stops on a `blocked` `ui-designer`,
  and this is where that is cheap to learn.
- `config_error` when it is not null. Report the message as it stands and say that
  `.mjloop/config.yaml` needs the edit before the next run: every op that loads config
  fails until it parses, and nothing else reports it.

If the run is halted, also read `HALT.md` from the run directory and summarise the
recommended next step. If the project has no `.mjloop/`, say so and offer `/mjloop:init`.
