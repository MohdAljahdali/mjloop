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
recommended next step. If the project has no `.mjloop/`, say so, offer `/mjloop:init`, and
stop there.

## One line about the specialists

Then call `mjloop_report_get` with `report: "telemetry"` and read **only** `flagged`: the
specialists this project has drafted five or more times without a single `high` or
`medium` finding to show for it. Print one line naming them and what can be done about it —
*"drafted with nothing to show: `security`, `perf` — worth a `never` in `specialists`, or
trimming the track's `available`"*. When `flagged` is empty, print nothing; there is no
news.

**Never print the `specialists` table that same call returns.** It is a row for every agent
this project has ever drafted, and status is a glance: folding the table into it would cost
every status call more context than the report was ever meant to save. The table is for
someone who asks for it — `mjloop_report_get` on its own, or the cockpit's Config tab.

Telemetry is a report, not a rule. Nothing in the engine drafts or skips an agent because
of it, and a specialist with a zero hit rate may be exactly why this project has no
findings of that kind. Say what the number is; do not decide the roster from it.
