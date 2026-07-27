# About mjloop

> النسخة العربية: [about.ar.md](./about.ar.md)

mjloop is a plugin for Claude Code that runs work as a **cycle** instead of a single
conversation.

A leader composes each cycle from a track's roster of agents, dispatches them in isolated
contexts, and judges what comes back on evidence rather than on impression. Execution
state lives in `.mjloop/` inside your project and is owned by an MCP server, so no agent
can corrupt it by hand.

## The problem it addresses

An agent asked to build something will usually report success. Sometimes it is right.
The failure that matters is not a bad edit — it is a confident report with nothing behind
it: a suite that was never run, a defect never reproduced, a plan checked against nothing.

mjloop is built so that a success claim has to survive a specific set of obstacles.

## What that means in practice

**No success without evidence.** Three of the four tracks — `edit`, `build`, and `fix` —
require a `verifier`, and its verdict rests on command output it attached, not on its
reading of the code. A `pass` with an empty evidence array is recorded as an unproven
claim. The `plan` track has no verifier, because there is no suite to run against a
document: its pass comes from `fit-checker`, the approval gate, and the story reviews.

**No fix before reproduction.** On the `fix` track, the engine refuses to record anything
from `fixer` until `reproducer` has produced a failing test and shown it fail. That is
enforced where results are written, not requested in a prompt.

**No stories before the plan was checked, and approved.** On the `plan` track,
`story-writer` cannot run until `fit-checker` has proven the plan matches the project that
actually exists — and under the default settings, no story is created until a person has
approved the plan.

**The loop stops itself.** Three guards end a run: a per-track cycle cap, a stagnation
guard that halts when consecutive cycles leave the same work remaining, and a
repeated-error guard that halts when the same command fails the same way twice. Each halt
writes a `HALT.md` naming which guard fired and why, and `/mjloop:stop` ends a run the same
way on your decision rather than a guard's.

The write lock and the gates above have a different job, and none of them ends a run. The
lock serialises concurrent writes so two agents cannot interleave them; a gate refuses one
write outright — a `fixer` result before the reproduction, a story before the approval.

**One writer for state.** `.mjloop/state.json` and every `manifest.json` are written only
by the MCP server, and a `PreToolUse` hook denies hand edits to them. A model corrupting
that JSON is the most common way agent loops fail in practice.

## The four tracks

| Command | Track | Shape |
|---|---|---|
| `/mjloop:edit` | `edit` | One cycle. `editor` → `verifier`. Escalates rather than growing. |
| `/mjloop:build` | `build` | Up to five cycles. `builder` → `verifier`, with findings carried forward. |
| `/mjloop:fix` | `fix` | Reproduce, investigate, test hypotheses in parallel, fix the cause, verify. |
| `/mjloop:plan` | `plan` | Draft, criticise, fit-check, get approval, break into stories. |

A track is **data**, not code. It declares a `required` set the leader can never drop and
an `available` set it draws from as the work warrants, plus a cycle cap and an optional
gate. Adding a track is a few lines of YAML, and the leader is never modified: it does not
know agent names ahead of time, it reads them from the track.

## Design constraints worth knowing

**The engine does not know agent names.** Not as an implementation detail — as the rule
that makes everything else possible. It is why a track is data, why the reproduction gate
is a config field naming agents rather than a hardcoded rule, and why adding an agent
requires no code change.

**One fact, one owner.** A story file is the source of truth for its story;
`manifest.json` is derived from the story files and `INDEX.md` from the manifests. Nothing
is kept in sync because nothing is stored twice.

**Every omission is stated.** Before a cycle runs, the leader records which agents it drew
and why each one it left out was safe to leave out. A wrongly skipped agent becomes a
finding like any other defect.

## What it is not

It is not a faster way to get one answer — a cycle costs more than a single prompt, and
`/mjloop:edit` exists precisely so small work does not pay for machinery it does not need.

It is not autonomous by default. `autonomous: true` is opt-in, and even then it extends no
limit: the guards end a run exactly where they would have with a person pressing enter.

It does not verify that a human approved a plan. No engine can. It enforces the ordering,
records who decided and in their own words, and offers `gates.plan_approval: auto` so that
a project which does not want a person in the loop says so rather than pretending.

## Next

- [Installation](./install.md)
- [Usage](./usage.md)
