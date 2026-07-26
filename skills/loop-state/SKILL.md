---
name: loop-state
description: Use when reading or changing loop state - explains the .loop directory and which MCP tool owns each write
---

# Loop State

## Layout

```
.loop/
├── config.yaml      tracks, limits, verify commands — hand-editable
├── state.json       current run — MCP-owned, never hand-edited
├── runs/<run>/      roster.json, cycle-NN/<agent>.json, HALT.md
├── plans/           one directory per plan (later milestones)
└── memory/          decisions and lessons (later milestones)
```

## One owner

`state.json` and every `manifest.json` are written **only** by the loop MCP server. A
`PreToolUse` hook denies `Write` and `Edit` on them. This is not ceremony: a model
corrupting that JSON loses the entire run, and it is the most common way agent loops
fail in practice.

`config.yaml` is the opposite — it is yours. Edit it freely to change a track's cap,
force a specialist, or set verify commands.

## Tools

| Need | Tool |
|---|---|
| Provision `.loop/` | `loop_init` |
| Read the current run | `loop_state_get` |
| Open a run | `loop_run_start` |
| Declare the cycle's agents | `loop_roster_set` |
| Persist an agent result | `loop_run_log` |
| Close a cycle | `loop_cycle_advance` |
| Stop with a report | `loop_halt` |

`loop_state_get` returns a compact summary rather than the whole file, so the leader's
context does not grow with the cycle count. Read the run directory when you need detail.

## Reading a halted run

`.loop/runs/<run>/HALT.md` carries the reason, the cycles attempted, the open findings,
and the recommended next step. Read it before restarting anything.
