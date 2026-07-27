---
description: Turn an idea into an approved plan broken into buildable stories
argument-hint: <the idea>
---

Run the `plan` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: creating the plan, dispatching agents,
handling both gates, and breaking the plan into stories.

This track has two gates of different kinds, and the leader skill explains both:

- **The fit-check gate** is enforced by the engine. `story-writer` cannot be recorded
  until `fit-checker` returns a pass with evidence that the plan matches the project that
  actually exists.
- **The approval gate** is enforced at story creation. Under `gates.plan_approval: human`
  — the default — no story may be added until a person has approved the plan and the
  answer is recorded with `loop_gate_set`.

When the run finishes, the plan's stories are ready for `/loop:build --next`.
