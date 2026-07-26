# loop

A Claude Code plugin. Install once, invoke from any project.

`loop` runs work as a **cycle**: a leader composes the cycle from a track's agent
roster, dispatches contract-bound agents in isolated contexts, and judges the result on
evidence. Execution state lives in `.loop/` in the host project and is owned by an MCP
server, so no agent can corrupt it by hand.

## Status

Milestone 3 — the engine, and the `edit`, `build`, and `fix` tracks. `plan` lands in the
next milestone. See `docs/superpowers/specs/2026-07-26-loop-plugin-design.md`.

## Install

```bash
cd engine && npm install && npm run build
```

Then add this repository as a plugin marketplace or local plugin in Claude Code.

## Use

```
/loop:init                          provision .loop/ and detect verify commands
/loop:edit <what to change>         one-cycle scoped change
/loop:build <what to build>         multi-cycle build with findings carried forward
/loop:fix <what is broken>          reproduce first, then fix the root cause
/loop:status                        where the current run stands
/loop:stop [reason]                 halt the run and write a report
```

## How a cycle is composed

Each track declares a `required` set the leader cannot drop and an `available` set it
draws from as the task warrants. Before running, the leader writes `roster.json` naming
what it chose and why each omission was safe. Every agent a track marks `required` is a
hard invariant — on the shipped tracks that includes `verifier`, and no success is
declared without its evidence.

Change a track, cap, or forced specialist in `.loop/config.yaml`. Tracks are data — a
new one needs no code.

## Development

```bash
cd engine
npm test           # unit and integration tests
npm run typecheck
```

Two opt-in smoke tests run against the real CLI, one per track (from `engine/`):

```bash
LOOP_E2E=1 npm run e2e         # edit track — one cycle, then done
LOOP_E2E=1 npm run e2e:build   # build track — findings carried forward, commit on pass
```
