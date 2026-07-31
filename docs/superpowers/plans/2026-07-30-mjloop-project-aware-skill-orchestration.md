# Project-Aware Skill Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MjLoop discover a project's components, run an optional Grill Me feature interview, dynamically attach the right skills to the existing agents, and safely discover, import, adapt, and audit external skills per project and platform.

**Architecture:** Preserve the existing leader and agent roster. Add a project-owned profile and feature-brief lifecycle under `.mjloop/`; the leader reads those records to select skills for the existing `planner`, `builder`, `critic`, and `verifier` roles. Keep the downloadable skill library user-local and shared, but store every acceptance, update policy, source policy, and activation decision in the individual project's `.mjloop/` state. External skill acquisition is a staged, non-executing review pipeline; only an explicitly approved, sandbox-tested package can become active.

**Tech Stack:** Node.js 20+, TypeScript 5.9, Zod 4, YAML, Vitest, existing MjLoop MCP server and local cockpit. The canonical skill source for the interview behavior is [mattpocock/skills `grilling`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md), retained with source/version/license metadata.

## Global Constraints

- This plan is implementation guidance only. It does not authorize implementation, edits to runtime code, commits, installation, or external skill execution.
- Preserve the existing leader, tracks, required/available/closing agent semantics, verification ownership, plan approval gate, and human-readable project configuration.
- Agents remain fixed roles. Skills are selected per task and component; do not create permanent `flutter-builder`, `nextjs-builder`, or equivalent duplicate agents.
- Every project owns its contract, source allowlist, discovery policy, approval mode, update mode, execution budget, and ambiguity policy. No project setting may silently affect another project.
- A user-local skill package may be downloaded once and referenced by several projects, but each project needs an independent accepted version and compatibility result before it can activate it.
- The normal external-search default is GitHub plus configured trusted skill registries. General web search is opt-in and every result requires review before import.
- Never execute an imported package during inspection. First inspect content and metadata; execute only executable packages in a sandbox with no project checkout, credentials, or network secrets.
- An imported skill is immutable by digest. Updates create a new candidate and must pass the same project-specific checks before replacing the accepted version.
- Do not add platform-specific rendering until the multi-platform migration's clean-baseline gate and adapter foundation are complete. The current Claude-only implementation must remain fully usable in the earlier phases.
- Preserve the existing dirty worktree. Do not overwrite unrelated control-center changes; regenerate `engine/dist/**` only in the task that changes its matching source and only after the repository's release/build gate permits it.
- Follow TDD for every task: focused failing test, observed failure, smallest implementation, focused pass, phase gate, and atomic commit.

---

## Delivery Order

1. Project-component profile and project policy.
2. Feature interview and immutable feature briefs.
3. Shared skill library, external discovery, review, sandboxing, and project activation.
4. Platform adapters and compatibility diagnostics, after the existing multi-platform migration prerequisite is met.

This order is intentional: an accepted component map exists before a feature brief names components; feature discovery then produces an approved brief before planning; the profile lets the leader route known skills before any external import machinery exists; the shared library is safe to add once there is a consumer; and platform rendering must reuse the canonical model rather than invent a second one.

## Locked Data Boundaries

| Record | Owner | Location | Mutability |
|---|---|---|---|
| Project policy, component map, accepted skill references | Project | `.mjloop/config.yaml` plus versioned project records | Project-scoped, edited through guarded config mutation or explicit CLI command |
| Feature brief | Project | `.mjloop/features/F###-<slug>/` | Draft while interviewing; immutable revision after approval |
| Downloaded skill package and audit evidence | User-local MjLoop library | MjLoop user data directory, outside a project checkout | Immutable content-addressed versions |
| Adapted host render | Adapter-managed host root | Never in shared `.mjloop/` engine state | Generated, hash-aware, conflict-aware |
| Runtime run/story evidence | Project | Existing `.mjloop/runs/` and `.mjloop/plans/` | Existing engine rules remain authoritative |

The implementation must introduce one versioned schema for project policy and one for feature briefs. Do not overload `state.json`; its run lifecycle is intentionally narrow. Do not put a user-local library path in committed project config; project records reference a package id, content digest, and accepted adapter result only.

## Rollback and Compatibility Rules

- All project-config additions are optional, defaulted, and additive. An existing `.mjloop/config.yaml` without the new blocks must continue to parse and preserve its existing tracks and gates.
- The immediate operational rollback for this feature is to set the project's feature discovery mode to `off` and deactivate the relevant project skill acceptance. That restores the existing plan/build flow without deleting evidence.
- A component-profile proposal is never an in-place migration. Rejecting it leaves the last accepted profile active; accepting a replacement retains the prior revision for audit and rollback.
- A feature-brief revision, library package digest, and project acceptance are immutable. Rollback means reselecting a prior accepted revision/digest, never mutating a record that a run may have pinned.
- Removing a generated host adaptation must use the adapter receipt and must never delete user-modified host files. If removal has a conflict, disable activation and surface the conflict instead.
- New `.mjloop/features/` records are additive. Do not add a startup migration, a destructive rewrite, or a requirement that existing plans/stories be converted before MjLoop can run.

## Task 0: Establish the implementation gate and repository-safe baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-mjloop-project-aware-skill-orchestration.md` only if review finds a planning defect.
- Read: `docs/superpowers/plans/2026-07-29-mjloop-multi-platform-migration.md`, `.mjloop/config.yaml`, `engine/package.json`, and `CONTRIBUTING.md`.
- Test: existing focused engine/config/web suites; no code change in this task.

**Produces:** A recorded baseline stating whether feature work may begin and whether Phase 4 remains blocked by the multi-platform migration gate.

- [ ] **Step 1: Record the exact dirty-worktree ownership before touching files.**

  Run `git status --short` and classify every existing change as pre-existing. Do not stage, revert, format, or regenerate it.

- [ ] **Step 2: Verify the existing migration prerequisite.**

  Read the migration plan's clean-baseline gate and inspect the Milestone 8 status, its review evidence, and the known test-discovery issue. Mark Phase 4 blocked unless that gate is proven complete.

- [ ] **Step 3: Run the smallest baseline checks that exercise config and plan behavior.**

  Run the focused config, init, plan, and web boundary tests from `engine`. Report targeted results separately from any unrelated full-suite failure.

- [ ] **Step 4: Commit nothing.**

  This task is a gate only. A later implementation task may start only from a baseline report that explicitly preserves unrelated changes.

## Task 1: Add the MjLoop Feature Discovery skill without changing agent roles

**Files:**
- Create: `skills/mjloop-feature-discovery/SKILL.md`
- Modify: `commands/plan.md`
- Modify: `skills/mjloop-leader/SKILL.md`
- Modify: `README.md`, `docs/usage.md`, `docs/usage.ar.md`
- Test: `engine/tests/plugin/feature-discovery-skill.test.ts` (new text-contract test)

**Consumes:** The existing `plan` command, `mjloop-leader` hard gates, the approved Grill Me behavior, and the accepted project-component profile from Task 3.

**Produces:** A project-aware interviewing skill that asks only decision questions, does not plan or execute, and writes an approved handoff record before the plan track can begin.

- [ ] **Step 1: Write failing text-contract tests for the new skill.**

  Assert that the skill requires: reading discoverable project facts first; one user decision question at a time; a recommendation with each question; no implementation; no agent/skill routing; and an explicit stop until a feature brief is approved.

- [ ] **Step 2: Implement `mjloop-feature-discovery`.**

  Base its interview behavior on the upstream `grilling` skill, but add MjLoop-specific inputs: project contract, current component map, existing feature briefs, and project documentation. Its output is a structured draft brief, not a plan and not an executable prompt.

- [ ] **Step 3: Make `/mjloop:plan` enter discovery according to project policy.**

  The command must honor three project modes: `always`, `ask`, and `off`. `always` starts discovery; `ask` presents the choice; `off` goes directly to the existing plan track. A per-feature explicit choice overrides the project default and is recorded in the brief.

- [ ] **Step 4: Keep leadership responsibilities separate.**

  Update the leader guidance so it consumes an approved brief before it starts the plan track. It must not make Grill Me choose components, select skills, write stories, or start a run.

- [ ] **Step 5: Run focused tests and documentation checks.**

  Verify the new skill's contract and that English/Arabic usage documentation describe the same three modes. Commit only the new skill, command/leader wiring, tests, and documentation.

## Task 2: Persist feature-brief revisions and approval choices

**Files:**
- Create: `engine/src/schemas/feature.ts`
- Create: `engine/src/store/feature-store.ts`
- Modify: `engine/src/store/paths.ts`
- Modify: `engine/src/mcp/server.ts`
- Modify: `engine/src/web/read.ts`, `engine/src/web/api.ts`, `engine/src/web/writes.ts`, `engine/src/web/codes.ts`
- Modify: `engine/src/web/protocol.ts`
- Test: `engine/tests/schemas/feature.test.ts`, `engine/tests/store/feature-store.test.ts`, `engine/tests/mcp/server.test.ts`, `engine/tests/web/read.test.ts`, `engine/tests/web/boundary.test.ts`

**Interfaces:**

```ts
type FeatureDiscoveryMode = 'always' | 'ask' | 'off'
type FeatureBriefStatus = 'draft' | 'approved' | 'superseded'

interface FeatureBrief {
  id: string
  revision: number
  title: string
  status: FeatureBriefStatus
  problem: string
  decisions: readonly Decision[]
  acceptance: readonly string[]
  affectedComponents: readonly string[]
  discovery: { mode: FeatureDiscoveryMode; questionBudget: number; completedAt: string | null }
  supersedes: { id: string; revision: number } | null
}
```

**Produces:** Engine-owned, validated briefs whose approval is auditable and whose later modification creates a successor revision rather than mutating planning input.

- [ ] **Step 1: Write schema tests before storage code.**

  Cover safe ids, bounded question budgets, required acceptance criteria, only known component ids, immutable approved revisions, and rejection of a successor that does not point to its predecessor.

- [ ] **Step 2: Add path and atomic storage helpers.**

  Extend `LoopPaths` with a `features` directory. Store each revision under a deterministic feature directory; use the existing lock and atomic-write conventions. Do not expose raw file paths supplied by a model or browser.

- [ ] **Step 3: Expose narrow MCP operations.**

  Add create/read/append-decision/approve/supersede operations. Approval must record the local decision actor and timestamp, and it must reject a stale expected revision.

- [ ] **Step 4: Add read-only cockpit endpoints and one guarded approval write.**

  Follow the existing read/write boundary: browser GET routes may read summaries and a single brief; browser writes may approve the displayed draft through compare-and-swap only. The browser must not create, edit, route, or execute a feature.

- [ ] **Step 5: Add regression tests for immutability and web boundaries.**

  Prove that an approved brief cannot be edited, a replacement becomes a new revision, stale approval is refused, and web source tests still forbid run-start/run-log/cycle-advance imports.

- [ ] **Step 6: Run focused suites and commit.**

  Run schema, store, MCP, and web-boundary tests. Commit only the feature-brief persistence slice.

## Task 3: Build the project component map and per-project orchestration policy

**Files:**
- Create: `engine/src/schemas/project-profile.ts`
- Create: `engine/src/ops/project-profile.ts`
- Create: `engine/src/store/project-profile-store.ts`
- Modify: `engine/src/ops/init.ts`
- Modify: `engine/src/schemas/config.ts`
- Modify: `engine/src/store/config-mutation.ts`
- Modify: `engine/src/web/read.ts`, `engine/src/web/writes.ts`, `engine/src/web/api.ts`
- Modify: `engine/src/web/public/panels/config.js`, `engine/src/web/public/index.html`, `engine/src/web/public/locales/en.json`, `engine/src/web/public/locales/ar.json`
- Create: `commands/config.md`
- Modify: `README.md`, `docs/usage.md`, `docs/usage.ar.md`
- Test: `engine/tests/ops/project-profile.test.ts`, `engine/tests/schemas/project-profile.test.ts`, `engine/tests/store/config-mutation.test.ts`, `engine/tests/web/panels.test.ts`

**Interfaces:**

```ts
type ComponentTechnology = 'flutter' | 'nextjs' | 'python' | 'unknown'
type UncertainConcurrency = 'sequential' | 'ask' | 'parallel'

interface ProjectComponent {
  id: string
  root: string
  technology: ComponentTechnology
  verification: { test: string | null; lint: string | null; build: string | null }
  skillTags: readonly string[]
}

interface ProjectOrchestrationPolicy {
  discovery: { mode: FeatureDiscoveryMode; questionBudget: number; completion: 'auto-plan' | 'review' | 'save-only' }
  execution: { afterPlanApproval: 'auto' | 'manual'; uncertainConcurrency: UncertainConcurrency; repairAttempts: number }
  quality: { independentPlanReview: boolean; independentVerification: boolean }
}
```

**Produces:** A read-only detector plus an approved, project-local profile. It recognizes Flutter from `pubspec.yaml`, Next.js from a package manifest/framework dependency, and Python from `pyproject.toml`/equivalent metadata; it never guesses a component from a folder name alone.

**Execution order:** Implement this task immediately after Task 0, before Tasks 1 and 2. It is numbered third only because it was defined after the feature-brief model during design.

- [ ] **Step 1: Write fixture-based detector tests.**

  Include standalone Flutter, Next.js, and Python fixtures; a mixed mobile/admin/service repository; an unknown repository; and nested manifests. Assert stable component ids, roots relative to the project root, detected verification commands, and no filesystem writes.

- [ ] **Step 2: Implement conservative discovery and approval records.**

  `initLoop` may generate a proposed profile after its existing state/config work succeeds, but it must not activate component routing until the user accepts or config policy explicitly permits auto-acceptance. A later scan detects additions/removals and proposes a revision rather than changing the accepted profile.

- [ ] **Step 3: Extend project-scoped config safely.**

  Add the discovery, question budget, plan/execution, repair, quality, source, and uncertain-concurrency settings to the strict config schema with explicit defaults. The default for ambiguous dependency analysis is `sequential`; `ask` and `parallel` are opt-in project choices. Validate bounded integer budgets and reject policies that allow execution after an unapproved brief.

- [ ] **Step 4: Add web and CLI configuration paths.**

  Extend the existing guarded Config panel and config mutation schema; add `/mjloop:config` in `commands/config.md` as the documented CLI configuration command. It must call the same validated mutation route as the web surface, rather than hand-editing YAML. Both surfaces must show the same values and stale writes must fail rather than overwrite a concurrent choice.

- [ ] **Step 5: Test mixed-component routing decisions.**

  Prove that a Flutter-targeted brief selects only the Flutter component; a Next.js brief selects only the admin component; independent component work can be marked parallel; and any uncertainty resolves to sequential under the default policy.

- [ ] **Step 6: Run focused tests and commit.**

  Run detector, config, mutation, and panel tests. Commit the project-profile/policy slice without changing external-skill code.

## Task 4: Select skills dynamically for existing agents

**Files:**
- Create: `engine/src/schemas/skill-selection.ts`
- Create: `engine/src/ops/skill-selection.ts`
- Modify: `engine/src/schemas/contract.ts`
- Modify: `engine/src/ops/run.ts`
- Modify: `skills/mjloop-leader/SKILL.md`
- Modify: `agents/planner.md`, `agents/builder.md`, `agents/critic.md`, `agents/verifier.md`
- Test: `engine/tests/ops/skill-selection.test.ts`, `engine/tests/ops/run.test.ts`, `engine/tests/schemas/contract.test.ts`, `engine/tests/plugin/agents.test.ts`

**Interfaces:**

```ts
interface SkillSelection {
  component: string
  agent: string
  skillIds: readonly string[]
  reasons: readonly string[]
  sourceBrief: { id: string; revision: number }
}

function selectSkills(input: {
  brief: FeatureBrief
  profile: AcceptedProjectProfile
  acceptedSkills: AcceptedProjectSkill[]
  agent: string
}): SkillSelection
```

**Produces:** An engine-validated selection manifest pinned to the run before agent dispatch. It changes what guidance a role receives, never the role itself.

- [ ] **Step 1: Write selection tests from the approved behavior.**

  Cover builder/planner/critic/verifier with Flutter, Next.js, and Python components; verify that only component-matching accepted skills are selected; verify an optional security skill can be added for an authentication boundary; and reject selection of an unaccepted or incompatible skill.

- [ ] **Step 2: Implement deterministic selection.**

  Use the accepted feature brief's component ids and tags, not free-form model claims. Sort results deterministically, preserve the reason for each choice, and pin the final manifest to the run so later library changes cannot rewrite a running task's context.

- [ ] **Step 3: Attach selected skills to agent briefs.**

  Extend the contract used for dispatch to carry references and rendered, bounded skill guidance. Existing agent files retain their responsibility; add a requirement that they follow only skills named in their run brief and report which ones were used.

- [ ] **Step 4: Keep conflicts serial by default.**

  Add dependency analysis for multiple components. Parallelize only when component roots, declared interfaces, and shared resource sets prove independent; otherwise obey `uncertainConcurrency`, whose default is sequential.

- [ ] **Step 5: Surface the evidence.**

  Add skill selections and reasons to run map/handoff rendering and the feature/cockpit read model. The UI reports decisions; it must not invent or mutate them.

- [ ] **Step 6: Run focused tests and commit.**

  Run selection, run, contract, and rendering tests. Commit the routing slice.

## Task 5: Create the user-local skill library and project activation records

**Files:**
- Create: `engine/src/schemas/skill-library.ts`
- Create: `engine/src/store/skill-library-store.ts`
- Create: `engine/src/ops/skill-library.ts`
- Modify: `engine/src/mcp/server.ts`
- Modify: `engine/src/web/read.ts`, `engine/src/web/api.ts`, `engine/src/web/codes.ts`
- Test: `engine/tests/schemas/skill-library.test.ts`, `engine/tests/store/skill-library-store.test.ts`, `engine/tests/ops/skill-library.test.ts`, `engine/tests/mcp/server.test.ts`

**Produces:** A content-addressed user-local library and separate project acceptance records.

- [ ] **Step 1: Define the package and acceptance schemas.**

  A package records source URL, immutable revision/digest, license, declared tags, dependency inventory, audit result, and host compatibility claims. A project acceptance records project id/path fingerprint, package digest, enabled components, update policy (`auto`, `review`, `pinned`), and current status. Do not store project policy in the shared library.

- [ ] **Step 2: Implement safe local-library paths.**

  Resolve the user library from a dedicated MjLoop data root, validate all ids before constructing paths, and use content digests to prevent one source update overwriting another. Never place this global library in a repository or under `.mjloop/`.

- [ ] **Step 3: Implement explicit activation and deactivation.**

  An imported package is unavailable to a project until an accepted record exists. Removing one project's acceptance must not delete the package or another project's acceptance.

- [ ] **Step 4: Add read-only library and project-acceptance views.**

  Expose source, revision, license, audit outcome, compatibility outcome, and per-project status. Keep all activation writes behind MCP/guarded config operations.

- [ ] **Step 5: Test isolation.**

  Prove that two projects can accept different digests of the same source, a project cannot see an unaccepted package in selection, and deleting an acceptance does not delete the library package.

- [ ] **Step 6: Run focused tests and commit.**

  Run schema, store, operation, and MCP tests. Commit the library foundation.

## Task 6: Add external discovery, import audit, and sandbox validation

**Files:**
- Create: `engine/src/schemas/skill-import.ts`
- Create: `engine/src/ops/skill-discovery.ts`
- Create: `engine/src/ops/skill-import.ts`
- Create: `engine/src/ops/skill-sandbox.ts`
- Modify: `engine/src/mcp/server.ts`
- Modify: `engine/src/web/read.ts`, `engine/src/web/api.ts`, `engine/src/web/codes.ts`
- Modify: `docs/usage.md`, `docs/usage.ar.md`, `README.md`
- Test: `engine/tests/ops/skill-discovery.test.ts`, `engine/tests/ops/skill-import.test.ts`, `engine/tests/ops/skill-sandbox.test.ts`, `engine/tests/security/skill-import.test.ts`

**Produces:** A staged candidate pipeline: discover → inspect → adapt candidate → sandbox executable content → show evidence → explicit project acceptance.

- [ ] **Step 1: Write tests for source-policy enforcement.**

  Verify GitHub and configured trusted registries are permitted by default; arbitrary web search is rejected unless the project enables it; a result is only a candidate; and a failed candidate cannot reach skill selection.

- [ ] **Step 2: Implement discovery connectors as data-only clients.**

  Return candidate metadata and immutable source references from Skills registries/GitHub search. Use an MCP registry only for discovering MCP tools, not as a substitute for a skill registry. Do not execute repository code or follow model-provided install commands.

- [ ] **Step 3: Implement static inspection.**

  Fetch a pinned revision, enumerate files, parse `SKILL.md`, identify executable files and dependencies, run license/source checks, calculate a digest, and record findings. A failed inspection returns a reason and offers a user-initiated `search alternative` action; it does not silently search again.

- [ ] **Step 4: Implement isolated executable validation.**

  For a package that contains scripts or executable tools, run only declared smoke checks in a disposable sandbox without project files, environment secrets, credential mounts, or write access outside the sandbox. Instruction-only skills skip execution and record that fact.

- [ ] **Step 5: Add update candidates, not in-place updates.**

  Detect a new upstream revision according to the project's update policy. Import it as a new candidate, repeat inspection/sandboxing/compatibility, and require the configured project decision before changing the accepted digest.

- [ ] **Step 6: Surface import reports and test all failure paths.**

  The cockpit displays source, revision, license, static findings, sandbox result, compatibility status, and failure reason. Add tests for malformed metadata, source-policy denial, sandbox failure, missing license, path traversal, stale approval, and alternate-search opt-in.

- [ ] **Step 7: Run security-focused suites and commit.**

  Run focused discovery/import/sandbox/security tests, then the relevant full engine suite. Commit the import pipeline.

## Task 7: Adapt accepted skills to each supported host platform

**Prerequisite:** Do not start until the existing multi-platform migration plan's adapter registry, canonical definitions, installation receipts, conflict handling, and platform capability probes are implemented and independently verified.

**Files:**
- Modify: canonical definition/catalog files introduced by the multi-platform migration
- Create: adapter-neutral skill renderer and per-host renderer tests under `engine/src/platform/`
- Modify: the Claude Code, Codex, Gemini CLI, and OpenCode adapters introduced by that migration
- Test: canonical renderer unit tests, staged installation tests, and opt-in real-host smoke tests per supported platform

**Produces:** A host-specific generated view of a project-approved skill without modifying its downloaded source package.

- [ ] **Step 1: Write adapter compatibility tests.**

  For each host, test native rendering when supported, adapter-emulated isolated dispatch when not native, and an actionable incompatible result when neither is safe. Assert the project contract, selected package digest, tool policy, and source attribution survive rendering.

- [ ] **Step 2: Implement canonical adaptation.**

  Transform only the adapter metadata and supported frontmatter/tool declarations. Preserve the semantic skill body, append the MjLoop project contract layer, and emit a deterministic generated digest. Never copy one host's unsupported fields into another host's file.

- [ ] **Step 3: Make adaptation project-specific and reversible.**

  Generated files belong in adapter-managed roots and are installed transactionally with receipts. An update or removal must preserve user-modified host files and report conflicts rather than overwrite them.

- [ ] **Step 4: Implement the failure decision.**

  If adaptation or host probe fails, show the reason and make `search alternative` a user-initiated action. Do not silently substitute a new external package.

- [ ] **Step 5: Run adapter gates and commit per adapter slice.**

  For each adapter, run renderer tests, staged install tests, and opt-in host smoke tests. Record actual native/emulated/unsupported capability results in the platform doctor report.

## Task 8: Integrate lifecycle, review, execution modes, and end-to-end proof

**Files:**
- Modify: `skills/mjloop-leader/SKILL.md`, `commands/plan.md`, `commands/build.md`, `commands/status.md`
- Modify: cockpit feature/config/run panels and English/Arabic localization files
- Modify: `README.md`, `docs/usage.md`, `docs/usage.ar.md`, `docs/install.md`
- Test: end-to-end fixtures under `engine/tests/integration/`, web panel tests, and platform smoke tests after Task 7

**Produces:** A coherent feature lifecycle visible in the cockpit and usable through commands:

```text
Feature request
  → optional Grill Me interview
  → draft feature brief
  → review/approval or save-only
  → independent plan review
  → plan approval
  → auto/manual build start
  → component-aware skill selection
  → independent verification/review when project policy requires it
  → evidence, feature history, and completion status
```

- [ ] **Step 1: Test the three feature-discovery completion modes.**

  Verify `auto-plan` begins planning only after an approved brief, `review` waits for user approval in the cockpit/CLI, and `save-only` creates no plan or run.

- [ ] **Step 2: Test the independent-plan-review gate.**

  When enabled by project policy, ensure a plan cannot be presented as ready until an independent reviewer checks it against the approved brief and project contract; retain the existing engine fit-check/story gate.

- [ ] **Step 3: Test execution and repair settings.**

  Verify auto/manual build start modes, bounded repair attempts, existing no-progress/cycle limits, and pre-execution operating-budget warnings. No setting may bypass engine verification invariants.

- [ ] **Step 4: Test a mixed Flutter/Next.js fixture.**

  Create a fixture with separate mobile and admin roots. Verify one-component tasks receive only matching skills, proven-independent tasks may run concurrently up to `max_parallel_agents`, and uncertain/shared-interface tasks serialize under the default policy.

- [ ] **Step 5: Test imported-skill lifecycle visibility.**

  Verify the feature page reports selected skills, reasons, source/version/license/audit state, agent usage, and failed-adaptation reasons without exposing secrets or raw executable output.

- [ ] **Step 6: Run release-grade verification and document exceptions honestly.**

  Run targeted suites, full engine tests, typecheck, build, and UI checks. If an existing baseline issue prevents a complete green run, name it separately from this feature's focused results. Update docs only after behavior is proven.

- [ ] **Step 7: Perform independent review before release.**

  Review contract preservation, project isolation, source-policy enforcement, sandbox boundaries, config migration, host adaptation, and end-to-end lifecycle behavior. Fix findings in separate commits and rerun the affected proof.

## Acceptance Matrix

| Scenario | Required result |
|---|---|
| New Flutter feature | Grill Me behavior follows project setting; approved brief routes existing agents to Flutter skills only |
| New Next.js admin feature | Same agents, Next.js skills only; no Flutter context leak |
| Cross-component feature | Parallel only with proven independence; any uncertainty uses the project's default sequential policy |
| Simple task with discovery off | Existing plan flow remains available and unchanged except for an explicit recorded bypass |
| Imported GitHub skill | Candidate is inspected, attributed, sandboxed if executable, then accepted separately per project |
| Imported skill update | New digest becomes a candidate; prior accepted version remains active until project policy allows replacement |
| Unsupported platform conversion | No generated host file is activated; user sees reason and can explicitly search alternatives |
| Existing project config | Parses with safe defaults; no project inherits another project's source/update/discovery settings |
| Dirty MjLoop worktree | Unrelated changes are preserved and never included in feature commits |

## Plan Self-Review

- **Coverage:** Covers the approved interview behavior, question budget, feature-brief approval/revision, per-project settings, component routing, fixed agents/dynamic skills, concurrent-versus-sequential policy, independent plan review, auto/manual execution, bounded repair/quality settings, shared library with project isolation, external search/import/audit/sandboxing, source visibility, update policies, host adaptation, and failure alternatives.
- **Scope:** Split into independently releasable stages. Platform adaptation is explicitly delayed until the pre-existing migration gate is satisfied.
- **Safety:** Uses existing engine locks, strict schemas, guarded web writes, and immutable digests; no external package is trusted or executed merely because it was discovered.
- **Known prerequisite:** The repository's current dirty worktree and the migration plan's baseline/test-discovery gate must be resolved before implementation starts. This plan deliberately makes no claim that either is already resolved.
