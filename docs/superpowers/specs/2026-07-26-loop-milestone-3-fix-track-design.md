# Loop — Milestone 3: Fix Track and the Reproduction Gate — Design

> **Renamed after this document was written.** The plugin ships as `mjloop`: the `/loop:fix` command described here is `/mjloop:fix`, MCP tools are `mjloop_*`, skills are `mjloop-*`, and project state lives in `.mjloop/`. `loop` collided with a command Claude Code already provides. This document predates the rename and uses the old identifiers throughout; the code is authoritative.

**Status:** approved, ready for planning
**Extends** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md` §3.3, §4, §12.

## 1. Purpose

`build` answers "make this work". `fix` answers a harder question: "why is this
broken?" — and the difference between the two is discipline about evidence.

The failure mode this track exists to prevent is the one every debugging session
falls into: a plausible cause is spotted, a change is made, the symptom disappears,
and nobody ever established that the change addressed the actual defect. The
symptom returns a week later in a different shape.

So the track enforces one rule mechanically: **no fix before the defect is
reproduced.** Not "the leader is instructed to reproduce first" — enforced by the
engine, at the point where work is recorded, in a way no prompt can talk its way
around.

## 2. Scope

**In:**

- The `fix` track: `reproducer`, `fixer`, `verifier` required; `investigator`,
  `hypothesis-tester`, `critic` available.
- Four agents: `reproducer`, `investigator`, `hypothesis-tester`, `fixer`.
- The reproduction gate, enforced in the engine and configured per track.
- Parallel same-agent dispatch: `runLog` gains an `instance` so N
  `hypothesis-tester` runs do not overwrite each other.
- `/loop:fix <problem>` command.

**Out, and why:**

- **A gate on any other track.** The mechanism is general — it is track config, not
  a special case — but `fix` is the only track that needs one today. Adding a gate
  to a future track is YAML.
- **Automatic halt when reproduction fails.** The gate makes an unproven fix
  impossible; it does not need to also end the run. A first reproduction attempt
  that is too narrow deserves a second cycle, and the stagnation guard already
  bounds how many. Halting is the leader's call, and `HALT.md` records it.

## 3. The fix track

```
reproducer            required — a test that fails because the defect exists
                        └─ GATE: nothing that changes code may run until this passes
 └─ [investigator]     evidence and ranked hypotheses — never fixes
 └─ [hypothesis-tester] ×N in parallel, one hypothesis each, verdict with evidence
 └─ fixer              required — the root cause, not the symptom
 └─ verifier           required — the failing test now passes, nothing else broke
 └─ [critic]           does the same defect exist elsewhere?
```

Track definition:

```ts
fix: {
  required: ['reproducer', 'fixer', 'verifier'],
  available: ['investigator', 'hypothesis-tester', 'critic'],
  max_cycles: 5,
  gate: { proven_by: 'reproducer', blocks: ['fixer'] },
}
```

When the cause is already obvious from the reproduction, the leader may go straight
from `reproducer` to `fixer` in the same cycle. It may never skip the gate, and it
may never skip `verifier`.

## 4. The reproduction gate

### Why it is configuration, not code

The obvious implementation hardcodes the rule: "reject a `fixer` result when no
reproduction exists". That would put two agent names inside the engine, and the
system's central claim is that the engine does not know agent names — tracks are
data, the leader reads them, and adding an agent touches no code.

So the gate is a field on the track:

```ts
gate: z.strictObject({
  /** Whose passing, evidenced result opens the gate. */
  proven_by: z.string().min(1),
  /** Agents that may not be logged until it is open. */
  blocks: z.array(z.string().min(1)).min(1),
}).optional()
```

A track without a `gate` behaves exactly as it does today. `edit` and `build` gain
nothing and change nothing.

### How it opens

There is no `loop_reproduction_set` tool, deliberately — the same objection that
ruled out `loop_finding_resolve` in milestone 2 applies here with more force. A
tool whose only input is the leader's word that the defect was reproduced is an
assertion, and this track exists precisely because assertions about causes are
what goes wrong.

Instead the gate opens as a **side effect of the ordinary evidence-bound channel**.
When `runLog` records a result from the track's `proven_by` agent, and that result
has `status: "pass"` with at least one `evidence` entry of kind `command` or
`test`, the engine records:

```ts
reproduction: {
  agent: string     // who proved it
  cycle: number     // when
  ref: string       // the command that reproduces the defect
  excerpt: string   // its output
} | null
```

The engine cannot read the excerpt and confirm it shows a failure — excerpts are
free text. What it can require is that the claim came from the designated agent,
carried command or test evidence, and was recorded through the contract-validated
path. That is the same standard `verifier`'s pass is held to everywhere else in
the system.

`status: "pass"` from the `reproducer` means "I reproduced the defect" — the
agent's own outcome, as everywhere else in the contract. A reproducer that
*cannot* reproduce returns `blocked`, which leaves the gate shut.

### How it blocks

`runLog` rejects any result from an agent in the track's `blocks` list while
`state.reproduction` is null, with `ReproductionGateError`. The rejection names the
gate and what would open it, so the leader gets a corrective message rather than a
mystery.

The gate is checked at logging, not at `rosterSet`, because a roster is declared
before the cycle runs. Checking there would force reproduction and fix into
separate cycles and contradict §3.3's allowance for going straight from one to the
other.

### Lifecycle

`runStart` clears `reproduction` along with the rest of the run-scoped state: a new
run has proven nothing. It survives across cycles within a run — a defect
reproduced in cycle 1 stays reproduced when cycle 2 opens.

`stateSummary` reports whether the gate is open, so `/loop:status` on a halted fix
run answers the first question anyone asks: did it ever reproduce the thing?

## 5. Parallel dispatch and result collisions

`hypothesis-tester` runs N times in one cycle, one hypothesis each. `runLog` writes
`cycle-NN/<agent>.json`, so all N would overwrite each other and the cycle would
record one verdict where it produced N.

This is a latent defect in `runLog` rather than a quirk of this track — the same
collision waits for any parallel same-agent dispatch — so it is fixed at the
source. `runLog` gains an optional `instance`:

```ts
{ agent: 'hypothesis-tester', instance: 'race-in-cache', result: {...} }
```

written to `cycle-NN/hypothesis-tester--race-in-cache.json`. `instance` is
validated by the same `AgentNameSchema` that milestone 2 added after a review found
an agent name could traverse out of the cycle directory; a name that reaches the
filesystem is validated once, in one place.

Findings from every instance fold into state as usual, so three testers that each
find the same defect produce one entry after the fingerprint's deduplication —
which milestone 2 added for exactly this reason.

## 6. Agents

All four carry the output contract inline, as established in milestone 1.

| Agent | Tools | Role |
|---|---|---|
| `reproducer` | `Read, Write, Edit, Grep, Glob, Bash` | Writes a test that fails **because the defect exists**, and runs it to prove it fails. Returns `pass` with the failing output as evidence, or `blocked` when the report cannot be reproduced. It writes only test files — a reproducer that touches the implementation has changed the thing it is measuring. |
| `investigator` | `Read, Grep, Glob, Bash` | Gathers evidence and returns **ranked hypotheses**, never a fix. Each hypothesis is a `findings` entry naming a file and a line, so the fixer inherits a task list rather than a narrative. Explicitly forbidden from editing: an investigator that fixes what it suspects destroys the evidence for whether it was right. |
| `hypothesis-tester` | `Read, Grep, Glob, Bash` | Takes **one** hypothesis and tries to falsify it. Returns `pass` when the evidence supports it, `fail` when it is refuted — with the command output either way. Never edits. Dispatched N-wide with distinct `instance` names. |
| `fixer` | `Read, Edit, Write, Grep, Glob, Bash` | Fixes the **root cause**, not the symptom. Blocked by the gate until reproduction exists. Does not run the verify suite and does not commit, for the same reasons `builder` does not. |

A note the prompts make explicit: `reproducer` returning `blocked` is a legitimate
and useful outcome, not a failure. "This does not reproduce" is information the
user needs, and it is far better than a fix aimed at a defect nobody demonstrated.

## 7. Leader changes

**Composing a gated cycle.** The leader reads the track's `gate` and orders the
cycle around it: `proven_by` first, blocked agents only after it has passed. If the
gate stays shut after `reproducer` returns `blocked`, it halts and reports what was
attempted — it does not dispatch `fixer` and let the engine reject it.

**Fanning out hypotheses.** When `investigator` returns ranked hypotheses and the
cause is not yet obvious, the leader dispatches one `hypothesis-tester` per
hypothesis, up to `limits.max_parallel_agents`, each with a distinct `instance`
derived from the hypothesis. It merges the verdicts before dispatching `fixer`: a
hypothesis every tester refuted is not the fixer's task list.

**Judging a fix.** A fix passes only when `verifier` reports that the reproduction
command now passes *and* the rest of the suite still does. A green suite that never
ran the reproducing test is not a verdict on this defect.

## 8. Engine changes

| File | Change |
|---|---|
| `src/schemas/config.ts` | `TrackSchema` gains optional `gate`; `DEFAULT_TRACKS` gains `fix` |
| `src/schemas/state.ts` | New `reproduction` field, nullable with a null default |
| `src/ops/log.ts` | `runLog` accepts `instance`; opens the gate; rejects blocked agents while it is shut. This makes `runLog` a config reader for the first time — it must know the running track's gate, and the track is config |
| `src/ops/run.ts` | `runStart` clears `reproduction` |
| `src/ops/summary.ts` | Report whether the gate is open |
| `src/mcp/server.ts` | `loop_run_log` accepts `instance` |
| `agents/` | New: `reproducer.md`, `investigator.md`, `hypothesis-tester.md`, `fixer.md` |
| `commands/fix.md` | New — `/loop:fix <problem>` |
| `skills/loop-leader/SKILL.md` | Gate ordering, hypothesis fan-out, fix judgement |

The `reproduction` field takes `.default(null)` for the same load-bearing reason
`last_fingerprint` did: `StateSchema` is strict, and without it every state file
written by milestones 1 and 2 would fail validation on read.

## 9. Error handling

- **A blocked agent logged while the gate is shut** — `ReproductionGateError`,
  naming the gate, the agent that would open it, and what it must return. The
  result is not written and state is untouched.
- **`proven_by` or a `blocks` entry names an agent the track does not define** — a
  config error, caught by a `TrackSchema` refinement when the config is parsed, not
  at the moment a run needs the gate. A gate that points at an agent the leader can
  never draft would otherwise shut the track permanently, and it would do it
  silently until someone tried to fix something.
- **The gate opens twice** — the second recording wins and the cycle is updated.
  Re-reproducing a defect after a failed fix attempt is legitimate.
- **An `instance` that collides with an existing file** — the write overwrites, as
  it does today for a repeated agent. Two testers given the same instance name is a
  leader error, and the roster records what it dispatched.

## 10. Testing strategy

**Unit — the gate.** A blocked agent is rejected while the gate is shut; the same
agent is accepted once it is open; a `proven_by` result with `status: "pass"` and
command evidence opens it; the same result with an empty `evidence` array does not;
a `blocked` result from `proven_by` does not; a track with no `gate` blocks nothing.

**Unit — instances.** Two results from the same agent with different instances
produce two files; the same instance overwrites; an instance that would escape the
cycle directory is rejected by `AgentNameSchema`.

**Unit — lifecycle.** `runStart` clears a previous run's reproduction; it survives
a `cycleAdvance` within a run.

**Integration — a full fix run.** Reproduce, investigate, dispatch two hypothesis
testers in one cycle, fix, verify, pass. Asserts two tester files exist, that the
gate opened at the reproducer's result, and a final state of `done`.

**Integration — the gate holds.** A run where the reproducer returns `blocked` and
the leader tries to log a `fixer` result anyway. Asserts the rejection, that no
`fixer.json` was written, and that state carries no findings from it.

**E2E.** `/loop:fix` against a fixture with a real defect, opt-in as in milestones 1
and 2, asserting the reproducing test exists, fails before the fix, and passes
after.

## 11. Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Where the gate lives | Engine, enforced in `runLog` | The leader's prompt — a guard a prompt can skip is a suggestion |
| How the gate is expressed | A `gate` field on the track | Hardcoded agent names in the engine, which breaks "the engine does not know agent names" |
| Where it is checked | At logging | At `rosterSet` — the roster precedes the cycle, which would force reproduction and fix into separate cycles |
| How it opens | A side effect of the `proven_by` agent's evidenced pass | A `loop_reproduction_set` tool — an assertion with no evidence, the same objection that ruled out `loop_finding_resolve` |
| Parallel testers | `instance` on `runLog`, one file each | Letting N testers overwrite one file, which silently discards N−1 verdicts |
| Failure to reproduce | Leader halts; the engine does not force it | Auto-halt, which denies a legitimate second attempt at a reproduction that was too narrow |

## 12. What this unlocks

After `fix`, three of the four tracks are shipped and the engine has grown every
mechanism the plan track needs: gates, multi-cycle judgement, parallel dispatch,
and carried work. Milestone 4 adds plans and stories on top of a machine that
already turns.
