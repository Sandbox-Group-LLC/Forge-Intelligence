# Session bootstrap (Claude Code on the web)

Makes a fresh web session boot **warm, gated, and self-aware** instead of cold
and silently-missing-things. Adapted from the claude-web-bootstrap template to
this repo: base branch `development`, reuses `WORKING-STATE.md`/`BUILD-HISTORY.md` as the
live pointer + archive, no Composio (connectors are harness-provided directly).

## What it does

```
session boots
  └─ SessionStart (.claude/hooks/session-start.sh)
        · npm install (web runtime only)
        · prints a brief: branch · behind origin/development · recent commits · newest WORKING-STATE block
        · runs the capability preflight → opens/closes the edit gate
every message
  └─ UserPromptSubmit (user-prompt-status.sh)
        · one-line live status: branch · behind · gate · current task · MISSING watched secrets
any edit / commit / push
  └─ PreToolUse (pre-tool-gate.sh)
        · blocked (exit 2) unless the preflight passed THIS session
```

The payoff for this repo specifically: the **status line surfaces a wiped
`ELEVENLABS_API_KEY` (or OpenAI/relay/Remotion key) at the first prompt** —
the exact failure where a container reset drops a secret and video generation
silently falls back to the wrong voice provider mid-task. The SessionStart brief
catches the other recurring gremlin: the reset that strands the checkout on a
**stale branch behind `development`**.

## Files

| File | Role |
|------|------|
| `capabilities.json` | Source of truth: required CLIs, required vs **watched** env, MCPs, knownBlockers. |
| `.claude/hooks/session-start.sh` | SessionStart: deps + brief + preflight. `BASE_BRANCH=development`. |
| `.claude/hooks/preflight.mjs` / `.sh` | Capability check; writes/removes `.claude/.state/preflight-ok`. |
| `.claude/hooks/pre-tool-gate.sh` | PreToolUse: deny edits/commits until preflight passes this session. |
| `.claude/hooks/user-prompt-status.sh` | UserPromptSubmit: live status line. `WATCH_ENV=` the wipe-prone secrets. |
| `.claude/settings.json.example` | Hook registration → copy to `.claude/settings.json` to activate (human step). |

## Required vs watched env

- **required** (currently empty): a missing one **closes the gate** and blocks all
  edits. Keep tiny — most code edits need no secret.
- **watched**: never blocks, but a missing one is printed on every message. This
  is where the provider keys live (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `ADMIN_RELAY_PASSWORD`, `REMOTION_LAMBDA_SERVE_URL`).

## Activate (one-time, human step)

```bash
cp .claude/settings.json.example .claude/settings.json
git add .claude/settings.json && git commit -m "chore: activate web bootstrap hooks"
```

The agent is blocked by the harness from writing the hook-registration file
itself (self-modification of the permission machinery), so this stays manual.
Hooks bind at session start — **start a fresh session** after activating.

## Honest limit

A hook can't attach a missing MCP to a *running* session or conjure a secret the
sandbox can't see — that's harness physics. It makes the gap **loud and blocking
at boot** so you restart once, deliberately, instead of discovering it deep in.
