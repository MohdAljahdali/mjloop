# S07 — External discovery, static audit, and sandbox validation

**Purpose:** Safely turn a discovered external skill into a project-acceptable candidate.

**Depends on:** S06.  
**Files owned:** Import/discovery/sandbox schemas and operations; narrow MCP/read views; documentation; focused discovery/import/sandbox/security tests.

## Required pipeline

1. **Discover:** Search GitHub and project-allowed trusted registries. General web search is permitted only if that project enables it. Return metadata-only candidates.
2. **Inspect:** Fetch a pinned revision; enumerate files; parse `SKILL.md`; identify executable content/dependencies; calculate digest; record source/license/findings.
3. **Sandbox:** If executable content exists, run only declared smoke checks in a disposable environment with no project checkout, credentials, secrets, or host writes. Instruction-only skills record that sandbox execution was skipped.
4. **Decide:** Display report. Create project acceptance only through the configured decision policy. A failure displays its reason and a user-initiated search-alternative action.
5. **Update:** Treat upstream changes as new candidates. Retain the accepted digest until replacement passes the full pipeline.

## Required tests

- Source-policy denial for arbitrary web sources by default.
- No discovery result becomes active automatically.
- Malformed metadata, missing license, path traversal, sandbox failure, stale approval, and failed alternative flow.
- Sandbox receives no project/secret inputs and cannot create host files.

## Completion evidence

- The UI reports source, revision, license, static findings, sandbox result, compatibility status, and failure reason.

## Stop conditions

- Never execute a source-provided install command.
- Never retry another external candidate automatically after a failure.
