#!/usr/bin/env bash
# Inject the current loop state into every session that has a .mjloop directory.
# All logic lives in mjloop-cli; this wrapper only moves bytes.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" session-start
