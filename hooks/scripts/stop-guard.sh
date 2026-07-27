#!/usr/bin/env bash
# Keep an autonomous loop going when Claude Code would otherwise end the turn.
# Silent unless the project set autonomous: true and a run is still going.
# All logic lives in mjloop-cli; this wrapper only moves bytes.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" stop-guard
