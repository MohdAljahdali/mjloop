# Task 3: The Run panel — report

## Behaviour list, each with the test that covers it

All in `tests/web/panel-run.test.ts` unless noted.

1. Uninitialised project shows `run.uninitialised`, distinct from an idle one — *"says the project has no loop at all…"*.
2. Idle project shows `run.idle` (implicit in every idle-branch test; `#run-body` absent).
3. `run_id` and last cycle draw (ported from `panels.test.ts:1836`) — *"draws run_id and the last cycle…"*.
4. Preflight estimate with no comparable run (ported from `panels.test.ts:1861`) — *"estimates the run nobody has started yet…"*.
5. Preflight estimate with comparable runs, range vs. bare number, minutes row absent when untimed — *"reports comparable runs with a range…"*.
6. Track picker opens on `state.track` when the config still offers it, over config order — *"picks the track the state already ran…"*.
7. Findings table, one row per finding, severity class — *"draws the findings table…"*.
8. Gate: shut → `run.gateState.shut`, proven → `provenBy` with agent/cycle, ref and excerpt shown — *"says the gate is shut until a reproduction proves it…"*.
9. Gate: excerpt hidden when empty, ref/excerpt both absent when nothing proven — *"hides the excerpt when it is empty…"*.
10. Cycle timeline, one row per history entry, result class — *"draws the cycle timeline…"*.
11. `HALT.md` drawn verbatim, present only for a halted run — *"draws HALT.md verbatim…"* / *"does not draw the halt report block…"*.
12. Manifest: brief/profile/concurrency mode+reason/generated, selections with skills and reason, guidance details hidden when empty — *"says what routed this run…"*.
13. Manifest: "selected nothing" distinct from "no manifest" — *"says a manifest selected nothing…"*.
14. Roster: `landed-yes`/`landed-no` per drafted agent, from `snapshot.roster` (not re-derived) — *"marks a drafted agent landed…"*.
15. Guards: `n/m` strikes as an identifier, `armed-yes` on the one signature that would halt the run — *"shows the strikes as an n/m identifier…"*.
16. Halt button offered only while `status === 'running'` — *"opens on the halt button, and is not offered…"*.
17. Halt dialog: opens on the button, no optimistic send, submits `{kind:'halt', run, reason}` through `submit()`, closes — *"writes a halt for the run on screen…"*.
18. Halt dialog: empty reason and Cancel both send nothing — *"sends nothing for an empty reason…"*.
19. Stalled banner (`Banners.vue`): silent when not stalled, names the time and nudges via `send({type:'nudge'})` (no run id — see report body below) — *"is silent while the session is not stalled"* / *"names when the session went quiet…"*.
20. Structural: `#run-body.panel-grid` with a genuine `.panel-side` aside (not a per-panel id) — *"gives the aside its own grid track…"*.
21. Structural: findings/cycles grids carry `role=table/row/rowgroup` so `.grid-head,.grid-body,.grid-row{display:contents}` reaches them, and sit inside `.scroller` — *"marks the findings and cycle grids…"*.
22. Structural: halt report and gate excerpt both carry `.excerpt` — *"gives a halt report and a gate excerpt…"*.

**Deferred, deliberately:** nothing behavioural. `#run-strikes`'s status as an ID selector in `60-panels.css:1387` is the one ID-keyed rule in the file for this panel and is preserved as an id on `<p id="run-strikes">`; every other structural rule the sheet keys on for this panel is class-based and is asserted in the "structure" describe block.

## Locale keys, and where each was found

Every key used already exists in `src/web/app/locales/en.json` — none invented:
`panel.run.title/help`, `run.uninitialised/idle/goal/story/plan/runId/findings/findingsCounts/gate/gateState.{open,shut,provenBy}/halted/lastCycle/roster/guards/findingsTitle/finding.{severity,where,claim}/gatePanel/timeline/cycle.{number,agents,result,ref}/haltReport` (all found grepping `en.json` lines 174–200); `preflight.*` (202–218); `manifest.*` (140–149); `status.*`, `stage.*`, `cycle.result.*`, `findings.severity.*` (151–172); `halt.title/explain/reason/cancel/confirm` (593–597); `session.stalled/nudge/stalledHint` (586–588); `controls.halt/stop` (590–591).

## What `60-panels.css` selects, and how it's satisfied

- `#run-strikes` (id selector) → kept as an id on the strikes `<p>`.
- `.panel-grid` / `.panel-grid:has(.panel-side)` / `.panel-side` / `.panel-side .block` → `#run-body` carries `panel-grid`, the `<aside>` carries `panel-side`, both sections inside it carry `block`.
- `.grid-findings` / `.grid-cycles` / `.grid` + `.grid-head/.grid-body/.grid-row{display:contents}` → the two grids carry those exact classes and `role=table/row/rowgroup`; each sits inside a `.scroller`.
- `.chip.landed-yes/-no`, `.chip.armed-yes/-no` → `RosterAgentChip.vue`/`CycleErrorChip.vue` toggle one class of the pair, mirroring `cls()`'s one-class-per-family guarantee.
- `.sev-high/-medium/-low`, `.res-pass/-fail/-blocked` → `FindingRow.vue`/`CycleRow.vue`.
- `.excerpt` → the halt report `<pre>` and the gate excerpt `<pre>`.
- `.picker`, `.facts`/`.fact`, `.chips`/`.chip` → unchanged generic classes, applied the same way the old markup did.

## Deferred elsewhere, with reason

- The rail's own `data-rail="halt"` trigger and `data-rail="stop"` button from the old page live in `.rail` (every tab), not inside a panel. `Rail.vue` (foundation, task 2) ships neither; `Stop` was already added to `PaneHead.vue`. Since my brief scoped only the halt **dialog** and the stalled banner/nudge to this task, and the run id the halt dialog needs is `Run.vue`'s own `summary.run_id`, I placed the halt trigger button inside `Run.vue`'s own `panel-head` (shown only while `status === 'running'`) rather than reaching into `Rail.vue`. If a later task wants it visible from every tab, that is a `Rail.vue` change outside this one's scope — flagging it here rather than silently deciding it.
- `lib/stories.ts`'s `draftedAgents` was not used: the Run panel's roster comes wholesale from `snapshot.roster.selected`/`.landed`, the engine's own per-cycle record — `draftedAgents` (a track's configured required/available set) answers a different question (what a track *could* draft before a cycle exists) and nothing in `run.js` or the old test ever combines the two. Noted in `Run.vue`'s own comment above `roster`.

## Commands run

- `npx vitest run tests/web/panel-run.test.ts` — 23 passed.
- `npx vitest run` — 89 files / 2124 tests passed, one run, no retry needed.
- `npm run typecheck` — exit 0 (`tsc -p tsconfig.json`, `tsc -b tsconfig.protocol.json`, `vue-tsc -p tsconfig.web.json`).
- `npm run build` — exit 0.
- `node scripts/verify-ship.mjs` — all checks `ok`, "The shipped tree runs with nothing installed."
- `git status` — clean after the commit below.

## Fix round 1

**Ruling 1 (halt placement) accepted — moved.** `Rail.vue` now carries both the halt button (`v-if="state.status === 'running'"`) and Stop (`v-if="session.jobId !== null"`, `:disabled="session.closing"`), after `<NoticeFeed />`, matching `index.html:83-84`'s order. `#pane-stop` in `PaneHead.vue` is untouched — it is a second, separate control, same as the old page. `HaltDialog` moved to `App.vue`, a sibling of `<main>` and outside its `<KeepAlive>`; a new module-singleton composable, `useHalt.ts` (same shape as `useTabs.ts`'s `active` ref), is the door between the button and the dialog since they are no longer in the same component subtree. `Run.vue`'s panel head lost the button and its own `haltOpen` ref entirely.

**Ruling 2 (`draftedAgents`) — no change, confirmed correct.**

**Regression test added for the KeepAlive defect** (Important 2): `tests/web/shell.test.ts`, `describe('App')`, *"keeps the halt dialog usable across a tab switch…"* — mounts the whole `App`, opens the dialog, switches to `#plans` (confirms `#panel-run` actually leaves the DOM — real deactivation, not a no-op), switches back, and confirms the dialog is still `.open` and a submitted reason still reaches `send()`. Placed in `shell.test.ts` rather than `panel-run.test.ts` because it exercises `App.vue`, not `Run.vue`. That describe block's `beforeEach` now also stubs `fetch`, since mounting `App` pulls in `Run.vue`'s feeds and two pre-existing `App` tests were until now issuing real network calls to a server that isn't running (harmless, but they were leaving an `ECONNREFUSED` `AggregateError` in every run's output — silenced as a side effect of this fix, not something I introduced).

**Important 3 (focus) — done.** `HaltDialog.vue` calls `reasonInput.value?.focus()` right after `showModal()`. Test: `panel-run.test.ts`, *"focuses the reason field on open, for a keyboard user"*.

**Important 4 (`.panel` on `<main>`) — done, and it is Task 2's regression, confirmed.** `class="panel"` moved off `<main>` in `App.vue` (which is now unclassed — only the `overflow-y:auto` scroller) and onto `Run.vue`'s own `#panel-run` section, matching `index.html:136`. Each future panel component will need to carry the class on its own root the same way; left a comment on `<main>` saying so.

**Minors — all done.**
- `#panel-run` restored `class="panel"`, `aria-labelledby="panel-run-title"`; its `<h1>` restored `id="panel-run-title"`.
- `#preflight-track` restored `name="track"` and an `aria-label` (bound via `:aria-label="t('preflight.track')"` — the Vue-native equivalent of the old page's `data-i18n-label`, since nothing here reads `data-i18n-*` attributes).
- The other dropped `#run-*` ids (on facts and blocks not named above) are left out: nothing in `60-panels.css` or `discipline.test.ts` selects them, confirmed by grep before this round and again now.
- `run-gate-ref`: the `<p>` now always renders; only the `<code id="run-gate-ref">` inside it is conditional, matching `run.js:469` (`flag(gateRef, …)` hides the code element itself, not its wrapper).
- `types/protocol.ts`: dropped the unused `State`, `Reproduction`, `Track` re-exports (confirmed by grep — nothing under `src/web/app` imported any of the three). `Run.vue`'s `stateFeed` now types itself `useFeed<StateView>` instead of restating `{ state: State }`.
- Added the preflight-track-change → refetch test: `panel-run.test.ts`, *"refetches the estimate when a person picks a different track (run.js:119-122)"* — changes `#preflight-track`'s value from `build` to `edit` and asserts `#preflight-facts` redraws against the second track's own preflight response.

**Worth knowing, not a defect (as flagged):** under `<KeepAlive>` a deactivated `Run` panel's feeds keep updating on every broadcast — `useFeed`'s `watchEffect` watches the store's `snapshot` ref directly, which has no notion of "this component is currently hidden." The old page's `register()`/`draw()` skipped a hidden panel's `update()` entirely. Traded deliberately for now (a feed watcher gated on visibility would also need to catch back up the moment the tab reopens, which is a second thing to get right), but it means a cached, invisible Run panel is still issuing conditional GETs and holding reactive state in memory for as long as the app is open. Left for whoever revisits panel memory/network cost across all eight panels, since it is a `<KeepAlive>`-wide question and not particular to Run.

Commands re-run after the fix: `npx vitest run tests/web/panel-run.test.ts` — 25 passed. `npx vitest run tests/web/shell.test.ts` — 17 passed. `npx vitest run` — 89 files / 2127 tests passed, one run, no retry needed, no unhandled-rejection noise. `npm run typecheck` — exit 0. `npm run build` — exit 0. `node scripts/verify-ship.mjs` — all `ok`. `git status` — clean after the commit.

## Fix round 2

**Important (late run-id read) — fixed.** `HaltDialog.vue` now has a `subject` ref, written from `props.runId` only inside the `isOpen` branch of the `watch(() => props.open, …)` — `dialog.js:27`'s own `subject`, and the same moment `app.js:256`'s `haltDialog.open(currentRun)` captures it. `confirm()` reads `subject.value`, never `props.runId`, and clears nothing on close (the next open overwrites it, same as the old page never resetting `subject` to `null` either).

Three tests added to `panel-run.test.ts`'s halt describe block, each driving the *live* prop away from what it was at open time via `wrapper.setProps({ runId: … })` while the dialog stays open — the retargeted round-1 tests all held `runId` static, which is exactly why this shipped uncaught:
- *"halts the run that was on screen when the dialog opened, not whatever run is current when it is confirmed"* — opens with `run-A`, moves the prop to `run-B` mid-dialog, confirms, asserts the write still names `run-A`.
- *"still halts the run captured at open, even if the live run id had gone null by the time the dialog is confirmed"* — opens with `run-A`, moves the prop to `null` mid-dialog, confirms, asserts the write still names `run-A` rather than silently sending nothing (the worst of the three outcomes the live-read version could produce, since a reader who just pressed "Halt the run" would otherwise believe something happened).

**Structural assertions added** (`panel-run.test.ts`, `describe('structure')`): *"carries class=\"panel\" and aria-labelledby, the two markers every future panel must copy"* — asserts `#panel-run` has class `panel`, `aria-labelledby="panel-run-title"`, and that `#panel-run-title` is an actual `<h1>`. Nothing pinned either before this round.

Nothing else touched — the rail, the dialog's placement in `App.vue`, and the `.panel` relocation are unchanged from round 1.

Commands re-run after this fix: `npx vitest run tests/web/panel-run.test.ts` — 28 passed. `npx vitest run` — 89 files / 2130 tests passed, one run, no retry needed. `npm run typecheck` — exit 0. `npm run build` — exit 0. `node scripts/verify-ship.mjs` — all `ok`. `git status` — clean after the commit below.
