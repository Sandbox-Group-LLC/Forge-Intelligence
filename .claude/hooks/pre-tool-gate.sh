#!/usr/bin/env bash
# PreToolUse gate — DENIES file edits and git commit/push until the capability
# preflight has passed THIS session. Reads-and-tests stay allowed (so preflight
# itself can run). exit 2 = block; stderr is fed back to the model.
set -uo pipefail
INPUT="$(cat)"
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
OK="$ROOT/.claude/.state/preflight-ok"

read -r TOOL SESSION CMD <<<"$(printf '%s' "$INPUT" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let j={};try{j=JSON.parse(d)}catch{}
const c=(((j.tool_input||{}).command)||"").replace(/\s+/g," ").slice(0,160);
process.stdout.write((j.tool_name||"-")+" "+(j.session_id||"-")+" "+c)})')"

mut=false
case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit) mut=true ;;
  Bash) printf '%s' "$CMD" | grep -qE 'git[[:space:]]+(commit|push)|npm[[:space:]]+publish' && mut=true ;;
esac

if [ "$mut" = true ]; then
  if [ ! -f "$OK" ] || [ "$(cat "$OK" 2>/dev/null)" != "$SESSION" ]; then
    {
      echo "⛔ PREFLIGHT GATE — edits/commits are blocked until the capability check passes this session."
      echo "   Run:  bash .claude/hooks/preflight.sh"
      echo "   Then resolve any ‼️ items (or surface them to the user). This is the deliberate stop that"
      echo "   prevents discovering a missing tool/secret/MCP deep into the work."
    } >&2
    exit 2
  fi
fi
exit 0
