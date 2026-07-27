# Loop — Milestone 5: The Remaining Guards — Design

> **Renamed after this document was written.** The plugin ships as `mjloop`: the `/loop:run` and `/loop:resume` commands described here are `/mjloop:run` and `/mjloop:resume`, MCP tools are `mjloop_*`, skills are `mjloop-*`, and project state lives in `.mjloop/`. `loop` collided with a command Claude Code already provides. This document predates the rename and uses the old identifiers throughout; the code is authoritative.

**Status:** approved, ready for planning
**Extends** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §11, §12.

## 1. Purpose

Six of the base spec's eight guards ship. This milestone adds the last two, and they are
the two the spec deliberately ordered last: the repeated-error guard, and the autonomous
`Stop` hook that lets a run continue without a person typing between cycles.

The order was not arbitrary. §18 puts autonomy after the guards "have proven themselves",
because a loop that restarts itself is only as safe as the things that stop it. The cycle
cap, the stagnation guard, and the reproduction gate have all now halted real runs in
tests; the machinery that would bound an autonomous run exists and is exercised.

## 2. Scope

**In:**

- The repeated-error guard: an error signature per cycle, and a halt when the same
  verification failure recurs.
- The autonomous `Stop` hook, inactive unless `autonomous: true`.
- `/loop:resume`, because an autonomous run that was interrupted needs a way back in and
  the base spec §13 defines the command with no milestone claiming it.

**Out, and why:**

- **`SubagentStop`.** A separate event that fires when a subagent finishes. The loop
  dispatches many subagents per cycle, and it wants none of them to trigger anything —
  `Stop` fires only for the main agent, which is exactly the semantics needed. Registering
  `SubagentStop` would fire the guard several times per cycle for no purpose.
- **`/loop:run <track>`, the generic runner.** The base spec describes the four track
  commands as thin wrappers over it. They already are thin, and a fifth command that adds
  a layer of indirection over four working ones is machinery for its own sake. Named here
  so the omission is deliberate rather than forgotten.

## 3. The repeated-error guard

### What it adds over stagnation

Milestone 2's stagnation guard halts when the *findings* do not change across cycles. It
misses a real case: the same underlying failure recurring while the findings around it
drift. A build that fails with the same compiler error every cycle, while the critic
reports a different nit each time, produces a fresh fingerprint every cycle and never
takes a strike.

The repeated-error guard is also **faster** where both apply. Stagnation needs two strikes
by default, so three identical cycles. An identical verification failure is stronger
evidence than identical findings — the same command failed the same way twice — so this
guard halts on the first repeat, at cycle 2.

### The signature

Milestone 2 excluded evidence excerpts from the stagnation fingerprint because they carry
durations and counts that differ between runs of the same failing command. That reasoning
still holds, so this guard does not hash raw excerpts either. It normalises first:

For each `evidence` entry of kind `command` or `test` on a result whose status is `fail`:

```
<ref> :: <first line of excerpt, with every run of digits replaced by N>
```

The first line because error output leads with the headline and trails into stack frames
and counts. Digits normalised because `1 failing` and `2 failing` are the same failure
recurring, not two different ones — and because durations and timestamps are digits.

Signatures are sorted and deduplicated, then hashed. Sorted for the same reason the
stagnation fingerprint sorts findings: agents run concurrently, and arrival order is not
part of the failure.

### The lifecycle

It mirrors the findings lifecycle exactly, which is deliberate — that pattern is built,
tested, and understood:

```ts
/** Normalised error signatures observed this cycle. Cleared when the next one opens. */
cycle_errors: z.array(z.string().min(1)).default([])
/** Fingerprint of the previous cycle's errors, compared by the repeated-error guard. */
last_error_fingerprint: z.string().min(1).nullable().default(null)
```

`runLog` appends signatures when it records a failing result, in the same locked update
that folds findings in. `cycleAdvance` compares and then clears, in the same place it
clears findings.

Both fields take a default for the same load-bearing reason as `last_fingerprint`,
`reproduction`, and `approval`: the state schema is strict, and without one every state
file written by an earlier milestone would fail validation on read.

### The rule

Inside `cycleAdvance`, after the pass check and **before** the stagnation check:

1. If the cycle produced no error signatures, there is nothing to compare — skip.
2. Otherwise fingerprint them. Equal to `last_error_fingerprint` → halt, reason
   `the same verification failure recurred: <first ref>`. Store the fingerprint either way.
3. Then stagnation, then the cap, unchanged.

Before stagnation because it fires earlier and its reason is more specific. Three halt
reasons now exist and stay distinct — "the same command keeps failing", "nothing is
changing", and "out of budget" send a reader to three different places.

## 4. The autonomous `Stop` hook

### What it does

When Claude Code is about to end a turn, the hook asks: is a loop run still going, and did
this project ask for autonomy? If both, it blocks the stop and tells the model what to do
next. If either is false, it says nothing and the turn ends.

### The contract

Confirmed against the official hooks reference rather than assumed, because a guessed
field name produces a guard that looks wired and does nothing:

- **Input** arrives as JSON on stdin and includes `cwd`, `hook_event_name`, and
  `stop_hook_active`.
- **Blocking** is a top-level `{"decision": "block", "reason": "..."}` on stdout — *not*
  the `hookSpecificOutput` shape that `SessionStart` and `PreToolUse` use. The two hooks
  this plugin already ships use the other shape, so this difference is a real trap.
- **`reason`** is fed to the model as context for why it should continue.
- **Registration** takes no meaningful matcher: `"Stop": [{ "matcher": "", "hooks": [...] }]`.
- **`Stop` does not fire when a subagent finishes.** `SubagentStop` is a separate event.
  This matters enormously here: the loop dispatches several agents per cycle, and a guard
  that fired on each of them would block the turn mid-cycle, repeatedly.

### When it allows the stop

Four conditions, any one of which means silence:

1. **`stop_hook_active` is true.** A Stop hook has already caused a continuation this
   turn. Re-blocking is how a hook loops forever, and Claude Code's own cap — eight
   consecutive blocks — is a backstop, not a design.
2. **`autonomous` is false in config.** The default. A project that has not opted in sees
   no behaviour change at all.
3. **The project has no `.loop/`.** Same silence the `SessionStart` hook already keeps.
4. **The run is not `running`** — `done`, `halted`, `idle`, or anything else. Every way a
   run ends is a way this hook stops blocking, which is precisely why the other guards
   had to ship first.

### What it says when it blocks

The reason has to be actionable, because it is the model's entire instruction:

```
Loop is running autonomously: track build, cycle 2 of 5, stage compose.
Goal: Add a Send button.
3 open findings carried from cycle 1 (2 high, 1 low).
Continue the cycle with the loop-leader skill. Do not stop until the run reaches
done or halted; the engine's guards will end it.
```

It is assembled from `stateSummary` — the same compact view the `SessionStart` hook and
`/loop:status` already use, so the hook adds no new way to read state.

### Why this is safe to ship now

An autonomous loop is bounded by everything already built: the cycle cap ends every run,
the stagnation guard ends a stuck one early, the repeated-error guard ends a repeating one
earlier still, and the reproduction gate keeps a fix track from producing anything before
it has proven the defect. The hook adds no new way to keep going — it only removes the
need for a person to press enter between cycles that were going to run anyway.

And it is opt-in twice over: `autonomous` defaults to false, and the hook is silent in any
project without `.loop/`.

## 5. `/loop:resume`

An autonomous run that was interrupted — a crashed session, a closed terminal — leaves
state at `running` with a cycle open. `/loop:resume` reads the state, reports where the run
stopped, and continues from the same stage.

It needs no engine change: `loop_state_get` already returns the track, cycle, stage, goal,
and open finding counts, and the run directory holds every agent result the interrupted
cycle produced. The command is a prompt that reads them and hands the leader its brief.

Included here rather than left to a later milestone because autonomy makes interruption
likely: a run that continues by itself is a run nobody is watching when the laptop sleeps.

## 6. Engine changes

| File | Change |
|---|---|
| `src/schemas/state.ts` | `cycle_errors`, `last_error_fingerprint` |
| `src/ops/fingerprint.ts` | `errorSignature`, `errorFingerprint` |
| `src/ops/log.ts` | `runLog` appends error signatures from a failing result |
| `src/ops/run.ts` | `cycleAdvance` applies the repeated-error guard and clears the signatures |
| `src/cli/index.ts` | `stop-guard` subcommand and `evaluateStopGuard` |
| `hooks/hooks.json` | Register `Stop` |
| `hooks/scripts/stop-guard.sh` | Wrapper, no logic |
| `commands/resume.md` | `/loop:resume` |
| `skills/loop-leader/SKILL.md` | The third halt reason, and what autonomy changes |

`evaluateStopGuard` is a pure function taking the parsed hook input, a `StateSummary`, and
the config, returning `{ block: boolean; reason: string }`. All the branching is tested
without a filesystem, exactly as `evaluateStateGuard` has been since milestone 1.

## 7. Error handling

- **Malformed hook input** — allow the stop. A guard that blocks on input it could not
  parse would trap a session over its own bug.
- **Unreadable config** — allow the stop. Autonomy is opt-in, and an unreadable config has
  not opted in.
- **Unreadable state** — allow the stop, for the same reason.
- **A failing result with no command or test evidence** — contributes no signature. The
  guard needs a failure it can name; an unevidenced one is the contract's problem, not
  this guard's.
- **Every guard firing at once** — the order decides, and it is fixed: pass, then repeated
  error, then stagnation, then the cap. `HALT.md` records one reason because there is one
  answer to "why did it stop".

## 8. Testing strategy

**Unit — the error signature.** Deterministic; identical for the same failure with
different counts; different for a different command; different for a different first line;
invariant under evidence order; ignores non-command evidence; ignores a passing result.

**Unit — the repeated-error guard.** A repeat halts at cycle 2 with the error reason, not
the stagnation reason; a changed error does not halt; a cycle with no signatures never
halts on this guard; a pass never triggers it; when the error repeats *and* the findings
are identical, the error reason wins because it is checked first.

**Unit — `evaluateStopGuard`.** Blocks a running autonomous loop; allows when
`stop_hook_active`; allows when `autonomous` is false; allows when uninitialised; allows
for every non-running status; the reason names the track, the cycle, and the open
findings; malformed input allows.

**Integration — an autonomous run bounded by its guards.** A run with `autonomous: true`
that would continue forever is halted by the cycle cap, and the hook then allows the stop.
Asserts the transition from blocking to allowing happens exactly when the run ends.

**E2E.** Not attempted for the hook. Exercising it needs Claude Code to end a turn, which
`claude -p` does at the end of a run — the shipped guards make the run terminate, but the
value of an E2E here is low and the setup is fragile. The unit tests cover every branch and
the integration test covers the transition; that is stated plainly rather than papered over
with a test that proves less than it appears to.

## 9. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Error signature | `ref` plus the normalised first line of the excerpt | Raw excerpts, which milestone 2 already established are non-deterministic and would silently disable the guard |
| Halt threshold | The first repeat, at cycle 2 | Two strikes like stagnation — an identical command failing identically is stronger evidence than identical findings, and waiting a third cycle buys nothing |
| Check order | Repeated error before stagnation | After — it fires earlier and names a more specific cause, so checking it second would report the vaguer reason |
| Error lifecycle | Per cycle, mirroring findings | A rolling window, which needs a size nobody can justify and state that grows |
| Hook output shape | Top-level `{"decision":"block"}` | `hookSpecificOutput`, which the plugin's two existing hooks use and which would silently do nothing here |
| `SubagentStop` | Not registered | Registering it, which would fire the guard once per agent per cycle |
| `/loop:run` | Dropped | Shipping it — four thin wrappers do not need a fifth layer |

## 10. What this unlocks

Every guard in the base spec ships, and a run can carry itself from start to halt without
a person in the loop. What remains is additive: the UI and specialist agents in milestone
6, and memory and extension in milestone 7.
