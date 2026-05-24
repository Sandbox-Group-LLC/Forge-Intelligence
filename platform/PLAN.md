# Event Intelligence Orchestration Platform — MVP Plan

> Working codename: **"Throughline"** (placeholder — the product's value is maintaining one consistent throughline from first touchpoint to closed pipeline). Final name TBD.

---

## Context — why we're building this

Event-tech stacks are fragmented: organizers run Cvent/RainFocus + a mobile app + a matchmaking tool + lead capture + a CRM, and **the data dies between tools**. Swoogo's 2025 Eventscape quantifies it: **44% don't connect their event platform to a CRM, 69% don't connect it to marketing automation** — so event signal never reaches where pipeline/ROI is measured. Event leaders describe this as "the missing link."

The opportunity is a **vendor-neutral, Bring-Your-Own-Tools "system of intelligence"**: a central environment where any event tool connects via API/webhook (two-way, near plug-and-play), and forensic-grade AI keeps **KPIs, goals, voice, audience, content, and context consistent from the first touchpoint through the post-event sales pipeline.**

**Critical reuse insight:** Forge Intelligence (this repo) is *already* a working system of intelligence — in marketing, not events. It has a compounding **Brain** (`brain_patterns`/`brain_mistakes`), a human-in-the-loop **Compliance Gate** (consistency enforcement), a **connector layer** with per-channel vaulted credentials, an analytics→pattern feedback loop, multi-model Claude routing, and an MCP server. The MVP largely **re-points these proven patterns at the event lifecycle** rather than inventing from scratch. Forge then plugs in as **Layer 8 (event journalism)**.

**Locked decisions (from founder):**
- **New standalone repo** (Forge's `server.js` is ~19.5K lines and near its scaling limit; the event data model is fundamentally different).
- **MVP = the "consistency thread"**: one unified event record + AI that keeps KPIs/voice/audience/content/context consistent first-touch → handoff.
- **First connectors = owned IP**: Sandbox-GTM + Engage (full API control, dogfoodable).
- **Intel content-intelligence code** (Layer 3 / call-for-papers): founder grants repo access; port relevant pieces.

---

## Honest market read (informs positioning, not just flavor)

- **Where it's crowded:** the *narrative* "AI orchestration for events." RainFocus **Nexus** ("system of specialized AI agents"), Cvent (which **acquired Goldcast, Dec 2025**) and Goldcast's "agentic AI" / AI Event Analyst are planting flags — **but inside their own walled gardens.**
- **Where the genuine, defensible gap is:** a **neutral layer that ingests competing tools simultaneously** (Cvent + Brella + HubSpot + Salesforce + Attio), maintains lifecycle consistency, and **drives post-event sales-readiness + clean CRM handoff** — the weakest-served, highest-value link, and the part incumbents are structurally disincentivized to build.
- **Positioning:** *"Switzerland for your event stack" + own the handoff.* Defensibility = genuine cross-tool neutrality + the sales-readiness/attribution layer, **not** another agentic-content feature.
- **Top risk:** incumbents use **data-access control** to box out neutral middleware. Mitigation: anchor on **owned IP first** (Sandbox-GTM/Engage), prefer **open-API tools** (HubSpot, Salesforce, Attio, Swapcard, Brella) for early connectors, and degrade gracefully to webhooks/CSV where APIs are partner-gated (RainFocus, Whova).

---

## Product thesis

> Define the event's **North-Star** once (goals, KPIs, target audience/ICP, brand voice, key messages). Connect your existing tools. The platform builds a **unified event record** across them and runs **forensic AI** that continuously flags where reality is drifting from the North-Star — then converts post-event engagement into **sales-ready, CRM-handed-off pipeline.**

Three pillars carry equal weight per the founder: **Quality, UX, Infosec.**

---

## Architecture — six MVP pillars

**1. Event Brain / North-Star (Layer 1 — owned IP).** The source of truth everything is measured against: event goals, structured KPIs, target audience/ICP, brand voice profile, key messages/themes. Plus a light **audience-intelligence** pass (enrich target accounts — the under-served "ABM-for-events" sub-gap). *Ports Forge's `voice_profile` + `settings.factualGround` (Factual Ground) + Territory injection + Brain-First Protocol.*

**2. Connector Fabric (BYO tools — buy the plumbing).** **Nango** as the backbone for durable two-way syncs of core objects (managed OAuth/token vault, unified proxy, typed syncs, self-hostable, SOC 2 Type II). **Pipedream** for long-tail webhooks/automations. MVP wires **Sandbox-GTM + Engage** first; framework designed so HubSpot/Swapcard/Cvent slot in next. *Ports Forge's `publishing_channels` credential pattern, `publish_log`, `/api/webhooks/*` handlers, and the "probe before pivot" rule.* **Lesson from Forge:** don't rebuild gated OAuth pushes naively (HubSpot tier-gate burned 4 rebuilds) — lean on Nango + webhooks.

**3. Unified Event Record (golden record — owned IP).** CDP-for-events data layer on Neon/Postgres: Event → Sessions → Contacts ↔ Accounts, with **identity resolution** (deterministic email/phone + probabilistic fuzzy), survivorship rules, person→account rollup, and **lifecycle stages** (registered → checked-in → session-attended → lead-scanned → opportunity). Anonymous→known resolution is first-class.

**4. Consistency Engine (the "forensic AI" — owned IP, the daily wow).** Multi-model Claude agents continuously compare cross-tool reality against the North-Star and emit **consistency signals / drift alerts**: e.g., "registered audience skews off-ICP," "mobile-app copy drifts from stated value prop," "session content doesn't ladder to KPI X." Human-in-the-loop review. *Ports Forge's Compliance Gate (`/api/compliance/critique|rewrite-section|approve`) + `decay_alerts` + Brain-First Protocol.* Model routing mirrors Forge: **Opus 4.7** for deep consistency reasoning, **Sonnet** for mid-tier analysis, **Haiku** for fast signal checks.

**5. Sales Readiness & Handoff (Layer 7 — owned IP, the differentiator).** Score attendee/account engagement across *all* connected tools, decide sales-readiness, hand off enriched records to CRM (HubSpot first). *Ports Forge's analytics→pattern loop (`content_analytics`, `precog_outcomes`, `/api/analytics/extract-patterns`).* This is the market's weakest link — even a thin version is the killer demo.

**6. Forge Intelligence as Layer 8 (journalism — owned IP, light MVP integration).** Forge ingests the event record + North-Star and produces on-voice recaps/journalism via its existing publishing engine. MVP = a connected module, not a rebuild.

---

## Reuse map — port these proven Forge patterns into the new repo

| New-repo capability | Forge source to port |
|---|---|
| North-Star / voice consistency | `voice_profile`, `brand_profiles.settings.factualGround`, Territory injection (`README.md` "Key Architecture Additions") |
| Cross-event learning Brain | `brain_patterns`, `brain_mistakes`, `agent_coordination`, `agent_activity_log` (`init-schema.sql`); Brain-First Protocol (`README.md` "Brain Architecture") |
| Consistency Engine (AI critique + human loop) | Compliance Gate endpoints in `server.js`: `/api/compliance/critique`, `/rewrite-section`, `/find-sources`, `/approve` |
| Connector credentials + webhooks | `publishing_channels` (per-channel JSONB creds, UTM template, `test_status`), `publish_log`, `/api/webhooks/*` |
| Engagement scoring / drift | `content_analytics`, `decay_alerts`, `precog_outcomes`, `/api/analytics/extract-patterns` |
| Multi-model routing | `README.md` "LLM Routing" table (Opus/Sonnet/Haiku economics) |
| Auth + tenant scoping | Clerk JWT template, `requireAuth`/`softAuth`, brand-scoped → tenant-scoped filtering |
| External AI access | existing `/mcp` JSON-RPC read-only server |
| Design system | 12-directive system (`README.md` "UI Design System": dark base, Intelligence Blue, calm UX, **no emojis**) |
| Hardening utilities | `sanitizeJson()`, SSE streaming pattern, `forgeScrape` (for audience/account enrichment) |

**Anti-pattern to avoid:** do **not** reproduce Forge's single-file 19.5K-line `server.js`. Start modular (routes/services/connectors/agents as separate modules) — Forge itself flags this as its main scaling debt.

---

## New-repo data model (high level, Neon/Postgres)

`organizations` (tenant) · `users`+`memberships` (RBAC, Clerk-mapped) · `events` (holds North-Star JSONB: goals/voice/ICP/themes) · `event_kpis` (structured targets) · `connections` (Nango connection id, provider, scopes, status — analogous to `publishing_channels`) · `contacts` (golden person) · `accounts` (company rollup) · `identity_links` (resolution) · `sessions` + `session_attendance` · `engagements` (normalized cross-tool activity stream) · `consistency_signals` (drift alerts) · `readiness_scores` (per contact/account) · `handoffs` (CRM push log) · `playbook_patterns`/`playbook_mistakes` (cross-event Brain) · `audit_log` (infosec) · `agent_runs` (AI audit).

---

## Build vs Buy (per founder rule: anything not owned-IP/MVP = 100% third party)

- **Build (owned IP):** Pre-event intelligence/North-Star (L1), Connector Fabric orchestration logic, Unified Event Record (L3 data), Consistency Engine, Sales Readiness & Handoff (L7), Event Journalism via Forge (L8). Call-for-papers/content intelligence (L3) seeded from the Intel repo.
- **Buy / integrate (third party):** Event mgmt — Cvent/RainFocus (+ Sandbox-GTM owned); Matchmaking — Brella/Swapcard/Grip; Mobile — EventMobi/Whova; CRM — HubSpot/Salesforce/Attio; Community — Swapcard/Gradual; Lead capture — iCapture/Engage(owned). **Plumbing:** Nango + Pipedream (iPaaS), Clerk (auth), Resend (email), Render (host), Neon (DB), Claude (intelligence). *Note: "Xtag" couldn't be verified as a real product — likely iCapture/Popl/momencio; confirm before listing.*

---

## Infosec (equal pillar — enterprise-safe by SMB-accessible)

- **Inherited compliance story (day 1):** Neon, Render, and Clerk are each **SOC 2 Type II** — credible foundation before our own audit.
- **Ship immediately:** SSO/SAML (Clerk), **RBAC**, **audit logging** (`audit_log`), encryption in transit + at rest (TLS + Neon), data retention + PII minimization, secrets management. **Store connector tokens in Nango's vault, not in our DB** (improves on Forge's JSONB-creds approach).
- **Program:** start SOC 2 Type I → Type II via Vanta/Drata (~6–12 mo, ~$20–100k); publish sub-processor list + DPA; document an ISMS-lite.
- **Known gap to flag:** **Clerk lacks native SCIM** (enterprise user-deprovisioning blocker) — plan a WorkOS fallback for SCIM-heavy enterprise deals.
- Per-tenant data isolation enforced on every query (port Forge's brand-scoped `WHERE` discipline → tenant-scoped).

## UX (equal pillar)

- **Onboarding wizard:** set North-Star in minutes → connect first tool via Nango embedded auth (plug-and-play feel) → see the unified record populate.
- **Home = Consistency Dashboard:** live drift signals, KPI-vs-reality, readiness pipeline. Calm, forensic, not noisy.
- **SMB-accessible:** self-serve signup, sensible defaults, one-click connectors. **Enterprise-safe:** SSO, RBAC, audit, isolation.
- Port Forge's design system (dark foundation `#0F1720`, Intelligence Blue `#3563FF`, Lucide icons, no emojis, calm motion).

---

## Phased roadmap (relative sequencing; spans the consistency thread)

- **Phase 0 — Foundations:** new modular repo; Render + Neon + Clerk; design-system port; infosec baseline (RBAC, audit, encryption); Nango + Pipedream accounts wired.
- **Phase 1 — Event Brain / North-Star (L1):** North-Star wizard (goals/KPIs/voice/ICP) + light audience enrichment via `forgeScrape`/Perplexity.
- **Phase 2 — Connector Fabric + Unified Record:** Sandbox-GTM + Engage via Nango; normalize into golden record; identity resolution; lifecycle stages.
- **Phase 3 — Consistency Engine:** Claude agents emit drift signals; Consistency Dashboard; human-in-the-loop review (ported Compliance Gate).
- **Phase 4 — Sales Readiness & Handoff (L7):** engagement scoring across tools; readiness scores; **HubSpot handoff** (open API, webhooks on all tiers).
- **Phase 5 — Forge as L8:** event record + North-Star → on-voice journalism via Forge's publishing engine.

*MVP demo line = Phases 0–4 on owned IP + HubSpot; Phase 5 is the storytelling flourish.*

---

## Verification (end-to-end)

1. **Dogfood with a real Sandbox-GTM event** (founder owns it): set a North-Star, connect Sandbox-GTM + Engage + a **HubSpot sandbox** via Nango.
2. Confirm the **unified record** populates (registrations → check-ins → lead scans) with correct identity resolution and person→account rollup.
3. Confirm the **Consistency Engine** surfaces at least one true drift signal against the North-Star (e.g., off-ICP registrants).
4. Trigger a **sales-readiness handoff**: a scored contact lands in the HubSpot sandbox as an enriched record.
5. Generate a **Forge recap** on-voice from the event record.
6. **Connector resilience:** simulate a webhook-only/CSV tool to prove graceful degradation when an API is gated.
7. **Infosec checks:** verify tenant isolation (no cross-org leakage), audit-log entries, and that connector tokens live in Nango's vault, not our DB.
8. Validate HubSpot interactions via the GitHub/CRM sandbox + Nango test connections; add automated tests for identity resolution + readiness scoring.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Incumbents (RainFocus/Cvent) restrict API access to box out neutral middleware | Anchor on owned IP first; design fabric to degrade to webhooks/CSV; lead with the handoff layer they won't build |
| Partner-gated APIs (RainFocus, Whova) slow integration | MVP uses open APIs (Sandbox-GTM, HubSpot, Salesforce, Attio, Swapcard, Brella) |
| Pipedream's Workday acquisition (roadmap/independence risk) | Keep core durable syncs in **Nango** (self-hostable); Pipedream only for long-tail |
| Clerk SCIM gap blocks enterprise deals | Plan WorkOS path; document interim manual provisioning |
| Scope creep across 8 layers | MVP = consistency thread on owned IP + 1 CRM; all other layers are post-MVP connectors |
| Crowded "agentic events" narrative | Differentiate on **neutrality + handoff**, not agentic content |

---

## Open follow-ups (not blockers to start)

- Final product name (replace "Throughline" placeholder).
- Intel content-intelligence **repo access** (founder to grant) — port CFP/abstract + scoring logic for L3.
- Pursue Cvent/RainFocus **partner/sandbox API access** for the connector roadmap.
- Confirm true identity of "Xtag" lead-capture tool.
- Budget/timeline/team size to convert relative phases into a dated schedule.
