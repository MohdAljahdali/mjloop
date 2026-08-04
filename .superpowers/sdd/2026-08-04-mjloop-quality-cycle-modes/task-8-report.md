# Task 8 report — Maintain and invalidate the five-dimension evidence ledger

## Outcome

Implemented the engine-owned quality ledger transitions in commit pending. Evidence records and invalidations are serialized under the project lock; the pure closure predicate refuses every required dimension that is pending, blocked, failed/contradicted, stale, or lacks required evidence references.

## Contract resolution

The old ledger `required_evidence` reused agent-result evidence kinds (`command | file | test`) even though downstream ledger input carries `agent` and `human`. Quality now has its own shared closed `QualityEvidenceKindSchema` / `QualityEvidenceKind` vocabulary: `command | test | agent | human`. Initial requirements use `test` for correctness/regression, `command` for security, `agent` for alignment, and `human` for UI; the old `file` token is not accepted by the ledger.

## Transition rules

- `recordQualityEvidence` samples `worktreeDigest` itself under the ledger transition. A submitted digest mismatch becomes pending/stale; when git is unavailable, the canonical SHA-256 fingerprint includes the run and cycle nonce, preventing cross-cycle reuse.
- Fingerprints use canonical JSON of dimension, sorted criteria, sorted changed files, sorted evidence references, and the worktree digest/nonce.
- A pass needs every persisted required evidence kind and at least one reference. A tool-blocked result remains `blocked`. Agent-only evidence cannot overwrite a failed command/test dimension.
- `invalidateQualityEvidence` clears only affected evidence: acceptance/goal changes invalidate required dimensions, pinned command changes invalidate executable checks, source changes invalidate correctness/regression plus their relevant security/UI dimensions. A UI path raises UI applicability to required; no transition lowers applicability or accepts an agent-written `not_applicable` verdict.

## TDD evidence

### RED

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts`

Failed as expected: `quality-ledger.ts` did not exist and `updateLedger` was not exported. A subsequent targeted RED proved a pass with empty evidence references incorrectly remained `pass`.

### GREEN

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts tests/schemas/quality.test.ts tests/ops/quality-policy.test.ts`

Passed: 4 files / 62 tests. Backend and test TypeScript checks, plus `git diff --check`, passed.

## Full-suite verification

`cd engine && npm test` produced 101 passed files / 2302 passed tests and the same 4 known Web/Cockpit failures outside Task 8: old boolean quality config expectations in `tests/web/lib.test.ts` and `tests/web/read.test.ts`, missing resumable status locale labels in `tests/web/locales.test.ts`, and the corresponding stale web typecheck in `tests/web/typeguard.test.ts`.

## Self-review

- All ledger read-modify-write transitions use `updateLedger`, which holds the project lock and fences its atomic publish.
- The closure predicate is pure and treats policy-required dimensions and later-raised ledger applicability as mandatory.
- No run-log/cycle-advance integration or runtime enforcement gate was changed.
