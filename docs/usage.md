# Using mjloop

> النسخة العربية: [usage.ar.md](./usage.ar.md)

## Start here

```
/mjloop:init
```

Run it once per project. It creates `.mjloop/`, detects your verify commands, and
registers the plugin in `CLAUDE.md`.

Then pick the command that matches the work:

| The work | Command |
|---|---|
| A small, well-scoped change | `/mjloop:edit <request>` |
| Something that needs a few verified rounds | `/mjloop:build <what to build>` |
| Something is broken and you do not know why | `/mjloop:fix <problem>` |
| An idea that needs to become buildable work | `/mjloop:plan <idea>` |

Choosing the smallest track that fits is not a formality. `/mjloop:edit` is capped at one
cycle and skips critique entirely, which is why it is cheap; `/mjloop:plan` runs five
agents through two gates, which is why it is not.

## The four tracks

### `/mjloop:edit <request>`

One cycle: `editor` writes the change and its test, `verifier` judges it on command
output. No critics, no specialists.

`editor` escalates rather than growing. If the change would touch more than three files,
alter a public interface, add a dependency, or need a design decision the request does not
settle, it stops and says so. That is a success for this track, not a failure — take the
answer to `/mjloop:build`.

### `/mjloop:build <goal | P001-S02 | --next>`

Up to five cycles. `builder` and `verifier` are required; `scout`, `critic`,
`ui-designer`, `ui-critic`, `security`, `docs`, and `perf` are available, and the leader
must state a reason for every one it leaves out.

A failing cycle produces findings that become the next cycle's task list. A pass ends the
run, so a run has exactly one passing cycle and commits exactly once — by the leader,
after the verdict, never by the agent that wrote the code. A run that halts has committed
nothing: every cycle it ran is still in the working tree, and `HALT.md` is what explains
it.

Three argument forms:

- `/mjloop:build add a Send button` — a direct goal.
- `/mjloop:build P001-S02` — a story from a plan, judged against its acceptance criteria.
- `/mjloop:build --next` — the next story whose dependencies are all done.

### `/mjloop:fix <problem>`

Reproduce first. `reproducer` writes a test that fails **because the defect exists** and
runs it to prove it fails. Until that succeeds, the engine refuses to record anything from
`fixer` — the guard is at the write, not in the prompt.

Then `investigator` produces ranked hypotheses, several `hypothesis-tester` runs try to
falsify them in parallel, `fixer` addresses the cause, and `verifier` confirms the failing
test passes and nothing else broke.

If it does not reproduce, that is the answer. "This does not reproduce under these
conditions" is information you need, and better than a fix aimed at a defect nobody
demonstrated.

### `/mjloop:plan <idea>`

`planner` drafts `PLAN.md`; `plan-critic` reviews it into `REVIEW.md`; `fit-checker`
checks it against the code that exists and its evidenced pass opens the first gate.

Then the approval gate: under the default `gates.plan_approval: human`, no story is
created until you approve the plan and the leader records your answer. Approve, reject, or
ask for changes — a change request sends the next cycle back to `planner` with your reason
as its work.

Finally `story-writer` breaks the plan into stories with checkable acceptance criteria,
and `story-critic` reviews each one.

## While a run is going

```
/mjloop:status     where the run is: track, cycle, stage, findings, halt reason
/mjloop:stop       halt cleanly and write a report
/mjloop:resume     continue a run interrupted by a closed terminal or a crash
```

`/mjloop:status` also reports whether a `fix` run has reproduced its defect, and whether
the project has a design system.

## When a run halts

Three reasons are possible and they mean different things:

- **cycle cap reached** — the work needed more cycles than the track allows.
- **no progress for N consecutive cycles** — the loop closed N cycles with the same work
  remaining. More cycles would not have helped.
- **the same verification failure recurred** — one command failed the same way twice
  running. This is the most specific thing the run knows about why it stopped.

Each writes `HALT.md` into the run directory with what was tried, the evidence, and the
open findings. Read it before restarting anything.

## Configuration

`.mjloop/config.yaml` is yours to edit. `/mjloop:init` generates it:

```yaml
version: 1
autonomous: false
limits:
  max_parallel_agents: 4
  no_progress_strikes: 2
verify:
  test: npm test
  lint: npm run lint
  build: null
tracks:
  edit:
    required: [editor, verifier]
    available: []
    max_cycles: 1
  # build, fix and plan follow
specialists: {}
gates:
  plan_approval: human
  commit: auto
```

**`verify`** — the commands `verifier` runs. A `null` slot is skipped, not an error.

**`specialists`** — override the leader's judgement in both directions, keyed by agent
name:

```yaml
specialists:
  security: always     # in every cycle, whatever the leader thinks
  perf: never          # a roster that drafts it is rejected
  docs: auto           # the leader decides — the default
```

**`gates.plan_approval`** — `human` requires your approval before stories are created;
`auto` lets the loop record the decision itself. Setting `auto` is honest; a leader
approving its own plan under `human` is not.

**`autonomous: true`** — a `Stop` hook keeps the turn going between cycles, so a run
carries itself to completion without you pressing enter. It extends nothing: the same
guards end the run in the same place.

## Plans and stories

A plan lives in `.mjloop/plans/P001-<slug>/`:

```
PLAN.md          the plan, authored — its frontmatter carries the approval
REVIEW.md        plan-critic's output
manifest.json    generated from the story files — never hand-edited
stories/         one markdown file per story
```

Each story carries its own id, status, acceptance criteria, dependencies, and — once it
passes — the path to the run that proved it. `.mjloop/INDEX.md` summarises every plan.

The story file is the source of truth. The manifest is derived from the story files and
the index from the manifests, so nothing has to be kept in sync. Write stories through the
`mjloop_story_*` tools rather than by hand.

## Memory

The project remembers on purpose, not automatically. No memory is injected into a session
or into an agent's brief.

The leader records at the end of a run — a decision the diff will not explain, a lesson
from a halt, a pattern worth repeating — and searches memory when composing a cycle. You
can read and add entries yourself; they are markdown files in `.mjloop/memory/`.

## Extending it

```
/mjloop:add agent <name>     scaffolds .claude/agents/<name>.md with the contract inline
/mjloop:add skill <name>     scaffolds .claude/skills/<name>/SKILL.md
/mjloop:add track <name>     adds a track to .mjloop/config.yaml and validates it
```

A new agent must be added to a track's `required` or `available` set before it can ever be
drafted. The scaffold refuses a name that would shadow an agent the plugin ships, because
a project agent takes precedence and would silently replace it.

The `mjloop-tracks` and `mjloop-extend` skills explain the whole system: what `required`
and `available` guarantee, the two kinds of gate, the three specialist modes, and what a
new agent must return.

## The design system

The UI agents read `.mjloop/design-system.md`, extracted from your code:

```
/mjloop:design-sync
```

It is extracted, never generated from a template — a design system written from
imagination would confidently describe a project that does not exist. Its frontmatter
names the files the extraction actually read, so you can check the claim. Without it,
`ui-designer` stops rather than inventing a design.

## Releasing a plugin

If the project you are working in is itself a Claude Code plugin, one command cuts its
release:

```
/mjloop:release            derive the bump from the commits since the last tag
/mjloop:release minor      choose the bump yourself
```

It refuses a dirty tree, a branch behind its remote, and failing verification; then bumps
the version everywhere it appears, commits, tags, pushes, and publishes the notes. The
version in `.claude-plugin/plugin.json` is what `/plugin` compares, so a release that
changes behaviour without bumping it is one nobody can install.

## Next

- [About](./about.md)
- [Installation](./install.md)
