---
description: Halt the current loop run and write a report
argument-hint: [reason]
---

Stop the current run cleanly.

1. Call `loop_state_get`. If nothing is `running`, say so and stop — there is nothing to halt.
2. Call `loop_halt` with the reason. Use $ARGUMENTS when given; otherwise
   `"stopped by the user"`.
3. Read the generated `HALT.md` and report: what was attempted, what the evidence shows,
   and what the open findings are.

Do not tidy up, revert, or commit anything. Halting records the state; it does not
undo work.
