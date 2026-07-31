---
name: mjloop-contract
description: Use when writing, invoking, or debugging a loop agent - defines the brief every agent receives and the single output shape every agent must return
---

# Loop Agent Contract

Every loop agent takes a uniform brief and returns one shape. The leader does not know
what an agent does internally, which is why a new agent can be added without touching
the leader.

## The brief the leader sends

```
Track:      build
Cycle:      3 of 5
Goal:       <what this run must achieve>
Story:      P001-S02 | none
Map:        .mjloop/runs/<run>/map.md | none
Handoff:    .mjloop/runs/<run>/cycle-02/handoff.md | none
Skills:     .mjloop/runs/<run>/skill-selection.json | none
Verify:     test="npm test" lint="npm run lint" build=null
Return:     the loop agent contract, and nothing else
```

`Map:` is the run's ground: where the work lands, written by the engine from the mapping
agent's own passing result. `Handoff:` is the last cycle's record — who ran, what each
returned, the files touched, the commands the engine executed, and the findings still
open.

Both lines carry a path, and the path is the whole point. They replace a `Files:` line and
a `Findings:` line that were inlined into every brief and had no ceiling: forty open
findings became a forty-entry line delivered to every agent of every later cycle. The two
documents own those lists now, each bounded, and the agent that needs one opens it. Cycle 1
has neither, so both read `none` and the brief is shorter still.

`Skills:` carries a path for the same reason. It names the run's pinned skill manifest —
which accepted skills this run selected for each component and each agent role, and why —
written once by the engine at run start from the approved brief and the accepted profile,
and untouched by anything that happens after. That is what makes it safe to hand out: a
project's skill library can change mid-run without rewriting what an agent already
dispatched was told. Open it, find the selection naming your component and your role, and
follow the skills it lists — nothing invented, nothing carried over from a different
project. The instruction itself is in the file's `guidance` block, keyed by skill id: the
selection gives you the id and the reason it was chosen, and `guidance` gives you the text
to apply. A skill id with no guidance entry cannot happen — the engine refuses to write such
a manifest — so if you find one, the file is not the one the engine wrote. Its `concurrency`
block is addressed to the leader, not to you. A run with no approved brief pins nothing, so
the line reads `none` exactly as `Map:` and `Handoff:` do in cycle 1, and behaves exactly as
it always has.

## The shape every agent returns

```json
{
  "status": "pass | fail | blocked",
  "summary": "One paragraph a reviewer can act on.",
  "evidence": [{ "kind": "command | file | test", "ref": "npm test", "excerpt": "12 passed" }],
  "findings": [{ "severity": "high | medium | low", "file": "src/a.ts", "line": 14, "claim": "..." }],
  "files_touched": ["src/a.ts"],
  "skills_used": ["skill-id"],
  "next_hint": "optional single suggestion, or null"
}
```

## Rules

- **Exact shape.** No extra keys. `mjloop_run_log` rejects unknown fields, so a smuggled
  `confidence` field fails the whole call.
- **`skills_used` names only what `Skills:` actually selected for you.** Every id in it must
  be one the run's pinned manifest named for your role — no model may add a skill id the
  manifest did not produce, however well it thinks one would fit. This is not advice:
  `mjloop_run_log` opens the manifest and rejects the whole result when an id is not in it,
  the same way it rejects a `pass` the verify ledger contradicts. Omit the key, or send `[]`,
  when you were handed nothing or applied none of what you were handed; the engine defaults
  it to `[]` so a result written before this field existed keeps parsing. If your role has no
  row in the manifest at all — most roles, on most runs — then nothing was selected for you
  and `[]` is the only answer the engine will take.
- **`status: "pass"` needs evidence.** An empty `evidence` array with a pass is an
  unproven claim.
- **`blocked` is a real answer.** Use it when you are missing a command, a decision, or
  a permission. It is not failure — it is the loop working.
- **Findings are specific.** A real file and a real line. "Consider improving error
  handling" is not a finding.
- **An excerpt is a citation, not a transcript.** Nothing is rejected for length — the
  engine caps what it stores and leaves a marker naming where the rest is: a file beside
  your result, or, when your `ref` matches a command the engine itself ran, that command's
  own `verify/<slot>.log`. The log holds the command's full output, not the text you
  assembled around it, so anything you composed past the cap is not kept verbatim. Lead
  with the decisive line: the cycle's repeated-failure guard is computed from the first one.
- **The object is the return value.** Do not wrap it in commentary; the leader parses it.

## When an agent returns the wrong shape

The leader gets a readable error from `mjloop_run_log`, gives it back to the agent as a
single corrective retry, and on a second failure counts the cycle as failed. One bad
agent does not kill the run.
