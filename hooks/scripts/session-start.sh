#!/usr/bin/env bash
# Inject the current loop state into every session that has a .loop directory.
# All logic lives in loop-cli; this wrapper only moves bytes.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" session-start
