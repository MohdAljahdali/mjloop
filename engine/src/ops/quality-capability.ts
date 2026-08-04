/**
 * Release-readiness gate for quality-cycle enforcement.
 *
 * A policy can pin `enforcement: active` today so the project's intent is not
 * lost, but Tasks 7-16 only build and observe the path. Runtime behaviour may
 * change only when both that pin and this capability are active. Task 17 is
 * the sole owner of opening this production gate.
 */
export function qualityRuntimeEnabled(): boolean {
  return false
}
