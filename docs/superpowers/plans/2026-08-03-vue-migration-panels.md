# Vue Migration — Panels and Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the eight panels and the pane surface to Vue, then retire `src/web/public/` and switch the cockpit over.

**Architecture:** Each panel becomes one SFC under `src/web/app/panels/`, rendered by `App.vue` behind `v-if` + `<KeepAlive>`. Panels read the store's `Snapshot` and their own `lib/api.ts` feed; they never own transport. The old panel and its `describe` block in `tests/web/panels.test.ts` are the specification for each one.

**Tech Stack:** Vue 3 SFC + `<script setup>`, TypeScript, Vite, `vue-tsc`, Vitest + `@vue/test-utils` + happy-dom.

**Predecessor:** `docs/superpowers/plans/2026-08-03-vue-migration-foundation.md`, landed as `611119c..e06e51b` on `feat/vue-cockpit-foundation`. Read `docs/superpowers/plans/2026-08-03-vue-migration-carried-forward.md` before starting — it carries the decisions and known gaps this plan inherits.

## Global Constraints

- **`engine/src/web/*.ts` is never modified** — the server, `protocol.ts`, `api.ts`, `writes.ts`, `codes.ts`, `revision.ts`. If a task appears to need a server change, stop and escalate.
- **`engine/src/web/public/` is never modified, and is the specification.** The user must not see a change. It is deleted in Task 12 and not before; until then every task reads it and no task edits it.
- **No new locale key until Task 13.** `tests/web/locales.test.ts` guards `app/locales/*.json` byte-identical to `public/locales/*.json` while both exist. Reuse existing keys; if a string has no honest key, note it for Task 13 rather than inventing one.
- **Identifiers never go through `Intl`** — story ids, run ids, plan ids, tracks, agent names, paths, commands and cycle numbers render through `<Bdi>`. `Intl.NumberFormat('ar')` renders `P001-S02` as `P٠٠١-S٠٢`. Prose counts, conversely, go through `t(key, { n })` or `tn(stem, n)`.
- **Every panel must reproduce the old panel's markup contract.** Four defects on the foundation branch were markup that stopped matching what the stylesheet selects, and none was visible to a `.text()` assertion. Each panel task ends with structural assertions: the ids, classes and attributes `css/60-panels.css` and its siblings select, and their position in the tree.
- **`dist/` is committed** and `node scripts/verify-ship.mjs` rebuilds and byte-compares. Every task that changes shipped output runs `npm run build` and commits `dist/` with its source.
- **Writes go through `submit()` only.** No panel calls `send({type:'write'})` directly, and no panel renders optimistically — the snapshot broadcast precedes the receipt.
- Node >= 20. All commands run from `engine/`.

---

## The shape every panel task takes

Tasks 3-10 are the same task eight times over different subject matter. Rather than repeat it, it is written once here; each task below gives only what is specific to it. **An implementer works from its own task plus this section.**

**Specification.** Three artefacts, in this order of authority:
1. `src/web/public/panels/<name>.js` — the behaviour.
2. The `describe('<name>', …)` block in `tests/web/panels.test.ts` — read it as a requirements list *before* writing the replacement, not after. This is the mitigation the spec named for the single-shot switch: it turns 3,744 lines of test code from something thrown away into a specification carried across.
3. The panel's markup in `src/web/public/index.html`, including its `<template>` rows, and the rules that select it in `src/web/public/css/60-panels.css`.

**Deliverables.**
- `src/web/app/panels/<Name>.vue`, plus one child SFC per repeated row that had its own `<template>` in the old markup.
- Any panel-only derivation as a composable under `src/web/app/composables/`, only when it is genuinely reusable or genuinely needs testing without a DOM. Derivations that already exist in `app/lib/` are imported, never re-implemented.
- `tests/web/panel-<name>.test.ts`, carrying every behaviour the old `describe` block asserted, plus the structural assertions above.
- `App.vue` renders it behind `v-if="active === '<id>'"` inside `<KeepAlive>`.

**Steps.** Each task runs the same cycle:
1. Read the three specification artefacts and list, in the report, every behaviour the old panel has.
2. Write the failing tests from that list.
3. Run them; watch them fail for the right reason.
4. Implement the SFC.
5. Run the panel's tests, then `npx vitest run`, then the full `npm run typecheck`.
6. `npm run build`, `node scripts/verify-ship.mjs`, confirm `git status` is clean.
7. Commit source and `dist/` together.

**Definition of done for a panel:** every behaviour in the list from step 1 is either covered by a passing test or named in the report as deliberately deferred with a reason.

---

### Task 1: Narrow the web program's types

The foundation added `"node"` to `tsconfig.web.json`'s `types` because `app/lib` imports `protocol.js`, which drags `writes.ts`, `revision.ts` and `ops/summary.ts` into the web program. Node globals are now resolvable throughout browser-only code, so nothing flags a component reaching for `process`. Eight panels will widen that; close it first.

**Files:**
- Modify: `engine/tsconfig.web.json`
- Create: `engine/src/web/app/types/protocol.ts` (if the barrel approach is taken)
- Test: `engine/tests/web/typeguard.test.ts`

**Interfaces:**
- Consumes: the type-only surface `app/` needs from `protocol.ts` — `Snapshot`, `StateSummary`, `PlanView`, `StoryView`, `Job`, `JobStatus`, `SessionView`, `GuardView`, `RosterView`, `Message`, `ServerMessage`, `ClientMessage`, `Revisions`, `Write`, `WebCode`.
- Produces: an `app/` tree that typechecks with `types: ["vite/client"]` and no Node typings.

- [ ] **Step 1: Establish which import pulls Node in**

Run `npx vue-tsc -p tsconfig.web.json --listFiles` and find which `app/` file first reaches `writes.ts` / `revision.ts` / `ops/summary.ts`. Record the chain in the report. Expect it to run through `import type { Snapshot } from '../../protocol.js'`.

- [ ] **Step 2: Write the guard test**

Create `engine/tests/web/typeguard.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * The web program must not carry Node typings.
 *
 * They were added when `app/lib` began importing `protocol.js`, which pulls the
 * server's own modules into the browser's compile. The cost is silent: with
 * `node` in `types`, a component that reaches for `process` or Node's
 * `setTimeout` overloads compiles clean and breaks in a browser.
 */
describe('the web program', () => {
  it('typechecks without node typings', () => {
    const out = execFileSync('npx', ['vue-tsc', '-p', 'tsconfig.web.json'], { encoding: 'utf8', stdio: 'pipe' })
    expect(out).toBe('')
  })
})
```

Then remove `"node"` from `tsconfig.web.json`'s `types` and run it. Expected: FAIL, with the `node:os` / `process` errors from the server files.

- [ ] **Step 3: Cut the dependency**

Preferred: a type-only barrel at `src/web/app/types/protocol.ts` that re-exports exactly the named types above with `export type { … } from '../../../protocol.js'`, and points every `app/` import at it. A type-only re-export is erased at compile time, so nothing is pulled into the bundle — but confirm `vue-tsc --listFiles` no longer lists `writes.ts` before believing it. If a barrel does not sever the graph, use a TypeScript project reference instead, and say in the report why.

Do not solve it by duplicating the type declarations. A second copy of `Snapshot` that drifts from `protocol.ts` is worse than the hole it closes.

- [ ] **Step 4: Verify and commit**

`npx vitest run tests/web/typeguard.test.ts` passes; `npm run typecheck` exit 0; `npx vitest run` whole suite green. `dist/` is unchanged by this task — confirm `git status` shows no `dist/` diff before committing.

```bash
git commit -m "refactor(web): keep node typings out of the browser program"
```

---

### Task 2: The pane surface

Everything the foundation deferred around the terminal: the pane head, the session/queue views, the queue list, the command launcher, the empty-terminal hint, and full-screen. The Run panel depends on none of it, but the reader's main control surface does.

**Files:**
- Create: `engine/src/web/app/components/Pane.vue`, `PaneHead.vue`, `QueueView.vue`, `QueueRow.vue`, `Launcher.vue`
- Modify: `engine/src/web/app/composables/usePane.ts` (add `toggleFull`), `engine/src/web/app/App.vue`
- Create: `engine/tests/web/pane-surface.test.ts`

**Specification:** `src/web/public/ui/pane.js`, `panels/queue.js` (186 lines, exports `split`, `mountQueue`), `panels/launcher.js` (77 lines, exports `suggestions`, `mountLauncher`), the pane markup in `src/web/public/index.html`, `css/40-terminal.css`, and the `describe('queue', …)` block at `tests/web/panels.test.ts:3108`.

**Interfaces:**
- Consumes: `usePane()`, `snapshot`, `activeJob`, `send`, `onOutput` from the store; `jobKey` from `lib/keys.ts`; `split` — port it to `app/lib/queue.ts` rather than into a component, because it is pure and already tested.
- Produces: `usePane()` gains `toggleFull(): void`; `Pane.vue` owns `.pane` and renders `Terminal.vue` inside `.pane-body`.

- [ ] **Step 1: Port `split` to `app/lib/queue.ts` with its existing tests**

It is pure and DOM-free, so it belongs beside the other `lib/` modules. Carry its tests from the `queue` describe block unchanged in meaning.

- [ ] **Step 2: List the behaviours, then write the failing tests**

From `pane.js` and the queue describe block. At minimum: the two view tabs switch between session and queue; enqueuing shows the queue view; `#terminal-empty` shows when no job is on screen and the `.terminal` is hidden; the command form composes and enqueues, then clears; `suggestions` fills the datalist; a queued job can be cancelled; attaching to a job reveals the pane and switches to the session view; full-screen toggles.

- [ ] **Step 3: Implement, keeping two rules from the foundation**

`Terminal.vue` moves *inside* `Pane.vue` unchanged — do not remount it, do not put a `v-if` above it, and do not let it be re-keyed. Its scrollback is the one thing the server cannot replay. And `bootPane()` must still run after the terminal has mounted; if `Pane.vue` changes the mount order, verify the terminal still opens into a laid-out box (the browser check in the carried-forward doc says what "laid out" looked like: `.xterm-screen` at 1440×240 with 16 rows, not 0×0).

- [ ] **Step 4: Structural assertions**

`.pane-head`, both `.view-tab`s, `#panel-queue`, the command form, `.pane > .hint`, `#terminal-empty`, and `.pane-body` — each present, each where `40-terminal.css` expects it.

- [ ] **Step 5: Verify and commit** — panel tests, whole suite, typecheck, build, verify-ship, `dist/` committed with source.

---

### Tasks 3-10: The eight panels

Each follows *The shape every panel task takes* above. Listed in dependency and risk order; do them in this order.

- [ ] **Task 3 — Run.** `panels/run.js` (687 lines), `describe('run')` at `panels.test.ts:1835`. The busiest read surface: live state, drafted-vs-landed roster, guards, findings, cycle history. Also carries the **halt dialog** (`ui/dialog.js`) and the **stalled banner with its nudge button**, both deferred from the foundation — the run id they act on lives here. Reuse `lib/stories.ts`'s `draftedAgents`.

- [ ] **Task 4 — Plans.** `panels/plans.js` (472 lines, exports `planRuns`, `planMemories`), `describe('plans')` at `panels.test.ts:194`. Owns the plan gate — approve / request changes / reject — which is a `submit()` with an inverse, so it is the first real user of the undo path the foundation built. Port `planRuns` and `planMemories` to `app/lib/plans.ts` with their tests; they are pure.

- [ ] **Task 5 — Stories.** `panels/stories.js` (1,098 lines), `describe('stories')` at `panels.test.ts:577`, plus `ui/worktabs.js` (145 lines). The story work-tabs — open, close, pin, reopen — persist through `lib/selection.ts`, which is already ported; use it rather than adding state. Requeue is a `submit()`. The dependency tree, readiness and filtering all come from `lib/stories.ts`.

- [ ] **Task 6 — Features.** `panels/features.js` (329 lines, exports `approvable`), `describe('features')` at `panels.test.ts:3258`. Approving a brief is **the one write on this page with no inverse** — the store refuses to touch an approved revision again — so it keeps its confirmation dialog. Everything else reversible must not gain one.

- [ ] **Task 7 — Skills.** `panels/skills.js` (495 lines, exports `shortDigest`, `joinAcceptances`), and four describe blocks: `skills` (3032), `skills library` (3436), `the skills a project has on disk` (3533), `searching for a skill from the cockpit` (3595). Search goes through `lib/api.ts`'s `get`, not the socket.

- [ ] **Task 8 — Evidence.** `panels/evidence.js` (424 lines), `describe('evidence')` at `panels.test.ts:1904`. Run directories and their artefacts, read through `lib/api.ts`'s `feed` — the revision-driven refetch is the point; do not poll.

- [ ] **Task 9 — Memory.** `panels/memory.js` (191 lines, exports `facet`, `memoryRow`), `describe('memory faceting')` at `panels.test.ts:1811`. The smallest panel. The query persists through `lib/local.ts`'s `memoryQuery`.

- [ ] **Task 10 — Config.** `panels/config.js` (1,838 lines, exports `mountConfig`, `collectConfigChanges`), `describe('config')` at `panels.test.ts:2023`. The largest and last. The structured `specialists:` and `tracks:` editors mutate a local draft and **the save button is the only thing that reaches the server** — keep that invariant explicit. Port `collectConfigChanges` to `app/lib/config.ts` with its tests. This panel also owns the **`config_error` banner** deferred from the foundation. Split the SFC by editor rather than shipping one 1,800-line component; a file that large is a file nobody reviews.

---

### Task 11: One door for notices

**Files:**
- Modify: `engine/src/web/app/stores/session.ts`, `App.vue`, `NoticeFeed.vue`, `components/Toasts.vue`
- Modify: `engine/tests/web/toasts-vue.test.ts`, `engine/tests/web/store.test.ts`

The foundation split them: write receipts become toasts and never reach the notice feed, while `notice.hint` promises write results in that panel. The old page routes both through one door on purpose — `ui/notifications.js:15`, "the ephemeral toast and the durable log can never disagree". Restore the single door, and make the unread badge count what the panel actually holds.

Also in this task: `aria-controls` on the tab anchors, now that the panels it references exist (`aria-controls="panel-<id>"`, with the matching `id` on each panel root).

- [ ] Write the failing tests first: a write receipt appears in both surfaces; the unread count matches the feed's unread rows; each tab anchor's `aria-controls` resolves to a real element id.
- [ ] Implement, verify, build, commit.

---

### Task 12: The switch

**Files:**
- Delete: `engine/src/web/public/` entirely
- Delete: `engine/tests/web/{render,list,bus}.test.ts`, and `engine/tests/web/panels.test.ts`
- Modify: `engine/tests/web/discipline.test.ts`, `engine/tests/web/locales.test.ts`, `engine/tests/web/helpers/page.ts`, `engine/src/web/page-globals.d.ts`, `engine/scripts/verify-ship.mjs`

This is the commit that makes the migration real. Nothing here is mechanical — read each item.

- [ ] **Step 1: Prove nothing is left behind.** Before deleting, diff the two trees' behaviour one last time: for every `data-act` in the old `index.html`, name the Vue handler that replaced it; for every `<template>`, name the component. Put the table in the report. Anything with no answer is a missed behaviour, and it stops this task.
- [ ] **Step 2: Retarget `discipline.test.ts`.** Keep and point at `app/**/*.vue`: accessibility (`aria-label` on every icon button), keyboard-before-pointer, RTL, the invariants a stylesheet edit could undo, and "the server can name everything it serves" — that last one matters more now, not less, because it is what catches an asset Vite emits with an extension `server.ts`'s MIME map does not know. Delete the three the compiler subsumes: "every `data-act` is registered", "no string-built DOM", "every `<template>` is cloned".
- [ ] **Step 3: Retarget `locales.test.ts`.** Its byte-identity guard between `app/locales` and `public/locales` goes with `public/`. Its key-coverage check must read the Vue templates instead of `index.html`, and its registry check must read `useI18n.ts` instead of `app.js`.
- [ ] **Step 4: `helpers/page.ts`'s `PUBLIC_DIR`** points into the deleted tree; repoint `readLocale` at `app/locales/`.
- [ ] **Step 5: Delete `page-globals.d.ts`** — `app/env.d.ts` already declares the xterm globals.
- [ ] **Step 6: `verify-ship.mjs`** — the locale staleness check compares `src/web/app/locales`, which is unchanged; confirm nothing else in it referenced `public/`.
- [ ] **Step 7: Verify hard.** Whole suite, typecheck, build, `verify-ship`, and **open the page in a browser** and walk all eight tabs. This is the one commit where a unit test genuinely cannot tell you the page still works.
- [ ] **Step 8: Commit** as a single commit with a message that says what was deleted and what now carries it.

---

### Task 13: What the switch unlocks

`public/locales/*.json` is gone, so `app/locales/*.json` is finally free to grow.

- [ ] **Add the keys the foundation had to borrow.** Chief among them: a write refused because the socket is down currently reuses `write.failed`, whose wording points at the server's terminal — wrong for an offline page. Give it its own key in both `en` and `ar`, with Arabic's plural categories where a count is involved.
- [ ] **`NoticeFeed`'s per-row `<time>`**, which `20-rail.css:326` selects and nothing provides.
- [ ] **Fix the two lying tests** named in the carried-forward doc: `toasts-vue.test.ts`'s "cancels the pending timer" asserts a length that is 0 either way, and `store.test.ts`'s online/offline case leaks a 1000ms timer — which is also why reconnection has no test. Add that test.
- [ ] **Put `tests/` in a tsconfig**, so `npm run typecheck` covers the test files.
- [ ] Verify, build, commit.

---

## Done when

- `npm run build && npm run typecheck && npx vitest run && node scripts/verify-ship.mjs` are all green.
- `engine/src/web/public/` does not exist.
- The cockpit runs from Vue, in both languages, with all eight tabs, verified in a browser.
- Every item in `docs/superpowers/plans/2026-08-03-vue-migration-carried-forward.md` is either done or re-recorded with a reason.
