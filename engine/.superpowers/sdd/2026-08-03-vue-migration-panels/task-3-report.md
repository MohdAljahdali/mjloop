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
