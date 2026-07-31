# Project-Aware Skill Orchestration — Codex Execution Stories

This packet is generated from the reviewed implementation plan and its review. It is intentionally explicit: a Codex executor must use only the inputs, files, interfaces, and acceptance criteria stated in the selected story. If a required fact is absent, it must stop and report a blocker instead of inventing an implementation.

## Execution graph

```text
S01 baseline
  └─ S02 project profile and policy
       └─ S03 Feature Discovery skill
            └─ S04 immutable feature briefs
                 └─ S05 dynamic skill selection
                      └─ S06 local skill library and activation
                           └─ S07 external discovery, audit, sandbox
                                └─ S08 host adaptation and lifecycle proof
```

## Universal execution rules

- Do not alter pre-existing dirty worktree files unless a story explicitly owns them and the current diff is reviewed first.
- Do not create a permanent technology-specific agent. Existing roles receive selected skills through their run brief.
- Do not hand-edit protected MjLoop state, generated manifests, indexes, or host-generated files.
- Do not execute an external skill, source-provided install command, or package script outside S07's disposable sandbox.
- Do not proceed when an acceptance criterion is unverifiable. Record a blocker with the missing fact and affected story.
- Follow the test-first cycle in each story: add focused test → observe expected failure → implement smallest behavior → rerun focused test → run listed regression tests → attach evidence.
- Create one atomic commit per completed story only after its listed tests pass. Do not include unrelated control-center changes.

## Story matrix

| Story | Initial status | Hard blockers | Can begin when |
|---|---|---|---|
| [S01](S01-baseline.md) | ready | None | Immediately; read-only |
| [S02](S02-project-profile-and-policy.md) | blocked | S01 | S01 records a safe baseline |
| [S03](S03-feature-discovery.md) | blocked | S02 | Accepted component map/policy interfaces exist |
| [S04](S04-feature-briefs.md) | blocked | S03 | Discovery skill output contract exists |
| [S05](S05-dynamic-skill-selection.md) | blocked | S04 | Approved brief and accepted profile APIs exist |
| [S06](S06-skill-library.md) | blocked | S05 | Selection schema accepts project activation records |
| [S07](S07-external-discovery-and-audit.md) | blocked | S06 | Immutable library/acceptance model exists |
| [S08](S08-platform-adaptation-and-lifecycle.md) | blocked | S07; multi-platform migration gate | Existing adapter foundation is independently green |

`S08` must not start merely because S07 is complete. It also requires the clean-baseline and adapter prerequisites in `docs/superpowers/plans/2026-07-29-mjloop-multi-platform-migration.md`.
