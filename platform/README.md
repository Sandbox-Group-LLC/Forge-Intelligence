# Event Intelligence Orchestration Platform

> Working codename: **"Throughline"** (placeholder). A vendor-neutral, Bring-Your-Own-Tools **system of intelligence** for the event lifecycle. Connect the event tools you already use; forensic AI keeps **KPIs, goals, voice, audience, content and context consistent from the first touchpoint through the post-event sales pipeline** — then turns engagement into sales-ready, CRM-handed-off pipeline.

This is **Phase 0 scaffolding** — the modular foundation the MVP builds on. It currently lives in a self-contained `platform/` subfolder of the Forge-Intelligence repo and is structured to extract cleanly into its own repository later.

## Why this exists

Event-tech stacks are fragmented and the data dies between tools (Swoogo 2025: 44% of organizers don't connect their event platform to a CRM, 69% don't connect to marketing automation). Incumbents (RainFocus Nexus, Cvent+Goldcast) are building "agentic" intelligence — but only inside their own walled gardens. The gap is a **neutral layer that ingests competing tools simultaneously** and owns the **post-event sales-readiness/handoff** link nobody else does well.

Much of the intelligence machinery is ported from **Forge Intelligence**, which is already a working "system of intelligence" for marketing (compounding Brain, human-in-the-loop consistency gate, connector layer, multi-model Claude routing). Forge plugs in as **Layer 8 (event journalism)**.

## Architecture — six pillars

| Pillar | Module | Status |
|--------|--------|--------|
| 1. Event Brain / North-Star (Layer 1) | `src/modules/northstar` | scaffold |
| 2. Connector Fabric (BYO tools) | `src/modules/connectors` | scaffold (registry live) |
| 3. Unified Event Record (golden record) | `src/modules/record` | scaffold (identity utils live) |
| 4. Consistency Engine (forensic AI) | `src/modules/consistency` | scaffold |
| 5. Sales Readiness & Handoff (Layer 7) | `src/modules/readiness` | scaffold |
| 6. Forge as Layer 8 (journalism) | external (Forge) | future |

## Stack

Node 22 · TypeScript · Express · Neon (Postgres) · Clerk (JWT/JWKS auth) · Nango (connector token vault) · Pipedream (long-tail automations) · Anthropic Claude (multi-model: Opus 4.7 / Sonnet 4.6 / Haiku 4.5) · Resend (email) · Render (host).

**Deliberately modular** — separate `config / db / lib / middleware / modules` rather than Forge's single 19.5K-line `server.js` (its main scaling debt).

## Layout

```
platform/
├── migrations/0001_init.sql     # full data model (tenant-scoped golden record)
├── src/
│   ├── server.ts                # entry
│   ├── app.ts                   # express wiring + /health
│   ├── config/env.ts            # zod-validated env
│   ├── db/                      # Neon pool + migration runner
│   ├── lib/                     # claude routing, logger, sanitizeJson, errors
│   ├── middleware/              # auth (Clerk), tenant, rbac, audit, error
│   ├── modules/                 # the six pillars
│   └── design/tokens.css        # ported design system
```

## Run locally

```bash
cd platform
cp .env.example .env     # fill in DATABASE_URL, CLERK_*, ANTHROPIC_API_KEY, NANGO_SECRET_KEY
npm install
npm run migrate          # apply migrations to Neon
npm run dev              # http://localhost:8080/health
```

`GET /health` reports which integrations are configured. Endpoints not yet built return a structured `501` naming the plan phase and the Forge pattern to port.

## Infosec posture (equal pillar)

- Tenant isolation: `organization_id` on every domain row, enforced on every query.
- Connector secrets live in **Nango's vault**, never in our DB.
- Day-1: Clerk SSO, RBAC (`requireRole`), `audit_log`, TLS + Neon at-rest encryption.
- Inherited SOC 2 Type II (Neon + Render + Clerk); own SOC 2 program is the next milestone. Known gap: Clerk lacks SCIM — WorkOS fallback planned for enterprise deals.

## Status

Phase 0 foundation. See the approved MVP plan for the phased roadmap (North-Star → Connector Fabric + Unified Record → Consistency Engine → Sales Readiness & Handoff → Forge/Layer 8).
