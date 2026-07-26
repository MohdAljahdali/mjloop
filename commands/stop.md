---
description: Halt the current loop run and write a report
argument-hint: [reason]
---

Stop the current run cleanly.

1. Call `loop_state_get`. If nothing is `running`, say so and stop — there is nothing to halt.
2. Call `loop_halt` with the reason. Use $ARGUMENTS when given; otherwise
   `"stopped by the user"`.
3. If the summary named a `story`, that story is still `doing` and `--next` skips it
   forever. Call `loop_story_update` on it: `status: "todo"` to put it back in the queue,
   or `status: "blocked"` if the stop reason is something that must be resolved first.
   Leave `evidence` alone — a cancelled run proved nothing. Then call `loop_index_render`.
4. Read the generated `HALT.md` and report: what was attempted, what the evidence shows,
   what the open findings are, and what you did with the story.

Do not tidy up, revert, or commit anything. Halting records the state; it does not
undo work.
