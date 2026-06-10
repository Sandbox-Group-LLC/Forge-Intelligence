#!/usr/bin/env bash
# Thin wrapper so hooks/docs can call a stable path. Runs the capability check.
set -uo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
exec node "$ROOT/.claude/hooks/preflight.mjs"
