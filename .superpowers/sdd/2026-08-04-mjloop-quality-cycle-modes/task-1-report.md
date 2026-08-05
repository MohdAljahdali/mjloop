# Task 1 Report: Normalize the quality configuration contract

## Status

Completed the Task 1 schema and loader foundation only. No Task 2+ consumer, CLI, mutation, or web changes were made.

## Implementation details

- Added the closed `QualityModeSchema` (`economy`, `adaptive`, `strict`) and exported `QualityMode`.
- Replaced the old two-boolean output with a strict explicit-or-legacy union. Legacy booleans normalize to `{ mode }`; an absent quality block normalizes to `{ mode: 'economy' }`; mixed shapes are rejected.
- Added `QualityConfigSource` and `loadConfigRecord(projectDir)`, which classifies parsed YAML with own-property checks before schema parsing. `loadConfig(projectDir)` remains the compatibility wrapper and returns only its `config`.
- Made `defaultConfig` write `{ mode: 'adaptive' }`, so newly initialized configuration serializes the explicit mode while older absent documents retain their economy default.

## Files changed

- `engine/src/schemas/config.ts`
- `engine/src/store/config-store.ts`
- `engine/tests/schemas/config.test.ts`
- `engine/tests/store/config-store.test.ts`
- `engine/tests/ops/init.test.ts`

## TDD evidence

### RED

Command:

```sh
cd engine && npx vitest run tests/schemas/config.test.ts tests/store/config-store.test.ts
```

Relevant output: `Test Files 2 failed (2)` and `Tests 10 failed | 92 passed (102)`. Failures were expected: legacy quality parsed as the old booleans, `QualityModeSchema` was undefined, and `loadConfigRecord` did not exist.

### GREEN

Command:

```sh
cd engine && npx vitest run tests/schemas/config.test.ts tests/store/config-store.test.ts tests/ops/init.test.ts
```

Relevant output: `Test Files 3 passed (3)` and `Tests 120 passed (120)`.

## Full-suite verification

Command:

```sh
cd engine && npm test -- --reporter=dot
```

Result: `95 passed` test files / `2153 passed` tests; `4 failed` test files / `5 failed` tests. The failures are Task 2+ consumers that still read or mutate `independent_plan_review` / `independent_verification` (`tests/cli/index.test.ts`, `tests/store/config-mutation.test.ts`, `tests/web/read.test.ts`, and the web typecheck). They are deliberately outside Task 1 ownership and are expected until those consumers migrate to `quality.mode`.

## Self-review

- The explicit and legacy shapes are both `z.strictObject`s, so a mixed mode-plus-boolean document cannot pass either union branch.
- The loader determines source before stripping legacy root keys and before parsing, using own-property checks at every inspected level.
- The compatibility wrapper preserves the `loadConfig` return type and error behavior.
- `git diff --check` passed with no whitespace errors.

## Concerns

The full suite and TypeScript build cannot yet pass because the current CLI, guarded configuration mutation, and web form still depend on the removed boolean output. This task intentionally leaves those Task 2+ migrations untouched.
