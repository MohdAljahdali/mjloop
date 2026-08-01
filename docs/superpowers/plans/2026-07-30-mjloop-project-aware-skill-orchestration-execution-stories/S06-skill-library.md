# S06 — Shared local skill library and project activation

**Purpose:** Download a package once while keeping every project's activation decision independent.

**Depends on:** S05.  
**Files owned:** Library schema/store/operations, narrow MCP/read API additions, and focused schema/store/operation/MCP tests.

## Required work

1. Define a content-addressed package record with source URL, immutable revision, digest, license, tags, dependency inventory, and audit state.
2. Place packages in a dedicated user-local MjLoop data root outside any repository and outside `.mjloop/`.
3. Define a project acceptance record with package digest, enabled component ids, update policy (`auto`, `review`, `pinned`), and current status.
4. Implement explicit activate/deactivate operations. Removing a project acceptance may not delete the shared package or another project's acceptance.
5. Expose source, revision, license, audit, compatibility, and project acceptance state as read-only views.

## Required tests

- Two projects accept different digests of one source without interference.
- A project cannot select an unaccepted package.
- Deactivation preserves the library package and other projects' references.
- All ids are validated before path construction.

## Completion evidence

- S05 can consume only a project acceptance record, not a raw library package.

## Stop conditions

- Do not store global-library paths in project config.
- Do not add a global policy fallback that can silently change a project's source or update policy.
