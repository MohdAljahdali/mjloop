#!/usr/bin/env bash
# Opt-in smoke test of the fix track against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-fix.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

# Plant a real defect: the exported label no longer matches what the caller
# expects, and no test covers the mismatch yet.
cat > src/button.js <<'EOF'
export function submitLabel() {
  return 'Submit'
}

export function primaryLabel() {
  // Defect: returns the raw key instead of the label it maps to.
  return 'submit_label'
}
EOF

git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture with a planted defect"

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
claude -p "/mjloop:fix primaryLabel() returns the raw key 'submit_label' instead of the human label 'Submit'" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

field() {
  node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"
}

status="$(field 'j.status')"
proven="$(field 'j.reproduction ? j.reproduction.proven : false')"

[[ "${proven}" == "true" ]] || fail "the defect was never reproduced (gate stayed shut)"
[[ "${status}" == "done" ]] || fail "expected status done, got ${status}"
grep -q "submit_label" src/button.js && fail "the raw key is still returned — the defect was not fixed"
npm test >/dev/null 2>&1 || fail "the suite does not pass after the fix"

rm -rf "${workdir}"
echo "PASS: the defect was reproduced, fixed at the cause, and the suite is green"
