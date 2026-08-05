/**
 * Release-readiness gate for quality-cycle enforcement.
 *
 * Open. Runtime behaviour changes only where this capability and a run's own
 * pinned `enforcement: active` are both true, which is the pair every quality
 * seam gates on — so a project that never named a quality mode pins `shadow`
 * and still closes exactly as it did before this milestone, while a project
 * that opted in has its pinned plan enforced.
 *
 * Kept as a function rather than inlined at its seven call sites: it is the one
 * place the rollout is decided, and `tests/integration/quality-modes.test.ts`
 * asserts both directions of that split against this switch rather than against
 * a mock, so closing it again goes red rather than quietly reverting behaviour.
 */
export function qualityRuntimeEnabled(): boolean {
  return true
}
