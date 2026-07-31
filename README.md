# mjloop

A Claude Code plugin. Install once, invoke from any project.

`mjloop` runs work as a **cycle**: a leader composes the cycle from a track's agent
roster, dispatches contract-bound agents in isolated contexts, and judges the result on
evidence. Execution state lives in `.mjloop/` in the host project and is owned by an MCP
server, so no agent can corrupt it by hand.

## Status

All four tracks ship: `plan`, `build`, `fix`, and `edit`, and so do all the guards: the
cycle cap, the stagnation guard, the repeated-error guard, the reproduction gate, and the
autonomous `Stop` hook. So do the conditional specialists — `ui-designer`, `ui-critic`,
`security`, `perf`, and `docs` — with `/mjloop:design-sync` and a `specialists` setting the
engine enforces in both directions; memory, in `.mjloop/memory/`, so a run can record a
decision and a later run can find it; extension, so `/mjloop:add` scaffolds an agent, a
skill, or a track; and the cockpit, `/mjloop:web`, which drives and reads a run in a
browser.

Milestone 8 — **the engine runs your verify commands itself.** It executes the copy of the
`verify:` block the run pinned when it started, keeps the whole log under the cycle, and
hands the verifier a bounded digest instead of a transcript. The receipt is what changes:
a `pass` citing a command the engine recorded as failing, killed, or never started is
refused rather than believed.

A run also stops regenerating its own narrative. It keeps a `map.md`, rendered from the
mapping agent's own result, and a `handoff.md` per cycle — what each agent reported, the
files it touched, the verification table, the open findings — generated from what the
cycle already produced, with no extra model call. Later cycles are handed paths to both
rather than a retyped file list and a growing findings array. `docs` now runs once, after
the run passes, against the code as it finally stands. And two reports are there when you
ask for them: which specialists are earning their dispatch, and what a run on a track is
likely to cost, in cycles, dispatches and minutes — no price table, because the engine
cannot see which model an agent runs on.

See `docs/superpowers/specs/2026-07-28-mjloop-milestone-8-token-economy-design.md`.

Newest — **the project maps itself, and its orchestration policy is a guarded setting.**
`/mjloop:init` now walks the tree and proposes one component per declared manifest —
`pubspec.yaml`, `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg` — carrying the
technology and the verify commands that manifest itself declares, never one inferred from a
directory name. A proposal activates nothing on its own: the accepted map is an immutable
numbered revision, and returning to an earlier one means accepting it as a new revision
rather than rewriting a record a run may have pinned. `mjloop-cli profile show`, `accept`
and `reject` are where that decision is made — with `--expect` carrying the revision you
read, so an acceptance built on a screen that has since moved is refused, and
`accept --from <revision>` reselecting an earlier revision's map without reading the
proposal at all, which is what makes the rollback reachable rather than merely modelled.
Never the browser: accepting a map activates routing for every later run, which is the
class of write the cockpit is permanently denied. Beside it, an `orchestration:` block
in `.mjloop/config.yaml` carries this project's policy, read and changed through
`/mjloop:config` and `mjloop-cli config get/set` — a write that compare-and-swaps on the
file's sha256 revision and re-parses the whole document, neither of which a hand edit does.
Every key is defaulted and `discovery.mode` defaults to `off`, so an already-provisioned
project's plan flow is unchanged by any of it. The cockpit's Config tab edits the block and
shows the accepted component map read-only.

Newer still — **a feature request can be interviewed before it is planned.** With
`orchestration.discovery.mode` set to `always` — or to `ask`, which puts the choice to the
user once and honours a no — `/mjloop:plan` runs the `mjloop-feature-discovery` skill first:
it reads the accepted component map, the config, and the project's own documentation for
itself rather than asking, then puts one decision at a time to the user — each with a
recommended answer — up to `discovery.question_budget` questions, marking whatever the budget
left unresolved as unresolved instead of guessing it. It stops at a draft brief for a person
to approve, and plans against the brief they approved. It plans nothing, routes nothing, and
starts nothing itself: the fit-check and the human approval gate still stand behind it,
against the plan. The brief it writes is a record on disk rather than a paragraph in a chat —
see below — and the mode defaults to `off`, so `/mjloop:plan` in an existing project is
unchanged.

Latest — **an approved brief is evidence, and it is immutable.** A feature brief lives in
`.mjloop/features/F###-<slug>/` as numbered revision files. A draft is written into place
as the interview goes, so an interrupted interview resumes instead of being re-asked;
approval freezes that revision, and the store refuses every later write to it rather than
trusting the caller. Approving is compare-and-swap on the revision the approver was shown —
a brief that moved in the meantime is refused outright — and it records who approved, when,
and their own words if they gave any, with the cockpit's approver taken from the machine's
own account rather than from anything the page can type. It refuses a brief with no
acceptance criteria, because that is what every later story is judged against. Changing
an approved brief mints a successor draft carrying its content forward, and rollback is
approving an earlier revision's content as a new one, so no record a run may have pinned is
rewritten or deleted. `superseded` is derived when a record is read — a revision is
superseded once a higher one exists — and never stored, since storing it would mean writing
to the file the rule exists to protect. `.mjloop/features/` is engine-owned like
`.mjloop/profile/`: `Write` and `Edit` are denied inside it, and briefs are created, read,
updated and approved through the four `mjloop_feature_*` operations. Once a brief is
approved, `orchestration.discovery.completion` decides what follows — `auto-plan` opens the
plan track against it, `review` records it and stops, `save-only` treats the brief itself as
the deliverable. The cockpit may read a brief with its revision history and approve the
revision it read; it may not create, edit, supersede, route, or execute one.

## Install

```bash
cd engine && npm install && npm run build
```

Then add this repository as a plugin marketplace or local plugin in Claude Code.

## Use

```
/mjloop:init                               provision .mjloop/ and detect verify commands
/mjloop:edit <what to change>              one-cycle scoped change
/mjloop:plan <idea>                        idea to approved plan to stories
/mjloop:build <goal | P001-S02 | --next>   multi-cycle build, optionally against a story
/mjloop:fix <what is broken>               reproduce first, then fix the root cause
/mjloop:status                             where the run stands, and what is not earning it
/mjloop:stop [reason]                      halt the run and write a report
/mjloop:resume                             continue an interrupted run
/mjloop:design-sync                        extract the design system the UI agents read
/mjloop:config [get | set <key> <value>]   read or change this project's orchestration settings
/mjloop:web                                cockpit: drive and read a run in a browser
/mjloop:add agent|skill|track <name>       scaffold a new element
/mjloop:release [major|minor|patch]        bump, tag, and publish a plugin release
```

## How a cycle is composed

Each track declares a `required` set the leader cannot drop and an `available` set it
draws from as the task warrants. Before running, the leader writes `roster.json` naming
what it chose and why each omission was safe. Every agent a track marks `required` is a
hard invariant — on `edit`, `build`, and `fix` that includes `verifier`, and no success is
declared without its evidence. The `plan` track has no verifier: there is no suite to run
against a document, so its verdict comes from `fit-checker`, the approval gate, and the
story reviews.

That evidence is the engine's own. The verifier calls `mjloop_verify_run`, the engine runs
the command the run pinned at its start, writes the whole log under the cycle, and records
what it executed — so a `pass` citing a command the engine watched exit non-zero is
refused, and an edit to `verify:` mid-run is reported rather than obeyed.

A track can also declare a `closing` set: agents that run once, after the run has passed,
and never inside a working cycle — which the engine refuses. On `build` that is `docs`,
because documentation drafted in cycle 2 describes code cycle 4 replaces. A closing agent's
result is recorded beside the run and changes no verdict.

Change a track, cap, or forced specialist in `.mjloop/config.yaml`.

## Extending it

A track is data. Adding one is a few lines in `.mjloop/config.yaml`, and the leader never
changes: it does not know agent names ahead of time, it reads them from the track.

```yaml
tracks:
  refactor:
    required:  [builder, verifier]
    available: [scout, critic, perf]
    closing:   [docs]
    max_cycles: 5
```

`/mjloop:add agent|skill|track <name>` scaffolds any of the three. New agents land in
`.claude/agents/`, which is where Claude Code reads project subagents from — the scaffold
refuses a name that would shadow one this plugin ships.

The `mjloop-tracks` and `mjloop-extend` skills explain the whole system: what `required`,
`available` and `closing` guarantee, the two kinds of gate, the three specialist modes, and
what a new agent must return.

## Plans and stories

A plan lives in `.mjloop/plans/P001-<slug>/`: `PLAN.md`, a `stories/` directory, and a
generated `manifest.json`. Each story is a markdown file that carries its own id, status,
acceptance criteria, dependencies, and — once it passes — the path to the run that proved
it.

The story file is the source of truth. `manifest.json` is derived from the story files
and `.mjloop/INDEX.md` is derived from the manifests, so nothing is ever edited in two
places. Every `mjloop_story_*` write regenerates its plan's manifest; `.mjloop/INDEX.md` is
regenerated by `mjloop_index_render`, which the leader calls after writing a story back.
Write stories through the `mjloop_story_*` tools rather than by hand.

## Specialists

A build cycle can draw on six optional agents beyond `builder` and `verifier`: `scout`,
`critic`, `ui-designer`, `ui-critic`, `security`, and `perf`. The leader drafts what the
change calls for and must record a reason for every one it leaves out. `docs` is the
seventh and it closes the run instead of joining a cycle.

`/mjloop:status` prints one line about any specialist this project has drafted five or
more times without a single high or medium finding to show for it. It is a report and
never a rule: nothing in the engine drafts or skips an agent because of it, and a
specialist with a zero hit rate may be exactly why the project has no findings of that
kind.

`specialists` in `.mjloop/config.yaml` overrides that judgement in both directions:

```yaml
specialists:
  security: always     # in every cycle, whatever the leader thinks
  perf: never          # a roster that drafts it is rejected
  docs: auto           # the leader decides — the default
```

The UI pair reads `.mjloop/design-system.md`, which `/mjloop:design-sync` extracts from your
code. Without it they stop rather than invent a design.

## Running unattended

Set `autonomous: true` in `.mjloop/config.yaml` and a `Stop` hook keeps the turn going
between cycles, so a run continues without somebody pressing enter.

It extends nothing. The cycle cap, the stagnation guard, and the repeated-error guard end
the run exactly where they would have with a person there — the hook only removes the
pause, and it goes quiet the moment the run is no longer running.

It removes one pause per turn, not all of them: Claude Code marks a stop it has already
continued from, and the hook yields on that mark rather than blocking its own
continuation. A long run can therefore come to rest with cycles still to go — `/mjloop:resume`
picks it up from exactly where it stopped.

## Development

Building the engine, running the tests, and what a reviewable pull request looks like:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
