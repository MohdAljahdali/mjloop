---
description: Continue a loop run that was interrupted
---

Pick up a run that stopped without finishing — a closed terminal, a crashed session, a
machine that slept mid-cycle.

1. Call `loop_state_get`. If nothing is `running`, say so and stop: there is nothing to
   resume. Report what the last run ended as, and offer the command that would start a new
   one.
2. Read the run directory for the open cycle. The per-agent results already logged tell
   you which agents ran and what they returned — that is where the cycle got to.
3. Continue from that stage with the **loop-leader** skill, entering at its
   *"2a. Resuming an open run"* section. Do not restart the cycle from the beginning: an
   agent whose result is already logged does not need to run again, and re-running it
   would double its findings. In particular the leader must **not** call
   `loop_run_start` — that opens a second run and discards this one's cycle, findings,
   history and gate.
4. If the run is on a gated track and the gate is already open, it stays open. Reproduction
   and fit-check evidence survive an interruption.

Nothing here resets state. If the interrupted run should be abandoned rather than
continued, `/loop:stop` halts it cleanly with a report.
