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

## 3. Report

Say which track ran, how many cycles it took, and what the verifier said.
