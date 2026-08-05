import { defineConfig } from 'vitest/config'

/**
 * The focused suite `stryker.config.mjs` runs, and nothing else.
 *
 * A mutation run executes the suite once per surviving mutant, so the set it
 * runs has to be the set that can actually kill one: these three files are the
 * unit suites for the pure predicates being mutated. The full `vitest.config.ts`
 * include (every `tests/**` file, plus a Vue plugin and a `dist/` precondition
 * none of these tests touch) would multiply a 55-second suite by the mutant
 * count for tests that cannot observe the mutation.
 */
export default defineConfig({
  test: {
    include: [
      'tests/ops/quality-ledger.test.ts',
      'tests/ops/destructive-risk.test.ts',
      'tests/ops/quality-policy.test.ts',
    ],
    environment: 'node',
  },
})
