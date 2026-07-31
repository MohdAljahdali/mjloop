# S01 — Baseline record

**Recorded:** 2026-07-31
**Branch created for the feature work:** `feat/project-aware-skill-orchestration`, cut from `main` at `2614cc5 chore: release 0.6.0`.
**Result:** S02–S07 may begin. **S08 is blocked** (and, by the operator's explicit decision, skipped entirely for this execution).

## 1. Dirty-worktree ownership before any file was touched

`git status --short` reported 52 entries, every one of which is **pre-existing work that this feature must not stage, revert, reformat, regenerate, or commit.** The set is the in-flight control-center slice plus its regenerated bundle, and the three planning documents this execution consumes.

### Pre-existing modified — user documentation (2)

- `docs/usage.md`, `docs/usage.ar.md`

### Pre-existing modified — control-center engine source (4)

- `engine/src/web/codes.ts`, `engine/src/web/protocol.ts`, `engine/src/web/queue.ts`
- `engine/tests/web/helpers/page.ts`

### Pre-existing modified — control-center browser assets (18)

- `engine/src/web/public/app.css`, `app.js`, `index.html`
- `engine/src/web/public/css/{10-layout,20-rail,30-tabs,40-terminal,50-controls,60-panels}.css`
- `engine/src/web/public/lib/{i18n,local}.js`
- `engine/src/web/public/locales/{ar,en}.json`
- `engine/src/web/public/panels/{config,memory,plans,queue}.js`
- `engine/src/web/public/ui/{pane,rail}.js`

### Pre-existing modified — control-center tests (4)

- `engine/tests/web/{lib,panels,queue,render}.test.ts`

### Pre-existing modified — generated bundle, `engine/dist/**` (21)

- `engine/dist/web/cli.js` and the mirrored `engine/dist/web/public/**` assets.

**Rule carried into S02–S07:** `engine/dist/**` is regenerated only by the task that changes its matching source, and only when the repository's release/build gate permits it. This feature does not regenerate it, because the dist tree already carries an uncommitted control-center build that is not ours to ship.

### Pre-existing untracked — this feature's own planning input (3)

- `docs/superpowers/plans/2026-07-30-mjloop-project-aware-skill-orchestration.md`
- `docs/superpowers/plans/2026-07-30-mjloop-project-aware-skill-orchestration-review.md`
- `docs/superpowers/plans/2026-07-30-mjloop-project-aware-skill-orchestration-execution-stories/`

## 2. Multi-platform migration prerequisite — **not met**

The migration plan (`2026-07-29-mjloop-multi-platform-migration.md`) gates host adaptation behind a canonical definition set, an adapter registry, host capability probes, and transactional installation receipts. None of it exists:

| Required artifact | Observed state |
|---|---|
| `engine/src/platform/` | Does not exist |
| Adapter registry / host adapters | No file under `engine/src` mentions an adapter |
| Canonical command/agent/skill definitions | Absent; `commands/`, `agents/`, `skills/` remain Claude-shaped |
| Capability probes, install receipts | Absent |

`git log` confirms it: the last eight commits are the control-center slice and the 0.6.0 release. The migration plan's own Task 1 ("Finish the current Milestone 8 branch before touching migration code") has never been started.

Milestone 8 itself **is** committed (`01c2039 feat: milestone 8 — a run's derived working memory`), so the migration's Milestone-8 dependency is satisfied; what is missing is every migration task after it.

**Conclusion: S08 is blocked.** Its own stop condition applies — *"If the migration prerequisite is incomplete or baseline is not green, remain blocked. Do not emulate a platform by copying Claude files."* Per the operator's decision on 2026-07-31, S08 is skipped in this execution rather than partially attempted. This blocks nothing in S02–S07.

## 3. Baseline test results

### Focused config / init / plan-track / web-boundary suites

```
npx vitest run tests/schemas/config.test.ts tests/store/config-store.test.ts \
  tests/store/config-mutation.test.ts tests/ops/init.test.ts tests/ops/plan.test.ts \
  tests/integration/plan-track.test.ts tests/web/boundary.test.ts tests/web/discipline.test.ts
```

**Test Files 8 passed (8) · Tests 253 passed (253) · 655 ms**

### Full engine suite

```
npm test        # vitest run
```

**Test Files 57 passed (57) · Tests 1130 passed (1130) · 31.82 s — exit 0**

### Typecheck

```
npm run typecheck   # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.web.json
```

**Passed — exit 0.**

### The migration plan's known baseline defect did not reproduce

The migration plan records that, at authoring time, "typecheck passed and 1,099 tests passed, but the aggregate run failed because `tests/ops/zz-union-flag-repro.test.ts` disappeared during discovery." That file is absent from the repository and the aggregate run is green at 1,130 tests. The transient discovery failure is **not** present in this baseline and is therefore not an exception S02–S07 have to carry.

### Non-failing stderr noise, recorded so a later reader does not mistake it for a regression

Three lines are printed by passing tests that deliberately exercise failure paths:

- `mjloop web: write failed: NoActiveRunError: no active run` — the guarded-write refusal path.
- Two `handoff was not written: EISDIR` lines — the handoff-render fault-tolerance path, which fixtures trigger by placing a directory where `handoff.md` would go.

All three suites containing them report green.

## 4. Files changed by this story

This record only. No source, test, or generated file was modified, staged, reverted, or committed by S01.
