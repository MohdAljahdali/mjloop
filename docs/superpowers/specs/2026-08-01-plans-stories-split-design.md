# Plans and Stories become two workspaces

**Date:** 2026-08-01
**Supersedes nothing.** Builds on `2026-08-01-cockpit-orchestration-views-design.md`, whose scope rules
this document treats as binding.

## The gap

`panels/plans.js` is 624 lines owning nine responsibilities: the plan list, the plan tally, the approval
gate, `PLAN.md` and `REVIEW.md`, the create form, the story list, the story filter, the ready block, and
the shared readiness derivations `app.js` and `panels/launcher.js` import from it. One tab is both the
place you manage a plan and the place you run its stories, and the two have different rhythms — a plan is
read occasionally and a story is watched while it runs.

Splitting the tab is the visible half. The half that decides whether the split is worth anything is that
several things the split wants to show **do not exist**:

| Wanted | Today |
|---|---|
| plan status, priority, tags, owner, version | `PlanFrontmatterSchema` is `{id, slug, title, created_at, approval}` |
| story runs, tasks, assigned agents, effort | `StoryFrontmatterSchema` adds `{status, ui, depends_on[], acceptance[], evidence}` and stops |
| an active plan | grep `activePlan|active_plan` over `engine/src` returns nothing |
| a plan activity timeline | `state.history[]` covers the current run and is reset by every `runStart` |
| a plan decision log | `ApprovalSchema` holds one decision, and `gateSet` overwrites it in place |
| terminal history after a restart | `JobQueue.transcripts` is an in-memory `Map`, 1 MB per job, 20 kept |
| an agent workflow | nothing associates an agent with a story; the engine knows no agent names |

So this is not a UI refactor with some plumbing behind it. It is three milestones, and the plan says so
rather than discovering it in the eleventh commit.

## Decisions

**1. Agent ordering becomes real engine data before any editor is drawn.** `ops/roster.ts` evaluates its
eight rules as `Set.has` membership and contains no ordering logic; the leader orders agents by *name*, in
prose (`skills/mjloop-leader/SKILL.md:124` — "`ui-designer` runs **before** `builder`"). A reorder control
over `config.tracks` arrays would persist a permutation nothing consumes — the "inert capability" defect
this project has already shipped once and written a test suite to prevent.

**2. Skill assignment in the cockpit is inspection only.** The orchestration-views design put activating a
skill and accepting a component map out of scope "and permanently", because both change what every later
run is told. `PROTECTED_DIRECTORIES` includes `skills`. The cockpit shows what an agent will use and links
to `mjloop-cli skills accept|disable|enable|remove`. No sixth write kind.

**3. Derive first; extend once, late, and calculated.** Plan evidence, plan memory, plan progress and the
activity timeline are client-side joins over routes that already answer. Exactly one schema extension
lands, in `B11`, after everything derivable has been derived. No plan status enum: `ops/index-render.ts:11`
states the reason — "a status kept alongside the stories it summarises is a status that can disagree with
them". No widened `StoryStatusSchema`: only `done` satisfies a dependency, so a `paused` story makes every
dependent permanently unready, and `listStories` *skips* a record it cannot parse rather than failing
loudly, so a new required field empties a panel over a full directory with no error anywhere.

**4. The first landing carries no new capability.** Milestone A splits the tab and changes nothing else.
`#plans` keeps working as the Plans workspace with updated help text — `routeFrom` swallows an unknown
fragment to the fallback, so a redirect would be silent, and a bookmark should land on a real screen.

### Settled design points

- **Readiness truth is the engine's.** `ops/plan.ts` computes its done-set inside one plan; the browser's
  `statusIndex(plans)` spans the project. Cross-plan dependencies cannot be written at all —
  `assertDependenciesResolve` is called with the current plan's stories and throws "which does not exist in
  this plan" — so the browser's wider index is defensive only, and must not mark a story Ready and tag it
  `next` when `/mjloop:build --next` would never pick it.
- **Selection precedence:** the hash wins on load and writes through to `Prefs`; `Prefs` is the fallback
  when the fragment carries no plan. `#stories/P001` is shareable. Open story tabs are session state.
- **Locale namespace:** `story` is on `locales.test.ts`'s whitelist; `stories` is not. Reuse `story.*`,
  `panel.stories.*`, `tabs.stories`.
- **Action names** are partitioned up front (`story-open`, `story-close`, `story-run`) and *moved*, not
  copied — `ui/bus.js` throws `duplicate action: <name>`.
- **Remaining = not done**, defined once in `lib/stories.js` and shared by the filter, the tally and the
  launcher datalist, so the three cannot disagree.
- **The persisted tab shape is `{id, pinned}[]` plus a bounded `recentlyClosed`** from the first commit
  that persists it. `lib/local.js`'s whitelist silently drops a key with no parse branch, so the shape is
  expensive to change later and fails quietly when it is wrong.
- **Every new control gets a `boot.test.ts` click-through** asserting the resulting frame on the mocked
  socket. `boot.test.ts` exists because cutting `bus.on('feature-confirm')` to a no-op left 145 tests green.

## Milestone A — the clean split

Seven commits. No schema change, no new write kind, no new interaction model. The app is fully working
after each one.

### A1 — `fix(web): escape the raw NUL separators, and guard the tree against new ones`

Three raw `0x00` bytes make three files invisible to text search, tool-dependently and silently:
`src/web/read.ts:192` (`.join(<NUL>)`, byte 8846) and `src/web/public/ui/dom.js:193` (two separators in
`phrase()`'s memo template literal, bytes 6726 and 6780), plus the committed mirror
`dist/web/public/ui/dom.js`. `dom.js` declares the entire rendering vocabulary and is imported by 14
modules, so it is the worst file in the cockpit to have unsearchable — every audit that greps for `clone`,
`phrase` or `translateStatic` gets a clean false negative.

Each raw byte becomes `\u0000` — not `\0`, which is a legacy-octal hazard the moment a digit lands beside
it, and which is not itself greppable. The joined values are unchanged, so `render.test.ts`'s `phrase()`
memoisation test and `read.test.ts`'s `componentFingerprint` test keep passing untouched.

`read.ts`'s bundle comes out byte-identical (`dist/web/cli.js` already holds the escaped form). `dom.js` is
copied verbatim, so `npm run build` moves exactly one dist file and it is committed in the same commit.

New: `tests/repo/source-bytes.test.ts` walks `engine/{src,scripts,tests}` for text extensions and fails on
any raw NUL, naming every offender with its byte offset and line. `dist/` is **excluded from the walk's
floor** — the floor exists so a broken walker cannot pass vacuously, and counting `dist` makes it red when
`dist` is merely absent mid-build. The negative control is part of the commit: injecting a NUL elsewhere
must fail this test.

### A2 — `refactor(web): one readiness rule, in lib, matching the engine's`

`FILTERS`, `unmet`, `statusIndex`, `planIndex`, `planStatus`, `ready`, `tally` and `sift` move from
`panels/plans.js` to a DOM-free `lib/stories.js`; `panels/plans.js`, `panels/launcher.js` and `app.js`
import from there. `statusIndex` is re-signed to take one plan's stories, which makes a missed call site a
`tsc` error rather than a behaviour change nobody notices.

Three comments are made false and all three are rewritten in this commit: `panels/plans.js:5-9`,
`app.js:102-108`, and `panels/plans.js:239` — "The statuses of the whole project, for the fetched detail's
dependency checks", sitting directly above the binding whose project-wide scope this commit deletes. The
moved `unmet` JSDoc is rewritten too: with a per-plan index the dominant case reaching that branch is a
cross-plan dependency on a story that *does* exist, not a typo.

The behavioural payload is near zero in practice, and the commit message says so honestly: only a project
with a hand-edited story file sees a pixel change. It is a structural enabler wearing a bug fix.

### A3 — `feat(web): remember the open plan and the story filter`

`Prefs` gains `activePlan`, `storyFilter`, `openStories` and `recentlyClosed`, each with its own parse
branch, and `lib/selection.js` holds the selection and lets modules subscribe.

Two corrections the first draft required:

- The `openStories` normaliser must type its parameter `unknown[]`, not lean on `Array.isArray` narrowing
  at the call site — the draft produced three `TS2339` errors under `tsconfig.web.json`, and typing the
  parameter `any[]` would compile while disabling every check the normaliser exists for.
- **A missing plan must not be forgotten.** A guard that write-throughs `null` when the current snapshot
  does not list the selected plan erases the reader's selection on any frame that happens not to list it —
  including the stale frame `ui/tabs.js`'s argument-less `draw()` replays on a hashchange. `snapshot.ts:110`
  already states the opposing rule: "One unreadable plan directory must not blank the whole panel." The
  detail hides for that frame; the selection survives.

`lib/selection.js` ships only the accessors this commit's consumers call. `openStories()` and
`recentlyClosed()` land with the commit that reads them — no guard in this repo can see an exported
function with zero callers.

### A4 — `feat(web): fingerprint each plan on its own and share its document`

`revisions.plans` is one joined string over every plan, so any story edit anywhere invalidates every feed
keyed on it — tolerable with one panel, multiplied by a Plans workspace, a Stories workspace and N open
tabs, against a transport whose 304 path is dead in the browser. It becomes per-plan keys, and
`lib/plandoc.js` owns one shared plan-document feed.

**The feed is pumped from an always-visible registration**, following `app.js:109-116` and
`ui/pane.js:87-92`. `ui/render.js` skips hidden panels, so a feed pumped from a panel's `update()` goes
stale whenever that panel is closed — which after the split is most of the time.

One guard evaporates unless this commit replaces it. `snapshot.test.ts`'s byte-identity assertion compares
`revisions` with `toEqual`, which is key-order-insensitive: once `plans` is a `Record`, an unstable key
order stops being caught, and `revision.ts:100` says exactly why that matters ("an unstable body flaps the
ETag"). Proven empirically — alternating the iteration order every call left that test green. The
assertion becomes a `JSON.stringify` comparison in the same commit.

Wire compatibility is a non-issue, for a reason worth recording: the auth token is minted per server start,
so a tab left open across a restart gets 401 on upgrade and retries forever. There is no mixed-version
window, here or in Milestone B.

### A5a — `refactor(web): pump the plan document from the navigation`

The lifecycle relocation, alone. A no-op for the user and the only change in this region with a silent
failure mode — it can freeze the screen — so it gets its own commit and its own bisect point. Its
regression test is written against today's markup.

### A5b — `refactor(web): the story vocabulary moves to its own namespace`

Mechanical and green on both sides: `build` → `story-run` and its siblings, and the `plans.*` → `story.*`
re-key across both locale files. It also adds the assertion that should already exist: the `plans.filter.*`
family is invisible to `locales.test.ts` in **both** directions — the key is composed as a template literal
and harvested as a prefix, so a leftover key is never reported dead and a missing key is never reported
missing. An exhaustiveness assertion lands here, following the `story.status.*` pattern.

### A5c — `feat(web): stories become a view of their own`

`#story-query`, `#story-filter`, `#plan-detail-stories`, `#plan-stories-empty` and `#plan-stories-more`
move out of `#plan-detail` into a new `#panel-stories`; `panels/stories.js` owns the list, the ready block
and the run handle. Plans keeps the plan list, the tally, the approval gate, `PLAN.md`/`REVIEW.md` and the
create form. The ready-count badge registers against an always-visible node so it stays correct while its
panel is closed.

Four things this commit must not ship silently:

- `#panel-stories`'s head wraps its heading and hint in a `<div>`, as all seven existing panels do —
  `.panel-head` is `justify-content: space-between`, so an unwrapped pair lands at opposite ends of one row.
- `#tab-stories` needs an `--icon` mask. `.tabs a::before` paints a 17×17 `currentcolor` box unconditionally,
  so without one it ships a solid square, which is what `#tab-features` and `#tab-skills` do today.
- The two cross-links need a style. There is no base `a {}` rule anywhere on the page; the only anchor
  selectors live under `.tabs`.
- `.plans-workspace[data-detail-open]`'s `0.75fr / 1.6fr` ratio is justified by a comment about story titles
  and acceptance criteria that the detail no longer holds. The ratio and the comment move together.

`statuses` and `first` stay mount-scope bindings, as they are in `plans.js` — the row factories close over
them, and `update()` runs before a new row is inserted.

Tests: the two hardcoded route arrays, the `.value=` allowlist (either an eighth entry or `setAttribute`),
`describe('plans')` split into plans and stories, `render.test.ts`'s pinned slot list, and a `boot.test.ts`
click-through asserting the run action's enqueue frame. Docs: `docs/usage.md`, `docs/usage.ar.md` and
`README.md` all describe the dashboard's plans and stories as one tab.

## Milestone B — the story workspace

A story becomes a thing you open, read, run and come back to.

| | | |
|---|---|---|
| B1 | Job↔story binding on the wire | `{type:'enqueue'}` gains `story`; `Job` gains it; the snapshot carries it. Today a story is found by parsing `/mjloop:build P001-S02` out of a free-form string a user can also type. |
| B2 | The worktab strip | Generic, id-agnostic: open, activate, close, pin, reopen-most-recently-closed, roving tabindex. The page's first keyboard interaction. |
| B3 | The details pane shell | |
| B4 | The story body, on both shapes at once | `readStoryDetail` returns an element of the array `readPlanDetail` already embeds; adding a body to one and not the other ships two shapes of one record. |
| B5 | Story Details: everything derivable today | |
| B6 | The story tab drives the one shared terminal | |
| B7 | Durable transcripts: writer, reader, retention | |
| B8 | Readiness inspector and command preview | |
| B9 | The dependency view | |
| B10 | Plans workspace surfaces, labelled as derived | |
| B11 | The one calculated schema extension | |
| B12 | A persistent notification surface, or an explicit deferral | |
| B13 | The narrow viewport | |

**B2 takes on a bug this project deliberately refused.** `ui/tabs.js`'s header records that `role="tablist"`
was rejected because arrow-key handling "has to honour text direction, which is a real RTL bug for no gain".
A dynamic tab strip needs it: `ArrowRight` means next under `dir=ltr` and previous under `dir=rtl`, read from
`documentElement.dir` rather than a hardcoded sign, and the Arabic case needs its own test because nothing
else on the page would catch it. Every worktab control is cloned from a `<template>` in `index.html`
carrying its literal `data-act` — `discipline.test.ts` harvests `data-act` from `index.html` only, so an
action assigned in JS makes its `bus.on` look unreachable.

**B7 is bounded by a standing guarantee.** `read.test.ts` hashes every file under `.mjloop/` before and
after every reader to prove the read side never writes, so the transcript writer lives in `JobQueue`, not
behind a lazy reader. Files land under `.mjloop/web/transcripts/`, a path no revision key stamps, so it adds
no poller cost. Retention is enforced on bytes, count *and* age — this is the only destructive operation the
server performs against `.mjloop/`. And job identity must be settled before it writes a byte: `JobQueue`'s
counter resets to 0 every boot, so yesterday's `j1.log` is the file today's first job opens.

**B11 names a trap so nobody springs it.** `ManifestSchema.schema` is a hard `z.literal(1)` and
`readManifest` returns `null` on any parse failure, which the snapshot turns into `PlanView.stories = []`.
Moving that literal blanks every plan in the cockpit while the CLI keeps working. Nothing in B11 needs it
moved.

## Milestone C — a real agent workflow

**It opens with an engine question, and the answer changes the UI.** Are `required`/`available`/`closing`
sets? The evidence says yes: `cycleRosterSet` evaluates all eight rules as `Set.has`, `permittedAgents`
unions the three arrays into one `Set` so `required` and `available` are indistinguishable at logging time,
and `TrackSchema.superRefine` builds its vocabularies as `Set`s. The only places array order is read at all
are two `?? []` defaults in the browser.

And the leader's two real orderings are both **cross-set** — `ui-designer` (available) → `builder`
(required), and `verifier` (required) → `ui-critic` (available). Neither is expressible as a position in any
one array. So ordering is a set of directed edges, not a permutation, and the editor is a small dependency
graph rather than a sortable list.

| | | |
|---|---|---|
| C1 | Ordering as data | `order: [{agent, after: [...]}]` on `TrackSchema`, defaulted `[]`, refused at parse when unsatisfiable: an edge naming an unknown agent, an edge touching a `closing` agent, a cycle, or an edge that inverts the track's own `gate`. Travels through `ConfigChangeSchema`'s existing `track` variant — no new write kind, no wire change. |
| C2 | Enforcement and emission | `runLog` refuses an out-of-order result as `GateClosedError` already refuses a blocked one; `roster_set` returns the topological waves; the leader's ordering prose moves into the default track as edges and the two agent names leave `SKILL.md`. |
| C3 | A dry-run seam | Validation splits from persistence and returns `{code, params}`, so the page can say a workflow is invalid before Run without re-implementing eight rules or rendering English prose from the server. |
| C4 | The edge editor, in the Config tab | Where `trackProblems()`, the `tpl-track-problem` renderer and the CAS conflict state machine already live. Stories links to it. |
| C5 | Keyboard first, pointer second | Plus a discipline rule making that permanent. |
| C6 | Change-impact preview | `config.patch` replaces the whole track subtree under a sha256 CAS over the entire file and discards YAML comments in it. |
| C7 | Per-agent skill inspection | Read-only, with pre-run warnings the data can support. |

**C2 states the only honest test.** Nothing in this repository dispatches an agent — the leader is a skill
and the engine is MCP tools. So the assertion lives at the two seams a dispatch is observable: `roster_set`
returns waves computed from the persisted order, and `run_log` refuses the second wave's result while the
first wave has no result file, then accepts it. A test that round-trips `order` through `config.yaml` proves
exactly the thing this milestone exists to stop shipping.

**C1's subtlety is the vacuous edge.** If `builder after ui-designer` hard-fails whenever `ui-designer` is
skipped, every non-UI cycle on the `build` track becomes uncomposable. If it is unconditionally vacuous, an
operator satisfies an edge by dropping its predecessor. The rule — an edge is vacuous when its predecessor
is not in `selected`, and `roster` already demands a stated reason for that omission — goes in the schema
comment, or the next reader fixes it in the wrong direction.

## What this does not do

A live terminal per story tab, or concurrent runs: `JobQueue.active` is a single slot because
`.mjloop/state.json` holds one run, and `queue.ts:57` argues the case. An SVG or canvas dependency graph:
`ui/dom.js` has no element factory and no SVG helper, `innerHTML` is banned, and an indented list satisfies
most of the need. A plan status enum, plan versions, plan duplication or plan export. Writing skill
assignment from the cockpit. Queue reordering — `pending` is a private array and no frame carries a move.
Widening the write receipt so a refusal can name its subject. The four stop modes: "after the current agent"
and "after the current task" are not control points in any layer, and the `claude` session accepts no such
instruction.

Three quarters of the queue requirement is already shipped and was simply never noticed: `cancel`, `stop`,
`resume` and `clear` are registered in `app.js` and work.
