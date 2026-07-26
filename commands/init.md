---
description: Provision .loop/ in this project and detect its verify commands
---

Set up the loop for this project.

1. Call `loop_init`.
2. Report what was created, and the verify commands that were detected.
3. If any of `test`, `lint`, or `build` came back null, ask the user **once** for the
   correct command and write it into `.loop/config.yaml`. Never invent a command —
   a fabricated verify command produces false passes.
4. Tell the user the loop is ready and that `/loop:edit <request>` is available.

If `loop_init` reports `alreadyInitialised: true`, say so and stop. Do not reset state.
