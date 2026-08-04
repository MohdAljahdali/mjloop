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

## Fix round 1/5 — receipts, cycle freshness, and state fencing

### Findings fixed

- Added `quality-evidence.ts`, a closed receipt resolver for Task 10. `recordQualityEvidence` no longer accepts caller-provided evidence kinds: a direct `cycle-NN/verify/<log>` reference must match an engine verify receipt in the active run and have a compatible completed outcome; a `cycle-NN/<agent>.json` reference must parse as a stored `AgentResult`. Command/test claims inside that result must name a matching engine receipt of the same kind. File evidence remains traceability only; no agent path can produce `human` provenance.
- Added ledger `cycle`, entry `recorded_cycle`, and entry `worktree_digest`. `advanceQualityLedgerCycle` is the narrow future cycle-advance seam: it advances the ledger cycle and invalidates passing null-digest evidence. The pure close predicate independently rejects an older null-digest recorded cycle.
- Replaced required UI `human` evidence with validated `agent` evidence, so unattended UI work can pass with an engine-stored agent result. Human remains an operator-only vocabulary member with no agent-resolvable receipt.
- Source-file invalidation now includes alignment. `updateLedger` rereads `state.json` under the project lock and rejects run/cycle/status drift before reading or publishing the ledger.

### RED

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts`

Result: 12 intended failures. The strict ledger rejected the new cycle/freshness fields, close accepted an older null-digest cycle, `updateLedger` accepted a changed active cycle, and the old transition still accepted a nonexistent claimed verify ref.

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts -t "command claim"`

Result: intended failure. A validated agent result that labelled a test receipt as `command` resolved to pending rather than rejecting the wrong kind.

### GREEN

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts tests/schemas/quality.test.ts tests/ops/quality-policy.test.ts`

Result: 4 files / 70 tests passed.

`cd engine && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.tests.json --noEmit && git diff --check`

Result: passed with no output.

### Self-review

- Receipt parsing only joins relative names to `cycleDirPath` for the current run; traversal strings, unknown logs, future-cycle refs, malformed agent JSON, and report-only kinds cannot become ledger proof.
- A passing command/test receipt must be engine-complete with exit code zero; a passing agent must itself be a validated pass result. A failed receipt cannot be relabelled into a pass through either direct or agent references.
- No runLog/cycleAdvance wiring was added. `advanceQualityLedgerCycle` is exported but inert until the future engine transition calls it.

## Fix round 2/5 — supersession, receipt provenance, and under-lock composition

### Findings fixed

- Verify receipt resolution now enumerates the active run's cycle ledgers, normalizes a cached row's already-run-relative log, checks that the physical engine log exists, and enforces the latest invocation for the same slot/command. A cited green that an later invocation superseded is rejected.
- Resolved receipts carry their actual invocation cycle. Ledger `recorded_cycle` now comes from that provenance rather than the caller's current state. An old null-digest receipt remains stale even if it is explicitly submitted after a cycle advance; cross-cycle non-null reuse additionally requires the verify fingerprint for the current worktree.
- Added `StateTransaction.beforeStatePublish` and `updateLedgerUnderLock`. `advanceQualityLedgerCycleUnderLock` uses this existing-lock transaction route, queues its fenced ledger write before state publication, and never reacquires `.mjloop/.lock`. The old public wrapper remains for standalone use.

### RED

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts -t "prior green|prior-cycle|cached verify|composes the cycle|unchanged when"`

Result: 5 intended failures. A cited old pass was accepted after a newer failure, old receipt provenance was stamped as cycle 2, a cached run-relative log was rejected as a nested path, and both under-lock calls were absent.

### GREEN

`cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts tests/schemas/quality.test.ts tests/ops/quality-policy.test.ts`

Result: 4 files / 75 tests passed.

`cd engine && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.tests.json --noEmit && git diff --check`

Result: passed with no output.

### Self-review

- A receipt is accepted only when it names an engine ledger row, its canonical log exists, and it is the most recent invocation of that slot/command. Cached rows retain the original canonical log but count as the current-cycle invocation that verified the cache fingerprint.
- Old receipts cannot gain current-cycle freshness by being re-recorded. The resolver preserves the actual cycle, and the close predicate is still independently conservative for null worktree identity.
- The transaction test proves the future cycle transition does not wait on its own non-reentrant lock; the rejection test proves an invalid ledger advance prevents both queued ledger publication and state publication. No Task 10 call site was added.
