#!/usr/bin/env bash
# SessionStart — installs deps (web runtime only), records the session id,
# force-feeds a briefing into context (git state, recent commits, the live
# WORKING-STATE pointer), and runs the capability preflight (which opens the
# edit gate when required caps are present).
#
# Forge-Intelligence: base branch is `development` (Render's dev service deploys
# from it); single npm package at the repo root.
set -uo pipefail
BASE_BRANCH="${BASE_BRANCH:-development}"

INPUT="$(cat)"
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
mkdir -p "$ROOT/.claude/.state"
SID=$(printf '%s' "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let j={};try{j=JSON.parse(d)}catch{}process.stdout.write(j.session_id||"")})')
[ -n "$SID" ] && echo "$SID" > "$ROOT/.claude/.state/session-id"

# Only install in the remote/web runtime (locally you manage your own deps).
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  ( cd "$ROOT" && [ -f package.json ] && npm install --no-audit --no-fund >/dev/null 2>&1 || true )
fi

cd "$ROOT" 2>/dev/null || true
git fetch origin "$BASE_BRANCH" >/dev/null 2>&1 || true
echo "════════════ session brief ════════════"
echo "branch: $(git branch --show-current 2>/dev/null)  ·  behind origin/$BASE_BRANCH by $(git rev-list --count HEAD..origin/$BASE_BRANCH 2>/dev/null || echo '?') commit(s)"
echo "recent commits:"; git log --oneline -6 2>/dev/null | sed 's/^/  /'
echo "uncommitted: $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') file(s)"
# Live pointer: print the newest WORKING-STATE session block (### heading) so a
# cold session lands on "where we are right now" without opening the file.
if [ -f "$ROOT/WORKING-STATE.md" ]; then
  echo "WORKING-STATE (newest block):"
  awk '/^### /{c++} c==1{print "  "$0} c==2{exit}' "$ROOT/WORKING-STATE.md"
fi
echo
node "$ROOT/.claude/hooks/preflight.mjs" || true
echo
echo "→ Read WORKING-STATE.md + CLAUDE.md. Verify the MCP list (capabilities.json) against your actual tools. Editing/committing is GATED on preflight."
