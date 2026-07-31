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
reader will find it: in the brief's own `discovery` block when discovery ran, which carries
the mode and the budget that interview actually ran under rather than the project's, and in
the plan's own prose when it was declined, so nobody mistakes a one-off for the project's
policy.

Discovery is not a third gate, and it does not stand in for the two below. It produces the
plan track's input and then stops; the fit-check and the approval still happen afterwards,
against the plan, exactly as they always did.

## After the brief: the completion branch

`orchestration.discovery.completion` is what the project decided happens to a brief once it
exists. Read it **after** the user's approval has been recorded, and branch on it as
explicitly as on the mode above. Consulting it earlier is the one mistake worth naming: a
completion read while the brief is still a draft is a start decided by policy against
decisions nobody has agreed to yet.

- **`auto-plan`** — open the plan track below straight away, without asking again, against
  the approved brief. **Only against an approved one.** A draft is not an input: if the user
  has not approved it — they asked for changes, they went quiet, the interview ran out of
  budget — there is nothing here to plan, and this branch waits exactly as `review` does.
  It skips no gate either: the fit-check and the plan approval still happen. It is refused
  by the config schema when `orchestration.discovery.mode` is `off`, because a project with
  discovery off never produces the brief this branch starts from.
- **`review`** — the default. Stop with the brief recorded and let the user decide when, or
  whether, it is planned. Say what was approved and name the feature id, so they can point
  at it later. Do not open the plan track, do not create a plan, do not add a story and do
  not start a run: their approval was of the brief, not of building it now, and treating one
  as the other is how a `review` project discovers it had `auto-plan` all along.
- **`save-only`** — the brief is the whole deliverable. Record it and stop: no plan, no
  stories, no run, and no suggestion that one is started. A project sets this when briefs
  are gathered first and worked later, in an order somebody chooses; a command that
  helpfully planned the one it happened to be holding would have chosen that order for them.

When discovery did not run — `off`, or an `ask` the user declined — none of this applies.
There is no brief, so there is no completion to honour: go straight to the plan track.

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
