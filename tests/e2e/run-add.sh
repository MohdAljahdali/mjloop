#!/usr/bin/env bash
# Opt-in smoke test of /loop:add against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-add.sh
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT
#
# `/loop:add track` is proven end to end: it edits `.loop/config.yaml`, which
# nothing guards, and validates the result through `config_error`.
#
# `/loop:add agent` is proven as far as a headless run can take it — the name
# is validated and a name that would shadow a shipped agent is refused. The
# write itself is NOT proven here. Claude Code guards `.claude/`, because that
# directory holds settings and hooks, so writing an agent there asks for
# approval and a non-interactive session has no way to give it. Four attempts
# confirmed it: `--allowedTools`, an `Edit(.claude/**)` rule, and a
# project-scoped `.claude/settings.json` all leave the guard in place, and the
# only thing that would get past it is disabling permission checks wholesale —
# which is a worse trade than an untested line.
#
# So the agent write is covered by the interactive path and by no automated
# test. That is stated here rather than papered over with a run that proves
# less than it appears to.
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

# --- 1. A track, end to end -------------------------------------------------
# The sets are given in the prompt: the command is told to ask for them, and a
# headless session has nobody to ask.
claude -p "/loop:add track refactor — required: builder and verifier; available: scout, critic and perf; max_cycles 4" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

grep -q "refactor:" .loop/config.yaml || fail "the track was not added to .loop/config.yaml"
node -e '
const YAML = require("'"${repo_root}"'/engine/node_modules/yaml")
const fs = require("fs")
const config = YAML.parse(fs.readFileSync(".loop/config.yaml", "utf8"))
const track = config.tracks.refactor
if (!track) { console.error("no refactor track"); process.exit(1) }
const required = (track.required || []).join(",")
if (!required.includes("builder") || !required.includes("verifier")) {
  console.error("required is wrong: " + required); process.exit(1)
}
if (!Number.isInteger(track.max_cycles)) { console.error("max_cycles is not an integer"); process.exit(1) }
console.log("track ok: required=" + required + " max_cycles=" + track.max_cycles)
' || fail "the added track is not the shape that was asked for"

# The engine must still consider the config sound after the edit.
config_error="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).config_error))')"
[[ "${config_error}" == "null" ]] || fail "the edit broke the config: ${config_error}"

# --- 2. An agent name that would shadow a shipped agent ---------------------
claude -p "/loop:add agent verifier" --permission-mode acceptEdits --allowedTools "${allowed[@]}" \
  > shadow.log 2>&1

[[ -f .claude/agents/verifier.md ]] && fail "a shipped agent was shadowed — .claude/agents/verifier.md must not exist"
grep -qi "verifier" shadow.log || fail "the refusal did not name the agent it protected"

# --- 3. A valid agent name reaches the write ---------------------------------
# The write is guarded, so this asserts the command got that far and named the
# right destination rather than stopping earlier or writing somewhere else.
claude -p "/loop:add agent db-reviewer" --permission-mode acceptEdits --allowedTools "${allowed[@]}" \
  > scaffold.log 2>&1

grep -q "\.claude/agents" scaffold.log || fail "the scaffold did not name .claude/agents as the destination"
find . -name 'db-reviewer.md' -not -path './.claude/*' | grep -q . \
  && fail "the scaffold wrote the agent somewhere Claude Code will never read"

rm -rf "${workdir}"
echo "PASS: a track was added and validated, and a shadowing agent name was refused"
