---
name: mjloop-extend
description: Use when adding a new agent, skill, or track to the loop - where each lives, what a new agent must return, and why none of it requires changing the engine
---

# Extending Loop

Nothing here requires an engine change. That is a property the design pays for: the engine
never learns an agent's name, so everything you add is data or a prompt.

## Adding an agent

**Where it goes:** `.claude/agents/<name>.md`. That is the directory Claude Code reads
project subagents from. Nothing loads agents from anywhere else — an agent written
elsewhere is a file that is never read.

**What it must return.** Every loop agent returns one shape, validated before it is
recorded:

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

Put that block **inline in the agent's own file**, not as a reference to another skill. A
real run proved the difference: agents pointed at the contract violated it on their first
attempt and each cost a corrective retry; agents carrying it inline complied first time.

**Give it one job and a stated limit.** Every agent in this plugin says what it must never
do — the verifier never edits, the builder never verifies or commits, the critic never
fixes what it found. A limit is what makes a second opinion worth having.

**Wire it in.** Add the name to a track's `required` or `available` set. An agent no track
offers can never be drafted, whatever its file says.

**Do not shadow a shipped agent.** Project agents take precedence over plugin agents, so
an agent named `verifier` replaces the one carrying the system's hardest invariant with
whatever you wrote. `/mjloop:add agent` refuses such a name.

## Adding a skill

`.claude/skills/<name>/SKILL.md`, with `name` and a `description` that says when it
applies. Plugin skills are namespaced, so a project skill cannot collide with one of this
plugin's.

## Adding a track

A few lines of YAML — see the **mjloop-tracks** skill for the sets, the gates, and the
specialist modes. `/mjloop:add track <name>` writes it and validates by reading the config
back.

## The constraint that explains the design

The engine does not know agent names. Not as an implementation detail — as the rule that
makes the rest possible.

It is why a track is data. It is why the reproduction gate is a `gate` field naming
agents from config rather than a hardcoded rule about `reproducer` and `fixer`. It is why
the specialist modes are a map the engine reads without interpreting.

When you extend the loop, keep it: if something you are adding would need the engine to
learn a name, the design is telling you the rule belongs in config instead.
