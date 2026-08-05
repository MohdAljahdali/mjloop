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

- `quality` when it is not null, in one line: the **pinned** mode and supervision — not
  whatever `.mjloop/config.yaml` says now — whether the pin is `active` or `shadow`, and
  the dispatches used out of the run's ceiling. A `shadow` pin is worth naming as such: the
  policy is being recorded and is not gating anything, which is what an existing project
  that never opted in should see.
- `quality.waiting` when it is set. This is the most useful line status prints, because it
  is the only one with an action attached. Say which of the two suspensions it is and what
  lifts it:
  - `budget` — the run is `budget_exhausted`. It needs one explicit budget amendment for
    this run, made in the cockpit (`/mjloop:web`).
  - `decision` — the run is `waiting_for_user` on a destructive operation. It needs an
    operator's approval or rejection, made in the cockpit, on that exact operation.

  Then name `/mjloop:resume` as what continues the run once the decision is recorded, and
  print the engine's `reason` as it stands. Neither suspension is spending anything while
  it waits, so there is no hurry to invent one.

Any token, cost or time number you report keeps the label the engine gave it —
`measured`, `estimated`, or `unavailable`. Do not turn an `estimated` count into a figure,
and do not convert an `unavailable` cost into one at all: this project may have no pricing
table, and a number nobody measured is worse than the absence it replaced.

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
