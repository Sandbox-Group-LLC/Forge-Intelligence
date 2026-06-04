# GitNexus — shared code-graph brain

GitNexus is a self-hosted **code knowledge graph** that indexes repositories into a
queryable graph (files · functions · classes · methods · call/import/inheritance
edges · auto-detected communities · execution-flow "processes"). It runs as a
remote **MCP server** so any Claude Code session can ask structural questions
about the codebase — "who calls `resolveTenant`", "what's the blast radius of
changing this connector", "trace the readiness-scoring flow" — that grep and
file-reads answer poorly.

One GitNexus instance is a **shared brain across all our repos**: index SYSOI.ai,
Sandbox-GTM, ForgeOS, etc. into the same graph and query any of them (or across
them) from a session in any repo.

## Where it lives

| | |
|---|---|
| Service | **Sandbox Brain** (Render web service `srv-d8dgc268bjmc73a5lup0`, Oregon) |
| Image | `docker.io/mekayelanik/gitnexus-mcp:latest` (upstream: `abhigyanpatwari/GitNexus`) |
| Plan | **Pro** (4 GB RAM / 2 vCPU) — indexing is memory-hungry; Starter's 512 MB OOM-kills on a real repo |
| Disk | 10 GB mounted at `/data` — the indexed graph **and** git credentials persist here across restarts |
| Public URL | `https://sandbox-brain.onrender.com` |
| MCP endpoint | `https://sandbox-brain.onrender.com/api/mcp` (note: `/api/mcp`, **not** `/mcp`) |
| REST API | `https://sandbox-brain.onrender.com/api/*` (analyze/repos/etc.) |

The root path serves a GitNexus SPA; `/docs` and `/redoc` serve the API docs.

## MCP wiring (`.mcp.json`)

Every repo that wants to query the brain carries this entry. It's already in
forgeintelligence.ai's `.mcp.json`:

```json
"gitnexus-remote": {
  "type": "http",
  "url": "https://sandbox-brain.onrender.com/api/mcp"
}
```

- `type: http` (streamable-HTTP transport — one POST endpoint that returns SSE),
  **not** `sse`. Claude Code handles the `Mcp-Session-Id` round-trip automatically.
- No auth header — the server accepts unauthenticated MCP init.
- **MCP servers load at session start.** Editing `.mcp.json` mid-session does
  nothing; restart the session/container for `gitnexus-*` tools to surface.

### MCP tools exposed (v1.6.5)

`list_repos` · `query` (execution-flow search) · `context` (360° view of one
symbol) · `cypher` (raw graph query) · `impact` (blast-radius) · `detect_changes`
(map uncommitted diff → affected flows) · `rename` (graph-aware multi-file
rename) · `route_map` · `tool_map` · `shape_check` · `api_impact` · `group_list`
· `group_sync`.

With multiple repos indexed, pass `"repo":"<name>"` to scope a call (e.g.
`"repo":"forgeintelligence.ai"`); `list_repos` shows what's available. Omit `repo` only when
a single repo is indexed.

## Indexing a repo (the analyze flow)

Indexing is a **REST call**, not an MCP tool — the MCP surface is query-only and
assumes repos are already indexed. The server clones the repo to `/data` and
builds the graph.

```bash
# 1. Kick off (returns {"jobId":"…","status":"cloning"})
curl -X POST https://sandbox-brain.onrender.com/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/Sandbox-Group-LLC/Forge-Intelligence.ai.git"}'

# 2. Poll job status until complete (DON'T use /progress — see gotchas)
curl https://sandbox-brain.onrender.com/api/analyze/<jobId>

# 3. Confirm it landed
curl https://sandbox-brain.onrender.com/api/repos
```

`POST /api/analyze` also accepts `{"path":"/data/<dir>"}` to index a directory
already on the server's disk. Re-running analyze on an indexed repo **refreshes**
it (idempotent).

### Private-repo auth (the credential helper)

GitNexus has **no `GITHUB_TOKEN` env var** — anonymous `git clone` of a private
repo fails with `Authentication failed`. We solved this once, persistently, with
a git credential helper on the `/data` disk:

1. On the Render **Shell** tab for the Sandbox Brain service, a one-time setup
   wrote `/data/.git-credentials` (mode 600, holding
   `https://x-access-token:<PAT>@github.com`) and `/data/.gitconfig`
   (`credential.helper = store --file=/data/.git-credentials`).
2. The service has env var **`GIT_CONFIG_GLOBAL=/data/.gitconfig`** so git picks
   up that config.

Result: `POST /api/analyze` with a **clean** `https://github.com/owner/repo.git`
URL authenticates via the on-disk credential — **no PAT ever rides in a request
body**, and it survives restarts because both files live on the mounted disk.
Adding a new private repo in the org is now just the clean-URL analyze call.

To rotate the PAT: re-write `/data/.git-credentials` from the Render Shell. To
revoke: delete that file (analyze then falls back to anonymous = fails for
private repos, which is the safe default).

## Prompt for other Claude Code sessions

Drop this into a fresh session in any repo you want indexed (the server already
holds org credentials, so no token plumbing is needed agent-side):

```
Index this repo into the shared GitNexus brain at https://sandbox-brain.onrender.com.
The server already has on-disk GitHub credentials for the Sandbox-Group-LLC org,
so no PAT/token plumbing is needed on your side.

Steps:
1. Get the repo's HTTPS git URL from `git remote get-url origin`. If it's the SSH
   form (git@github.com:owner/repo.git), convert it to
   https://github.com/owner/repo.git.
2. POST https://sandbox-brain.onrender.com/api/analyze with {"url":"<https URL>"}
   — returns {"jobId":"…"}.
3. Poll GET https://sandbox-brain.onrender.com/api/analyze/<jobId> every 5s until
   status is "complete" or "failed". Don't use the /progress SSE endpoint —
   Render's edge kills it on cert rotations.
4. On success, GET https://sandbox-brain.onrender.com/api/repos and report the new
   entry's stats (files, nodes, edges, communities, processes, last commit).

Re-running analyze on an already-indexed repo refreshes it — that's fine, report
the new stats. If analyze takes >5 min or the service 502s, stop and report
(likely OOM — needs a bigger Render plan).
```

To actually **query** the brain (not just index) in that session, the repo's
`.mcp.json` must carry the `gitnexus-remote` entry above *before the session
starts*, and the agent scopes calls with `"repo":"<name>"`.

## Gotchas (learned the hard way)

- **MCP path is `/api/mcp`, not `/mcp`.** `GET /mcp` serves the SPA and `POST /mcp`
  404s, so a misconfigured URL makes the harness silently drop the server at
  startup (no tools, no error).
- **Don't tail `/api/analyze/<job>/progress` for the outcome.** It's a long-lived
  SSE stream; Render rotates the `*.onrender.com` TLS cert roughly hourly (seen at
  :35 past), which kills the connection mid-stream and returns a 502 HTML page
  with zero events — even though the analyze *succeeded* server-side. Poll
  `GET /api/analyze/<job>` instead.
- **In-memory job state is lost on restart.** After a crash/redeploy, the job id
  returns `{"error":"Job not found"}` — but a *completed* index persists on
  `/data` (check `/api/repos`). Jobs are ephemeral; the graph is durable.
- **512 MB OOMs on a real repo.** Indexing forgeintelligence.ai (~172 files) peaked >400 MB
  and crashed Starter in ~49 s. Pro (4 GB) finishes the same repo in ~22 s. Keep
  the service on a plan with headroom as more/larger repos get added.
- **Embeddings are off by default** (`embeddings: 0` in the stats). Semantic
  search needs `OPENAI_API_KEY` set on the service; structural query/context/
  impact/cypher all work without it.

## Render quick reference

- Manage via the Render MCP (workspace `tea-d6gtqoh4tr6s73bgmk1g`): `get_service`,
  `get_metrics` (watch `memory_usage` vs `memory_limit` during an index),
  `list_logs` (app logs show `git clone stderr`, `MCP HTTP endpoints mounted at
  /api/mcp`, instance restarts), `update_environment_variables`.
- Shell access: the service's **Shell** tab in the Render dashboard (no SSH key
  needed) drops you into the running container with `/data` mounted.
