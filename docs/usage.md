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

## The dashboard

```
/mjloop:web        a local page that queues runs and shows each one in a terminal
```

It prints a url. Open it and you get three things beside each other: the state the loop
is in, the project's plans and stories, and a queue of commands. Click a story and it is
queued; type any loop command into the box and it is queued too.

The queue runs **one at a time**, each in its own `claude` session. `.mjloop/state.json`
holds one run, so two at once would overwrite each other — the server enforces that
rather than trusting whoever is clicking.

The terminal is the real session, not a summary of it. You can type into it: that is how
you approve a tool permission or answer a question without stopping the queue. When the
run reaches `done` or `halted`, the server closes that session and starts the next job in
a fresh one — a clean context per story, which is what makes long queues behave.

Two things worth knowing:

- **The url contains an access token.** Anyone who has it can run commands in your
  project. Do not paste it anywhere. Each server start issues a new one, and the server
  listens on `127.0.0.1` only.
- **`autonomous: false` means a session can stop mid-run and wait for you.** The page
  notices — after 90 quiet seconds it says so and offers a Continue button. Setting
  `autonomous: true` in `.mjloop/config.yaml` lets cycles run on without it.

The page speaks English and Arabic, picked from your browser and changeable in the
header. The terminal is always left-to-right whatever the interface language is.

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
### `orchestration` — what the loop settles on its own

`/mjloop:init` writes this block too, and every key in it is defaulted. A `config.yaml`
written before the block existed keeps parsing and gains the whole tree on the next read,
and the defaults it gains change nothing about how the project already runs.

```yaml
orchestration:
  profile:
    auto_accept: false
  discovery:
    mode: off
    question_budget: 8
    completion: review
  execution:
    after_plan_approval: manual
    uncertain_concurrency: sequential
    repair_attempts: 1
  quality:
    independent_plan_review: false
    independent_verification: false
  skills:
    sources: [github]
    trusted_registries: []
    update_mode: review
```

| Key | Default | Accepts |
|---|---|---|
| `profile.auto_accept` | `false` | `true` / `false` — may a scan activate a component map with nobody accepting it |
| `discovery.mode` | `off` | `always` / `ask` / `off` |
| `discovery.question_budget` | `8` | a whole number, 1–20 — a ceiling on questions, not a target |
| `discovery.completion` | `review` | `auto-plan` / `review` / `save-only` |
| `execution.after_plan_approval` | `manual` | `auto` / `manual` — does an approved plan start building on its own |
| `execution.uncertain_concurrency` | `sequential` | `sequential` / `ask` / `parallel` — what to do with stories whose independence cannot be proven |
| `execution.repair_attempts` | `1` | a whole number, 0–5; `0` is a real setting and means never repair |
| `quality.independent_plan_review` | `false` | `true` / `false` |
| `quality.independent_verification` | `false` | `true` / `false` |
| `skills.sources` | `[github]` | any subset of `github`, `registry`, `web`; the empty list means nothing may be discovered from outside this project |
| `skills.trusted_registries` | `[]` | `https://` URLs — plain `http://` is refused at the schema |
| `skills.update_mode` | `review` | `auto` / `review` / `pinned` |

**`discovery.mode` is `off` on purpose.** It is the setting that keeps `/mjloop:plan`
behaving exactly as it did before this block existed. Any other default would change what
the command does in every already-provisioned project the moment the engine is upgraded —
and that is a decision a project makes for itself, once, in writing.

Two combinations are refused when the document is parsed, each because it is a setting
that could never take effect and would fail silently:

- `discovery.completion: auto-plan` while `discovery.mode: off`. `auto-plan` names a start
  driven by discovery's own output, and a project with discovery off never produces one.
- `registry` in `skills.sources` while `trusted_registries` is empty. A source that names
  no registry admits nothing, and the project believes it enabled one.

A change that would introduce either is refused outright; written in by hand, it turns up
as a config that no longer parses.

### Changing a setting: `/mjloop:config`

```
/mjloop:config get                 every orchestration setting, and the file's revision
/mjloop:config set <key> <value>   change exactly one of them
```

It drives the engine's own binary, which you can run yourself:

```bash
mjloop-cli config get [--dir <path>] [--json]
mjloop-cli config set <key> <value> [--dir <path>]
```

`set` changes one setting, named by its full dotted key — `orchestration.discovery.mode`,
`orchestration.quality.independent_verification`, and so on. The two list settings take a
comma-separated value, and the empty string is the empty list:
`mjloop-cli config set orchestration.skills.sources ''` is how a project says no skill may
be discovered from outside it at all.

**Hand-editing this block is not the path, and that is not a style preference.** The
guarded write behind `config set` does three things an editor cannot:

1. It compare-and-swaps on the file's sha256 revision, so a change built on bytes that
   have since moved is refused instead of quietly clobbering whoever wrote in between.
2. It re-parses the whole document after applying the change. A setting can be perfectly
   legal on its own and illegal beside another — the two combinations above are exactly
   that — and only a whole-document parse sees it.
3. It writes nothing at all when either check fails, so a refusal leaves the file
   byte-identical rather than half-applied.

A hand edit gets none of the three, and its damage does not surface at the keystroke: the
config is next loaded when somebody starts a run, so a broken document turns up as a
failed `/mjloop:build`, in another session, with no obvious cause. The cockpit's Config
tab writes through the same guarded route. `config set` reaches the `orchestration` block
and nothing else — change `tracks`, `verify`, `gates`, `specialists` and `limits` in the
cockpit.

## The component map

`/mjloop:init` also walks the project and writes what it found to
`.mjloop/profile/proposed.json`: one component per directory that declares a manifest —
`pubspec.yaml`, `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg` — each with its
root, its technology, and the verify commands that manifest declares.

Technology is decided by declared content, never by a directory name. A `pubspec.yaml`
that declares Flutter is a Flutter component; one that does not is still a component, with
technology `unknown`. A directory called `mobile` with no manifest is not a component at
all. The commands are read the same way — a `package.json`'s own `scripts`, `pytest` when
`pyproject.toml` declares `[tool.pytest.ini_options]` — and a slot with nothing behind it
is left empty rather than guessed.

The walk itself changes nothing in your tree, and **a proposal is never activated on its
own.** Nothing routes off it, and running `/mjloop:init` again simply overwrites it with
what the tree says now.

Accepting one produces an **accepted revision**: `.mjloop/profile/accepted/rev-001.json`,
then `rev-002.json`, and so on. Every revision is immutable, and there is no mutable
"current" pointer — the accepted map is the highest-numbered revision file, and each one
records the revision it supersedes. That is the whole rollback model: going back to an
earlier map means accepting its components as a **new** revision, so nothing a run may
have pinned is ever rewritten or deleted.

One setting accepts a map: `orchestration.profile.auto_accept: true` lets `/mjloop:init`
accept its own scan, and only on a project that has no accepted revision yet. A later scan
never replaces a map that is already routing runs. Left at `false` — the default — a
project has a proposal, no accepted map, and no run routed by one until somebody accepts.

### Deciding on a map: `mjloop-cli profile`

```bash
mjloop-cli profile show   [--dir <path>] [--json]
mjloop-cli profile accept [--dir <path>] [--expect <revision|none>] [--from <revision>]
mjloop-cli profile reject [--dir <path>]
```

`show` prints the accepted revision — its number, when it was accepted, by whom, and its
components with their verify commands — then the current proposal, and says plainly
whether the two differ. It exits 0 on a project with nothing accepted: that is the state
every project starts in, not a failure.

`accept` accepts the current proposal as the **next** revision. `--expect` is the
compare-and-swap made explicit: pass the revision number you read, or the word `none` to
say you believe nothing is accepted yet, and the acceptance is refused outright if the
project has moved on since you looked. Omitted, the command reads the current revision for
you — a convenience, not a bypass, and somebody acting on a screen they read a while ago
should pass it. Who accepted it is taken from the machine's own username rather than from
anything you can type: that field is the only account of why a revision exists, and one
you could type would be forgeable. It refuses when there is no proposal at all, and names
`mjloop init` as what produces one.

`reject` discards the proposal and leaves the last accepted revision active and untouched.
It never writes anywhere near `accepted/`.

**Rolling back is `accept --from <revision>`.** It reads that revision's components and
accepts them as the next revision. It does not read `proposed.json` at all — not as a
fallback, not to compare against — so a project whose last scan was rejected, or never ran,
can still return to any map in its history.

It lands as a new revision rather than moving a pointer because there is no pointer, and
there is not meant to be one: a revision a run has pinned must still say exactly what it
said when the run read it, so the way back to an earlier map is forwards. For the same
reason `supersedes` on the new revision names the revision that was **current when the
acceptance landed**, not the one `--from` named. Revision 3 replaces revision 2 whatever
map it carries, and a `supersedes` pointing back at 1 would leave nothing on record saying
revision 2 had ever stopped being current — the chain would no longer read as the sequence
it is. `generatedAt` is carried over from the revision you reselected, because that is when
the scan behind those components actually ran, and stamping the present moment on a map
nobody re-scanned would be a small lie inside an audit record.

`--expect` composes with it and means exactly what it always did: the compare-and-swap is
on the accepted-revision counter, which `--from` does not touch, because a rollback is
still an append. `--from` refuses — writing nothing — when the revision was never accepted,
when the value is not a positive number, or when the revision file no longer parses, and
the refusal names the revisions that do exist. `--from` naming the revision that is already
current is allowed and writes a new revision, the same way accepting an unchanged proposal
does.

`.mjloop/profile/` is engine-owned, the way `state.json` and a plan's `manifest.json` are:
Claude Code's `Write` and `Edit` are denied inside it. An accepted revision is immutable,
and an acceptance reads either the proposal or, with `--from`, an accepted revision — never
anything a hand edit could have reached. That is what the denial buys: a hand-edited
proposal would put a component map nobody scanned in front of the person accepting it, and
a hand-edited revision would corrupt the map a rollback reselects.

The cockpit's Config tab shows the accepted map, read-only: its revision number, who
accepted it and when, and a card per component with its root, technology, skill tags, and
three verify slots. When a newer scan proposes a different map the page says so and stops
there. Accepting a map activates routing for every later run, which is exactly the class
of write the browser is permanently denied — so it reports the difference and never
resolves it.

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
