# Cockpit orchestration views

**Date:** 2026-08-01
**Source:** `docs/superpowers/plans/2026-07-30-mjloop-project-aware-skill-orchestration-execution-report.md`

## The gap

The project-aware skill orchestration work (S01–S07) shipped its whole read surface on the server and
almost none of it in the browser. Every route exists and answers:

| Route | Serves | Reached by the page |
|---|---|---|
| `/api/profile` | the accepted component map | yes — one block inside Config |
| `/api/features` | every feature brief raised | **no** |
| `/api/features/:id` | latest revision, history, content digest | **no** |
| `/api/skills` | the machine library and this project's acceptances | **no** |
| `/api/runs/:id/skills` | the routing decision a run was pinned to | **no** |

The `feature.approve` write is likewise complete — `web/writes.ts:210`, compare-and-swapping a sha256 of
the brief's content — and its receipt strings `write.ok.feature` and `write.stale.feature` are already in
`locales/en.json`. Nothing in `src/web/public/` calls it.

This is the same "inert capability" shape section 3 of the execution report describes: the capability is
written, tested, and unreachable by any user.

## Scope

Four views, one of them carrying the one write the browser is permitted.

1. A **Features** tab: the briefs, their revision history, and the approval.
2. A **Skills** tab: the component map (moved), the machine library, this project's acceptances.
3. A **pinned manifest** block inside the existing Run tab.
4. Three new revision keys, without which none of the above can know it went stale.

Explicitly out of scope, and permanently: activating a skill, and accepting a component map. Both change
what every later run is told, which is the class of write `web/writes.ts`'s header denies the browser.
`mjloop-cli skills accept|disable|enable|remove` and `mjloop-cli profile accept` own those decisions.

## 1. Revision keys

`Revisions` carries six keys and none of them fingerprints `.mjloop/features/`. The consequence is not
cosmetic: `applyWrite` broadcasts a snapshot *before* the receipt, so a page whose feed depends on no
moving key receives the confirmation and keeps showing the pre-approval brief. The approval would look
like it did nothing.

`panels/config.js:203` already documents this hole and works around it by riding `config` and `state` —
the two keys that happen to move when a profile is accepted. That workaround does not generalise, and is
retired here.

Three keys are added to `revision.ts` and `protocol.ts`:

| Key | Fingerprint | Why it is its own key |
|---|---|---|
| `profile` | `.mjloop/profile/` directory, plus `proposed.json` | accepted revisions are immutable files; the directory's own mtime moves when one lands |
| `features` | `.mjloop/features/` directory, plus its sorted entries | approval writes a new revision file inside it |
| `skills` | `.mjloop/skills/` plus the sorted entries of `<library>/packages/` | acceptances are project-local; the library is machine-wide and moves under `skills import` |

**`resolveLibraryRoot` throws.** `LibraryRootCollisionError` fires when the resolved root would land inside
the project or inside any `.mjloop` directory. `readRevisions` runs on every poller tick and must never
throw — a throw there takes out the whole snapshot, not one panel. The library half of the `skills` key is
therefore wrapped so that an unresolvable root yields `-`, exactly as `stamp` does for an absent path.

Cost: three `stat` calls and two `readdir` calls per tick, on the same order as the existing `memory` and
`runs` keys.

## 2. The Features tab

`panels/features.js`, following `panels/plans.js` structurally, because the two views have the same shape:
a list, one detail fetched only while open, and a decision.

**Routing.** `lib/router.js` normalises flat fragments only — `routes.includes(id)` — and has no parameter
form. The detail is therefore opened by a `data-act` toggle over a module-level `opened`, as `plans.js:579`
does, not by `#features/F001`. `features` and `skills` join the route list in `app.js`.

**Feeds.** The list rides `revisions.features` against `/api/features`. The detail rides
`` `${opened}:${state.revisions.features}` `` against `/api/features/:id`, so a project with forty briefs
issues one conditional GET rather than forty.

**What a brief shows.** The record as it is on disk: title, status, problem, decisions, acceptance criteria,
affected components, declared tags, the discovery block, `supersedes`, `createdAt`, and the approval block
when there is one. Beside it the revision history from `FeatureDetail.revisions`, each row carrying its
derived status — `superseded` is never stored, it is "a higher revision exists" computed on read
(`read.ts:264`).

**The approval.** The button renders only when `status === 'draft'`. It opens a modal that names the
feature, its revision, and its acceptance-criteria count, and takes an optional note bounded at 2000
characters. Confirming submits:

```
{ kind: 'feature.approve', feature, revision, digest, note }
```

`digest` is the one served in the same `/api/features/:id` response the screen was drawn from. That is the
entire point of the compare-and-swap: a draft holds one revision number for the whole of its editable life,
so a number alone would approve whatever the brief says by the time the click lands. Section 3 of the
execution report records this being got wrong once already.

**A dialog, against the existing rule.** `ui/dialog.js`'s header states that everything reversible — "an
approval, a requeue" — goes without one, because a stale click is refused rather than obeyed. That reasoning
holds for a *plan gate*, which can be re-decided. It does not hold here: `approveFeatureBrief` refuses to
touch an approved revision ever again, and there is no undo one press away. The departure is deliberate and
is recorded in the file.

**A draft with no acceptance criteria.** `FeatureBriefSchema` refuses an approved brief with an empty
`acceptance` array, and `writes.ts:259` deliberately gives that refusal no code of its own — it falls to
`write.failed` with the diagnosis on the server's terminal. The page therefore cannot explain the failure
after it happens, so it prevents it before: the button is disabled with the reason stated. Writing the
brief's criteria is the interview's job, not the cockpit's.

**`by` is never sent.** `decidedBy()` derives it from `os.userInfo()` precisely so an approver cannot be
typed. A brief is what a plan is built from; a forgeable approver is a forgeable authorisation for work
nobody agreed to.

## 3. The Skills tab

`panels/skills.js`, three blocks, all read-only.

**Block 1 — the component map.** Moved out of `panels/config.js`: the `config-profile-block` markup, the
`profileRecord` / `profileDrift` / `profileEmpty` / `profileHost` handles, the `/api/profile` feed, and
`drawProfile` with `componentCard`. It rides the new `revisions.profile` instead of the documented
`config`+`state` workaround. The `orchestration.profile.auto_accept` control stays in Config: that is a
setting, not a record.

**Block 2 — the machine library.** Per package: `skillName`, `packageId`, a shortened `digest`, the source
(kind, url, pinned revision), the license, an `audit.state` badge, and `audit.findings`. The findings list
includes the sandbox line, because `writePackage` is only ever reached from a passed audit — there is no
separate import report to render (`read.ts:199`). Declared `dependencies.executables` and
`dependencies.packages` are shown as declared, never as resolved. `unreadable` entries are rendered with
their reason rather than dropped, for the reason `listPackages` collects them: an entry there can be an
interrupted import.

**Block 3 — this project's acceptances.** Per acceptance: `skillId`, `packageId`, shortened `digest`,
`status`, `compatible`, components, agents, tags, `updatePolicy`, `acceptedBy`, `acceptedAt`. Each is
joined to the library by digest, and an acceptance with no matching package is labelled as such — that is
the true state of a repository cloned onto a machine whose library has never imported it, and it is
invisible in either list read alone.

A standing line under blocks 2 and 3 names `mjloop-cli skills accept|disable|enable|remove` as where
activation happens. Without it a read-only panel reads as a broken one.

## 4. The pinned manifest, inside Run

A block in the Run tab fetching `/api/runs/:id/skills`, riding the run id and `revisions.cycle`. It is
hidden entirely when the route answers `null` — a run that pinned no manifest has nothing to say, and an
empty table claiming otherwise would be worse than absence.

It renders `sourceBrief` as `F001@2`, `profileRevision`, and the concurrency **mode with its reason** in
one line — `ConcurrencyDecisionSchema` carries the reason precisely so that "why did this serialise?" is
answerable, and a bare mode would drop it. Then one row per `SkillSelection`: component, agent, and each
selected skill id beside the index-aligned reason that chose it, with the matching `guidance` text
collapsed. The schema's own refinement guarantees the two arrays cannot have drifted.

## 5. Constraints the tests impose

`tests/web/discipline.test.ts` is strict and every one of these applies to new markup:

- No DOM built from strings. Every row comes from a `<template>` through `clone()`.
- Every declared template is cloned and every cloned template is declared.
- No `<tr>` at a template root.
- Every `data-act` in the markup has a registered action, and every registered action appears in the markup.
- Every top-level view has a visible heading; every control has an accessible name.
- RTL rules hold.
- Nothing assigns to a control's `.value` except in the one sanctioned place, on a user action.

`tests/web/locales.test.ts` enforces key-for-key parity between `en.json` and `ar.json`, so every new string
is written in both.

New coverage:

- `tests/web/read.test.ts` and `tests/web/api.test.ts` — the three revision keys, including that an
  unresolvable library root degrades to `-` rather than throwing.
- `tests/web/panels.test.ts` — the derived logic: revision status derivation, the acceptance-to-package
  join and its missing-package case, and the disabled-approval rule for a criteria-less draft.
- `tests/web/writes.test.ts` already covers `feature.approve`; what is new is that a page can reach it.

## What this does not do

No activation, no map acceptance, no brief editing, no discovery launched from the browser. The interview
that writes a brief is a terminal skill, and a second, weaker discovery flow beside it is exactly what
`web/writes.ts:58` argues against.
