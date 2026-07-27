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
Track:      edit
Cycle:      1 of 1
Goal:       <what this run must achieve>
Story:      P001-S02 | none
Files:      <known-relevant paths, when any>
Findings:   <open findings from earlier cycles, when any>
Verify:     test="npm test" lint="npm run lint" build=null
Return:     the loop agent contract, and nothing else
```

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
- **The object is the return value.** Do not wrap it in commentary; the leader parses it.

## When an agent returns the wrong shape

The leader gets a readable error from `mjloop_run_log`, gives it back to the agent as a
single corrective retry, and on a second failure counts the cycle as failed. One bad
agent does not kill the run.
