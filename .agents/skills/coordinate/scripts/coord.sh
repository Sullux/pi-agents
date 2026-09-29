#!/usr/bin/env bash
# Backward-compatible shim for coord.js
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/coord.js" "$@"
