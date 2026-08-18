---
name: "sandbox-cortex"
description: "Work with Sandbox Cortex — the fleet's retrieval brain: query the live API or DB, load corpora, run the anonymizer, respect tenant/T2 invariants."
---

# Sandbox Cortex

Work with Sandbox Cortex — the Sandbox fleet's retrieval brain. Tenant-isolated corpus
(RAW/T1) → anonymized patterns (T2) → served to agents/services. **No model weights**:
pipelines + Neon pgvector + Claude reasoning. Write-path stays with producing services;
Cortex is the fleet-wide READ layer.

## Live API (deployed 2026-08-15)

- **Base:** `https://cortex.forge-os.ai` (Coolify app `y1lhcbsjxwawvtfeshw2x9yd` on forge-c; DNS A → 24.199.76.255)
- **Auth:** `Authorization: Bearer <token>` — tokens in `op://Openclaw/CORTEX_SERVICE_TOKENS/password`
  (format `token:consumer:tenant1|tenant2`; consumers: sandy, sysoi, pitchbox → tenant sandbox;
  gibson → sandbox|czarnowski). Every query is tenant-filtered by token; no unscoped access.
- **Endpoints:** `GET /health` (public) · `POST /api/query` `{q, kind?, top_k?}` semantic ·
  `GET /api/dossiers?company=&fit=&limit=` structured · `GET /api/dossiers/{doc_id}` full doc ·
  `GET /api/docs` OpenAPI.
- **Consumer env staged:** Sandy (Render srv-d9j7jlfaqgkc73b38d40) + SYSOI (srv-d89p4lm7r5hc73do9mo0)
  both have `CORTEX_API_URL` + `CORTEX_API_TOKEN` set. Code integration (client/tool) = follow-up per repo.

## Facts

- **Repo:** `Sandbox-Group-LLC/Sandbox-Cortex` · clone `~/.openclaw/workspace/projects/sandbox-cortex/`
  · branch `agent/gibson`, ship via PR (`main` = deploy branch). Canon: `docs/DESIGN.md`.
- **Neon:** project **`morning-fog-96335417`** (org `org-small-firefly-14254859`, us-east-2, pg17).
  Conn: `op://Openclaw/SANDBOX_CORTEX_DATABASE_URL/password`. Neon API: `op://Openclaw/NEON_API_KEY/password`
  (REST only — neonctl OAuth dead headless; pass `org_id` on project create).
- **Embeddings:** OpenAI `text-embedding-3-small` (1536d) on `op://Openclaw/OPENCLAW_OPENAI_API_KEY/password`.
  Chunks 1500/200 overlap. Swap-seam: single embed() per script.
- **Corpus (2026-08-15):** 575 docs / 4,196 chunks — 573 MailForge dossiers (tenant sandbox,
  kind dossier, meta: company/domain/instance/fit_verdict) + 2 czarco RFP copies (tenant czarnowski).
  **Nightly delta cron** `cortex-dossier-delta` (3am PT, main-session systemEvent) runs
  `ingest/load_dossiers.py` for both MailForge instances (idempotent by source_ref).
  Drive dossier mirror EXTERMINATED 2026-08-15 (folder trashed, storePitchInDrive no-op'd).
- **Python env:** `projects/sandbox-cortex/.venv` (presidio, en_core_web_md, psycopg, fastapi).

## Invariants (NEVER violate)

1. Every content row carries `tenant_id`; retrieval always filters on it (+ `acl_scope`).
2. Cross-tenant queries touch ONLY `pattern_pursuits`, and only with **k≥3** distinct source pursuits.
3. `token_maps` is never embedded, exported, or committed; real client names never leave RAW.
4. Nothing enters T2 for a tenant without: written T2 grant + anonymizer run + Brian spot-check.
5. `pattern_pursuits` stays a pure derivation of RAW (tenant deletion → rebuild works).
6. No corpus ingest without naming its first weekly query (anti-zombie; RIP Sandbox Brain v1).

## Recipes

**Query the live API:**
```bash
TOK=$(op read "op://Openclaw/CORTEX_SERVICE_TOKENS/password" | tr ',' '\n' | grep ":gibson:" | cut -d: -f1)
curl -s -X POST https://cortex.forge-os.ai/api/query -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -d '{"q":"...","kind":"dossier","top_k":5}'
```

**Load a pursuit / dossier delta:** see `ingest/load_pursuit.py` and `ingest/load_dossiers.py`
(both need DATABASE_URL + OPENAI_API_KEY; dossier loader also MAILFORGE_DB, instances:
canonical=Render srv-d8ldgiernols73e9jgug, pitchbox=srv-d94djgeq1p3s73beogl0, key DATABASE_URL).

**Anonymize before any T2 promotion:** `anonymizer/poc.py --seed-orgs "..."` → grep report
for LEAK → Brian spot-check.

## Gotchas

- **Presidio has NO generic ORG entity** — per-tenant seed lists + Claude review pass before T2.
  Leak checks need `\b` word boundaries ("Intel" ⊂ "intelligence").
- 1P first: `export OP_SERVICE_ACCOUNT_TOKEN="$(cat ~/.openclaw/credentials/onepassword/service-account-token)"`.
- czarnowski is **T1 only** until written T2 grant (ask draft: `docs/czarnowski-data-ask.md`, Brian sends).
- Seed RFP copies have HubSpot template bleed (rfp56) — replace when real Czarnowski data lands.
- Not yet built: T2 promotion pipeline, pattern layer serve (k≥3 gate), MCP server, capture loop.
- Shell-work crons MUST be main-session systemEvent (isolated agentTurn gets exec stripped).
