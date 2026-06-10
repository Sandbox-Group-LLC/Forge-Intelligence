#!/usr/bin/env bash
# UserPromptSubmit — re-injects a one-line live status on EVERY message, so the
# session can't drift/forget what's wired and what's missing. The missing-env
# field is the one that would have caught the wiped ELEVENLABS_API_KEY at the
# first prompt instead of mid-task.
set -uo pipefail
BASE_BRANCH="${BASE_BRANCH:-development}"
# Provider secrets that get wiped on container resets — surfaced every message.
WATCH_ENV=(ANTHROPIC_API_KEY OPENAI_API_KEY ELEVENLABS_API_KEY ADMIN_RELAY_PASSWORD REMOTION_LAMBDA_SERVE_URL)

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" 2>/dev/null || exit 0
BR=$(git branch --show-current 2>/dev/null || echo '?')
BEHIND=$(git rev-list --count HEAD..origin/$BASE_BRANCH 2>/dev/null || echo '?')
SID=$(cat "$ROOT/.claude/.state/session-id" 2>/dev/null || echo)
OK="$ROOT/.claude/.state/preflight-ok"
GATE="closed"; [ -f "$OK" ] && [ "$(cat "$OK" 2>/dev/null)" = "$SID" ] && GATE="open"
# Current task = newest WORKING-STATE block heading (### ...), trimmed.
TASK=$(awk '/^### /{sub(/^### /,""); print; exit}' "$ROOT/WORKING-STATE.md" 2>/dev/null)
MISS=""
for v in "${WATCH_ENV[@]:-}"; do [ -n "$v" ] && [ -z "${!v:-}" ] && MISS="$MISS $v"; done
echo "[session] branch=$BR · behind origin/$BASE_BRANCH=$BEHIND · preflight-gate=$GATE${TASK:+ · now: $TASK}${MISS:+ · missing-env:$MISS}"
