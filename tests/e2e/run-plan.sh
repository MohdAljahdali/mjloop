#!/usr/bin/env bash
# Opt-in smoke test of the plan track against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-plan.sh
#
# Runs with gates.plan_approval: auto. The human path cannot be exercised
# non-interactively — which is precisely what makes it a gate.
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
  "mcp__plugin_loop_loop"
  Task Read Edit Write Grep Glob Bash
)

fail() {
  echo "FAIL: $1" >&2
  echo "work directory kept for inspection: ${workdir}" >&2
  exit 1
}

claude -p "/loop:init" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

# The approval gate cannot be answered by a person in a headless run.
node -e '
const fs = require("fs")
const path = ".loop/config.yaml"
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("plan_approval: human", "plan_approval: auto"))
'
grep -q "plan_approval: auto" .loop/config.yaml || fail "could not switch the approval gate to auto"

claude -p "/loop:plan add a cancelLabel() export to the button module, returning the human label 'Cancel', covered by a test" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- plans ---"
find .loop/plans -type f | sort

plan_dir="$(find .loop/plans -maxdepth 1 -mindepth 1 -type d | head -1)"
[[ -n "${plan_dir}" ]] || fail "no plan directory was created"
[[ -f "${plan_dir}/PLAN.md" ]] || fail "PLAN.md was not written"
[[ -f "${plan_dir}/manifest.json" ]] || fail "manifest.json was not generated"
[[ "$(find "${plan_dir}/stories" -name '*.md' | wc -l)" -ge 1 ]] || fail "no stories were written"
[[ -f .loop/INDEX.md ]] || fail "INDEX.md was not rendered"
grep -q "decision: approved" "${plan_dir}/PLAN.md" || fail "the approval was not recorded"

rm -rf "${workdir}"
echo "PASS: the idea became an approved plan with stories ready to build"
