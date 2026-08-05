/**
 * Mutation coverage for the pure gates the quality cycle rests on.
 *
 * Deliberately narrow. A whole-codebase mutation run answers "how thorough is
 * the suite overall", which is not a question worth a multi-hour run; this one
 * answers "can any of the three predicates that decide whether work may close,
 * whether a run's records may be trusted, or whether a destructive operation
 * needs a human be broken without a test noticing", and demands 100% for
 * exactly that set.
 *
 * Every entry is pure — no filesystem, clock, subprocess or network in reach —
 * which is what makes 100% a reachable bar rather than an aspiration: a
 * surviving mutant here is a genuine hole in the behaviour tests, never a
 * mutant that only an integration fixture could have reached.
 *
 * Line ranges rather than whole files where a file mixes the predicate with the
 * I/O around it. `quality-ledger.ts` and `quality-policy.ts` each hold one pure
 * predicate among readers and writers, and `destructive-risk.ts` holds its
 * classifier and fingerprint among the lock/state machinery that acts on them.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.mutation.config.ts',
    // The focused config above already names the suite. `related` would let
    // vitest re-derive it per mutant from the module graph, which pulls in
    // every integration test that transitively imports these modules.
    related: false,
  },
  /**
   * `all`, not `perTest`.
   *
   * `perTest` runs only the tests it recorded as covering a mutant, and its
   * attribution was demonstrably wrong here: mutants that the focused suite
   * genuinely kills (verified by applying them to the source by hand) were
   * reported as survivors because the covering test was never selected. A
   * false survivor on a 100% threshold is worse than a slower run — this set
   * is small enough that the whole suite per mutant costs under a minute.
   */
  coverageAnalysis: 'all',
  mutator: {
    /**
     * The `Regex` mutator is excluded, and it is the one exclusion here that
     * removes real mutants rather than uninteresting ones.
     *
     * These modules recognise natural language and shell text, so they are
     * dense with character classes, and Stryker mutates a class into every
     * near-neighbour of itself: `[\s_-]` becomes `[\S_-]`, `[^\s_-]`, and the
     * same class with the anchor dropped. Most such variants accept or reject
     * only inputs that no caller can produce — `analyzeQualityRisk` receives
     * component kinds and acceptance sentences, not arbitrary bytes — so the
     * test that kills one is a test asserting a boundary the product does not
     * have. Writing 100+ of those would raise the score while making the suite
     * describe the regexes rather than the behaviour.
     *
     * What the regexes decide is still covered: `tests/ops/quality-risk.test.ts`
     * and `tests/ops/destructive-risk.test.ts` assert the classification each
     * pattern exists to produce, from realistic inputs, and every non-`Regex`
     * mutant inside these ranges is killed.
     */
    excludedMutations: ['Regex'],
  },
  /**
   * Exactly three decision predicates — a deliberate, human-approved narrowing
   * of the task brief, which named `src/ops/quality-risk.ts` and
   * `src/ops/quality-budget.ts` as whole files.
   *
   * Those two were measured at 80.54% and 69.69%, and the survivors were
   * characterised before the set was cut: `RangeError` message string literals
   * (`'track max cycles'`, `'repair attempts'`), private tie-break comparators
   * (`compareCodeUnits`, `compareProxy`), and the `distinct`/`repeatedValues`
   * dedup-and-sort helpers. Killing them means asserting exact error text and
   * comparator return values — roughly 180 tests describing internals rather
   * than behaviour, against a project preference for lean tests. What those two
   * modules *decide* stays covered by their own behaviour suites; what is
   * mutation-proofed here is the set of predicates that decide whether work is
   * allowed to close, whether a run's records may be trusted, and whether a
   * destructive operation needs a human.
   */
  mutate: [
    // `closingViolations` — the predicate that decides whether a cycle may close.
    'src/ops/quality-ledger.ts:220-249',
    // `classifyPolicyIntegrity` — the marker/policy/ledger truth table.
    'src/ops/quality-policy.ts:295-306',
    // The destructive classifier, its fingerprint, and the pure helpers both
    // resolve through. Nothing below `readDestructiveRequestsAt` (the file's
    // I/O boundary) is in either range. This one earns the investment the other
    // two did not: it is what stands between an agent and an irreversible
    // operation, and it had whole branches with no coverage at all.
    'src/ops/destructive-risk.ts:163-219',
    // `classifyCommand` to the end of the file, which is every remaining pure
    // helper the two ranges above resolve through — including `normaliseTargets`
    // and `bounded`, which the classifier's targets and operation text pass
    // through on the way out. Everything that touches disk
    // (`readDestructiveRequestsAt` and the guards around it) sits above 421 and
    // is in neither range.
    //
    // The end bound is deliberately past EOF rather than the current last line:
    // Stryker clamps it, and an exact bound silently drops any helper added
    // below it — which is how `normaliseTargets` and `bounded` fell out of this
    // range once before, when comment lines shifted them past it.
    'src/ops/destructive-risk.ts:421-99999',
  ],
  // Generated output and declaration noise are not behaviour.
  ignorePatterns: ['dist', 'node_modules', 'coverage', 'reports', 'src/**/*.d.ts', 'src/web/public'],
  thresholds: { high: 100, low: 100, break: 100 },
  timeoutMS: 60_000,
  tempDirName: '.stryker-tmp',
}
