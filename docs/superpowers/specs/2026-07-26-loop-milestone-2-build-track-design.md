# Loop — Milestone 2: Build Track and Stagnation Guard — Design

**Status:** approved, ready for planning
**Supersedes nothing.** Extends `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §3.2, §4, §12.

## 1. Purpose

Milestone 1 shipped a loop that turns once. `edit` is capped at a single cycle, so
every mechanism that only matters across cycles — carrying work forward, noticing that
the loop is going in circles — was untestable and deliberately deferred.

This milestone ships the first genuinely iterative track. `/loop:build <goal>` runs
`scout → builder → verifier → critic` for as many cycles as the work needs, folds each
cycle's open findings into the next cycle's task list, and halts the moment the loop
stops making progress rather than burning its cycle cap first.

## 2. Scope

**In:**

- The `build` track: `builder` and `verifier` required, `scout` and `critic` available.
- Three agents: `scout`, `builder`, `critic`.
- `/loop:build <goal>` command.
- Per-cycle findings with archive-and-carry semantics.
- The stagnation guard: cycle fingerprint, strikes, halt.
- Leader judgement across cycles, including a commit per passing cycle.

**Out, and why:**

- **Story and plan ids.** `/loop:build P001-S02` needs plans and stories, which the
  plan track produces in milestone 4. Until then the track consumes a goal string.
  The command's argument grows a story form later without changing the engine.
- **`ui-designer`, `ui-critic`, `security`, `docs`, `perf`.** Conditional specialists
  belong to the UI and specialists milestone. The track's `available` set is data, so
  adding them later touches no code.
- **The repeated-error guard and the autonomous `Stop` hook.** The spec orders the
  `Stop` hook last, after the guards have proven themselves in supervised runs. The
  repeated-error guard overlaps heavily with stagnation and is better designed once
  stagnation has real run data behind it.

## 3. The build track

```
[scout]     read-only exploration, only when knowledge is missing
 └─ builder    required — writes code and tests, does not verify, does not commit
 └─ verifier   required — judges on command evidence, never edits
 └─ [critic]   severity-classified defects, including a wrongly skipped agent
 └─ leader judgement
      pass → commit, run done
      fail → this cycle's findings become the next cycle's task list
```

Track definition, added to `DEFAULT_TRACKS`:

```ts
build: { required: ['builder', 'verifier'], available: ['scout', 'critic'], max_cycles: 5 }
```

A track is data. Adding `build` adds no branching to the leader: it reads the required
and available sets from config exactly as it already does for `edit`.

`max_cycles: 5` is a ceiling, not a target. With the stagnation guard in place, a stuck
run halts well before it.

## 4. Findings lifecycle

`state.findings` holds the findings of **the current cycle only**. On close,
`cycleAdvance` archives them, returns them to the caller, and clears them as the next
cycle opens. A close that ends the run — a pass, a cap halt, a stagnation halt — keeps
them instead: there is no next cycle to clear for, and they are the work the run ended
with, which is what `HALT.md` prints and what `loop_state_get` must count. Clearing
them there would report `0H/0M/0L` for a run that halted over an open high finding.

Why not accumulate: `runLog` appends, so across cycles the same unfixed defect is
reported again every cycle. The list grows without bound, duplicates inflate the
severity counts the leader reads each cycle, and the stagnation fingerprint — which
must distinguish "same work remaining" from "different work remaining" — loses its
meaning. Per-cycle findings mean a finding that survives is one an agent re-observed
with fresh evidence, not one that was asserted once and never revisited.

Why not explicit resolution: an MCP tool that lets the leader mark a finding resolved
makes the leader the authority on whether a defect is fixed. The whole system is built
so that verdicts rest on evidence rather than assertion; a `loop_finding_resolve` call
is an assertion with no evidence attached.

**The return value matters.** `loop_state_get` returns severity counts, not the
findings themselves — deliberately, so the leader's context does not grow with cycle
count. If the engine cleared findings without handing them back, the leader would lose
exactly the work list it needs to compose the next cycle. So `cycleAdvance` returns:

```ts
export interface CycleAdvanceResult {
  state: State
  /**
   * The closed cycle's findings. On a fail these are the next cycle's task list.
   * On a pass they are informational — the leader's pass rule forbids an open
   * high-severity finding, but medium and low ones may survive a passing cycle,
   * and there is no next cycle to carry them to.
   */
  carried_findings: Finding[]
  /** `null` on a pass: the run is over, so no fingerprint is recorded. */
  fingerprint: string | null
  /** `state.no_progress_count` after this cycle. */
  strikes: number
}
```

This changes the op's signature from `Promise<State>`, and with it the
`loop_cycle_advance` tool output and every existing caller and test. That churn is
accepted: the alternative is an eighth MCP tool whose only job is to hand back state
the leader just caused to change.

**Durability.** Each agent's findings are already persisted in
`runs/<run>/cycle-NN/<agent>.json` by `runLog`. The archive that `cycleAdvance` writes
to `cycle-NN/findings.json` is a convenience aggregate over files that already exist,
not a second source of truth. An interruption between the state write and the archive
write therefore loses nothing recoverable — the per-agent files still hold every
finding, and a resuming leader can read them.

## 5. Stagnation guard

### State

Two of the three fields already exist and have had no consumer since milestone 1:
`state.no_progress_count` and `config.limits.no_progress_strikes` (default 2). One
field is new:

```ts
last_fingerprint: z.string().min(1).nullable().default(null)
```

The `.default(null)` is load-bearing: `StateSchema` is a strict object, and without a
default every `state.json` written by milestone 1 would fail validation on read. With
it, milestone-1 state files parse unchanged and gain the field on their next write.

### Fingerprint

```ts
export function cycleFingerprint(findings: Finding[], result: Result): string
```

A pure function in `engine/src/ops/fingerprint.ts`, so it is testable without a project
on disk. It reduces each finding to `(severity, file, claim)` — with `./` and separator
noise normalised out of `file` — then sorts, deduplicates, and hashes the result
together with the cycle result.

Sorting and deduplication are required, not cosmetic. Agents are dispatched
concurrently, so the order findings land in `state.findings` varies between otherwise
identical cycles; and one defect reported by two agents is the same remaining work as
one defect reported by one, so adding `critic` to a stuck cycle must not reset the
counter that stall should be driving. Either would make a repeat cycle look new and
silently disable the guard.

`line` is excluded for the same reason: the builder writes to the file its findings
point at, so a defect that survives a cycle usually drifts a line or two. Hashing the
line would let a flailing loop escape every strike and halt on the cycle cap instead,
telling the operator "out of budget" about a run that was stuck from cycle 1.

Evidence is excluded. Excerpts carry durations, timestamps, and counts that differ
between runs of the same failing command — including them guarantees a unique
fingerprint every cycle, which is the same silent failure by another route.

`files_touched` is excluded. Including it makes the guard *more permissive*, not
stricter: a loop that flails at a different file every cycle without fixing anything
would produce a fresh fingerprint each time and never take a strike. What is left —
the open findings plus the verdict — is precisely "the work still remaining", which is
what "no progress" means.

### Rule

Inside `cycleAdvance`, in this order:

1. `pass` → the run is done. No fingerprint bookkeeping; there is no next cycle.
2. Otherwise compute the fingerprint. Equal to `last_fingerprint` → increment
   `no_progress_count`; different → reset it to 0. Store the new fingerprint either way.
3. `no_progress_count >= limits.no_progress_strikes` → halt, reason
   `no progress for N consecutive cycles on track <track>`.
4. `cycle >= track.max_cycles` → halt, reason `cycle cap N reached for track <track>`.
5. Otherwise open the next cycle.

Stagnation is checked before the cap because its whole purpose is to halt earlier. With
the default of 2 strikes, three consecutive identical cycles halt the run — the first
establishes the fingerprint, the next two are the strikes.

The two halt reasons are deliberately distinct. "The loop is stuck" and "the loop ran
out of budget" call for different responses from whoever reads `HALT.md`, and a single
generic reason would hide that.

### Concurrency

The judgement stays inside the locked `store.update` callback, judging the draft rather
than a pre-lock snapshot. Milestone 1 fixed a race in which two concurrent advances each
read stale state and stepped the run past its cap; adding fingerprint bookkeeping must
not reintroduce it by reading `last_fingerprint` outside the lock.

## 6. Agents

All three carry the output contract inline, as milestone 1 established after a real run
showed that pointing at the `loop-contract` skill was not enough — both agents violated
the contract on their first attempt and each cost a corrective round trip.

| Agent | Tools | Contract |
|---|---|---|
| `scout` | `Read, Grep, Glob` | Read-only. Returns a focused map of the code the story touches: entry points, the patterns already in use, the tests that cover the area. `files_touched` is always `[]`. No `Bash` — a scout that can run commands starts verifying, and verification has an owner. |
| `builder` | `Read, Edit, Write, Grep, Glob, Bash` | Writes the code and the test that covers it. Does not run the verify suite and does not commit: an agent that grades its own work is not evidence, and an agent that commits before the verdict puts unverified work in the history. |
| `critic` | `Read, Grep, Glob, Bash` | Never edits. Returns severity-classified findings with real files and lines. Explicitly empowered to challenge a roster omission: an agent skipped without adequate reason is a finding like any other defect. |

`builder` needs `Bash` for the narrow purposes of reading the tree and running a single
targeted test while writing it — not for the verify suite. Its prompt draws that line;
the tool grant cannot.

## 7. Leader changes

Three additions to `skills/loop-leader/SKILL.md`:

**Folding findings.** The brief for cycle N+1 carries `carried_findings` from
`cycleAdvance` as the cycle's task list, highest severity first. A cycle with carried
findings is not a fresh attempt at the goal; it is work on a known list.

**Commit the passing cycle.** When `gates.commit` is `auto`, the leader commits after
the cycle passes — never before the verdict, and never `builder`'s own commit. Only
verified work enters the history, and a failing cycle leaves none. A pass ends the run,
so a run commits at most once, on its last cycle; a run that halts has committed nothing
and its work is still in the working tree, which is what `HALT.md` is for.

**Reading the halt.** The leader distinguishes a stagnation halt from a cap halt and
says which one happened. It may not raise `max_cycles` or reset the strike count to get
past either; both are the user's decision.

## 8. Engine changes

| File | Change |
|---|---|
| `src/schemas/config.ts` | Add `build` to `DEFAULT_TRACKS` |
| `src/schemas/state.ts` | Add `last_fingerprint` with a null default; `initialState` sets it |
| `src/ops/fingerprint.ts` | New — `cycleFingerprint` |
| `src/ops/run.ts` | `cycleAdvance` archives findings and clears them as the next cycle opens, applies the stagnation guard, returns `CycleAdvanceResult` |
| `src/mcp/server.ts` | `loop_cycle_advance` returns the new shape |
| `agents/` | New: `scout.md`, `builder.md`, `critic.md` |
| `commands/build.md` | New — `/loop:build <goal>` |
| `skills/loop-leader/SKILL.md` | Folding, commit gate, halt reasons |

## 9. Command surface

```markdown
/loop:build <what to build>
```

Runs the `build` track through the leader. Unlike `/loop:edit`, it does not stop at one
cycle: a failing cycle produces findings that become the next cycle's work, up to the
track's cap or until the stagnation guard halts it.

`/loop:status` needs no change — it already reports the halt reason, and the two new
reasons are plain strings.

## 10. Error handling

- **Malformed agent result** — unchanged: one corrective retry, then the cycle counts
  as failed. Milestone 1's inline contracts made this path rare in practice.
- **A cycle that fails with no findings** — permitted, and it will fingerprint
  identically to the next such cycle, so two of them in a row halt the run through the
  ordinary stagnation path. No special case is needed.
- **`carried_findings` lost to an interruption** — recover from the per-agent
  `cycle-NN/*.json` files, which are written before the cycle closes.
- **A stagnation halt on a run that was making invisible progress** — a real cost of
  the stricter fingerprint, accepted deliberately. The remedy is the user's: read
  `HALT.md` and start a new run with a narrower goal. The leader may not override it.

## 11. Testing strategy

**Unit — fingerprint.** Deterministic for identical input; invariant under the order
findings arrive in, under a repeated finding, and under a drifting `line`; sensitive to
a changed severity, file, or claim; different for the same findings under a different
result.

**Unit — stagnation transitions.** A repeat takes a strike; a change resets the count;
the threshold halts with the stagnation reason and not the cap reason; a `pass` never
takes a strike; stagnation halts before the cap when both would fire.

**Unit — findings lifecycle.** `cycleAdvance` returns the closed cycle's findings, the
archive file matches what was returned, `state.findings` is empty once the next cycle
opens, and still holds them on a run that ended.

**Integration — a passing multi-cycle run.** Three cycles on a fixture: cycle 1 fails
with findings, cycle 2 works the carried list and fails with fewer, cycle 3 passes.
Asserts the carried findings at each boundary and a final state of `done`.

**Integration — a stuck run.** Identical findings every cycle on a track with
`max_cycles: 5`. Asserts the run halts at cycle 3 with the stagnation reason, that
`HALT.md` names it, and that two cycles of budget were saved. This is the test that
proves the guard earns its place.

**E2E.** `/loop:build` against the fixture through the real CLI, opt-in as in milestone
1, asserting a final state of `done` and a commit per passing cycle.

## 12. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Milestone scope | Build track **and** the stagnation guard | Track alone — the cap is the only brake, and it only stops after the whole budget is spent |
| Findings | Per cycle, archived and returned on close | Accumulate with explicit resolution (an assertion without evidence); accumulate with dedup (resolved findings linger forever) |
| Commits | Leader, after the cycle that passes — a pass ends the run, so at most one per run | `builder` commits its own work (unverified history, and the next cycle must revert git state); committing a failing cycle (unverified work in the history) |
| Fingerprint | Findings + cycle result | Adding `files_touched` (makes the guard more permissive, not less); adding evidence excerpts (non-deterministic, disables the guard silently) |

## 13. What this unlocks

With `build` shipped, the `fix` track in milestone 3 reuses the whole multi-cycle
machine and adds only its reproduction gate. The plan track in milestone 4 then feeds
`build` real stories, and `/loop:build P001-S02` becomes a change to the command's
argument handling rather than to the engine.
