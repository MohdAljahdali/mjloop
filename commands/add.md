---
description: Scaffold a new loop agent, skill, or track
argument-hint: agent|skill|track <name>
---

Scaffold a new element for this project: $ARGUMENTS

Read the kind and the name from the argument. Reject a name that is not lowercase letters,
digits, and hyphens — all three kinds become a filename or a directory.

## `agent <name>`

Write `.claude/agents/<name>.md`. That is the directory Claude Code reads project
subagents from; nothing loads agents from anywhere else, whatever a config might suggest.

**First check the name against the agents this plugin ships.** Project agents take
precedence over plugin agents, so scaffolding one named `verifier`, `builder`, `fixer`,
`reproducer`, or any other shipped agent would silently replace it with an empty stub —
including the ones carrying the system's hardest invariants. If the name collides, refuse,
say which agent would have been shadowed, and stop.

Scaffold it with frontmatter (`name`, `description`, `tools`, `model: inherit`), a short
statement of what the agent does and what it must never do, and the full output contract
inline — copy the contract block from an existing agent in this plugin so the new one is
contract-correct on its first run rather than corrected by a retry.

Then tell the user the step the scaffold cannot do for them: **add the agent to a track's
`required` or `available` set in `.loop/config.yaml`.** An agent no track offers can never
be drafted.

## `skill <name>`

Write `.claude/skills/<name>/SKILL.md` with the frontmatter Claude Code requires: a `name`
and a `description` that says when the skill applies. No shadowing check is needed —
plugin skills are namespaced and cannot collide.

## `track <name>`

A track is data. Add it to `tracks:` in `.loop/config.yaml`:

```yaml
  <name>:
    required:  [agent-a, verifier]
    available: [agent-b]
    max_cycles: 5
```

Ask for the required and available sets rather than guessing them. Then **validate**: call
`loop_state_get` and check `config_error`. If it is not null, the edit broke the config —
report the message and fix it before saying anything succeeded.

A track may also carry a gate:

```yaml
    gate: { proven_by: agent-a, blocks: [agent-b] }
```

Both names must belong to the track, and the config refuses to parse otherwise.

## After any of the three

Claude Code picks up a new agent or skill within seconds — **unless the directory did not
exist when this session started**, which is exactly the case when you have just created
the project's first one. Say so: the user needs to restart the session, and will otherwise
wonder why the thing you just made does not exist.
