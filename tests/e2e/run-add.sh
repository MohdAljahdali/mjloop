#!/usr/bin/env bash
# Opt-in smoke test of /loop:add against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-add.sh
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

claude -p "/loop:add agent db-reviewer" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

[[ -f .claude/agents/db-reviewer.md ]] || fail "the agent was not written to .claude/agents/"
grep -q "^name: db-reviewer" .claude/agents/db-reviewer.md || fail "no name in the frontmatter"
grep -q "files_touched" .claude/agents/db-reviewer.md || fail "the output contract is not inline"

# Shadowing a shipped agent must be refused.
claude -p "/loop:add agent verifier" --permission-mode acceptEdits --allowedTools "${allowed[@]}" \
  > shadow.log 2>&1
if [[ -f .claude/agents/verifier.md ]]; then
  fail "a shipped agent was shadowed — .claude/agents/verifier.md should not exist"
fi
grep -qi "verifier" shadow.log || fail "the refusal did not name the agent it protected"

rm -rf "${workdir}"
echo "PASS: the scaffold wrote a usable agent and refused to shadow a shipped one"
