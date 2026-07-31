---
description: Turn an idea into an approved plan broken into buildable stories
argument-hint: <the idea>
---

Run the `plan` track for: $ARGUMENTS

## Before the plan track: the discovery branch

Read `orchestration.discovery.mode` from `.mjloop/config.yaml` — `mjloop-cli config get`
prints it, and `/mjloop:config` is how it is changed — then take the branch it names.

Branch on the setting **explicitly**, before anything else happens. Whether a request is
interviewed before it is planned is a decision this project made once, in writing; a command
that decided it per invocation would interview the same request on one afternoon and plan it
straight through on the next, and the difference would look like the loop having a mood.

- **`always`** — enter discovery first, with the **mjloop-feature-discovery** skill. It asks
  the user one decision at a time and presents a draft brief. The plan track opens only
  against the brief they approved.
- **`ask`** — put the choice to the user once, with a recommendation, and honour their
  answer. Recommend discovery when the request names an outcome rather than a change, or
  when it touches more than one component; recommend going straight to planning when it is
  already specific enough to write acceptance criteria from. Ask once — a command that
  re-asks mid-run has made the setting meaningless.
- **`off`** — the default, and the reason an existing project is unaffected by any of this.
  Go straight to the plan track below, exactly as this command behaved before discovery
  existed.

A per-feature choice the user states plainly — *skip the questions*, *interview me on this
one first* — overrides the project default in either direction. Record it where a later
reader will find it: in the brief when discovery ran, and in the plan's own prose when it
was declined, so nobody mistakes a one-off for the project's policy.

Discovery is not a third gate, and it does not stand in for the two below. It produces the
plan track's input and then stops; the fit-check and the approval still happen afterwards,
against the plan, exactly as they always did.

## The plan track

Use the **mjloop-leader** skill. It owns the cycle: creating the plan, dispatching agents,
handling both gates, and breaking the plan into stories. When discovery produced an approved
brief, that brief is what the leader plans against.

This track has two gates of different kinds, and the leader skill explains both:

- **The fit-check gate** is enforced by the engine. `story-writer` cannot be recorded
  until `fit-checker` returns a pass with evidence that the plan matches the project that
  actually exists.
- **The approval gate** is enforced at story creation. Under `gates.plan_approval: human`
  — the default — no story may be added until a person has approved the plan and the
  answer is recorded with `mjloop_gate_set`.

When the run finishes, the plan's stories are ready for `/mjloop:build --next`.
