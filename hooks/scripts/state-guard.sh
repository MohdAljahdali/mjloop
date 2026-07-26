#!/usr/bin/env bash
# Deny hand edits to loop-owned state files.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" state-guard
