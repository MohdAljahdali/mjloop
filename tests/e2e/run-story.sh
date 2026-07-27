#!/usr/bin/env bash
# Opt-in smoke test of a story-driven build against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-story.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture"

allowed=(
  "mcp__plugin_mjloop_mjloop"
  Task Read Edit Write Grep Glob Bash
)

fail() {
  echo "FAIL: $1" >&2
  echo "work directory kept for inspection: ${workdir}" >&2
  exit 1
}

claude -p "/mjloop:init" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

# The approval gate cannot be answered by a person in a headless run, and the
# leader is right to stop rather than approve its own plan. This script proves
# the story-driven build, not the gate — run-plan.sh covers that — so it opts
# the fixture out explicitly, exactly as run-plan.sh does.
node -e '
const fs = require("fs")
const path = ".mjloop/config.yaml"
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("plan_approval: human", "plan_approval: auto"))
'
grep -q "plan_approval: auto" .mjloop/config.yaml || fail "could not switch the approval gate to auto"

# Write the plan and its one story through the tools, the supported path.
claude -p "Using the loop MCP tools only, create a plan with slug 'labels' titled 'Button labels', then add one story titled 'Cancel label' whose acceptance criterion is: src/button.js exports cancelLabel() returning 'Cancel', covered by a test. Then render the index. Do not write any file by hand." \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

[[ -f .mjloop/INDEX.md ]] || fail "INDEX.md was not generated"
grep -q "Button labels" .mjloop/INDEX.md || fail "the plan is missing from INDEX.md"

claude -p "/mjloop:build --next" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

[[ "${status}" == "done" ]] || fail "expected status done, got ${status}"
grep -q "cancelLabel" src/button.js || fail "the export was not added"
grep -rq "status: done" .mjloop/plans/*/stories/ || fail "the story was not marked done"
grep -rq "evidence: .mjloop/runs" .mjloop/plans/*/stories/ || fail "the story carries no evidence path"

rm -rf "${workdir}"
echo "PASS: the story drove the build and carries the proof of its own completion"
