---
description: Continue a loop run that was interrupted
---

Pick up a run that stopped without finishing — a closed terminal, a crashed session, a
machine that slept mid-cycle.

1. Call `mjloop_state_get`. If the run is `waiting_for_user` or `budget_exhausted`, it is
   suspended rather than interrupted — read the section below and report what it is waiting
   for instead of resuming it. If nothing is `running` either, say so and stop: there is
   nothing to resume. Report what the last run ended as, and offer the command that would
   start a new one.
2. Read the run directory for the open cycle. The per-agent results already logged tell
   you which agents ran and what they returned — that is where the cycle got to.
3. Continue from that stage with the **mjloop-leader** skill, entering at its
   *"2a. Resuming an open run"* section. Do not restart the cycle from the beginning: an
   agent whose result is already logged does not need to run again, and re-running it
   would double its findings. In particular the leader must **not** call
   `mjloop_run_start` — that opens a second run and discards this one's cycle, findings,
   history and gate.
4. If the run is on a gated track and the gate is already open, it stays open. Reproduction
   and fit-check evidence survive an interruption.

Nothing here resets state. If the interrupted run should be abandoned rather than
continued, `/mjloop:stop` halts it cleanly with a report.

## The two suspensions a person lifts

An interruption is not the only reason a run is not moving. Two statuses are the run
waiting on a decision only a person can make, and both are resumable — they are not
`halted`, and nothing about them is lost by leaving them open:

- **`waiting_for_user`** — the run proposed a destructive operation and stopped in front of
  it. The decision is made by an operator in the cockpit (`/mjloop:web`), never by an agent
  and never through an MCP tool, and it is bound to that exact operation: change a word or
  a target and the old answer buys nothing and the question is asked again. An approval is
  spent once.
- **`budget_exhausted`** — the run reached a ceiling its pinned policy set, and stopped
  before spending past it. What lifts it is one explicit budget amendment for that one run,
  recorded with the old value, the new value, the reason, and who decided. The pin itself
  is never rewritten: the effective ceiling is the pin plus the amendments, in order.

**Neither status costs anything while it waits.** A suspended run runs no agent, no
dispatch, no polling and no periodic summary — it is stopped at the stage it reached, and
that stage is where it continues.

Once the decision or the amendment is recorded, the engine puts the run back to `running`
at the same stage and `/mjloop:resume` picks it up by the rules above: the agents whose
results are already logged are not dispatched again. `/mjloop:status` reports which of the
two the run is waiting on and what it is waiting for.

A rejected destructive operation is the one case that may not resume: the run continues if
nothing had to be undone, and otherwise stays suspended until the work is reverted or the
run is ended through `/mjloop:stop`, which states a reason. A suspension nobody can lift is
not an ending.
