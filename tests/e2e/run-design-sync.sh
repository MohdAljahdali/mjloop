#!/usr/bin/env bash
# Opt-in smoke test of design-system extraction against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-design-sync.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

allowed=(
  "mcp__plugin_loop_loop"
  Task Read Edit Write Grep Glob Bash
)

fail() {
  echo "FAIL: $1" >&2
  echo "work directory kept for inspection: ${workdir}" >&2
  exit 1
}

claude -p "/loop:init" --permission-mode acceptEdits --allowedTools "${allowed[@]}"
claude -p "/loop:design-sync" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- design system ---"
cat .loop/design-system.md 2>/dev/null || fail "design-system.md was not written"

grep -q "extracted_at:" .loop/design-system.md || fail "no extracted_at in the frontmatter"
grep -q "sources:" .loop/design-system.md || fail "no sources list in the frontmatter"
# The extraction must name a file it actually read, not one it imagined.
grep -qE "tokens\.css|card\.js|button\.js" .loop/design-system.md || fail "no real source file is named"
grep -q "color-accent" .loop/design-system.md || fail "the token file was not actually read"

rm -rf "${workdir}"
echo "PASS: the design system was extracted from files that exist"
