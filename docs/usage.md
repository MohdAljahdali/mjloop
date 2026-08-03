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

A track with none of the four commands above still runs: `/mjloop:run <track> <goal>` opens
any track named in `config.yaml`, including one built from the cockpit's Tracks tab that no
command was ever written for. See **`/mjloop:run <track> <goal>`** below.

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

The track can be preceded by an interview. Under `orchestration.discovery.mode` this command
first asks whether the request is understood well enough to plan at all — see **Feature
discovery** below. The setting defaults to `off`, so a project that has not changed it gets
exactly the command described here.

### `/mjloop:run <track> <goal>`

The other four commands each name their own track in their own text, which is exactly why a
track that exists only in `config.yaml` — one created from the cockpit's Tracks tab, say —
had nothing that could open it. `/mjloop:run` fixes that by naming no track at all: it reads
the first word of its argument, checks that word against `tracks:` in `config.yaml`, and
runs whichever one matches.

It adds no rules of its own. The roster still comes from the track's own `required`,
`available`, and `closing` sets; its gate and its order graph still apply exactly as they do
under any of the four named commands. If the first word names `edit`, `build`, `fix`, or
`plan`, it still runs — but the leader also says that the matching named command carries
guidance this one does not, so you know it exists next time.

## Feature discovery

`/mjloop:plan` can interview you before it plans, with the **mjloop-feature-discovery**
skill. The interview has one output: a draft brief you approve or send back.

It asks about decisions and nothing else. Anything the project can already answer — the
accepted component map, `.mjloop/config.yaml`, the project's own documentation, the code the
request lands in — it reads for itself rather than asking you. A question whose answer is
already in the repository spends your attention on something the interview could have looked
up, and it spends it from a budget that is not refilled.

It asks **one question per turn** and waits for your answer before choosing the next, and
every question carries its recommended answer and a sentence of why. Both halves are
deliberate: a batch of six questions gets a paragraph that answers two and leaves the rest
unclear, and a question with no recommendation hands the analysis back to the person the
interview exists to serve. The recommendation is also what makes disagreement cheap — "no,
the other one, because —" is a faster and more precise answer than an open question ever
gets.

Then it stops. Discovery does not plan, does not choose which agents or skills the work
needs, writes no story, edits no code, and starts no run. It presents a draft — a title, the
problem in your own terms, each decision with the answer you gave, acceptance criteria, and
the affected component ids taken from the accepted map rather than invented — and waits.
Approval is your word, and the plan track then opens against the brief you approved rather
than against a restatement of your original sentence.

### The three modes

`orchestration.discovery.mode` decides whether any of that happens, and the choice belongs to
the project rather than to a judgement made per invocation:

| Mode | What `/mjloop:plan` does |
|---|---|
| `always` | interviews first, every time, and plans against the approved brief |
| `ask` | puts the choice to you once, with a recommendation, and honours your answer |
| `off` | goes straight to the plan track — **the default** |

`off` is the default because it is the only value that leaves an existing project alone: a
project that gains this block gets exactly the `/mjloop:plan` it had before. Change it when
the project decides to, in writing:

```
/mjloop:config set orchestration.discovery.mode ask
```

or the same write from a shell:

```bash
mjloop-cli config set orchestration.discovery.mode ask
```

A per-feature choice you state plainly — *skip the questions*, *interview me on this one
first* — overrides the project default in either direction, for that one request. It is
recorded where it happened: the brief carries its own `discovery` block naming the mode and
the question budget that interview actually ran under, so that nobody later mistakes a
one-off for the project's policy, or reads a brief against a setting the project has since
changed.

### The question budget

`orchestration.discovery.question_budget` bounds the interview: a whole number, 1–20,
defaulting to 8. It is a ceiling and not a target, and an interview that reaches a shared
understanding in three questions is finished at three.

When the budget is spent the interview stops asking and presents what it has, marking every
decision that stayed unresolved as unresolved, with the options it would have put to you. It
does not spend a last question guessing the rest. An unresolved decision is a real output: it
tells the plan track exactly where it must not assume, and it tells you what a second,
shorter interview would be about. A guess recorded as an answer is indistinguishable from a
decision you made, and is found much later by whoever built on it.

### Where a brief lives

A brief outlives the conversation that produced it. Each one is a directory —
`.mjloop/features/F001-<slug>/` — holding one file per revision: `rev-001.json`, then
`rev-002.json`, and so on. A draft is written into place as the interview goes, question by
question, so an interview interrupted halfway is resumed rather than asked again. The moment
a revision is approved that file stops being writable at all, and the engine enforces it
rather than trusting whoever holds the tool. Later stories are planned against those bytes,
and a record that could still move is a record a plan cannot cite.

So a stored revision only ever says `draft` or `approved`. `superseded` is a third status
you will see and nothing ever writes it: a revision is superseded when a higher revision of
the same feature exists, which is worked out when the record is read. Storing it would mean
writing to the very file the immutability rule exists to protect, and a stored status could
then disagree with the revisions sitting beside it.

**Approval is compare-and-swap.** It carries the revision number that was put in front of
you, and if the brief has moved on since — another window, another session, one last
decision appended — it is refused outright rather than landing on a record nobody read. It
records who approved it, when, and their own words if they gave any. Approving from the
cockpit is attributed to the machine's own account and is not a field the page can fill in:
an approver a browser could type would be a forgeable authorisation for work nobody agreed
to. It also refuses a brief with no acceptance criteria: a draft may sit without them while
it is still being assembled, but every later story is judged against them, so approving a
brief that promises nothing is not a thing the engine allows.

**Changing an approved brief creates a successor.** Revision 2 opens as a draft carrying
revision 1's content forward and recording that it supersedes it; revision 1 is not touched.
Rollback is reselection, exactly as it is for the component map: returning to an earlier
revision means approving its content as a **new** revision, so nothing a run may have pinned
is ever rewritten or deleted. A feature that went 1 → 2 → back to 1's content approved as 3
has all three revisions on disk, each still saying what it said.

`.mjloop/features/` is engine-owned, the way `.mjloop/profile/` and `state.json` are:
Claude Code's `Write` and `Edit` are denied inside it. That denial is what an approved brief
is worth: a brief a hand edit could reach would let somebody approve a title and a list of
criteria that a later keystroke replaced, and the record would still read as your approval.
Briefs are created, read, updated and approved through the engine's own `mjloop_feature_*`
operations, the way stories are written through `mjloop_story_*`.

The cockpit is allowed exactly two things with a brief: read one, and approve the revision
it read. It serves a feature's latest revision with the revisions behind it, and accepts one
kind of write against it — approval, compare-and-swapped on the revision it served. It
cannot create a brief, edit one, supersede one, or turn one into a plan or a run: authoring
a brief is the interview's job, and planning or building one is `/mjloop:plan` and
`/mjloop:build`, which the page queues as commands like everything else. This version ships
no Features tab, so that is the server's boundary rather than a screen's — said here rather
than left to be found out by somebody looking for the tab.

### After approval: `discovery.completion`

`orchestration.discovery.completion` is the project's answer to what happens once a brief is
approved. It is read then and not before: a completion consulted while the brief is still a
draft is a start decided by policy against decisions nobody has agreed to yet.

| Setting | What follows an approved brief |
|---|---|
| `auto-plan` | the plan track opens straight away, against the approved brief |
| `review` | the brief is recorded and nothing else happens — **the default** |
| `save-only` | the brief is the whole deliverable |

`auto-plan` starts only from an approved brief. If you asked for changes, went quiet, or the
budget ran out with the brief still a draft, there is nothing here to plan and it waits
exactly as `review` does. It skips no gate either — the fit-check and the plan approval
still stand, against the plan. The config refuses `auto-plan` while `discovery.mode` is
`off`, because a project with discovery off never produces the brief it would start from.

`review` is the default because approving a brief and asking for it to be built now are two
different sentences. It stops with the brief recorded and names the feature id so you can
point at it later; the plan track opens when you say so.

`save-only` is for a project that gathers briefs first and works them later, in an order
somebody chooses. It records the brief and stops — no plan, no stories, no run — because a
command that helpfully planned the one it happened to be holding would have chosen that
order on your behalf.

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

It prints a url. Open it and you get the state the loop is in, the project's work, and a
queue of commands. Plans and Stories are two tabs, not one: **Plans** is where a plan is
read, approved and tracked, and **Stories** is where its stories are filtered and run.
Whichever plan you have open under Plans is the one Stories shows. Click a story's Run and
it is queued; type any loop command into the box and it is queued too.

### Agents and Tracks

Two more tabs sit beside Plans and Stories. **Agents** lists every agent a run can draft —
project and plugin, drawn in two separate sections rather than merged, because a project
agent shadows a plugin agent of the same name and one list would hide exactly that — and
shows which tracks use each one. It creates, edits, and deletes `.claude/agents/<name>.md`
from there: each write compares and swaps on the file's own sha256, the name is confined by
the same schema that keeps it from ever becoming a path outside `.claude/agents/`, deleting
an agent a track still names is refused, and every agent write is refused outright while a
run is open — an edit mid-run would make what ran and what is recorded two different
things. A plugin agent stays read-only; deriving one copies it into a project agent you can
then edit, the same way a hand-written one works.

**Tracks** is where `tracks:` and `specialists:` moved to, out of Config and into their own
tab: a Vue Flow graph of the track's order beside the full list view, not a summary of it —
the list is what a keyboard reaches the same edits through. A track built here needs no
command written for it before it runs: `/mjloop:run <track> <goal>` opens it by name, as
described above.

Opening a session in a project that has `.mjloop/` starts it for you and puts it on
screen. Only on a genuine session start — not on `/clear` and not on a resume, which happen
too often to be worth a browser tab each — and only once: a second session finds the
cockpit already serving this project and opens that one rather than racing it for the
port. Turn it off per project with `mjloop-cli config set web.autostart false`, or find
`web:` in your own `.mjloop/config.yaml`.

The very first run installs `node-pty`, and a session hook will not do that unasked — so
on a fresh clone the hook tells you to run `/mjloop:web` once, by hand, and starts nothing.

The queue runs **one at a time**, each in its own `claude` session. `.mjloop/state.json`
holds one run, so two at once would overwrite each other — the server enforces that
rather than trusting whoever is clicking.

The terminal is the real session, not a summary of it. You can type into it: that is how
you approve a tool permission or answer a question without stopping the queue. When the
run reaches `done` or `halted`, the server closes that session and starts the next job in
a fresh one — a clean context per story, which is what makes long queues behave.

The terminal pane starts collapsed and opens itself when a job starts — the command
box stays on screen either way, and the ▼ button parks it wherever you want it.

Four things worth knowing:

- **Stop closes the running job; it does not wedge the queue.** Stopping asks the session
  to exit and the page says `closing the session` until it does. If jobs were waiting
  behind it the queue pauses, says why, and offers Resume; if nothing was waiting there is
  nothing to hold, so the next command you type starts straight away. The same is true of
  a failure: the rest of the queue holds, and a failure with nothing behind it does not.
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
| `skills.sources` | `[github]` | any subset of `github`, `registry`, `web`, `skills-sh`; the empty list means nothing may be discovered from outside this project |
| `skills.trusted_registries` | `[]` | `https://` URLs — plain `http://` is refused at the schema |
| `skills.update_mode` | `review` | `auto` / `review` / `pinned` |

**`discovery.mode` is `off` on purpose.** It is the setting that keeps `/mjloop:plan`
behaving exactly as it did before this block existed. Any other default would change what
the command does in every already-provisioned project the moment the engine is upgraded —
and that is a decision a project makes for itself, once, in writing.

`always` and `ask` are the two values that turn the interview on, and **Feature discovery**
above is what they turn on — including what it refuses to do, which a table of accepted
values cannot say.

`discovery.completion` is read afterwards, once a brief has been approved, and **After
approval** above is what its three values do — including what each of them declines to do,
which is the half that matters when a project picks between them.

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
failed `/mjloop:build`, in another session, with no obvious cause. The cockpit's Config and
Tracks tabs write through the same guarded route. `config set` reaches the `orchestration`
block and nothing else — change `verify`, `gates` and `limits` in Config, and `tracks` and
`specialists` in Tracks.

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

## Skill selection

A run built against an approved feature brief can hand skill guidance to any agent this
project's own tracks name — `planner`, `builder`, `critic`, and `verifier` are the floor a
config that declares no tracks still gets, not a ceiling on what a config that declares its
own can route to. **The set of routable agents is what the project's tracks say it is, and
there is no `flutter-builder`, no `nextjs-builder`, and there never will be.** A Flutter
project and a Next.js project dispatch the same roles their tracks name; what differs
between them is the guidance a role is handed for one task, never who holds the
responsibility — inventing a role per technology is exactly what this design refuses to do.

Selection is a match, not a guess. A skill is offered to a component when the skill's own
tags intersect that component's skill tags — the tags the accepted component map already
derives from its declared technology — or when they intersect the brief's own declared
tags, which is what lets a concern that cuts across every component's technology, an
authentication boundary for instance, add a skill without that skill needing to pretend it
is a Flutter or a Next.js concern. Only a skill this project has accepted, still active, and
found compatible with this host is ever a candidate: an unaccepted, disabled, incompatible,
or simply unrelated skill is never selected, however well its tags happen to match.

**A brief's tags are declared, never inferred.** They are set through the engine's own
`mjloop_feature_*` operations, by a person deciding a tag belongs to the work — never by
reading `problem` or `acceptance` prose for a cue like "authentication", which is exactly
the free-form guess this design keeps out of a routing decision. A brief that names no tag
selects on its component ids alone, which is the ordinary case and not a gap.

**The manifest is pinned once, when the run starts,** into `skill-selection.json` beside
`verify-pinned.json` — the same reasoning as the verify pin: what a run's agents are told is
decided once, and a later change to the project's skill library, or a later edit to the
brief, must not rewrite the context a task already in flight is working from. Every
dispatched agent is handed the manifest's path rather than its contents, follows only the
selection naming its own component and role, and reports which skill ids it actually used.
A run that names no feature, or names one this project has not yet accepted a component map
for, pins nothing at all — it behaves exactly as it always has.

**Work runs in parallel only when independence is proven, never guessed.** More than one
affected component is necessary but not sufficient: the analysis also requires that no two
components' roots name or contain each other — the project root `.` is never independent of
anything beside it — and that no two components share a verify command string in any slot,
since a shared `npm test` means one suite already covers both, and two agents racing it
would contend for the same verify lock. Proven-independent work still only goes parallel
when `orchestration.execution.uncertain_concurrency` is `parallel`; the default,
`sequential`, and `ask` all serialise it, because a pure analysis has no way to put a
question to anyone — `ask` names itself in the reason so the leader knows to offer the
choice rather than silently falling back to sequential. Whatever a run decides, the reason
is recorded in full, so that anyone reading it afterward can see exactly why the work
serialised rather than ran in parallel.

**The evidence lands in the cycle's handoff.** Each cycle already writes one — a record,
kept beside the run, of what happened and why — and skill selection adds one more section
to it: every skill this run's manifest actually matched, naming the component, the role it
was offered to, the skill id, and the one reason recorded for choosing it. A run that pinned
no manifest gets no such section: everything else about the handoff stays exactly as it was.

**No skill library exists yet.** This story selects and pins; it does not import, vet, or
store a single skill — that is the next one. Until it ships, every project has accepted
nothing, so every selection this manifest can produce is empty. Say so plainly rather than
describe a feature nobody can use yet: today a run pins a manifest with a concurrency
verdict and no skills in it, because there are none on this project to select from.

## Skill library

The skill library is what skill selection above draws from, once a project has accepted
something into it. It lives **per machine, not per project** — a directory outside any
checkout, shared by every project on that machine — because the whole point of importing a
package once is that every later project which accepts it reuses the same download rather
than fetching its own copy.

**Where it lives.** By default, `~/.local/share/mjloop`. Set `MJLOOP_DATA_HOME` to an
absolute path to point it elsewhere — the override every test in this story uses, and the
escape hatch on a host where the default is not writable. `XDG_DATA_HOME/mjloop` is honoured
too, when set and absolute, before the default applies. One layout on every platform, on
purpose: a real per-OS resolver would be branches this project's own contributors could
never all test, so it stays one path everywhere. The resolved root is refused outright if it
would land inside the project directory or inside any `.mjloop/` directory — a library
nested in a checkout is exactly the cross-project interference this store exists to
prevent, so the collision is a thrown error, never a silent correction.

**Content-addressed, so a revision can never overwrite another.** A package is stored under
`<library root>/packages/<digest>/`, where `<digest>` is the sha-256 hash of the package's
content — a `package.json` record beside a `content/` directory holding the files as
fetched. One source imported at two revisions is two different digests, hence two
directories that cannot collide; writing a digest that already exists is refused rather than
silently accepted, because identical content is identical bytes and a second write of the
same digest is either a no-op or a corruption worth noticing.

**A project accepts a digest, never a path.** The acceptance record lives at
`.mjloop/skills/<skillId>.json` and is engine-owned the same way `.mjloop/profile/` is:
`Write` and `Edit` are denied inside it, and `mjloop-cli skills …` is the only way in. The
record names the digest it pinned, the components and agents it applies to, its own update
policy, and its status — never a filesystem path into the library, because the library
moves from machine to machine while the acceptance record is committed and travels in the
repository. `orchestration.skills.update_mode` (above) is only ever a *default offered* at
the moment of acceptance; nothing in this project consults it afterward, and there is no
global fallback that could reach into an already-accepted record and change what source or
policy it pinned.

**Acceptance is per project, and isolated.** Two projects on the same machine, sharing the
same library, can each accept a different digest of the same source, and neither project's
record moves when the other writes. Removing a project's acceptance — `skills remove`
— deletes that project's record and nothing else: not the package, not any other project's
acceptance of it. The engine can only see the current project's acceptances, so a package
removal (not exposed by this story) additionally refuses while *this* project's records
still reference it — a guard against the common case, not a proof that no other project
depends on it too.

**`mjloop-cli skills`** is the one user-reachable route into all of this:

```
skills list [--dir <path>] [--json]
skills accept <packageDigest> [--dir <path>] [--components a,b] [--agents builder,critic] [--policy auto|review|pinned]
skills disable <skillId> [--dir <path>]
skills enable <skillId> [--dir <path>]
skills remove <skillId> [--dir <path>]
```

`list` prints every package this machine's library holds — source, revision, license, audit
state — beside every acceptance this project has made — digest, components, agents, policy,
status; it exits 0 on an empty library, which is the state every machine starts in. `accept`
refuses a digest the library does not hold, an unknown component or agent name, and —
today, always — a package whose audit has not passed. `disable`/`enable` flip an
acceptance's status without touching its record otherwise. `remove` deletes only this
project's acceptance and says so in its own output.

**The cockpit reports the library; it never activates from it.** `GET /api/skills` is a
read-only projection of the same data `skills list` prints — packages and this project's
acceptances — with no new write kind and no new locale string, because accepting a package
is a decision that changes what every later run is told, which is exactly the class of
write the browser is permanently denied everywhere else in this system too.

The Skills page answers four questions, in order: what this project is made of (the component
map), **what skills this checkout holds** (`.claude/skills/`, read straight off disk, each one
marked with whether mjloop routes work to it), what this project has accepted, and what this
machine's library holds. A skill can be present and unrouted — that is a normal state, and the
page says which.

To find a new one, search — from the cockpit's Skills page with the search box on that page, or
from a terminal with:

```
mjloop-cli skills search <query> --source github|registry|web|skills-sh
```

`skills-sh` searches <https://skills.sh>. Two things it needs first, whichever way the search
is made:

1. The project must allow it — add `skills-sh` to `orchestration.skills.sources` in
   `.mjloop/config.yaml`. The default is `[github]` and no source is ever enabled on a
   project's behalf.
2. Its API requires a Vercel OIDC token. Set `SKILLS_SH_TOKEN` or `VERCEL_OIDC_TOKEN` in the
   shell (see <https://skills.sh/docs/api>). Without one, the search refuses and says so — it
   never reports an empty result for a missing token. The cockpit reads the environment of the
   shell it was started from, so set the variable before `/mjloop:web`.

Search is metadata only. Nothing is downloaded and nothing is activated by it —
`mjloop-cli skills inspect <url>` looks at a candidate, and `mjloop-cli skills import <url>`
is what writes one into the library after a passed audit. Import stays a command; it is not
offered from the cockpit.

**`acceptSkill` refuses any package whose audit state is not `passed`.** Discovery, static
inspection, and the sandbox — the next section — are what finally let a package earn that
state; before they existed, the library was empty on every machine and `skills accept` had
nothing real to accept. That is no longer true, and the next section is why.

## External discovery, inspection, and the sandbox

This is how a package gets from "somewhere out there" to `audit.state: 'passed'` — or, far
more often, to a plainly stated reason it did not. The whole pipeline is a sequence of
refusals: each phase either produces evidence or refuses outright and says exactly why.
Nothing here retries silently, fills a gap with a guess, or claims a boundary it does not
have.

### Which sources are allowed, and how to change it

`orchestration.skills.sources` (above) is the allowlist: any subset of `github`, `registry`,
`web`, `skills-sh`, defaulting to `[github]`. Every command that reaches outside this project —
`skills search`, `skills inspect`, `skills import` and `skills check-updates` — refuses a
source this project has not enabled, before a single request goes out, naming the setting and
the command that changes it:

```bash
mjloop-cli config set orchestration.skills.sources 'github,registry'
```

General web search is opt-in and off by default. It is not enough to ask `skills search
--source web`; the project's own config has to have added `web` to `sources` first — and
today, even once it has, no web search provider is wired up in this build, so the search is
refused with that reason stated plainly rather than a result faked to look real. `registry`
draws on `orchestration.skills.trusted_registries` (`https://` only; the schema already
refuses `registry` with an empty list, see above).

`skills-sh` is the fourth source, detailed in the Skills page section above: the same opt-in,
plus a Vercel OIDC token, and a refusal stating why when either is missing.

### A candidate is a search result, and nothing more

```
skills search <query> [--source github|registry|web|skills-sh] [--dir <path>] [--json]
```

returns metadata only — `{ source, url, repository, ref, skillName, description, stars? }` —
where a package claims to live, not its content. Nothing here is written to the library, and
no candidate can ever reach skill selection: the only path from a search result to something a
project can use runs through `skills inspect` and then a passed sandbox. A connector never
follows a redirect to a different host than the one it requested — the candidate's own
`url`/`repository`/`ref` are what this pipeline trusts, never wherever a response claims to
have been redirected to.

The same search is available from the cockpit's Skills page, in the search box described
below, as `GET /api/skills/search` — reachable without touching a terminal, but subject to
exactly the same source allowlist and, for `skills-sh`, the same token requirement.

### Pin first, then fetch

```
skills inspect <url> [--ref <ref>] [--dir <path>] [--json]
```

is where a candidate becomes evidence. In order:

1. **The ref is pinned to an immutable commit sha through the API before a single byte of
   content is fetched.** A moving ref — commonly a branch — fetched twice is two different
   packages wearing one name; pinning first means the sha in the report is the sha every
   later byte actually came from.
2. **The tree is fetched under hard caps**, each an outright refusal naming the cap, never a
   silent truncation: 500 entries, 200,000 bytes per file — checked against the *decoded*
   bytes, never a declared size field, because a zip-bomb-shaped blob understates exactly that
   field — 5,000,000 bytes total, and a path nested no deeper than 12 segments. GitHub's own
   `truncated: true` on an over-large tree is treated as exceeding the cap too, never accepted
   as a partial list.
3. **A hostile path is refused the moment its name first appears** — absolute, containing
   `..`, or starting with a separator — before anything is written anywhere. A symlink entry
   is fetched here as inert text, the same as any other blob; `writePackage`'s existing
   symlink refusal is what stops one from ever becoming a real file, and this phase does not
   duplicate that rule.
4. **`SKILL.md` is parsed for a `name` and `description`.** A package with no `SKILL.md`, or
   whose frontmatter is missing either field, is not a skill and is refused.
5. **A missing license blocks acceptance.** An SPDX id in frontmatter or a recognised
   `LICENSE` file satisfies it; neither present is a finding that blocks, exactly like a
   missing `SKILL.md`.
6. Executable content is classified — a shebang, an executable extension (`.sh .bash .zsh .py
   .js .mjs .cjs .ts .rb .pl .ps1`), or a `package.json` declaring `scripts` — and dependencies
   are inventoried from whatever manifests are present. Both are read, never run: classifying
   a file by its shebang line is reading a byte, not executing it.
7. A sha256 digest is computed over the canonical sorted content — the same digest the
   library addresses a package by.

A report that hit a blocking finding says so, carries every finding it could still determine
alongside the reason, and offers exactly one thing to do next: a **user-initiated** `search
alternative` action. Nothing here searches again on its own.

### The sandbox — and what it is not

**A bare child process with a scrubbed environment is not a sandbox.** It can still read the
filesystem, open sockets, and write anywhere the user can — calling that isolation would be
exactly the false claim this pipeline exists to refuse. The sandbox only counts when it is a
real isolation mechanism this machine can detect: `sandbox-exec` on darwin, `bwrap`
(bubblewrap) on linux. Nothing else counts.

- **No executable content** (the common case — most skills are markdown): the sandbox is
  skipped outright, recorded as `{ state: 'skipped', reason: 'no executable content' }`, and
  the package is acceptable with no backend at all.
- **Executable content, a backend detected**: only the checks the package itself declares —
  `mjloop.smoke` in `SKILL.md` frontmatter, each a bare argv array, never a shell string — run
  inside that backend, in a disposable temp directory holding only the package's own content;
  an environment scrubbed to exactly `PATH`, `HOME` (repointed at the temp directory), and
  `LANG`, with nothing else inherited from the parent process; no network (the backend's own
  isolation denies it outright, not merely by omission); a hard 30-second timeout that kills
  the check rather than waiting on it; and output capped and labelled, never the raw stream.
  Passing every declared check earns `{ state: 'passed' }`; any non-zero exit or timeout earns
  `{ state: 'failed' }`.
- **Executable content, no backend detected**: `{ state: 'unavailable', reason }`, naming the
  backend (`sandbox-exec` or `bwrap`) that would let this machine verify it — and **the package
  cannot be accepted here**. This is the honest outcome on a machine with neither tool; running
  the package unsandboxed to find out anyway is never an acceptable substitute, and this
  pipeline does not do it.

What "isolation" covers, precisely, because a boundary you cannot describe is one you cannot
rely on: the check may **write** only inside its own disposable directory, may not reach the
network at all, and may **read** only that directory plus the fixed system paths an executable
needs to launch (`/usr`, `/bin`, `/sbin`, `/opt`, `/System`, `/dev`). Your project checkout,
your home directory, and your credential files are not readable from inside a check on either
backend — which matters, because whatever a check prints is captured into the report that
`skills inspect --json` shows you. The backend binary itself is invoked by the absolute path
detection verified, never by a bare name `PATH` could resolve to something else.

The 30-second per-check timeout kills the check's whole process group, so nothing a check
starts in the background outlives it, and the sandbox phase as a whole is bounded too — a
package cannot multiply the runtime it was granted by declaring more checks.

Be plain about what this means for you: a report saying `sandbox: passed` verified only what
its declared checks exercised, run once, on this machine, inside this backend's isolation. It
is not a general guarantee the package is safe to run outside a smoke check, and it says
nothing about a package this machine could not sandbox at all — that one is refused, not
vouched for.

`audit.state` becomes `'passed'` only when inspection found nothing blocking **and** the
sandbox state is `'passed'` or `'skipped'`. Every other combination — including
`'unavailable'` — is `'failed'`.

### Import fills the library; acceptance is still your decision

```
skills import <url> [--ref <ref>] [--dir <path>]
```

runs the same pipeline and, only on a passed audit, writes the package into this machine's
shared library through `writePackage` — the same content-addressed store the skill library
section above describes. **It does not accept the package into this project.** That stays the
separate, explicit `skills accept <digest>` decision, and the command's own output says so and
prints the digest to accept:

```
imported "<name>" at digest <digest>
this writes the package into this machine's library only — it is not yet accepted into this project.
accept it with: mjloop-cli skills accept <digest>
```

A failed audit writes nothing, exits non-zero, and prints the same report `skills inspect`
would have.

Import also re-hashes the bytes it is about to store and refuses unless they are exactly the
bytes the audit was computed from. Staging fetches the pinned revision a second time, and a
second answer from a source is not self-evidently the first answer repeated — so a source that
served one tree to inspection and another to staging is refused by name, and nothing is
written. The digest a package is stored under always describes the content stored under it.

### An upstream change is a candidate, never a replacement

```
skills check-updates [--dir <path>] [--json]
```

resolves each acceptance's source to its current revision — except one whose `updatePolicy` is
`pinned`, which is not even checked, by design; the story is explicit that this policy never
moves. A different sha is reported as `new-candidate`, never imported and never accepted
automatically: the accepted digest stays exactly what it was, and picking up the change means
importing and accepting it yourself, the same as any other candidate.

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
