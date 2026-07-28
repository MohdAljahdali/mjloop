# mjloop cockpit — design

The web dashboard becomes the place you drive a loop from: a permanent status
rail, five tabs, and a terminal that is a deliberate size rather than whatever
is left over.

This supersedes the layout and page sections of
[2026-07-28-mjloop-web-design.md](2026-07-28-mjloop-web-design.md). Its
security model, its queue, its completion detector and its i18n discipline are
unchanged and are not restated here except where this design extends them.

## Problem

The dashboard ships one screen: a 320px sidebar holding state, plans and the
queue, beside a terminal. It works, and it has three problems that compound.

**It shows a third of what it already knows.** `snapshot.runs`, `last_cycle`,
`recovered`, `run_id`, `plan`, `reproduction.ref`, `depends_on` and every job
timestamp cross the wire every 800ms and are drawn nowhere. Six locale keys —
`story.status.{todo,doing,done,blocked}`, `story.blockedBy`, `queue.count` —
are written, translated into Arabic, and unreachable. `{type:'notice'}` frames
the server already sends for `queue.blocked` and `job.abandoned` are parsed in
`app.js` and dropped: there is no branch for them.

**It has nowhere to put anything.** One scrolling column stacks state, every
plan with every story, and every job since boot, with no collapse, no filter
and no cap — and `JobQueue` never trims the finished list (`queue.ts:166`). A
findings table, a cycle timeline, a roster, a guard meter: adding any of them
to that column pushes the run state itself below the fold. Failure conditions
render at the weight of a normal row — `config_error` is a total outage and it
reads no louder than the cycle count.

**It cannot hold a control.** Every changed snapshot rebuilds all three panels
with `innerHTML` (`app.js:311-318`), up to eight times a second on an active
run. Focus, caret, scroll and selection die with the nodes. A search box, an
approval note or a filter is unusable before it is written.

Underneath all three: a person running a plan's worth of stories reads the
terminal to learn things the engine already wrote down. Whether a halt is two
cycles away, which agent in this cycle has landed, what the critic actually
found, why the leader skipped the security review — all of it is on disk, in
schemas the engine owns, and none of it is on the screen.

## What it becomes

```
┌─ mjloop ───────────────────────── ~/Projects/loop ──── [العربية ▾] ─┐
│ ● build · cycle 3/5 · P001-S02 · ⚠2 · strikes 1/2 · gate ✓  [halt] │  rail
├─────────────────────────────────────────────────────────────────────┤
│ [Run] [Plans] [Evidence] [Memory] [Config]                          │  tabs
│                                                                     │
│                        tab content — full width                     │
│                                                                     │
├─ ▼ [Session] [Queue 3] ────────────────────── [⤢] [stop] ───────────┤  pane
│ $ …                                                                 │
├─────────────────────────────────────────────────────────────────────┤
│ [+] /mjloop:fix …                                            [Run]  │  bar
└─────────────────────────────────────────────────────────────────────┘
```

Three layers. The **rail** is visible in every tab and carries what you must
never have to go looking for. The **tab region** is full width, so a table can
be a table. The **terminal** lives in its own pane with three modes —
collapsed, docked, fullscreen — and a **command bar** pinned below it.

The queue does not get a tab. It is a second view inside the terminal pane,
one click away, so it never competes with a plan for the same column.

## Non-goals

The previous design's non-goals stand, with one restated because this design
walks up to it.

- **Parallel runs.** `state.json` holds one run. The queue enforces sequence
  in code.
- **Remote access.** Localhost only. This process spawns `claude` with the
  user's credentials.
- **Replacing the CLI.** Still true, and now load-bearing rather than modest.
  The terminal remains the only thing that *executes*: every button that
  starts work composes a loop command and enqueues it, so there is one
  execution model and not a second, weaker one beside it. Exactly three engine
  writes are reachable from the browser (below), and each exists because no
  command can express it.
- **Editing `config.yaml` from the browser.** `writeConfig`
  (`config-store.ts:47-51`) serialises the whole parsed document back to YAML,
  dropping every comment and every key the schema stripped, and it takes no
  lock — unlike every state and plan write. Its only caller is `init`. The
  Config tab is read-only until that is fixed, and fixing it is not part of
  this work.

## The three writes

Everything else on the page either reads, or composes a command and enqueues
it. These three cannot be expressed as a command, and each is something a
person is stuck on today:

| Write | Op | Why a command cannot do it |
|---|---|---|
| Plan approval | `gateSet` | `gates.plan_approval` defaults to `human`; the build is refused until a person decides. Spawning a whole `claude` session to flip one frontmatter field is absurd. |
| Requeue a story | `storyUpdate`, `status` only | A run cancelled mid-story leaves it `doing`, which makes it invisible to `--next` forever (`commands/build.md:18-22`). The documented repair is a text editor. |
| Halt a run | `halt` | The existing Stop kills the pty and leaves `state.json` saying `running` with no `HALT.md`. That is not a halt. |

**`runStart`, `rosterSet`, `runLog` and `cycleAdvance` are forbidden from the
browser permanently.** `runLog` opens a gated track's gate from the payload's
evidence array alone (`ops/log.ts:149-158`) — a browser that could call it
could let a click "prove" a reproduction nobody ran. `runStart` wipes findings,
history, guard counters and the reproduction. `cycleAdvance` is the only writer
of terminal status. These four are how the loop *reports what it did*; a
browser that can write them can claim work nobody performed.

This path also bypasses the `PreToolUse` state guard entirely — it is the
server process, not a `claude` tool call — so the boundary has to be
structural, not a hook. Four independent layers enforce it; see
[Writes](#writes--one-door-conditional-inside-the-lock).

## The tabs

Every item below is grounded in something the engine already writes. Nothing
here needs a new engine concept.

### Rail (always visible)

Status, track, `cycle / max_cycles`, the active plan and story, `run_id`, and
findings counts. Two things that are new and matter most:

- **The halt-imminent meter.** `no_progress_count` out of
  `limits.no_progress_strikes` (`schemas/state.ts:63`, `schemas/config.ts:100`).
  Today a stagnation halt arrives without warning; this says it is coming.
- **Gate state**, when the running track has one.

Above the rail sit the page-level banners, promoted out of the sidebar where
they currently whisper: `config_error`, a **stale-state** warning when
`summary.recovered` is true (the state came from `.bak`, so it describes the
write *before* the last one), connection loss, the stall notice, and
`{type:'notice'}` frames rendered as toasts.

Halt and Stop sit side by side here, labelled distinctly. Conflating them is
the obvious mistake.

### Run

What is happening now, without reading the terminal.

- **Live cycle progress.** `roster.selected` diffed against which
  `cycle-NN/<agent>.json` files exist ⇒ "builder ✓ · verifier ● · critic ○".
  This is the exact procedure `skills/mjloop-leader/SKILL.md:36-44` prescribes
  for resuming, and it is the *only* real intra-cycle progress signal:
  `StateSchema` permits stage `execute` and `judge`, but nothing in the engine
  ever sets them (`ops/run.ts:68-231`). The UI must not promise what the engine
  never writes.
- **Findings table** — severity, `file:line`, claim — replacing three integers.
- **Guards** — strikes used, this cycle's error signatures, with any matching
  `last_error_fingerprint` flagged as the one that will halt the run.
- **Gate panel** — `proven_by`, what it blocks, the reproducing command and its
  excerpt. `reproduction.ref` already crosses the wire and is drawn nowhere.
- **Cycle timeline** from `state.history[]` — cycle, agents, result, `ref`,
  each linking into Evidence.
- **Halt report** when the run halted: `HALT.md`'s reason, cause, the
  Cycle/Agents/Result table, open findings, and its cause-specific next step.

There is deliberately **no `max_cycles` control on the halt screen.** The
leader is explicitly forbidden from raising `max_cycles` to escape a halt
(`skills/mjloop-leader/SKILL.md:276-278`). The decision is the user's, but
putting the knob on the halt banner recreates exactly the reflex the rule
exists to prevent. It lives in Config, as a pre-run setting.

### Plans

- **What's ready next**, computed *on the page* from `status` and `depends_on`
  — the same rule as `index-render.ts:23-28`. `storyNext`'s `reason` is English
  prose composed in the engine; importing it would break the no-prose rule, so
  the page derives readiness from data it already has.
- **Per plan**: derived status (`planStatus`, a pure function over exactly the
  `StoryView[]` the snapshot holds), a done/total count, and the full approval
  record — `decision`, `by`, `at`, `note` — where today only `decision`
  survives `snapshot.ts:64`.
- **Approval control**: Approve / Request changes / Reject, with a note.
- **Plan reader**: `PLAN.md`'s body beside the plan-critic's `REVIEW.md`.
  Nothing in `engine/src` reads `REVIEW.md` at all today.
- **Per story**: status as a word rather than an 8px dot, dependency chips
  ("Waits on P001-S01" — the locale key already exists), and a build button
  that is disabled with its reason when dependencies are unmet.
- **Story detail**: acceptance criteria as a checklist and the evidence run
  directory linked into Evidence, plus a "done with no evidence" anomaly flag.
  Both fields live in story frontmatter and are deliberately absent from
  `ManifestEntry`, so this needs `listStories`, never `readPlan`.
- **Requeue** a story stuck in `doing` or `blocked`.
- **Create**: "New plan" and "New story" as forms that compose
  `/mjloop:plan …` and enqueue it. Structured fields, one execution path.

### Evidence

- **Run list** with outcomes — run id, story or adhoc, track, cycles used,
  halted or done — instead of `snapshot.runs`'s bare directory names.
- **Per cycle**: the roster, meaning agents drafted *and agents skipped with
  the leader's stated reason*. Those reasons are recoverable from nowhere else.
- **Per agent**: status, summary, evidence cards (kind, ref, excerpt),
  `files_touched`, `next_hint`. Parsed with the engine's own
  `AgentResultSchema`; a file that fails to parse is skipped, not fatal — the
  rule `snapshot.ts:41-47` already applies to an unreadable plan.

### Memory

Browse by kind, title, tags, time and originating run, with client-side
facets — `memorySearch` supports none of those filters, so faceting cannot be
pushed to the server. Search shows the relevance score and the 300-character
excerpt, with a reader for the full entry.

Writing a memory is **out of scope**: it would be a fourth write, and
`writeMemory` uses flag `wx` with no update and no delete anywhere, so a UI
that looked editable would be lying.

### Config (read-only)

Every track's `required` / `available` / `max_cycles` / `gate`; `limits`; the
specialist matrix; both gates; and the three verify commands with a callout for
any that is unset — each is injected verbatim into every agent brief
(`skills/mjloop-contract/SKILL.md:22`) and a missing one is a `blocked` the
engine is forbidden to invent around. The design system renders if present, or
offers `/mjloop:design-sync` if not.

Each value shows the `config.yaml` key that sets it, because the page will not
set it for you.

## Rendering — retained DOM

**Zero `innerHTML`.** Rows are cloned from `<template>` elements in
`index.html`; updating is property writes guarded by a comparison. A keyed
reconciler moves and removes; it never rebuilds. Focus, caret, scroll,
selection, open `<details>` and a working `aria-live` region all survive for
one reason: the node holding them is never replaced.

```
ui/dom.js      clone(id) → {root, slots}; text/attr/flag/cls/phrase/verbatim
ui/list.js     reconcile(host, items, keyOf, factory, limit = 200)
ui/bus.js      one delegated click + submit dispatcher over [data-act]
ui/render.js   one rAF-coalesced draw; hidden panels are skipped
```

Keys are server-assigned identity only — `job.id`, `${plan.id}/${story.id}`,
the run directory name, `${runId}/${cycle}/${agent}` — never an array index.
A list whose membership and order are unchanged performs zero DOM mutations.

Three rules make hand-written `update()` functions safe:

1. **No memoisation above the leaf.** A locale switch mutates no snapshot
   field, so any memo above the leaf silently repaints nothing and produces a
   half-translated page. That is the class of bug that survives six months in
   a project with no compiler watching. `phrase()` memoises at the node, keyed
   on `${key}\0${params}\0${localeEpoch}`.
2. **Conditionals choose the value, never whether to write.** `text(n, x ?? '')`,
   never `if (x) text(n, x)`. Every member of a class family is written every
   time, so a status transition cannot leave two status classes on a node.
3. **No renderer ever assigns to `.value`.** Every control the user types into
   is uncontrolled and written once at mount. The approval note, the memory
   search box and the launcher fields are immune to an 800ms tick by
   construction rather than by a focus check somebody forgets on the fortieth
   form.

`escape()` and every one of its call sites are deleted. The cockpit renders `PLAN.md`,
`HALT.md`, finding claims, agent summaries and memory bodies — all model- or
user-authored — and `verbatim()` becomes the single path for that text. The
XSS surface goes away by construction instead of by discipline.

**The terminal.** `ui/terminal.js` is the only module that touches `#terminal`.
xterm mounts once at boot and never sits inside a reconciled container. Pane
mode is `body.dataset.pane`; CSS does the rest, and `data-pane` must never set
`overflow: visible` — `.terminal { overflow: hidden }` exists to clip xterm's
measuring span parked at `left:-9999em`, which in an RTL document otherwise
gives the whole page a horizontal scrollbar. `addEventListener('resize', refit)`
is replaced by a `ResizeObserver` on `.terminal`: collapsing the pane or
switching tabs changes the terminal's box *without* firing a window resize, and
xterm then reports stale columns to the pty.

Long lists cap at 200 rows with an explicit "show more". Virtual scrolling is
rejected outright: a virtual scroller recycles nodes under the viewport, which
is precisely the node destruction this design exists to prevent.

## Transport — push the keys, pull the bytes

The rule, in one sentence: **the poller pushes only facts it has already parsed
from files it already opens; everything with a body is fetched.**

`Snapshot` keeps its wire shape and gains three fields:

```ts
guards:    { strikes, strikesAllowed, cycleErrors, errorArmed }
roster:    { cycle, selected: string[], landed: string[] } | null   // running only
revisions: { state, config, plans, runs, cycle, memory }
```

`guards` comes from a second `StateStore.read()` — `atomic.ts:55-59` says in so
many words that there is deliberately no repair write there, and a 2 KB read
twice per 800ms is free. It is read rather than added to `StateSummary` because
that type is the compact view for the leader brief and the SessionStart hook
(`summary.ts:60-63`) and widening it changes what every agent sees.

Both additions are paid for in cash: `manifest.json` is currently read **twice**
per plan per tick (`snapshot.ts:80` and `:110` each call `readManifest`), and
`readPlans` is skipped wholesale when `revisions.plans` has not moved. On an
idle project the poller becomes about eight stats and a readdir.

Everything else is a read-only, token-authed `GET` behind the same auth as the
page:

```
/api/state                              full State — findings, history, cycle_errors
/api/config                             { raw, parsed, error } — raw YAML, comments intact
/api/plans/:planId                      PLAN.md + REVIEW.md + approval + stories
/api/stories/:storyId                   acceptance, evidence, depends_on
/api/runs                               run list with outcomes
/api/runs/:runId                        HALT.md + cycle index
/api/runs/:runId/:cycle                 roster.json + findings.json + agent results
/api/memory  ?q=                        list or search
/api/memory/:id                         one entry
```

with `ETag` and `304`. The route table is matched **after** the token check and
**before** the static resolver, so no `/api` path can reach it. The id shape is
itself the traversal guard — `.` is outside `[\w-]`, so `..` cannot match — and
every resolved path is re-checked against the loop root anyway.

Each tab declares its dependency, and that is the entire subscription
mechanism:

```js
run:      s => `${s.revisions.state}:${s.revisions.cycle}`
plans:    s => s.revisions.plans
evidence: s => `${s.revisions.runs}:${s.revisions.cycle}`
memory:   s => `${s.revisions.memory}:${local.read().memoryQuery}`
config:   s => s.revisions.config
```

No server-side watch table: the open tab *is* the subscription, so there is
nothing to leak when a socket dies, no resubscribe on reconnect, and no
per-view tick budget somebody has to tune. A late answer for a tab the user has
left is dropped by a generation counter, mirroring the `jobId` guard on
`{type:'output'}`.

Two details that are deliberate and must be commented as such:

**`revisions.cycle` is always dirty while running.** It is the poller's own
tick counter, not a fingerprint, because the open cycle directory is the one
thing being actively written while someone watches, and mtime granularity
loses writes inside the same second. The consequence is explicit and intended:
while a run is live, an open Run or Evidence tab issues its conditional GETs
once per tick, and the `ETag` makes almost all of them a 304 with an empty
body over a loopback socket. That is the price of never showing a stale cycle,
and someone will otherwise "fix" this into a fingerprint.

**Directory fingerprints stat documents by name.** Overwriting `PLAN.md` in
place moves no directory's mtime, so `revisions.plans` folds each plan's
`PLAN.md`, `REVIEW.md` and `manifest.json` individually. Every `readdir` sorts,
because `JSON.stringify` follows insertion order and an unstable body flaps
the `ETag`.

**Why a revision field is necessary at all:** `ops/log.ts:175` only calls
`store.update` when an agent result carries findings, a gate proof or error
signatures. A clean-pass agent writes `cycle-NN/<agent>.json` and never touches
`state.json`. Without a revision, the Evidence tab would sit there confidently
showing nothing.

**Errors carry no prose.** The catch branch sends `{ error: { code } }` with no
`params` at all — a `params` hole is exactly how a sentence gets smuggled past
the rule. `error.message` never crosses the wire; a diagnosis goes to the
terminal the server was launched from. `Message.code` becomes a closed
`WebCode` union exported from `src/web/codes.ts`, so an untranslated code is a
compile error rather than a raw identifier on screen. The one existing leak
gets fixed on the way past: `"Config error: {error}"` becomes `"Config error"`
and the YAML text renders as a sibling `verbatim()` node.

## Writes — one door, conditional, inside the lock

Every write carries `from` (what was on record when the button was pressed) and
`to`. The precondition is evaluated **inside the lock the op already takes**,
so there is no read-then-write window anywhere in the web layer.

```ts
{ kind: 'gate',         plan, from: decision | null, to: decision, note }
{ kind: 'story.status', story, from: status, to: status }
{ kind: 'halt',         run, reason }
```

Ids are validated by the engine's own `PlanIdSchema` / `StoryIdSchema`, not
retyped. `schemas/plan.ts:6-10` records that these were constrained after a
review found a story id could steer a write outside `.mjloop`; reusing them
means the wire validation *is* that defence.

This answers four questions at once:

- An 800ms-stale page can be trusted, because a stale click is **refused**
  rather than obeyed.
- A `claude` session writing to the same `.mjloop/` needs **no** second "is a
  job running" interlock. `session.jobId` is a fact about a pty, not about the
  lock: a session holds no lock ~99% of the time, and an orphaned agent can
  hold the lock with no session at all. Two sources of truth that disagree is
  worse than one. `.mjloop/.lock` already serialises; CAS catches the one thing
  a lock cannot see, a lost update across two separately-locked writes.
- The UI needs no optimistic render and no rollback: a write that returns `ok`
  has already landed, and the snapshot broadcast goes out *before* the receipt.
- Confirmation dialogs disappear from everything reversible.

Three additive engine changes, each a **trailing `options` parameter**, never a
field inside the patch:

```ts
gateSet(dir, input, now?, { expect?: ApprovalDecision | null })
storyUpdate(dir, storyId, patch, now?, { expectStatus?: StoryStatus })
halt(dir, reason, now?, { expectRun?: string })
```

The trailing-parameter shape is the point. `StoryFrontmatterSchema` is strict
and `ops/plan.ts:283` does `{...current.frontmatter, ...patch}`, so an
expectation carried inside `StoryPatch` fails validation blaming a field the
caller never sent. All 32 `storyUpdate` references, 23 `gateSet` references and every `halt` call
site across `src/` and `tests/` pass `clock` positionally fourth at most, and
nothing anywhere passes a fifth argument — so this costs zero churn and the MCP
path stays bit-for-bit identical.

A new `StalePreconditionError` carries subject, id and actual value, and each
check sits beside the guard the op already has, inside the lock it already
takes. A precondition that throws after writing would be worse than none, so a
test asserts the file is byte-identical after every refusal.

`by` is computed by the server as `dashboard:<username>` and never sent by the
browser. `schemas/plan.ts:29` already says the engine cannot verify who made a
decision and that pretending otherwise would be worse; a `by` the page could
type would be a forgeable audit record.

**`note` and `reason` are free text and that is not a violation.** The no-prose
rule constrains *server-authored* prose. These are the user's own words
travelling into a project file — the same category as `job.command` and
`state.goal`, which the snapshot already carries. Nothing the server *says*
about a write is ever prose.

**Halt is authoritative on state and best-effort on the session.** It writes
`HALT.md` first; if that throws, the pty is untouched and nothing happened.
Only on success does the queue type `/exit\r`.

Confirmation and undo follow one rule rather than a case list: no dialog on
anything whose inverse is itself a permitted write. `story.status` gets an Undo
in its toast — safe precisely because it is conditional, so an undo arriving
after the leader moved on is refused rather than clobbering. `halt` gets a
native `<dialog>` whose required field *is* the reason. `gate` gets neither;
instead the plan panel renders the full approval record, so the state is
legible and changing it is just another write.

Four layers make widening this impossible by accident:

1. **Compile.** `HANDLERS` is `{ [K in Write['kind']]: … }` — a new kind does
   not compile until it is handled, and a handler with no kind does not compile
   either.
2. **Schema.** `strictObject` throughout, so an undeclared wire field is
   rejected before `applyWrite` is reached.
3. **An import allowlist**, per file under `src/web/`, asserted from source
   text. `writes.ts` may import exactly the three ops and their error classes;
   `server.ts` may import none.
4. **A `FORBIDDEN` list** — `runStart`, `rosterSet`, `runLog`, `cycleAdvance`,
   `planCreate`, `storyAdd`, `memoryAdd`, `initLoop`, `renderIndex`,
   `renderManifest`, `writeConfig`, `StateStore`, `writeJsonAtomic` — asserted
   to appear nowhere under `src/web/`, each with the reason written beside it.

`JobQueue` gains nothing. `queue.stop()` is called from `server.ts`. Any diff
to `queue.ts` is a signal the design has gone wrong.

## Modules and i18n

```
public/
  index.html          shell + one <template> per repeatable row (~420 lines)
  app.js              BOOT ONLY, ~70 lines
  app.css             invariants: reset, tokens, [hidden], the .terminal pin, the grid
  css/                10-layout 20-rail 30-tabs 40-terminal 50-controls 60-panels
  lib/                i18n keys fmt router local api        ← DOM-free, node-testable
  net/socket.js       connect, reconnect, demux
  ui/                 dom list bus render tabs toasts terminal dialog rail
  panels/             run plans evidence memory config queue launcher
  locales/            en.json ar.json — one flat file per language, permanently
  vendor/             xterm.js xterm.css addon-fit.js
```

Layer rule: `lib/` imports nothing from `ui/` or `net/`; `ui/` imports nothing
from `panels/`. Only `app.js` and `ui/terminal.js` touch `document` at module
scope, which is what makes every panel and every `lib/` module importable under
the existing vitest `environment: 'node'` with no new dependency.

`app.js` keeps its `const LOCALES = {` block **byte-identical**, with a comment
saying why: `locales.test.ts:54-60` reads it as source text and expects
two-space keys and a closing brace at column 0. The registry is injected
downward via `installLocales(LOCALES, FALLBACK, io)` rather than exported, so
`lib/i18n.js` never imports `app.js` and there is no cycle around the top-level
`await`. A new assertion that `app.js` contains `installLocales(LOCALES` closes
the dead-literal loophole the current grep cannot see.

Three translation entry points: `t()` returns a string and is for attributes
only; `tx()` returns a `DocumentFragment` with every `{param}` wrapped in
`<bdi>` and is what renderers use for content; `tn()` resolves plurals against
each language's own `Intl.PluralRules` categories — `one`/`other` for English,
`zero`/`one`/`two`/`few`/`many`/`other` for Arabic.

**Digits.** `Intl.NumberFormat('ar')` renders Arabic-Indic digits, so ids,
paths, commands, cycle numbers and run ids go through `verbatim()`. `P001-S02`
must not become `P٠٠١-S٠٢`. Number formatting is for prose counts only.

Around 200 keys stay reviewable through four enforced conventions: a namespace
whitelist; **ordered** parity (`toEqual(Object.keys(en))`, strictly stronger
than today's sorted comparison, and it makes a diff of the two files
line-aligned so translators overwrite values in place); plural stems compared
against each language's own category set; and a codified bidi rule — after
stripping `{param}` holes, any value mixing an Arabic run with a Latin run of
two or more letters must carry a direction mark. Hole-stripping is what makes
that rule non-brittle: it correctly exempts `"{cycle} من {max}"`. Today's
`ar.json` passes with its 17 marks, and the test pins the intent rather than
the number.

Families whose values the engine owns — `status.*`, `stage.*`,
`findings.severity.*`, `cycle.result.*`, `story.status.*`, `plans.approval.*` —
are asserted exhaustive against the engine's own schema `.options`. Families
whose values come from the user's config — agent names, track names — fall back
to a readable identifier, which is what `t()`'s `?? key` already does.

**Type checking the page.** A `tsconfig.web.json` with `allowJs` + `checkJs` +
`NodeNext` checks the browser JavaScript against `protocol.ts`'s real types
through JSDoc comments. This was verified against a probe: `s.state.trackk`
produced exactly one error, `TS2551`, suggesting `track`. It emits nothing and
changes nothing at runtime, and it must be wired into the existing `typecheck`
script — a separate script becomes decoration within two months. This is the
concrete answer to "someone edits this in six months with no build step".

**`verify-ship.mjs` stops carrying a fixed asset list.** It derives one:
`dist/web/public` must be a byte-for-byte mirror of `src/web/public` (the build
is a verbatim `fs.cp`, and `dist/` is git-tracked — 8 files under `web/public`
today), plus a required spine and a count floor so a bug in the walker cannot
make the suite vacuously pass, plus a BFS over the import graph from
`index.html`. With no bundler, a mistyped import specifier is a white screen.
The only hand-maintained list that survives is the three vendor filenames,
extracted so `build.mjs` and `verify-ship.mjs` share one definition.

No dynamic `import()` on this page, ever — it is the one thing that would
defeat the graph walk, and all panels mount at boot anyway.

## Testing

Following the existing suite: vitest, `makeTmpProject`, tests under
`engine/tests/web/`. `happy-dom` joins as a devDependency; the global
environment stays `node` and DOM files opt in per-file, so the six existing web
suites run exactly as today. The dependency never ships — `verify-ship.mjs`
copies `dist/` and `package.json` into a staging tree and never installs.

- **render** (happy-dom, loading the *real* `index.html` so tests consume
  shipped templates): identity survives a tick and a reorder; a changed key
  replaces the node; `text(node, 'x')` twice leaves `firstChild` the same object
  — selection preservation depends on exactly that; focus and caret offset
  survive three draws and the renderer never assigns `.value`; scrollTop
  survives a `hidden` flip; a status transition leaves exactly one status class;
  **a locale change repaints a byte-identical snapshot** — the test that forbids
  reintroducing a memo above the leaf; a hidden panel's `update` is not called;
  a throwing panel does not wedge the next frame.
- **list**: append, prepend, middle-remove, reverse, empty — plus a
  `MutationObserver` asserting zero records when the input is identical twice.
- **read**: hash every file under `.mjloop/`, call every reader with valid
  params including against a deliberately clobbered `PLAN.md`, re-hash, assert
  byte-identical. This is the non-destructive guarantee, tested the way
  `snapshot.test.ts` already tests it.
- **api**: for every error path, `Object.keys(error)` is exactly `['code']` — a
  params hole cannot appear without failing. Traversal table; `POST` → 405; a
  conditional-GET round trip asserting the 304 body is empty.
- **snapshot**: revisions are byte-identical across two calls with nothing
  touched (a flapping revision silently turns the poller into a 1.25 Hz
  broadcaster); **the clean-pass hole** — write a passing agent result carrying
  no findings and assert `revisions.cycle` moved while `state.updated_at` did
  not; `gateSet` moves `revisions.plans` despite the in-place overwrite no
  directory mtime would catch.
- **writes**: each write lands and is visible through `buildSnapshot` on the
  next read; each stale variant returns `write.stale.*`; a refused write leaves
  the whole `.mjloop` tree byte-identical; two rapid writes receipt in send
  order; and for every failure path, every `params` value matches
  `/^[\w:.@/-]+$/` — which is what stops someone forwarding `error.message`
  into a param the day a code feels too vague.
- **server**: a `{type:'write'}` with `plan: '../../etc'` is dropped with no
  reply of any kind, proving the id schema is doing filesystem duty on the wire;
  a fired `cycleAdvance` / `runLog` / `runStart` frame leaves `state.json`,
  `PLAN.md` and `manifest.json` byte-identical and receives no reply.
- **discipline** (source text, node, no new deps): no `innerHTML`, `outerHTML`,
  `insertAdjacentHTML` or `document.write` anywhere under `public/`; every
  `clone('tpl-x')` has a matching `<template>` and vice versa; every `data-act`
  has a registered action; every import specifier resolves to a file that
  exists; no dynamic imports; the import closure equals the file set, so there
  are no orphans; every shipped extension is a key of the MIME map parsed out
  of `server.ts`; the `.terminal` `direction: ltr` and `overflow: hidden` pins
  and the `[hidden]` rule are still present; and an RTL lint over `css/`
  forbidding physical properties unless annotated — today's `app.css` has
  exactly one in 365 lines, so this passes with a single annotation and holds
  the line at 1500.
- **locales**: everything today's suite pins, plus the namespace whitelist,
  ordered parity, plural categories, the bidi rule, schema-derived family
  exhaustiveness, every `t()` key existing in `en.json`, and the inverse dead
  key sweep. That sweep run against today's tree already finds six dead keys,
  so it pays for itself before it is written. The server-code grep is replaced
  by importing `WEB_CODES` and asserting every entry has an `en.json` key.
- **queue**: untouched, and that is a designed property.

## Milestones

Each is a separate implementation plan, listed in dependency order.

**M1 — the shell.** No new data. `lib/`, `ui/`, `net/`, the rail, five tabs
(four with honest empty states), the terminal pane, the queue and launcher
moved across, the CSS split, the page typecheck, the derived `verify-ship`, and
the discipline tests. It ships one visible win by itself: everything the server
already sends finally gets drawn — notices as toasts, the stale-state banner,
`last_cycle`, `run_id`, dependency chips, story status as a word, job
durations, and the six dead locale keys brought to life.

**M2 — transport.** `codes.ts`, `revision.ts`, `api.ts`, `read.ts`,
`lib/api.js`, and the snapshot's `guards` / `roster` / `revisions`. Needs M1.

**M3 — the three writes.** `precondition.ts`, the three trailing-`options`
engine edits, `writes.ts`, the halt dialog, toasts and undo. Needs M1 only, so
it can be built beside M2 rather than after it.

**M4 — the Run tab.** Findings, guards, live roster, gate, timeline, halt
report. Needs M2.

**M5 — the Plans tab.** Detail, approval, acceptance, ready-next, requeue,
creation forms. Needs M2 and M3.

**M6 — Evidence, Memory, Config.** Needs M2.

## Risks

- **Surface area.** `index.html` goes from 70 to ~420 lines and `app.js` becomes
  31 files, in a project whose thesis is that it ships what is in git and runs
  with no install step. The mitigation is that every new file passes an import
  graph walk and a typecheck; the alternative — a vendored framework — would be
  a permanent fourth entry in the build's vendor list and a dependency in a
  project that refuses dependencies. Stated plainly rather than buried.
- **`revisions` is mtime-based**, and mtime granularity can lose a write inside
  the same second. `revisions.cycle` closes this for the only data being
  actively written. Everything else gets a manual refresh control on every tab,
  which makes the worst outcome an inconvenience rather than a wrong decision.
- **The page has no regression net today** — nothing in `engine/tests` reads
  `index.html` or `app.css`. This design adds one, but the first milestone is
  written against a suite that does not yet exist. Build the discipline tests
  in M1 first, not last.
- **Accessibility starts at zero** and a tabbed page deepens it if ignored.
  Roles, labels, `aria-current`, a live region and a focus-trapped dialog are
  part of M1, not a later pass. Anchors in a `<nav>` rather than
  `role="tablist"`: these panels are URL-addressable, back and forward should
  move between them, and a tablist needs arrow-key handling that must honour
  text direction — a real RTL bug waiting to happen.
- **Empty states are the normal case.** `runs/`, `plans/` and `memory/` are all
  empty in a fresh project, `mjloop_init` creates no `INDEX.md` and no design
  system, and this repo gitignores `.mjloop/` so there is no committed example
  to design against. Every panel needs a real empty state, written first.

## As built

All six milestones ship. Five things came out differently, and each is here
because a reader of this design would otherwise be surprised by the code.

- **Tables are `role="table"` grids, not `<table>`.** `<tr>` at the root of a
  `<template>` is valid HTML and works in a browser, but happy-dom drops it —
  which would have left every row template in the four tables with no
  regression net, in the one part of the page that has never had one. A
  discipline test now forbids a table row at a template root.

- **`tx()` lives in `ui/dom.js`, not `lib/i18n.js`.** It produces DOM, and
  `lib/` is DOM-free so the plural and bidi rules stay node-testable. The
  segmentation it is built from — `parts()` — is the pure half and stays in
  `lib/i18n.js`. `phrase()` is the memoising node-level wrapper.

- **`verbatim()` wraps its value in a reused `<bdi>` child** rather than
  setting `dir="ltr"` on the node itself. `dir` on a container also sets that
  container's text alignment, so in Arabic every identifier jumped to the far
  left of its column.

- **M2 and M4 shipped together, as did M5 and M6.** The discipline suite
  forbids an unreachable module, so `lib/api.js` needed its first consumer in
  the same change that introduced it.

- **`StateStore` is not on the forbidden list; `store.update` is.** `guards`
  is read from a second `StateStore.read()`, exactly as this design specifies,
  and `atomic.ts:55-59` says in so many words that a read performs no repair
  write. What must never appear under `src/web/` is an *update*, and that is
  what the test asserts — along with `readPlan`, which repairs by rewriting.

Three bugs found by driving the real page rather than the tests, all of one
shape and worth naming: **a control that hides itself must not be the node its
own panel is registered against.** `render` skips hidden panels, so the queue
count and the halt button could never appear. `register()` now says so. The
third was the delegated bus firing a form's action on click *and* on submit,
which wrote HALT.md twice.
