---
description: Run any track in this project by name
argument-hint: <track> <goal>
---

Run the track named in the first word of $ARGUMENTS, for the rest of it: $ARGUMENTS

## 1. Check the track exists

Read `.mjloop/config.yaml`. If the first word is not a key under `tracks:`, **stop and say
so**, listing the tracks that do exist. Do not guess at the nearest name: running the
wrong track spends a whole run producing the wrong kind of work.

If the first word names one of `edit`, `build`, `fix` or `plan`, say that
`/mjloop:<name>` is the command for it and carries guidance this one does not — then run
it here anyway rather than refusing, because the user asked for this track by name.

## 2. Run it

Follow the **mjloop-leader** skill. Everything it says about composing a roster applies
without change: the roster comes from the track's own `required`, `available` and
`closing` sets, and the gate and the order graph are the track's, not this command's.
This command adds no rules of its own — that is the whole point of it.

## 2a. Supervision is per run

`mjloop_run_start` takes `supervision`, and it defaults to `supervised` — the human review
points this project already has stay where they are. Pass `unattended` **only** when the
user asked for this run to go without them, in words, in this request. It is a decision
about one rare run: it is never inferred from a previous run, and there is no setting that
makes it a project's default.

Either way the run's quality policy is pinned at start — the mode, the supervision, the
budget — and the run works against that pin rather than against the config file, which may
move under it. `unattended` does not remove the destructive gate: a protected operation still
suspends the run and waits for a person, and `/mjloop:resume` says what happens then.

## 3. Report

Say which track ran, how many cycles it took, and what the verifier said.
