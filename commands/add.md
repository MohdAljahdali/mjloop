---
description: Scaffold a new loop agent, skill, or track
argument-hint: agent|skill|track <name>
---

Scaffold a new element for this project: $ARGUMENTS

**Create it now.** Do not describe what you would create, do not print the file's contents
for the user to paste, and do not ask whether to proceed — the user already asked by
running this command. The only outcomes are a file written, or a refusal with a reason.

## 1. Parse and validate

Read the kind (`agent`, `skill`, or `track`) and the name from the argument. Reject a name
that is not lowercase letters, digits, and hyphens: all three kinds become a filename or a
directory. Reject an unknown kind.

## 2. Do the work for that kind

### `agent`

1. **Check the name for a collision first.** List the agent files this plugin ships. If the
   name matches one, **refuse and stop** — say which agent would have been shadowed and
   why that matters: project agents take precedence over plugin agents, so the scaffold
   would replace a working agent with an empty stub, including ones carrying the system's
   hardest invariants.
2. **Write `.claude/agents/<name>.md` with the Write tool.** That is the directory Claude
   Code reads project subagents from; nothing loads agents from anywhere else, whatever a
   config might suggest. Writing under `.claude/` asks for approval in an interactive
   session — that prompt is expected, and the file is not created until it is granted.
3. Give the file: frontmatter (`name`, `description`, `tools`, `model: inherit`), a short
   statement of what the agent does and what it must never do, and the full output contract
   inline. Read an existing agent in this plugin and copy its contract block verbatim, so
   the new agent is contract-correct on its first run rather than corrected by a retry.
4. Read the file back to confirm it landed.
5. Tell the user the step the scaffold cannot do for them: **add the agent to a track's
   `required` or `available` set in `.loop/config.yaml`.** An agent no track offers can
   never be drafted, whatever its file says.

### `skill`

1. **Write `.claude/skills/<name>/SKILL.md` with the Write tool**, including the
   frontmatter Claude Code requires: a `name`, and a `description` that says when the skill
   applies rather than what it contains.
2. Read the file back to confirm it landed.

No collision check is needed here: plugin skills are namespaced and cannot conflict with a
project skill.

### `track`

1. Ask the user for the `required` and `available` sets rather than guessing them, then
   **edit `.loop/config.yaml`** and add the track under `tracks:`:

   ```yaml
     <name>:
       required:  [agent-a, verifier]
       available: [agent-b]
       max_cycles: 5
   ```

   A track may also carry a gate, and both names it uses must belong to the track or the
   config refuses to parse:

   ```yaml
       gate: { proven_by: agent-a, blocks: [agent-b] }
   ```

2. **Validate the edit**: call `loop_state_get` and read `config_error`. If it is not null
   the edit broke the config — report the message and fix it before claiming anything
   succeeded.

## 3. Report

Say what you created, at what path, and — for an agent or a skill — whether a session
restart is needed: Claude Code picks up a new one within seconds **unless the directory did
not exist when this session started**, which is exactly the case when this is the project's
first. Without that note the user will wonder why the thing you just made does not exist.
