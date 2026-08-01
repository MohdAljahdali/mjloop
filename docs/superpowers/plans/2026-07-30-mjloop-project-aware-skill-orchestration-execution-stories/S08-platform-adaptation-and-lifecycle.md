# S08 — Host adaptation and full lifecycle proof

**Purpose:** Render accepted skill packages for Claude Code, Codex, and later supported hosts, then prove the complete feature lifecycle.

**Depends on:** S07 and completed, independently verified multi-platform migration prerequisites.  
**Initial status:** blocked.

## Required work

1. Re-read the multi-platform migration plan and prove the canonical definitions, adapter registry, host capability probes, transactional installation, and clean baseline gates are complete.
2. Add canonical adaptation/rendering tests before adapter changes. For every host, assert native, emulated, and unsupported outcomes explicitly.
3. Render semantic skill guidance plus project contract, package digest, attribution, and tool policy. Do not copy unsupported frontmatter or host-specific fields from another platform.
4. Install generated files only through adapter-managed, hash-aware receipts. Preserve user-modified files and report conflicts.
5. On adaptation failure, stop, show the cause, and permit only a user-initiated alternative search.
6. Add end-to-end fixtures for: discovery mode, approved feature brief, independent plan review, plan approval, auto/manual execution, component selection, configured verification, and evidence.

## Required tests

- Renderer unit tests, staged installation tests, and opt-in real-host smoke tests per supported platform.
- Mixed Flutter/Next.js fixture proves component isolation and configured parallel/sequential behavior.
- Existing config and current Claude behavior remain compatible.
- Full engine typecheck/build/test gate plus documented baseline exceptions.

## Completion evidence

- Platform doctor reports actual native/emulated/unsupported capability state.
- Independent review validates contract preservation, project isolation, import safety, sandbox boundaries, and lifecycle evidence.

## Stop conditions

- If the migration prerequisite is incomplete or baseline is not green, remain blocked. Do not emulate a platform by copying Claude files.
- Do not claim support for a host that its capability probe cannot prove.
