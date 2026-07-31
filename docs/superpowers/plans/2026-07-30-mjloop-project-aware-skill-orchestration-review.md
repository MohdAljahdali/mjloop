# Implementation Plan Review: Project-Aware Skill Orchestration

**Spec:** Conversation-approved feature decisions, recorded in the implementation plan.

**Plan:** `2026-07-30-mjloop-project-aware-skill-orchestration.md`

## Final Verdict

**SAFE WITH CHANGES**

## Summary

The plan has strong coverage for project isolation, safe external-skill intake, dynamic selection for existing agent roles, and the dependency on the pre-existing multi-platform migration. It was not yet safe to hand directly to an executor because the component-map task was numbered after consumers, the CLI configuration surface lacked a concrete command file, and the rollback model was implicit. Those corrections have been applied to the master plan; implementation must follow the explicit execution order rather than task-number order.

## Spec Coverage Gaps

No requested functional area is absent after correction. The plan covers discovery settings, question budget, approved feature briefs, per-project policies, mixed-component routing, external discovery and audit, platform adaptation, and independent evidence.

## High Issues — corrected before execution

### Component map was defined after its consumers

- **Problem:** The original task numbering placed the component-map work after feature discovery and brief storage, even though those records reference component ids.
- **Risk:** An executor working top-to-bottom could invent ids or build a second temporary representation.
- **Fix applied:** The delivery order and story order now require `baseline → component map → feature discovery → feature briefs → selection → library → import → platform adaptation`. The master plan labels Task 3 as an immediate post-baseline prerequisite.

### CLI configuration path was not concrete

- **Problem:** The plan required a CLI configuration path but did not name its command definition.
- **Risk:** An executor could bypass guarded config mutation by editing YAML directly.
- **Fix applied:** Task 3 now creates `commands/config.md` for `/mjloop:config` and requires it to use the same validated mutation path as the cockpit.

### Rollback policy was implicit

- **Problem:** The plan protected imported packages but did not define how to disable the feature safely or recover from a bad accepted profile/adapter render.
- **Risk:** A partial rollout could leave a project unable to use its prior plan/build flow.
- **Fix applied:** The plan now contains additive config compatibility, policy-off rollback, immutable revision/digest reselection, non-destructive adapter removal, and no startup conversion requirements.

## Medium Issues — execution discipline required

### Task numbering differs from execution order

- **Risk:** A new executor might follow task numbers mechanically.
- **Required handling:** The execution packet must use the topological order in the Delivery Order section, not document order. The future story-conversion skill must encode those dependencies explicitly.

### External registry behavior must remain data-only

- **Risk:** A discovery connector could be implemented as an installer or execute source-provided commands.
- **Required handling:** Task 6 must keep discovery metadata-only and require the static-audit/sandbox pipeline before an acceptance record can exist.

## Order Risks

- Component detection and policy acceptance must precede any feature brief that names components.
- Feature brief approval must precede plan generation whenever discovery policy requires it.
- Project acceptance must precede dynamic skill selection.
- Static inspection must precede sandbox execution; sandbox success must precede activation.
- The existing multi-platform migration gate must precede host adaptation.

## Testing and Operational Checklist

- [x] Existing config compatibility is explicitly additive and defaulted.
- [x] Dirty-worktree preservation is a hard baseline gate.
- [x] Independent plan review and configured verification are included.
- [x] Mixed-component concurrency has a safe sequential default.
- [x] Import source policy, static inspection, sandboxing, and immutable updates are included.
- [x] Rollback and disable paths are now documented.
- [ ] Execute focused tests and release checks only when implementation begins; this review did not run code changes.

## Reviewer Handoff

The plan is ready for conversion into executable stories only if every story names its exact inputs, output interfaces, files, focused tests, blocking dependencies, and completion evidence. A story must not direct Codex to infer unspecified requirements; unresolved decisions remain blockers, not implementation guesses.
