#!/usr/bin/env bash
# Opt-in smoke test against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-edit.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

# `claude -p` is non-interactive, so a tool awaiting approval has no way to get
# it and the run stalls into a refusal instead of failing loudly. Every tool the
# cycle needs is granted up front: the loop MCP server for the leader, and the
# file and shell tools the editor and verifier agents run on.
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
claude -p "/loop:edit change the submit button label to Send" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

if [[ "${status}" != "done" ]]; then
  echo "--- run artefacts ---" >&2
  find "${workdir}/.loop/runs" -type f -print >&2 2>/dev/null || true
  fail "expected status done, got ${status}"
fi

grep -q "Send" "${workdir}/src/button.js" || fail "the label was not changed"

rm -rf "${workdir}"
echo "PASS: the edit cycle completed and the change landed"
