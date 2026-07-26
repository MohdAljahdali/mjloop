#!/usr/bin/env bash
# Opt-in smoke test of the build track against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-build.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

# The build track commits the cycle that passes, so the fixture needs to be a repo.
git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture"

# `claude -p` is non-interactive, so a tool awaiting approval has no way to get
# it and the run stalls into a refusal instead of failing loudly.
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
claude -p "/loop:build add a cancelLabel() export to src/button.js returning 'Cancel', with a test covering it" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

[[ "${status}" == "done" ]] || fail "expected status done, got ${status}"
grep -q "cancelLabel" "${workdir}/src/button.js" || fail "the export was not added"
[[ "$(git -C "${workdir}" rev-list --count HEAD)" -gt 1 ]] || fail "the passing cycle was not committed"

rm -rf "${workdir}"
echo "PASS: the build cycle completed, the change landed, and it was committed"
