# Forge Intelligence — Master SSOT

> **Last updated:** March 26, 2026 (6:16 PM PDT) | **Status:** Phase 1 — Active Build
> **This README is the single source of truth for all AI sessions, dev work, and project decisions.**
> When starting a new AI session, read this file top to bottom before touching anything.

---

## What Is This

**Forge Intelligence** is a premium B2B marketing intelligence platform.

**The core idea:** Every AI content tool solves for production volume. None solve for *compounding content intelligence* — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product.

**One-liner:** Forge Intelligence turns fragmented marketing activity into clear intelligence and confident action.

**Descriptor:** The intelligence layer behind modern marketing.

**Brand promise:** Turn fragmented marketing activity into clear intelligence and confident action.

---

## Current Build Status (as of March 26, 2026 — ~12:30am)

### ✅ What Is Live Right Now

| Component | Status | Notes |
|-----------|--------|-------|
| Landing page | ✅ LIVE | `forgeintelligence.ai` — fully styled, waitlist capture working |
| Waitlist email capture | ✅ LIVE | Resend wired, emails delivering |
| `/context-agent` workspace | ✅ LIVE | Full UI built + styled with 12-directive design system |
| Context Agent backend | ✅ LIVE | Stage 1, Claude Sonnet 4.6, Brain-First protocol |
| GEO Strategist backend | ✅ LIVE | Stage 2, Claude Sonnet 4.6, 12 topics, per-platform scoring |
| `/geo-strategist` workspace | ✅ LIVE | Topical Authority + GEO Opportunities + Entity & Schema + GEO Brief tabs |
| `/authenticity-enricher` workspace | ✅ LIVE | Stage 3 UI — Brain selector, Run Enrichment, E-E-A-T output |
| Authenticity Enricher backend | ✅ LIVE | Stage 3, Claude Sonnet 4.6, E-E-A-T + SME signals + author schema |
| NeonDB brand profiles | ✅ LIVE | Persisting on every call, cache hits working |
| Activity logging | ✅ LIVE | `agent_activity_log` table, tokens + latency tracked |
| Real `brandProfileId` | ✅ LIVE | Returns UUID on every call, `cached: true` on repeat |
| Render deployment | ✅ LIVE | Auto-deploys on push to main |

### 🔲 What Is NOT Built Yet

- Stage 3 — Authenticity Enricher agent
| Stage 4 Content Generator | ✅ LIVE | `/content-generator` — SSE streaming, Brain-First, confidence scoring, per-brand `generated_content_{uuid}` table |
- Stage 5 — Compliance & Human Refinement Gate
- Stage 6 — Publishing & Distribution
- Stage 7 — Performance Intelligence
- Stage 8 — Pattern Extractor / Feedback Loop
- Admin dashboard (agent activity log UI)
- Pre-seed / bulk brand brain seeding script
- HubSpot, WordPress, Webflow integrations

---

## Infrastructure

### Hosting & Services

| Service | Details |
|---------|---------|
| **Repo** | `github.com/Sandbox-Group-LLC/Forge-Intelligence` |
| **Branch** | `main` (auto-deploys to Render) |
| **Render service** | `srv-d726u7ea2pns739kopmg` |
| **Live domain** | `forgeintelligence.ai` (Hostinger DNS → Render CNAME) |
| **Render URL** | `forge-bysandbox.onrender.com` |
| **Email** | Resend — waitlist capture + future digests/alerts |

### NeonDB

**Three databases:**

```
forge_platform       ← shared platform tables (clients, users, billing, activity log)
forge_brain          ← default brain DB (used for Phase 1 testing)
forge_brain_{uuid}   ← per-client brain (provisioned at signup, Phase 2+)
```

**`forge_platform` tables (all confirmed created):**
- `brand_profiles` — voice profile, personas, competitive gaps, third-party signals
- `agent_activity_log` — every agent call, tokens used, latency, status
- `clients` — client records
- `users` — user accounts
- `billing` — billing records

**`forge_brain` tables (all confirmed created via `brain/schema.sql`):**
- `memories` — vector embeddings (pgvector, HNSW index on cosine ops)
- `patterns` — structured wins, success rates, confidence scores
- `mistakes` — failures + human feedback + guardrails generated
- `agent_coordination` — multi-agent sync log
- `brand_profiles` — per-brain brand profile
- `geo_briefs` — Stage 2 output
- `enriched_briefs` — Stage 3 output
- `generated_content_{brandProfileId}` — Stage 4 output (per-brand table, auto-provisioned on first generate call)

**Active `NEON_DATABASE_URL`** points to `forge_platform`. Set in Render environment variables.

### Environment Variables (set in Render)

See `Content Platform Global Env Vars.docx` in repo for full list. Key vars:
- `ANTHROPIC_API_KEY` — Claude Sonnet 4.6
- `NEON_DATABASE_URL` — forge_platform connection string
- `RESEND_API_KEY` — email delivery

---

## Repo Structure

```
/
├── README.md              ← THIS FILE. SSOT. Read before touching anything.
├── Whiteboard             ← Full product spec (8-stage workflow, detailed architecture)
├── server.js              ← Main Express server + all API routes
├── src/
│   ├── agents/
│   │   ├── stage1_context_agent/
│   │   │   ├── index.ts   ← Context Agent — fully wired, live
│   │   │   └── tools.ts   ← Scraper tools
│   │   ├── stage2_geo_strategist/
│   │   │   └── system_prompt.md   ← Prompt spec written, wired in server.js
│   │   └── stage3_authenticity_enricher/
│   │       └── system_prompt.md   ← Prompt spec written, agent LIVE
│   │   └── stage4_content_generator/
│   │       └── system_prompt.md   ← Brain-First, confidence tiers, E-E-A-T injection format
│   └── tools/
│       └── scraper.ts     ← Brand/review/competitor scraper (Claude direct prompt, no tool-calling)
├── brain/
│   └── schema.sql         ← Full NeonDB schema for Client Brain
├── public/                ← Static assets, landing page files
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## API Endpoints (Live)

### `GET /`
Returns platform health JSON.

### `GET /health`
Returns service status + uptime.

### `POST /api/v1/context`
**The main Stage 1 endpoint.**

```json
// Request
{
  "clientId": "550e8400-e29b-41d4-a716-446655440000",  // Must be valid UUID
  "url": "https://example.com",
  "competitors": ["competitor1.com", "competitor2.com"]
}

// Response (first call — fresh)
{
  "status": "complete",
  "stage": 1,
  "brandProfileId": "799a5acf-8bbf-4beb-a704-b5adb07a5a37",
  "cached": false,
  "profile": {
    "voice_profile": { "formality_score", "confidence_score", "complexity_score", "brand_vocabulary", "tone_summary" },
    "personas": [{ "title", "primary_pain_point", "trigger_event", "skepticism" }],
    "third_party_signals": { "customer_power_phrases", "friction_points" },
    "competitive_gaps": { "competitor_owned_topics", "white_space" }
  }
}

// Response (repeat call — cache hit, instant return)
{
  "status": "complete",
  "stage": 1,
  "brandProfileId": "799a5acf-8bbf-4beb-a704-b5adb07a5a37",
  "cached": true,
  "profile": { ... }
}
```

**Important:** `clientId` must be a valid UUID v4. Auto-generation of UUID server-side if non-UUID is passed is on the backlog.


### `POST /api/authenticity-enricher/analyze`
**Body:** `{ brandProfileId, geoBriefId?, manualInputs?, force? }`  
**Returns:** E-E-A-T scores, SME signals, injection map, enriched brief sections, author schema, confidence score, gaps + manual input prompts  
**Tools:** Perplexity SME scraper → E-E-A-T scorer → Voice/Persona mapper → Enriched Brief assembler

---

### `POST /api/geo-strategist/analyze`
**The main Stage 2 endpoint.**

```json
// Request
{
  "brandProfileId": "799a5acf-8bbf-4beb-a704-b5adb07a5a37"
}

// Response
{
  "success": true,
  "data": {
    "topicalAuthorityMap": [
      {
        "topic": "AI Training Infrastructure Leadership",
        "citationProbability": 92,
        "coverage": "NVIDIA dominates discourse with CUDA ecosystem and H100/A100 citations",
        "priority": "high"
      }
    ],
    "geoOpportunities": [
      {
        "topic": "Sovereign AI and Local Inference",
        "chatgpt": 72, "perplexity": 75, "aiOverviews": 68, "gemini": 71,
        "quickWin": true
      }
    ],
    "entitySchema": { ... },
    "geoBrief": { ... },
    "opportunityScore": 74,
    "cached": false
  }
}
```

**Caching:** Results stored in `geo_briefs` table in NeonDB. Stale cache auto-detected (topics named "Unknown" or zero scores trigger fresh run).


### `POST /api/content-generator/generate`
**Stage 4 — Content Generator (streaming)**

**Body:** `{ brandProfileId, enrichedBriefId?, force? }`

**Response:** Server-Sent Events (SSE) stream — article body chunks with confidence metadata

**Brain-First:** Reads `brand_profiles`, `geo_briefs`, `enriched_briefs` before generating a single word.

**Output stored in:** `generated_content_{brandProfileId}` table (per-brand, UUID-keyed)

**Confidence tiers (per section):**
- 🟢 Green — high Brain pattern match, auto-approvable
- 🟡 Yellow — SME input needed or fact needs verification  
- 🔴 Red — explicit human decision required

> **Multi-tenancy note:** Current UI allows manual brand/brief selection for dev/test purposes.
> Production refactor required: remove brand selector, scope all calls to authenticated client's brandProfileId only.

### `POST /api/waitlist`
Captures waitlist email, stores in DB, sends confirmation via Resend.

---

## The Context Agent (Stage 1) — How It Works

**Model:** Claude Sonnet 4.6

**Brain-First Protocol:** Before any action, agent checks `brand_profiles` for existing data. Cache hit = instant return, zero Claude tokens spent.

**On cache miss:**
1. Fires Claude Sonnet 4.6 with brand analysis prompt
2. Claude analyzes the URL + competitor list
3. Returns structured JSON (voice profile, personas, competitive gaps, third-party signals)
4. Persists to `brand_profiles` in NeonDB
5. Logs call to `agent_activity_log` (tokens used, latency, status)
6. Returns `brandProfileId` + full profile

**Files:**
- `src/agents/stage1_context_agent/index.ts` — full agent logic
- `src/tools/scraper.ts` — scraping tools (Claude direct prompt, NOT tool-calling API — SDK version locked at `^0.39.0` to avoid TS type conflicts)

**Known issue / backlog:** `clientId` must be sent as UUID from client. Server-side auto-generation of UUID if string is passed = backlog item.

---

## UI Design System

### Design Principles (12-Directive System)

The UI is built on these non-negotiable directives, applied to all screens:

1. **Dark foundation** — `#0F1720` base, `#1E293B` cards/panels
2. **Intelligence Blue accent** — `#3563FF` primary CTA, active states
3. **Signal Teal secondary** — `#14B8A6` for positive states, insight signals
4. **Proof Amber highlight** — `#F5B942` sparingly, never dominant
5. **Inter/Geist typography** — modern neo-grotesk, strong hierarchy, generous spacing
6. **Slightly rounded corners** — 10–14px radius. Not sharp. Not pill.
7. **Lucide icons** — 1.5 stroke weight, round caps, consistent across all UI
8. **Subtle motion** — purposeful transitions only (hover depth, graph movement, signal pulses)
9. **Grid-based layout** — modular, reusable components, progressive information density
10. **Real product UI over abstract decoration** — dashboards, signal maps, workflow diagrams
11. **Calm UX** — no noise, no gratuitous animation, no clutter
12. **Brand continuity** — landing page visual language = app visual language. No seam.

### Screens Built

- **Landing page** (`forgeintelligence.ai`) — hero, interrupt, 3 pillars, moat section, GEO FAQ bait, waitlist CTA
- **`/context-agent` workspace** — fully styled, wired to live API, shows brand profile output
- **`/geo-strategist` workspace** — fully styled, 4-tab layout (Topical Authority, GEO Opportunities, Entity & Schema, GEO Brief), wired to live API

### Screens NOT Built Yet

- Admin dashboard (agent activity log)
- Stage 3 Enriched Brief workspace
- Stage 4 Content generation workspace
- Client brain viewer
- Billing / account management

---

## The 8-Stage Workflow (Product Architecture)

```
[1. Context Hub] → [2. GEO Strategy] → [3. Authenticity Enrichment]
↑                                                      ↓
[8. Feedback Loop] ←— [7. Performance] ←— [6. Publish] ←— [5. Compliance] ←— [4. Generation]
```

See `Whiteboard` file for full detailed spec on all 8 stages. Summary:

| Stage | Name | Status | Agent | Model |
|-------|------|--------|-------|-------|
| 1 | Context Hub | ✅ LIVE | Context Agent | Claude Sonnet 4.6 |
| 2 | GEO Strategy | ✅ LIVE | GEO Strategist | Claude Sonnet 4.6 |
| 3 | Authenticity Enrichment | 🔲 Not built | Authenticity Enricher | Gemini 2.5 Pro |
| 4 | Multimodal Generation | 🔲 Not built | Generator | Gemini 2.5 Pro |
| 5 | Compliance & Human Gate | 🔲 Not built | Compliance Agent | Claude Sonnet 4.6 |
| 6 | Publishing & Distribution | 🔲 Not built | Publishing Agent | — |
| 7 | Performance Intelligence | 🔲 Not built | Performance Agent | Claude Sonnet 4.6 |
| 8 | Feedback Loop | 🔲 Not built | Pattern Extractor | Claude Opus 4.6 |

---

## Client Brain Architecture

Each client gets an isolated NeonDB instance with pgvector. Multi-agent shared memory.

```
Client Brain (NeonDB + pgvector)
├── memories          — vector embeddings (what was published, performance outcome)
├── patterns          — what worked (success rate, confidence, recency weight)
├── mistakes          — what failed + human feedback + guardrail generated
├── agent_coordination — multi-agent sync log
└── Predictive Guardrails (derived, not a table)
```

**Brain-First Protocol (mandatory on every agent):**
```
BEFORE any action:
  1. Read Mistakes relevant to this task
  2. Read Patterns that succeeded in this context
  3. Read Memories of similar past content
  4. THEN act — informed by all three
```

**The Compounding Effect:**
```
Day 1:    Brain empty. Agents start from brand context only.
Week 4:   10–15 patterns. Agents prefer proven structures.
Month 3:  50+ patterns. 20+ guardrails. Human edit rate drops ~30%.
Month 6:  Personas behavioral. Agents self-correct before human review.
Month 12: Brain is a proprietary asset. Switching = starting over.
```

---

## LLM Routing

| Agent/Task | Model | Reason |
|------------|-------|--------|
| Context Agent (Stage 1) | Claude Sonnet 4.6 | Reasoning/planning, pattern extraction, structured JSON |
| GEO Strategist (Stage 2) | Claude Sonnet 4.6 | Multi-step competitive reasoning → structured brief |
| Authenticity Enricher (Stage 3) | Gemini 2.5 Pro | Voice matching, natural E-E-A-T injections |
| Multimodal Generator (Stage 4) | Gemini 2.5 Pro | Publishable copy generation |
| Compliance Agent (Stage 5) | Claude Sonnet 4.6 | Structured rule checking, fast + precise |
| Pattern Extractor (Stage 8) | Claude Opus 4.6 | Complex reasoning: performance analysis, guardrail gen |
| Pre-cog Scorer | Claude Opus 4.6 | Probabilistic reasoning across Brain data |
| GTM Strategy layer | GPT 5.2 | Branding, tone, positioning |

**SDK:** Anthropic SDK pinned to `^0.39.0` in `package.json`. Do NOT upgrade without testing — tool-calling types changed between versions and broke builds previously.

---

## Brand Platform

### Identity

- **Brand name:** Forge Intelligence
- **Descriptor:** The intelligence layer behind modern marketing
- **Mission:** Help marketers see clearly, act faster, and prove what drives growth
- **Vision:** A world where every marketer operates with the clarity of a full intelligence team

### Tagline Options
- "The intelligence layer behind modern marketing."
- "From fragmented signals to measurable growth."
- "Clearer signals. Smarter marketing."
- "See what matters. Act with confidence."

### Voice Attributes
- Intelligent, not academic
- Confident, not inflated
- Clear, not simplistic
- Human, not robotic
- Strategic, not buzzword-heavy

### Color Palette

| Name | Hex | Usage |
|------|-----|-------|
| Charcoal | `#0F1720` | Base background |
| Graphite | `#1E293B` | Cards, panels |
| Cloud | `#F8FAFC` | Light backgrounds |
| Stone | `#D0D7E2` | Borders, dividers |
| Intelligence Blue | `#3563FF` | Primary accent, CTAs |
| Signal Teal | `#14B8A6` | Secondary, insight states |
| Proof Amber | `#F5B942` | Highlight only |

### Anti-Patterns (never do this)
- Do not over-emphasize events, registrations, or live experiences
- Do not use neon-cyberpunk aesthetics
- Do not use overly playful consumer UI
- Do not rely on abstract AI visuals with no product proof
- Do not make the brand feel like a narrow point solution
- Do not use buzzword stacking or startup clichés

---

## GTM Strategy

### Phase 0 — Sandbox Method (Dogfooding)

**Goal:** Use Forge to launch Forge. Test the full funnel in a controlled environment.

**The Frictionless Hook:**
- Input: Just a URL. No forms, no onboarding calls.
- 7 minutes → Full Brand Intelligence Profile (Voice, 3 Personas, Competitive Gap Map)
- CTA: "Generate first content package" ($29 trial or $99/mo)

**The Magic Moment:** User sees their brand understood better in 7 minutes than their last agency understood it in 3 months.

### Sandbox-GTM Integration (The Differentiator)

Forge connects to the broader Sandbox Group ecosystem:
- **Sandbox-GTM** event registration + live experience data feeds directly into Forge Client Brain
- What attendees say/do/engage with at live events becomes proprietary content intelligence
- Post-event content cadence is generated from actual event behavioral data
- **Moat:** "We turn your live experiences into content intelligence." No standalone AI tool can replicate physical event data ingestion.

### Pricing

| Tier | Phase | Price | Value |
|------|-------|-------|-------|
| SMB Standard | 1 | $99/mo | Brand Intelligence + Enriched Briefs |
| Agency Standard | 1 | $499/mo | Multi-client briefs + competitive snapshots |
| Pro | 2 | $299/mo | Full content generation + approval gate |
| Agency Pro | 2 | $799/mo | Agency generation + client publishing |
| Enterprise | 3 | $599/mo | Full intelligence loop + ROI dashboard |
| White-label | 4 | Custom | Agency network licensing |

### Unit Economics

| Component | Per Client/Month | Notes |
|-----------|-----------------|-------|
| NeonDB + pgvector | ~$20 | Scales with usage |
| LLM calls | $0.50–$2/brief | Model routing keeps lean |
| EasyCron | Negligible | — |
| Resend | $0.10/1k emails | — |
| **Total COGS** | ~$25/mo | $99 SMB = ~75% margin |

---

## Build Roadmap

### Phase 1 — Context Intelligence Engine (Months 1–3) ← WE ARE HERE

**Deliverable:** Brand Intelligence Profile + GEO/E-E-A-T enriched brief in <10 min from a URL
**Target:** SMB marketing teams, boutique agencies
**Pricing:** $99/mo SMB · $499/mo Agency

**Status:**
- [x] Render service live + auto-deploy from main
- [x] `forgeintelligence.ai` domain live
- [x] Landing page built + styled
- [x] Waitlist email capture (Resend wired)
- [x] NeonDB setup (`forge_platform`, `forge_brain`, full schema)
- [x] Context Agent (Stage 1) — fully wired, persisting, caching, logging
- [x] `/context-agent` workspace UI — fully built + styled
- [x] Stage 2 — GEO Strategist agent (LIVE — Topical Authority Mapper, GEO Opportunity Scorer, Entity & Schema Mapper, Brief Generator)
- [ ] Stage 3 — Authenticity Enricher agent (prompt spec written, agent NOT built)
- [ ] Admin dashboard (surface `agent_activity_log`)
- [ ] Brand brain pre-seeding script (run against target prospect domains)
- [ ] Server-side UUID auto-generation (currently requires client to send valid UUID)

### Phase 2 — Generation + Governance (Months 4–6)

| Stage 4 Content Generator | ✅ LIVE | `/content-generator` — SSE streaming, Brain-First, confidence scoring, per-brand `generated_content_{uuid}` table | (long-form + social + email + video + podcast)
- Stage 5 — Compliance & Human Refinement Gate (3 modes)
- Stage 6 — Publishing (UTM engine, queue, version control, WordPress/Webflow/HubSpot integrations)
- Pre-cog score running silently (hidden Standard tier)
- LinkedIn + X one-click OAuth publish

### Phase 3 — Intelligence Loop (Months 7–12)

- Stage 7 — Performance Intelligence (GSC, GEO citation tracking, engagement, revenue attribution)
- Stage 8 — Pattern Extractor / Feedback Loop
- Pre-cog score dashboard (Pro pay-to-view)
- HubSpot Track B (email/contact attribution)
- Deep Pattern Analysis add-on

### Phase 4 — Scale & Expansion (Year 2)

- White-label agency layer
- External client approval portal
- Reader-level personalization (CDP integration)
- Native video + audio generation
- Industry Benchmark Reports (cross-client opt-in)
- EU AI Act compliance layer

---

## GitHub Project Board

The project board tracks all active issues against this roadmap. When picking up a new session:
1. Read this README
2. Check open issues on the GitHub project board
3. Confirm current deployment status on Render before pushing anything

**Key issue categories:**
- `stage-1` — Context Hub / Context Agent work
- `stage-2` — GEO Strategist work
- `stage-3` — Authenticity Enricher work
- `infra` — Render, NeonDB, env vars, deployment
- `ui` — Frontend, design system, screens
- `gtm` — Landing page, waitlist, brand

---

## Known Issues & Backlog

| Item | Priority | Notes |
|------|----------|-------|
| Server-side UUID auto-gen | Medium | `clientId` currently must be sent as valid UUID from client |
| `third_party_signals` often null | Low | G2/Reddit scraping not deeply implemented yet — Claude reasoning fills what it can |
| `brandProfileId` was returning "unknown" | ✅ Fixed | Now returns real UUID from NeonDB |
| Anthropic SDK tool-calling TS errors | ✅ Fixed | Removed tool-calling pattern, using direct prompts. SDK pinned to `^0.39.0` |
| `TextBlock` citations field TS error | ✅ Fixed | Using `Anthropic.TextBlock` type directly |
| `mistakes` table not found | ✅ Fixed | Schema run against correct DB |
| UUID type error on `test-client-001` | ✅ Fixed | Must use valid UUID |

---

## For AI Sessions — Context Pack Instructions

**When starting a new session with this codebase:**

1. Read this README top to bottom first
2. Check `Whiteboard` file for deep-dive on any specific stage
3. Pull current repo file tree to understand actual state of code
4. Check open GitHub issues before suggesting new work
5. Check Render deploy status before pushing
6. The Anthropic SDK is pinned at `^0.39.0` — do not change this
7. `NEON_DATABASE_URL` points to `forge_platform` — this is correct
8. All commits go to `main` — Render auto-deploys
9. The owner of this repo and project is the founder of Sandbox Group LLC (Portland, OR)
   - Sandbox Group comprises: **Sandbox-XM** (experience marketing agency) + **Sandbox-GTM** (event registration + GTM platform)
   - Forge Intelligence is the third pillar — the intelligence layer that turns live experiences into measurable revenue

**Tone for AI collaboration:** Direct, fast, no hand-holding. Build it, commit it, tell them what changed and why. Don't ask for permission on things already decided in this doc.
