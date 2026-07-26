#!/usr/bin/env bash
# Opt-in smoke test against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-edit.sh
set -euo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

claude -p "/loop:init" --permission-mode acceptEdits
claude -p "/loop:edit change the submit button label to Send" --permission-mode acceptEdits

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

if [[ "${status}" != "done" ]]; then
  echo "FAIL: expected status done, got ${status}" >&2
  echo "--- run artefacts ---" >&2
  find "${workdir}/.loop/runs" -type f -print >&2
  exit 1
fi

if ! grep -q "Send" "${workdir}/src/button.js"; then
  echo "FAIL: the label was not changed" >&2
  exit 1
fi

echo "PASS: the edit cycle completed and the change landed"
