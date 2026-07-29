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

## The shape every agent returns

```json
{
  "status": "pass | fail | blocked",
  "summary": "One paragraph a reviewer can act on.",
  "evidence": [{ "kind": "command | file | test", "ref": "npm test", "excerpt": "12 passed" }],
  "findings": [{ "severity": "high | medium | low", "file": "src/a.ts", "line": 14, "claim": "..." }],
  "files_touched": ["src/a.ts"],
  "next_hint": "optional single suggestion, or null"
}
```

## Rules

- **Exact shape.** No extra keys. `mjloop_run_log` rejects unknown fields, so a smuggled
  `confidence` field fails the whole call.
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
