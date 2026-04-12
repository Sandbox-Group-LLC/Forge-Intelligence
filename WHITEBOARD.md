# Forge Intelligence — Whiteboard

> **Active working doc.** README.md is the architecture SSOT.
> This file tracks current platform state, session history, product spec, open work, and original thinking.
> Keep it current. Both branches should always have the same version of this file.

---

## Session — April 9, 2026 (continued)

### Pre-cog Predictions — UI Overhaul
- Compact card design — matches Compliance Gate card density (13px titles, 12px padding, inline score+tier)
- Score displayed inline with tier badge (colored pill with color-mix background) — no more stacked 32px number
- Title truncated to single line with ellipsis — clean list at any length
- Accuracy banner changed to `inline-flex` + `align-self: flex-start` — no longer stretches full width
- Hover state: subtle bg lift + border color change (matches comp gate pattern)
- Ported to production branch (CSS only — no auth or brand-switcher code touched)

### Pre-cog Backend — Production Migrations
- `precog_outcomes` table — was referenced in RLS policies but never created in `initDB`; accuracy tracking was silently failing in production; now created on boot
- `brain_patterns` extended columns — `source_channel`, `example_titles`, `last_validated_at`, `success_rate` added via `ALTER TABLE IF NOT EXISTS`
- `precog_score`, `precog_breakdown`, `precog_scored_at` — migrated onto all existing `generated_content_*` tables at boot
- All migrations idempotent — safe on repeated deploys

### README Updates
- Platform status date updated to April 9, 2026
- Known Issues backlog cleaned — resolved items moved to "Recently Resolved" table
- WordPress, Webflow, LinkedIn OAuth, HubSpot, scheduler auth, Brain Intelligence tab, Topic Queue, sitemap all marked resolved

---

## Session — April 9, 2026

### Bugs Fixed
- **Patterns tab** — root cause was early `return null` before all hooks violating React Rules of Hooks; moved early returns after all hooks; default tab changed to `patterns`
- **Patterns loading** — replaced `useCallback` chain with `authTokenRef` retry loop that bypasses React dep chain entirely
- **Brain Intelligence tab** — wiped old patterns engine; rebuilt as writing rules distilled from human edits via Haiku; `patternsLoading` only clears on `d.success`
- **extractMeta unused state** — removed, was causing TS build error
- **LinkedIn Connect** — was routing through Pipedream (no credentials); now routes through native OAuth `/api/linkedin/auth`
- **HubSpot / Webflow Connect** — `pipedreamApp` had been incorrectly added in commit `451aba64`; restored `oauthFlow: true` and native OAuth routing
- **HubSpot auth endpoint** — was doing `res.redirect()` causing cross-origin fetch failure; changed to `res.json({ authUrl })` matching LinkedIn pattern
- **HubSpot setup guide** — rewritten for OAuth flow; removed Private App Token instructions
- **Card Connect button** — only routed `pipedreamApp` channels to `handleSave`; fixed to include `oauthFlow` channels
- **Credential fields** — still showed for `oauthFlow` channels; gated on `!ch.oauthFlow`
- **LinkedIn sync** — `UNION ALL` with non-existent `channel_credentials` table caused token lookup to silently fail; removed legacy table reference
- **Scheduler self-call** — `/api/publishing/publish` had `requireAuth` blocking scheduler; added `adminPassword` bypass; campaign 50108CCF had 2 failed posts, both reset and republished
- **Memory write error** — `gen_random_uuid()::text` into uuid column; removed `::text` cast
- **BASE_DOMAIN = forge-os.ai** — old domain was in env vars causing article links to post wrong URL; corrected to `forgeintelligence.ai`; two X posts deleted and republished
- **Admin page title** — showed "New Analysis" because `pageTitle` prop was dropped in AppShell destructure and TopBar didn't accept it; fixed full prop chain
- **Render env var wipe** — PUT /env-vars is destructive; all future Render env var updates must GET → merge → PUT

### Features Built
- **Brain Intelligence tab** — full rebuild: writing rules distilled from Compliance Gate human edits via Haiku, confidence scores, Avoid/Do direction, before/after examples, Content Signals section locked until 3+ articles
- **`/api/brain/distill`** — new endpoint; reads `brain_mistakes`, sends to Haiku, writes `writing_rule` brain_patterns; 10 rules distilled from 40 signals for Forge brand
- **Topic Queue** — add form, filter tabs (All/Idea/In Progress/Generated), inline editing (click to edit, Enter/Escape), auth headers, persistent storage, send to generator
- **Dynamic sitemap.xml** — server-generated, production URLs only, live Ghost articles from DB; static file deleted so server route wins
- **Article CTA** — brand scan CTA above every article footer: "See what Forge Intelligence knows about your brand" → forgeintelligence.ai with UTM params
- **LinkedIn post prompts** — rewritten for link-click CTR: hook + curiosity gap, 500-800 chars, no summarizing

### Design
- **Dev theme** — `index.css`, `Sidebar.css`, `TopBar.css` replaced with production versions; dev now mirrors production visually

### Infrastructure
- **`PIPEDREAM_PROJECT_ENVIRONMENT=production`** — added to Render env vars
- **`BASE_URL=https://forgeintelligence.ai`** — added so scheduler self-calls route correctly  
- **`BASE_DOMAIN=forgeintelligence.ai`** — corrected from `forge-os.ai`
- **All OAuth redirect URIs** — set explicitly in Render: LinkedIn, LinkedIn Org, HubSpot, Webflow, GSC all pointing to production
- **Safe Render env var rule** — always GET → merge → PUT; never PUT only new vars

### Known Remaining
- LinkedIn Org OAuth (`/auth/linkedin/org/callback`) — registered in portal but company page posting not tested
- Facebook — Pipedream credentials now in production; needs real connect test
- GSC dev callback URL — needs adding in Google Cloud Console for dev environment
- LinkedIn MDP approval — impressions/clicks still blocked pending LinkedIn review

## Platform State — April 5, 2026

- **Production:** `forgeintelligence.ai` — LIVE
- **Dev:** `dev.forgeintelligence.ai` — LIVE
- **DB:** NeonDB `ep-odd-waterfall-akyrdo6x-pooler` — NEVER revert to `ep-cool-firefly`
- **Auth:** Clerk — Google, GitHub, email/password
- **Price:** $99 one-time via PayPal
- **All 8 stages:** ✅ LIVE

---

## Build Status

### Phase 1 — SMB ($99/mo) ✅ Complete
All 8 stages live. Auth, PayPal gate, full pipeline end-to-end.

**Publishing Queue — fully audited and fixed (April 5, 2026):**
- Post copy now injects real UTM-tagged article URLs per channel (was hardcoded to forgeintelligence.ai, UTMs never applied)
- Bitly shortening via Pro account — X and LinkedIn post copy use `bit.ly/...` URLs. `BITLY_ACCESS_TOKEN` in Render.
- Smart Export UTM Link tab rebuilt — per-channel ready-to-copy links using stored templates, falls back to sensible defaults when template is null
- UTM Preview modal killed — was showing fake `yoursite.com` URL, useless
- Send for Review `🔗` emoji → Lucide SVG
- Publishing icon row is now: Content Preview, Smart Export, Send for Review, Archive, Delete (5 actions, no confusion)

### Phase 2 — Pro ($299/mo) ✅ Complete
- Pre-cog scoring engine (Haiku-powered, data-gated, `requireAuth`, no fake scores)
- Pre-cog Predictions tab in Performance Dashboard
- Pre-cog score badge on Publishing Queue cards
- Ghost analytics honest KPIs (clicks, read time, feedback — impressions don't exist in Ghost API)
- WordPress + Webflow live publish confirmed working
- Ghost CMS publish + analytics confirmed

### Phase 3 — Intelligence Loop 🔄 Active
To be defined with Brian. Candidates:
- HubSpot Track A (UTM → deal/campaign attribution)
- Pre-cog accuracy tracking ✅ Done — `precog_outcomes` table, `updatePrecogOutcomes` runs after every analytics sync, accuracy banner + predicted vs actual in Predictions tab
- Deeper pattern analysis ✅ Done — content structure correlation, pre-cog feedback loop, channel breakdown, monthly trends, topic momentum, pattern upsert with freshness tracking
- LinkedIn impressions/clicks (⏳ blocked — MDP approval submitted and under review)

### Phase 4 — Scale Core (Year 2) 🔲 Not started
- Reader-level personalization via CDP
- Native video + audio generation
- EU AI Act compliance layer
- GA4 native attribution
- Industry Benchmark Reports (cross-client opt-in, anonymized)

### Phase 4.5 — Agency ($499/mo) ⏸ Parked
Not current focus. Multi-brand UX, access control, and commercial packaging only — the data model is already built.
See Agency Multi-Brand section below for full spec.

---

## Open Issues

| Issue | Notes |
|-------|-------|
| LinkedIn impressions/clicks | MDP approval submitted, under review — unblock when approved |
| Medium integration | Legacy — new tokens unavailable since early 2025 |

---

## The Core Idea

Every AI content tool today solves for production volume. None solve for **compounding content intelligence** — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product.

---

## The 8-Stage Workflow

```
[1. Context Hub] → [2. GEO Strategy] → [3. Authenticity Enrichment]
↑                                                      ↓
[8. Feedback Loop] ←— [7. Performance] ←— [6. Publish] ←— [5. Compliance] ←— [4. Generation]
```

| Stage | Name | Status | Model |
|-------|------|--------|-------|
| 1 | Context Hub | ✅ LIVE | Claude Sonnet 4.5 |
| 2 | GEO Strategy | ✅ LIVE | Claude Sonnet 4.5 |
| 3 | Authenticity Enrichment | ✅ LIVE | Claude Sonnet 4.5 |
| 4 | Content Generator | ✅ LIVE | Claude Sonnet 4.5 |
| 4.5 | Campaign Generator | ✅ LIVE | Claude Sonnet 4.5 |
| 5 | Compliance Gate | ✅ LIVE | Claude Sonnet 4.5 |
| 6 | Publishing & Distribution | ✅ LIVE | Queue + multi-channel |
| 7 | Performance Intelligence | ✅ LIVE | Dashboard + Analytics Sync |
| 8 | Feedback Loop | ✅ LIVE | Pattern Extractor (Haiku) |

---

## Stage Specs

### Stage 1 — Context Hub *(Gap: Shared Team Context)*

**The 6 Core Tools:**

1. **Brand Scraper & Auto-Populator** — Crawls website, blog, case studies, social. Extracts implicit brand signals (sentence patterns, vocab, formality). Generates draft Brand Context Profile in <5 min.
2. **Tone & Voice Calibration Engine** — Formality/Confidence/Complexity sliders. Output: Locked Voice Profile.
3. **Audience Persona Builder** — Structured templates + CRM import (HubSpot first). Primary buyer / influencer / end user layering. Output: Persona Library.
4. **Competitive Intelligence Snapshot** — 3–5 competitors. Content gaps, GEO citation presence. Output: Gap Map (feeds Stage 2).
5. **Knowledge Base Connector** — Index past content, GSC data, CRM objections. Output: RAG-ready Knowledge Base.
6. **Third-Party Voice Intelligence Crawler** *(unique differentiator)* — G2, Capterra, Trustpilot, Glassdoor, Reddit. Extracts Power Phrases, Objection Patterns, Competitor Comparisons. Output: Third-Party Voice Profile (feeds Stages 2–4).

**Open questions:**
- Brand Scraper: Social included? (LinkedIn/X for voice signals)
- Context refresh: Manual or scheduled cadence?
- Third-Party Voice: G2 parsing depth? Reddit weight?
- CRM: Required or optional for SMB tier?

---

### Stage 2 — GEO Strategy *(Gap: GEO-Native Optimization)* ✅ LIVE

Brain-First: reads Mistakes + Patterns + Memories before every brief.

- **Topical Authority Mapper** — maps brand + competitor coverage, scores by GEO citation probability
- **GEO Opportunity Scorer** — ChatGPT, Perplexity, AI Overviews, Gemini. Surfaces "quick win" topics.
- **Entity & Schema Mapper** — Article, FAQ, HowTo, Organization, Breadcrumb schema
- **Brief Generator** — H1/H2 hierarchy, entities, FAQ structure, GEO anchors

Reads from Brain: Past AI-citation performance, competitive patterns
Writes to Brain: GEO opportunity scores, schema requirements, brief templates that convert

---

### Stage 3 — Authenticity Enrichment *(Gap: E-E-A-T Signal Integration)* ✅ LIVE

Brain-First: reads which SME injections previously converted vs. fell flat.

- SME voice repository match to content sections
- First-person experience injection points
- Proprietary data hooks (surveys, case studies, original research)
- Author schema auto-generation
- Customer power phrases from Third-Party Voice Crawler
- Manual Input Fallback — targeted prompt cards with tooltips

Reads from Brain: Voice patterns that drove engagement
Writes to Brain: E-E-A-T patterns that passed compliance + converted

---

### Stage 4 — Content Generator *(Gap: Native Multimodal)* ✅ LIVE

Brain-First: reads ALL Brain tables before generating a single word.

- SSE streaming — per-section generation with live progress panel
- Per-section confidence badges (🟢🟡🔴) with reason text
- E-E-A-T tags per section
- Hero image via Haiku prompt → Flux/fal.ai (async, non-blocking)
- Brain Match score + citation count in meta bar
- Per-brand `generated_content_{uuid}` table auto-provisioned on first run

**Confidence tiers (Brain-derived):**
- 🟢 Green — high pattern match, auto-approvable
- 🟡 Yellow — SME input needed or fact needs verification
- 🔴 Red — explicit human decision required

**Generated package scope (MVP = long-form article only):**
Social variants, email sequences, video scripts, podcast outlines — product roadmap, not yet built.

Reads from Brain: Every Pattern, Mistake, Memory
Writes to Brain: Raw generation log (scored by Stage 7)

---

### Stage 5 — Compliance Gate ✅ LIVE

Three configurable modes:

```
Mode 1: Auto-Ship     → AI self-critique passes → auto-publish → human notified only
Mode 2: Approve-to-Ship → review yellows/reds, one-click greens, inline edit on yellows
Mode 3: Full Review   → named approver, full audit log (Enterprise — shelved for now)
```

**The Mistakes Loop:** Every human edit is a signal. Consistent edits to a pattern → AI flags it → writes to brain_mistakes → stops generating that pattern. No training required.

Reads from Brain: Mistakes table (compliance history)
Writes to Brain: Human edits as Mistakes + guardrails

---

### Stage 6 — Publishing & Distribution ✅ LIVE

Brain-First: reads UTM patterns, channel performance, and timing data before scheduling.

**Architecture tiers:**
- **Tier 1 — Native (always):** UTM Intelligence Engine, Content Version Control, Publishing Queue
- **Tier 2 — Deep Integrations:** WordPress ✅, Webflow ✅, HubSpot (Track A — Phase 3), Ghost ✅
- **Tier 3 — Smart Export:** HTML (site-template-aware), Markdown, JSON, UTM Link
- **Tier 4 — Social:** LinkedIn ✅, X ✅, Facebook ✅, Reddit (pending), Medium (legacy)

**HubSpot Two-Track Architecture (important — do not collapse):**
```
Track A: Campaign-level (Phase 3, no email required)
→ Push content performance + GEO metrics + engagement as campaign activity
→ Works for blog, social, video. No contact data needed.

Track B: Direct email campaigns (Phase 4)
→ Full contact + deal-level attribution
→ Requires consent management + GDPR compliance layer
→ Two different integration architectures — do not build as one
```

---

### Stage 7 — Performance Intelligence ✅ LIVE

**What we measure:**
- **Layer 1: Traditional SEO (GSC)** — ranking velocity, impressions → CTR → clicks
- **Layer 2: GEO Citation Tracking** *(unique)* — cited in ChatGPT/Perplexity/AI Overviews/Gemini?
- **Layer 3: Engagement Signals** — clicks, read time, reactions, shares
- **Layer 4: Revenue Attribution** — UTM → conversion (Track A anonymous, Track B identified via HubSpot)
- **Layer 5: Content Decay Monitoring** — 50%+ engagement drop triggers alert + recommended action

**Delivery tiers:**

| Feature | Standard | Pro |
|---------|----------|-----|
| Performance dashboard | ✅ | ✅ |
| Pre-cog score | Badge only | Full Predictions tab |
| Decay monitoring | ✅ | ✅ |
| Pattern Dashboard | ✅ | ✅ |
| Deep Pattern Analysis | — | Phase 3 |
| Industry Benchmark Reports | — | Opt-in Phase 4 |

---

### Stage 8 — Feedback Loop ✅ LIVE

**Pattern Extractor Agent (Claude Haiku — runs on cadence):**

1. **Pattern Promotion** — `IF performance > threshold AND sample_size > minimum` → extract hook/format/length/persona → write to brain_patterns with success_rate + recency weighting
2. **Mistake Crystallization** — underperformed OR human edits > threshold → write Mistake + generate prevention guardrail → update agent prompt constraints
3. **Persona Refinement** — engagement deviates from persona assumption → update vocabulary preferences, adjust pain point weighting, flag persona drift
4. **Context Hub Refresh (weekly)** — re-run Third-Party Voice, re-score competitive gap map, refresh GEO opportunity scores, update decay queue

**The Pre-Cog Score:**
Runs under the hood for all tiers. Full Predictions tab unlocked at Pro.

*Free users feel the platform is better. They just don't know why. That's the upgrade hook.*

**Cross-Client Pattern Sharing:** Default OFF. Explicit opt-in → unlocks Industry Benchmark Reports for your vertical.

**The Compounding Effect:**
```
Day 1:    Brain empty. Agents start from brand context only.
Week 4:   10–15 patterns. Agents prefer proven structures.
Month 3:  50+ patterns. 20+ guardrails. Human edit rate drops ~30%.
Month 6:  Personas behavioral. Agents self-correct before human review.
Month 12: Brain is a proprietary asset. Switching = starting over.
```

---

## Client Brain Architecture

Each brand gets isolated NeonDB + pgvector. Multi-agent shared memory fabric.

```
Client Brain (NeonDB + pgvector)
├── Memories    (vector embeddings — what was published, performance outcome)
├── Patterns    (what worked — success_rate, confidence, recency weight)
├── Mistakes    (what failed + human feedback + guardrail created)
└── Agent Coordination Log (multi-agent sync)
```

**The 4 Memory Tables:**
```
memories:     content_id | embedding | metadata | raw_content | performance_outcome
patterns:     pattern_type | success_rate | confidence | example_id | recency_weight
mistakes:     mistake_type | content_id | human_feedback | fix_applied | guardrail_created
coordination: agent_id | query | memory_used | decision | outcome
```

**Brain-First Protocol (mandatory on every agent):**
```
SYSTEM: Before any action, query the Client Brain.
  1. Read Mistakes relevant to this task
  2. Read Patterns that succeeded in this context
  3. Read Memories of similar past content
  4. THEN act — informed by all three
```

Self-critique fires at two moments:
- **Pre-output:** Agent scores its own output against Patterns before surfacing it
- **Post-performance:** When Stage 7 reports back, agent writes its own failure analysis to Mistakes, tagged by root cause

Agents never start cold.

**Cost:** ~$20/mo per active client at current NeonDB pricing.

**Open questions (still active):**
- Memory retention: Prune low-confidence over time? Apply time decay?
- Cross-client sharing: Anonymized pattern sharing by industry — opt-in mechanism?
- NeonDB: Per-client DB or RLS shared instance at scale?

---

## Auth Architecture

```
Landing page → Clerk-free, zero friction
  → Free Context Hub (unauthenticated)
  → Brand Profile reveal
  → Click locked feature → GateModal
      → Promo code OR PayPal $99
      → is_paid = true in DB
      → if signed in: reload → useActiveBrand → isPaid = true → gate drops
      → if not signed in: localStorage brand_id → Clerk sign-up → auto-tether → gate drops
```

- `requireAuth` guards all protected endpoints
- `softAuth` attaches userId if token present, passes either way (public routes)
- `clerk_user_id` on `brand_profiles` — auto-tethered on first `/api/auth/me`
- `useActiveBrand` waits for `isLoaded`, re-fires on `isSignedIn` change
- `AppContext.isPaid` wired from `useActiveBrand.isPaid` — single source of truth

**Clerk URLs:**
- Sign in: https://accounts.forgeintelligence.ai/sign-in
- Sign up: https://accounts.forgeintelligence.ai/sign-up
- JWKS: https://clerk.forgeintelligence.ai/.well-known/jwks.json

**Promo codes (unlimited, server-side only):**

| Code | Description |
|------|-------------|
| `FORGEFRIEND` | Friend of Forge 🐐 |
| `EARLYBIRD` | Early Access |
| `SANDBOX100` | Sandbox Internal |

**Dev reset:** `POST /api/admin/reset-brand-paid` `{ brandProfileId, adminPassword: "ForgeCanvas" }`
Resets `is_paid = false`, clears `clerk_user_id`, clears promo redemptions.

**God mode:** `?god=ForgeCanvas` / `?ungod`

---

## GTM Strategy

**Brand:** Forge Intelligence (forgeintelligence.ai)
**Promise:** "Your content works harder every time you publish."
**Primary target:** Frustrated Directors & Agency Owners tired of "AI slop."

### The Frictionless Hook
- Input: Just a URL. No forms, no onboarding calls.
- 7 minutes later: Full Brand Intelligence Profile (Voice, 3 Personas, Competitive Gap Map)
- CTA: "Generate first content package"

**The Magic Moment:** User sees their brand understood better in 7 minutes than their last agency understood it in 3 months.

### The Sandbox Method (Dogfooding)
Use Forge to launch Forge. Sandbox-XM, Sandbox-GTM, and Forge Intelligence running simultaneously in dev **is the agency demo**. That's the thing to show on sales calls.

### Sandbox-GTM Integration (The Differentiator)
Event registration and live experience data feeds directly into the Forge Client Brain.
"We turn your live experiences into content intelligence." No standalone AI tool can replicate physical event data ingestion.

---

## Pricing

| Tier | Phase | Price | Core Value |
|------|-------|-------|------------|
| SMB Standard | 1 | $99/mo | Full 8-stage pipeline, 1 brand |
| Agency Standard | 4.5 | $499/mo | Multi-client + competitive snapshots |
| Pro | 2 | $299/mo | + Pre-cog full dashboard |
| Agency Pro | 4.5 | $799/mo | + client publishing |
| Enterprise | 3 | $599/mo | + full ROI dashboard + HubSpot Track B |
| Add-ons | 3+ | TBD | Live DB, Deep Patterns, Benchmarks |
| White-label | 4 | Custom | Agency network licensing |

---

## Agency Multi-Brand Mode — Phase 4.5

> The data model, per-brand tables, brand selectors, and publishing channels are ALL already built in dev. Phase 4.5 is UX, access control, and commercial packaging only.

### What We Discovered Running Multiple Brands in Dev

Running Sandbox-XM, Sandbox-GTM, and Forge Intelligence simultaneously revealed a natural agency workflow that works today:

1. **Brand selector dropdowns** — agency users think in brands, not articles. Dropdown stays visible and prominent when >1 brand exists.
2. **Brand-scoped Brain data** — all `brain_patterns`, `brain_mistakes`, `content_analytics`, `geo_citations`, `decay_alerts` already scoped by `brand_profile_id`. Each brand learns independently. Zero cross-contamination.
3. **Per-brand publishing channels** — `publishing_channels` keyed by `brand_profile_id`. Each client's LinkedIn, X, Ghost credentials fully isolated.
4. **Performance Dashboard per brand** — brand dropdown filters all KPIs, trends, pattern data. Agency weekly check-in per client in <5 min.
5. **Campaign Generator per brand** — campaigns are brand-scoped. Running 3 client campaigns simultaneously works today.

### Production Recast Rules (Do Not Break These)
- **DO NOT remove** brand selector dropdowns — hide via CSS when 1 brand, show when >1
- **DO NOT remove** brand-scoped tables — they are the multi-tenancy foundation
- **DO NOT remove** per-brand publishing channels
- **DO preserve** the Performance Dashboard brand dropdown

### What Needs Building for Agency Tier
- [ ] Brand Switcher in TopBar — quick-switch between client contexts
- [ ] "Currently working in: [Brand]" indicator in TopBar
- [ ] Agency Dashboard — bird's-eye view: articles/week per brand, pending compliance per brand, decay alerts across all brands, citation status
- [ ] Client-level access control — Clerk auth + org-slug (admin sees all, client sees own)
- [ ] Brand duplication — "Clone this brand's settings to new brand"
- [ ] External client approval portal — white-label review workflow
- [ ] White-label architecture — UI skinning, custom domain
- [ ] Cross-client pattern sharing — opt-in OFF by default, Industry Benchmark Reports as value exchange

### Agency Tier Positioning
> "You run Forge for your clients the way we run Forge for ours. Every brand gets its own brain. Every brain learns from every publish. Your clients get smarter content over time — and you get the credit."

---

## Architectural Decisions

### OAuth Layer — Pipedream Connect

**Decision date:** April 1, 2026. **Status:** Active.

OAuth is not Forge's core product. Intelligence is. Every hour debugging LinkedIn redirect URIs is an hour not spent on Pre-cog scores and GEO Citation. Pipedream Connect handles the full OAuth flow for 2,700+ apps using pre-approved client IDs — token storage, refresh, rotation, sensitive scope reviews already cleared.

**Channels on Pipedream Connect:** LinkedIn, Facebook, HubSpot, Webflow
**Channels staying manual:** X (X asked Pipedream to remove), Ghost (key-based), WordPress (app password), Medium (legacy)

**Implementation:** `connect.html` iframe with token in query params + postMessage listener. Bypassed the SDK entirely — SDK token resolution was broken. The iframe URL is the ground truth.

**Store Pipedream `account_id` in `publishing_channels` instead of raw credentials.** Tokens never touch our DB.

**What this unlocks when needed:** GSC one-click, Google Analytics, Reddit, Notion, Slack, Gmail — hours not weeks.

**Cost consideration:** Priced per connected account/month at Agency tier scale — factor into $499/mo margin.

### LLM Routing

| Agent/Task | Model | Reason |
|------------|-------|--------|
| Context Agent (Stage 1) | Claude Sonnet 4.5 | Brand reasoning, structured JSON |
| GEO Strategist (Stage 2) | Claude Sonnet 4.5 | Multi-step competitive reasoning |
| Authenticity Enricher (Stage 3) | Claude Sonnet 4.5 | E-E-A-T analysis |
| Content Generator (Stage 4) | Claude Sonnet 4.5 | Long-form, Brain-First |
| Campaign Generator (Stage 4.5) | Claude Sonnet 4.5 | 8-angle planner + article gen |
| Compliance Gate (Stage 5) | Claude Sonnet 4.5 | Structured rule checking |
| Pattern Extractor (Stage 8) | Claude Haiku | Fast, cheap, high-volume |
| Pre-cog scoring | Claude Haiku | Semantic scoring vs. Brain data |
| Post copy | Claude Haiku | LinkedIn/X/Facebook post copy |
| Image prompts | Claude Haiku → fal.ai Flux | Hero image generation |

SDK pinned at `^0.39.0` — do not upgrade without testing.

### Scheduled Jobs (EasyCron)
```
Weekly:      Pattern Extractor → promote patterns, crystallize mistakes
Weekly:      Context Hub refresh → Third-Party Voice, GEO re-score
Daily:       Decay monitoring → silent refresh queue
Daily/Weekly: Performance digest → compile + Resend
```

---


## Security Architecture — Multi-Tenant Data Isolation

**Status: Hardened April 5, 2026**

### The Problem (discovered April 5, 2026)
A test account (different `clerk_user_id`) had created a "Forge Intelligence" brand profile and run Pattern Extraction against it. That orphaned brand's `brain_patterns` and `brain_mistakes` were leaking into Brian's Performance Dashboard because the brand URL matched and application-layer checks were missing on the patterns endpoints. 83 routes had no `requireAuth`. 0 routes verified brand ownership.

### Three-Layer Defense Now In Place

**Layer 1 — Authentication (`requireAuth` middleware)**
Every route that serves or modifies brand data now requires a valid Clerk JWT. 55 previously unauthenticated routes locked down, including:
- All analytics endpoints (sync, dashboard, patterns, decay)
- Publishing queue (read, write, archive, delete, publish)
- Publishing channels (read, write — contains API credentials)
- Brand settings (read and write)
- Compliance Gate endpoints
- Content library, topic ideas, reviewers
- GEO strategist, authenticity enricher, campaign generator

**Layer 2 — Ownership verification (`verifyBrandAccess`)**
After authentication, every endpoint that takes a `brandProfileId` verifies the authenticated user OWNS that brand via `SELECT id FROM brand_profiles WHERE id = $1 AND clerk_user_id = $2`. A valid JWT is not enough — you must own the brand you're querying. Returns 403 if not.

**Layer 3 — Neon Row Level Security**
RLS enabled with `FORCE ROW LEVEL SECURITY` on all sensitive tables:
`publishing_queue`, `publishing_channels`, `content_analytics`, `brain_patterns`, `brain_mistakes`, `geo_briefs`, `geo_citations`, `decay_alerts`, `precog_outcomes`, `topic_ideas`, `reviewers`, `memories`, `publish_log`

Policy: `no_orphan_brands` — enforces that `brand_profile_id` must belong to a brand with a non-null `clerk_user_id`. Even if application code has a bug, the DB will not serve data for orphaned brands.

**Boot-time orphan purge**
On every server boot, `brain_patterns` and `brain_mistakes` rows belonging to brands with no `clerk_user_id` are automatically deleted.

### Remaining Phase 2 Security Work
- Full user-level RLS (requires transaction wrapper around pool queries to set `SET LOCAL app.current_user_id`)
- Audit `generated_content_*` dynamic tables (per-brand tables, access controlled by safeId derivation but no RLS)
- Formal penetration test before Agency tier launch
- `forge_brain_{client_id}` Neon project — confirm nothing writes to it and decommission

### Architecture Note
Multi-tenant shared tables with `brand_profile_id` scoping is standard SaaS architecture and SOC2-compliant when all three layers are in place. The shared table pattern is NOT the problem. Orphaned brands and missing auth were.

## Architecture Rules — Do Not Break

- **Never** use Render env vars `PUT` API — replaces ALL vars. Individual updates only.
- **Never** `git merge main → production` or copy entire files between branches.
- **NEON_DATABASE_URL** must stay on `ep-odd-waterfall-akyrdo6x-pooler`.
- **requireAuth** on every endpoint that touches brand data.
- **sanitizeJson()** is a top-level shared utility in `server.js` — do not re-inline.
- **activeBrand from useApp()** is the only source of brandProfileId on any page.
- **view-container owns all page padding** (`48px 40px 96px`) — page CSS must not add padding.
- **No emojis in UI** — Lucide SVGs only, 1.5 stroke, round caps, `currentColor`.
- GitHub Contents API commits require a freshly fetched SHA — stale SHAs fail.
- Anthropic SDK pinned at `^0.39.0`.

---

## Branch Differences (Production vs Main)

| Component | Production | Main (Dev) |
|-----------|-----------|------------|
| `TopBar.tsx` | No brand switcher | Multi-brand dropdown |
| `AppContext.tsx` | Single brand, Clerk auth | Multi-brand, `isSuperAdmin`, `allBrands`, `switchBrand` |
| Auth | Clerk + `requireAuth` everywhere | Same + super admin `brian@sandbox-xm.com` |
| Docs | Identical | Identical |

---

## Session Log — April 6, 2026 (continued)

### Security & Auth Hardening
- Brand hijacking via paid brand tether fixed — `auth/me` now blocks tethering any brand with an existing owner
- Forge Intelligence brand retethered to brian@forgeintelligence.ai after admin@makemysandbox.com hijack
- Landing page domain claimed wall — `/api/domain/check` endpoint + hard stop UI before any redirect
- `brand_profiles` primary key added (was missing — just an indexed column, not PK)
- GateModal contact message added for disputed brand ownership

### Performance Dashboard
- authToken exposed from AppContext — Clerk JWT in state, refreshed every 55s
- PerformanceDashboardPage: all 17 fetches use authToken directly, no interceptor dependency
- analytics/dashboard channel=all — aggregates across all channels for Predictions tab
- precog/all split-query fix — RLS cross-table JOIN replaced with two separate queries merged in JS
- brandProfileId added to useEffect deps — fixes empty Predictions on first load
- One-shot prevTokenRef effect — loadDashboard fires once on token arrival, not every 55s refresh
- handleSync gated on authToken — no more unauthenticated sync POSTs

### Dev Branch
- Brand dropdown always visible (no isSuperAdmin gate)
- AuthGate layout route — single wrapper for all /app/* routes
- verifyBrandAccess bypasses for super admin on dev
- All Brian's dev brands marked paid in DB then reverted (only Intel + Mars stay paid)

## Session Log — April 6, 2026

### Branch Reconciliation — Production → Dev (main)

**Group 1 — Direct ports (9 files):**
- `src/Landing.tsx` — UTM fixes, privacy link, updated hero
- `src/pages/PrivacyPage.tsx` — full privacy policy (new file)
- `src/pages/ContextAgentPage.tsx`
- `src/pages/GeoStrategistPage.tsx`
- `src/pages/AuthenticityEnricherPage.tsx`
- `src/pages/CampaignGeneratorPage.tsx`
- `src/pages/BrandSettingsPage.tsx` — voice attrs panel, digest opt-out
- `src/pages/PerformanceDashboardPage.tsx` — pre-cog, pattern dashboard
- `src/pages/PublishingQueuePage.tsx` — UTM fix, Bitly, Smart Export, Lucide SVGs
- express body-parser limit bumped to 500kb in production server.js (Brian patched directly)

**Group 2 — Surgical patches (8 files):**
- `src/main.tsx` — PrivacyPage import + /privacy route (preserved RequirePaid)
- `src/components/TopBar.tsx` — 4 route labels added, Manage Account button (preserved brand switcher)
- `src/pages/IntegrationsPage.tsx` — Webflow + HubSpot liveStatus → live, Ghost logo fix
- `src/pages/ComplianceGatePage.tsx` — activeBrandId → activeBrand?.id
- `src/pages/ContentImportPage.tsx` — activeBrandId → activeBrand?.id
- `src/pages/TopicQueuePage.tsx` — activeBrandId → activeBrand?.id
- `src/pages/ContentLibraryPage.tsx` — GateModal guard added
- `src/components/Sidebar.tsx` — comment update

**Group 3 — server.js ✅ Complete:**
- `updatePrecogOutcomes` fn + `/api/precog/all` + `/api/precog/accuracy` routes added
- `sendDigestForBrand` fn + 3 digest routes added
- `/api/utils/shorten-url` (Bitly) added
- Fixed: duplicate `verifyBrandAccess` declaration removed
- Fixed: missing `sendDigestForBrand` function definition added (routes existed without the fn)
- express body-parser limit raised to 500kb in production (Brian patched directly)

**Group 4 — LinkedIn Insight Tag ✅ Complete:** ported dev `index.html` → production

**Preserved in dev (do not touch):**
- `src/context/AppContext.tsx` — multi-brand engine (isSuperAdmin, allBrands, switchBrand)
- `src/components/TopBar.tsx` — Super Admin brand switcher
- `src/main.tsx` — RequirePaid route wrapper

**Bonus find:** dev/main `index.html` has LinkedIn Insight Tag (pid 8912978) that production doesn't — port to prod in Group 4.

## Session Log — April 6, 2026

- Added `/privacy` route — placeholder Privacy Policy page, on-brand styling, back link to `/`
- Privacy Policy link added to landing page footer (after hello@forgeintelligence.ai, dot-divider pattern)

---

## Session Log — April 5, 2026 (continued)

### Phase 2 Completion
- Pre-cog scoring engine — Haiku-powered, real data gate (≥3 articles), percentile-based predictions, `requireAuth` on all endpoints, `ALTER TABLE` in `initDB` not hot path, batch uses shared fn not self-HTTP. 8 duplicate `initDB` migrations cleaned.
- Predictions tab in Performance Dashboard — scored articles, batch scoring, signals, recommended actions, predicted impressions range
- Pre-cog badge on Publishing Queue cards — lazy-loaded, colored, tooltip, honest "No data yet" state
- Ghost analytics — KPIs: Clicks / Avg Read Time / Positive Feedback / Negative Feedback. Bar chart uses clicks as proxy. `AnalyticsTotals` interface updated.
- `GET /api/precog/all/:brandProfileId` endpoint added for Predictions tab
- Phase 1 and Phase 2 declared complete. Phase 3 active.

---

## Session Log — April 5, 2026

### Critical Infosec Fix — Application-Layer Brand Scoping
13 pages called `/api/context-hub/brains` without auth token → empty array → `brandProfileId: ''` → everything writing to void. DB layer was correct throughout. Application layer was broken from day one.

Pages fixed: PublishingQueuePage, ContentLibraryPage, ContentImportPage, TopicQueuePage, GeoStrategistPage, AuthenticityEnricherPage, ContentGeneratorPage, CampaignGeneratorPage, ComplianceGatePage, PerformanceDashboardPage, BrandSettingsPage, IntegrationsPage, AdminPage

Admin stats also scoped to `WHERE clerk_user_id = $1` — was returning platform-wide counts.

### JSON Parse Hardening
`sanitizeJson()` shared utility — escapes bare control chars inside strings before `JSON.parse`. Applied at 6 LLM parse points: context agent, content generator (×2), campaign plan, campaign articles (×8), compliance critique.

### Other Fixes
- `startTime` undefined in `/api/compliance/approve`
- Sidebar active state — transparent bg, accent text + left bar
- Settings group — `/app/admin` added to active/open detection
- Eyebrow labels corrected across Publishing pages
- Per-page padding removed from ContentLibrary + ContentImport CSS
- All emojis → Lucide SVGs in Compliance Gate + Import Article
- TypeScript cleanup across 4 pages

---

## Session Log — April 4, 2026 — Integration Blitz + Production Launch

**Production:** forgeintelligence.ai LIVE.

- Clerk auth — `requireAuth`/`softAuth`, JWKS, `clerk_user_id` auto-tether
- PayPal gate — $99 one-time, `is_paid = true`
- Promo codes: `FORGEFRIEND`, `EARLYBIRD`, `SANDBOX100`
- LinkedIn, HubSpot, Webflow OAuth via Pipedream Connect
- WordPress REST API live
- Ghost Admin API live
- Facebook Graph API live
- Super Admin role (brian@sandbox-xm.com) — dev only
- User sync to HubSpot on every Clerk login

---

## Session Log — April 2, 2026 — Production Polish

- Content Library (`/app/content-library`) — searchable archive, hero thumbs, preview modal
- Inline Article Editing — click-to-edit title, meta, sections, saves on blur
- External Review Workflow (`/review/[token]`) — signed token, VP approves without Forge account. First verdict: "Slay." ✅
- Queue Card inline title edit, live article preview link
- Publishing Queue Archive

---

## Session Log — March 30, 2026

- Post scheduling — 60s poll, `publishing` flag prevents double-fire
- Campaign grouping — week lanes, campaign badges
- UTM injection fixed across all channels
- Hero image auto-generation at publish time
- Ghost CMS full pipeline — JWT auth, HTML, hero, canonical, reverse delete
- Reverse publish per-channel
- Sidebar active state — fully URL-based via `NAV_ROUTES`
- brain_patterns / brain_mistakes tables added to `initDB` (campaign generator was querying them before they existed — fixed 7/8 article failures)

---

## Session Log — March 28, 2026 — First Full Pipeline Run

Stage 1 → 6 end-to-end complete.
- Article: `forgeintelligence.ai/articles/sandbox-gtm-com/first-sales-hire-playbook...`
- LinkedIn published, OG meta correct
- Brand: Sandbox GTM (`ac6b7ff1-5e6c-4fe6-a3bb-441c2f969779`)

---

## GTM Zingers

> Pull for ads, landing page, sales decks, cold outreach. Raw — needs polish before paid use but bones are solid.

**Core positioning:**
> "The only member of your content team who will tell you when the strategy is wrong."

**On the gap:**
> "Every AI content tool today solves for production volume. None solve for compounding content intelligence — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product."

**On the Brain:**
> "Your clients get smarter content over time — and you get the credit."

**On switching cost:**
> "Month 12: The brain is a proprietary asset. Switching means starting over."

**On the magic moment:**
> "User sees their brand understood better in 7 minutes than their last agency understood it in 3 months."

**On Forge vs agencies:**
> "Forge doesn't have a manager. It doesn't need budget approval to say the true thing."

**On the Pre-flight Check:**
> "Not opinion. Pattern recognition from your own data. The brain read every article you published, every compliance edit, every engagement metric — and reported back. No feelings, no politics, no 47-slide deck to justify it."

**On the SVP problem:**
> "Every SVP who accidentally found themselves managing a comms org is going to need a moment of reckoning. Forge doesn't water it down."

**On what Forge is:**
> "The intelligence layer behind modern marketing."

**On the agency pitch:**
> "You run Forge for your clients the way we run Forge for ours."

**On the dev environment as demo:**
> "The dev environment running Sandbox-XM, Sandbox-GTM, and Forge Intelligence simultaneously is the agency demo. That's the thing to show on sales calls."

**On OAuth (internal):**
> "OAuth is not our core product. Intelligence is. Every hour debugging LinkedIn redirect URIs is an hour not spent on Pre-cog scores and GEO Citation."

## Session Log — April 7, 2026

### Light Mode Redesign
- Full token swap in index.css — blueberry base (#EDF1FF), white cards, blue-glow shadows
- --color-text-emphasis (#0F172A) new token for titles/quotes needing extra contrast
- Sidebar + TopBar: white bg, chrome shadow (no border)
- WorkspaceLayout: content area uses --color-bg-base
- Sign In button: solid blue CTA
- Collapsed nav active item: left border (not bottom border)
- Dark color sweep: GeoStrategistPage, AuthenticityEnricherPage, ContentGeneratorPage, CampaignGeneratorPage cards fixed

### Security
- Landing page domain claimed gate — /api/domain/check + hard stop wall before redirect
- brand_profiles PRIMARY KEY added
- auth/me tethering hardened — never overwrites existing owner
- Forge Intelligence brand retethered to brian@forgeintelligence.ai

### Performance Dashboard
- authToken race fixed — one-shot prevTokenRef effect
- analytics/dashboard isAll applied to top/trend/posts queries (was only on totals)
- authToken removed from dep arrays — no more 55s re-fire flood

### Campaign Generator
- Recent Campaigns list on setup screen
- Load existing campaign — restores all 8 cards from DB
- Resume Generation — resets frozen 'generating' articles to pending, picks up from exact article
- authToken wired into plan/create fetches
- as const fix for ArticleStatus literal type
- Send All to Compliance Gate CTA when all 8 complete
- New Campaign button clears state
- imageLoading: false on restored articles

### Content Generator → Compliance Gate Pipeline
- Send to Compliance Gate green CTA after article completes
- authToken wired into briefs + topic-check fetches

### Compliance Gate
- Selected article card visual state — accent border, blue bg, accent title
- Accept Suggestion → AI Rewrite (Route B): POST /api/compliance/rewrite-section
  - Uses claude-sonnet-4-5
  - Removed silent fallback — surfaces real errors
  - window.__forgeToken fallback for auth race
  - 401 explicit guard
  - Rewrite Applied blue badge on success, clears on failure
- Inline flagged excerpt highlighting — HighlightedBody component
  - Parses quoted text from flag.reason
  - Red for factual_claim/legal_risk, amber for tone
  - mark tags with colored underline
- Flag type badge — color-coded pill (factual claim, tone, legal risk) + severity
- Section tint background for yellow/red tier sections
- loadArticles gated on authToken
## Session Log — April 7, 2026 (continued)

### Compliance Gate — Major Overhaul
- Split into ComplianceGateContent + thin gate wrapper — permanent fix for React hooks violations
- freshToken() + authFetch() helper — auto-retries on 401, gets fresh Clerk token at call time
- Clerk JWT template extended to 600s (jwt-template-600) — eliminates token expiry window mid-session
- All compliance fetches (critique, approve, find-sources, rewrite-section, latest) use authFetch
- editedSections persisted to localStorage per article — survives refresh, clears on approve
- Selected article card visual state — accent border, blue bg, accent title
- Section footer — confidence + decision status, balances card layout
- Top border replaces left border — cleaner section separation
- Confidence score badge on article list cards — color-coded green/amber/red

### Compliance Gate — AI Rewrite (Route B)
- POST /api/compliance/rewrite-section — claude-sonnet-4-5 rewrites flagged section
- Rewrite Applied blue badge on success, clears on failure
- Accept Suggestion button disabled while rewriting

### Compliance Gate — Find Sources
- POST /api/compliance/find-sources — Perplexity sonar search
- Uses search_results directly — no JSON parsing, no Claude extraction layer needed
- Exponential backoff on 429 rate limits
- 3 source candidates shown with title, snippet, year, URL
- Source selection feeds into rewrite prompt — AI weaves citation naturally
- Rewrite with Source button (purple) vs Accept Suggestion (green)
- Sources clear after successful rewrite

### Compliance Gate — Inline Highlights
- HighlightedBody component — parses quoted text from flag.reason
- Wraps matched phrases in mark tags — red for factual_claim/legal_risk, amber for tone
- Flag type badge — color-coded pill + severity
- Neutral flag card background — no harsh amber/red

### Campaign Generator
- Recent Campaigns list on setup screen with status badge
- Load existing campaign — restores all 8 cards from DB
- Resume Generation — resets frozen generating articles, picks up from correct article
- Send All to Compliance Gate CTA when all 8 complete
- New Campaign button clears state

### Content Generator
- Send to Compliance Gate CTA after article completes
- authToken wired into briefs + topic-check fetches

### Publishing Queue — Campaign Scheduler
- Channel picker added — required field, uses connected channels
- Date scheduling fixed — Article 1 publishes on exact chosen date/time
- Subsequent articles find next occurrence of their target day-of-week after previous article
- Writes channels + status:'scheduled' to DB — cron job now picks up and publishes
- Was broken: channels was empty [], status was 'staged', nothing ever published

### Performance Dashboard
- analytics/dashboard isAll applied to top/trend/posts queries
- One-shot prevTokenRef — loadDashboard fires once on token arrival

### Auth / Token Architecture
- Clerk JWT template jwt-template-600 — 600s lifetime set in Clerk dashboard
- getToken({ template: 'jwt-template-600' }) used everywhere
- authFetch pattern established for all authenticated fetches in Compliance Gate

### Known Pending
- Option B authToken rollout — remaining pages (PublishingQueuePage 25 fetches, etc.)
- Full dark color sweep — PublishingQueuePage.css, PerformanceDashboardPage.css remaining
- LinkedIn Insight Tag → production index.html
- GSC dev callback URL in Google Cloud Console

## Session Log — April 7, 2026 (Night)

### Neon SQL Relay
- Added `POST /api/admin/relay` endpoint to `server.js` (main only — dev tool)
- Enables direct DB queries from Claude sessions via dev.forgeintelligence.ai
- Password-gated via `ADMIN_PASSWORD` env var

### Campaign Scheduler — Full Overhaul (both branches)
- **Root cause:** `scheduleCampaign` was POSTing to `/api/publishing/schedule` which never existed. Silent 200, nothing written to DB, success toast fired anyway.
- **Fix 1:** Switched to PATCH `/api/publishing/queue/:id` (the working endpoint individual items already use)
- **Fix 2:** `preview` array initialized as `[]` and never updated — scheduler read stale state. Fixed to call `buildSchedulePreview()` fresh at click time
- **Fix 3:** Added channel picker to campaign scheduler modal (missing on main, broken on production)
- **Fix 4:** Proper error handling — try/catch, failed-count check, no unconditional success toast
- **Fix 5:** `buildSchedulePreview` date math treated start date as Monday + raw day offsets. Fixed: Article 1 on exact start date, subsequent articles find next real occurrence of target day-of-week
- **Fix 6:** Day labels derived from actual `scheduled_at` date, not `publish_day` from DB
- Campaign 50108CCF reset in DB and successfully rescheduled — 8 articles on X, correct dates confirmed via relay

### Publishing Queue — Light Mode CSS Sweep (both branches)
- `pq-chip` hover + selected states: swapped hardcoded `#fff` / `rgba(255,255,255,...)` for CSS vars — chips were ghosting on white card backgrounds
- Content preview modal: all hardcoded dark-mode colors replaced with CSS vars — modal was completely unreadable in light mode

### Publishing Queue — UX Language (both branches)
- `Staged {date}` + separate clock emoji → single context-aware label: `Generated Apr 7` / `Scheduled Apr 8 · 9:00 AM` / `Published Apr 8 · 9:00 AM`
- "Staged" → "Generated" — matches product language (Content Generator, Campaign Generator)

### Generate Image — Full Fix (both branches)
- **Root cause:** All Claude model strings were invalid (`claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-5`) — Anthropic API throwing on every call platform-wide. 19 Sonnet hits in production alone.
- **Fixed:** `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-6`
- `authToken` wired into Generate Image + Regenerate Image fetch calls — was hitting `requireAuth` with no token
- Added `generatingImage` loading state — spinning ↺ + "Generating..." label, button disabled during fetch
- `authToken` fully ported to main AppContext: `AppContextType`, `useState`, 55s refresh `useEffect` with `jwt-template-600`, context value

### Image Generation Prompt — Brand-Driven Aesthetic (both branches)
- **Problem:** `buildImagePrompt` hardcoded Wired/HBR/dark-cinematic aesthetic onto every brand. Forge's moody editorial style was force-fed to Intel, skincare brands, everyone.
- **Fix:** Two-path logic — brands with Context Hub visual data get Haiku reasoning from their own `visualStyle` + `accentColor`; brands without get a neutral clean editorial fallback
- Removes hardcoded "dark cinematic", "deep indigo/slate/amber" rules
- Brand intelligence now actually drives image intelligence — consistent with core value prop

### Known Pending
- authToken rollout to remaining unauthenticated fetches in PublishingQueuePage
- Full light mode sweep — PerformanceDashboardPage.css and remaining PublishingQueuePage.css sections
- LinkedIn Insight Tag → production index.html
- GSC dev callback URL in Google Cloud Console
- Formal pen test before Agency tier launch

---

## Session — April 11, 2026

### Full Code Review Pass (50 findings — CODE_REVIEW.md)

**Criticals (all fixed):**
- C1 — Dual scan paths unified; 75s timing; URL brand persistence; mobile recovery
- C2/C3/C4 — Auth locked on brand-profiles/list, content-generator, campaign/generate, content/:id, test/image deleted

**Highs (all fixed):**
- H1 — /api/publishing/republish: requireAuth + BASE_URL self-call fix
- H2 — /api/precog/* all 3 endpoints require auth
- H4 — initDB triple-fire: 3 BACKFILL blocks → 1, 9 MIGRATION blocks → 1
- H5 — BrandProfile GEO CTA fixed to /app/geo-strategist preserving profileId
- H6 — Strategy tab now derives all content from real brandProfile data
- H7 — Dead "Save Version" button removed
- H8 — IntegrationsPage, BrandSettingsPage, ContentImportPage, GeoStrategistPage: mobile-safe localStorage fallback chain
- H9 — Scan failure dispatches forge:scan-error event; navigates to new-analysis
- H11 — GeoStrategistPage mobile-safe brand ID fallback

**Mediums (fixed or deferred):**
- M7 — ClerkTokenSync stripped to bare no-op
- M9 — CSS var sweep: 16 rgba replacements in PublishingQueuePage, 2 in PerformanceDashboardPage
- M11 — AuthenticityEnricherPage gets its own CSS file (was importing GeoStrategistPage.css)

**UX (fixed or deferred):**
- U1 — forge:scan-error wired to NewAnalysis inline error + Try again
- U3 — GateModal backdrop click removed
- U6 — Brain cache indicator now shows across all app pages with update date tooltip
- U7 — BrandProfile UUID replaced with clickable brand URL
- U8 — Null/0-confidence signals filtered from display
- U9 — Elapsed timer persists via sessionStorage across remounts
- U11 — False LinkedIn scraping claim replaced with accurate Claude Opus synthesis description
- U12 — PayPalGate.tsx tombstoned

**Enhancements (fixed or deferred):**
- E1 — payment_events table + record written on every PayPal confirmation
- E5 — Landing domain lookup: cache-first recovery + "Already scanned?" hint
- E6 — Promo code collapsed behind "Have a promo code?" toggle
- E9 — Persistent brand context pill in TopBar across all app pages

---

### Stage 4.6 — Email Campaign Generator (SHIPPED)

**Spec:** Brief-driven (5 sections), Brain-First, 3 subject line variants per email (curiosity/benefit/pattern interrupt), Smart Export as .txt, HubSpot push as drafts, reusable brief templates.

**Route:** `/app/email-campaign` — gated behind isPaid

**Compliance:** Existing gate logic + 4 email-specific flag types: email_spam_risk, email_cta_conflict, email_promise_gap, email_sequence_drift

**Files:**
- `src/agents/stage46_email_campaign/system_prompt.md`
- `src/pages/EmailCampaignPage.tsx` (563 lines)
- `src/pages/EmailCampaignPage.css` (232 lines)

**Backend endpoints (server.js):**
- POST /api/email-campaign/create
- GET /api/email-campaign/generate/:id (SSE, claude-sonnet-4-6, 8000 tokens)
- GET /api/email-campaign/:id
- GET /api/email-campaign/list/:brandProfileId
- POST /api/email-campaign/push-to-hubspot (HubSpot Marketing Emails API — requires Marketing Hub)
- POST /api/email-campaign/save-brief-template
- GET /api/email-campaign/brief-templates/:brandProfileId

**DB tables:** email_campaigns, email_campaign_emails, email_brief_templates (lazy-created)

---

### Infrastructure Fixes

- **requireAuth** now accepts `?token=` query param for SSE/EventSource endpoints (EventSource can't send headers)
- **AuthenticityEnricherPage.css**: all hardcoded dark hex values replaced with CSS vars + explicit fallbacks; .geo-content scope enforces light mode vars
- **GeoStrategistPage.css**: .geo-running card gets !important override for light mode
- **server.js main branch**: was catastrophically truncated at line 416 (SyntaxError: Invalid regular expression) from a previous session's broken find/replace. Restored from production (9,184 lines).

---

### Open / Deferred
- AuthenticityEnricherPage dark cards — root cause of var override never isolated; mitigated with scope-level var enforcement + fallback hex values
- U4 (OnboardingBot for unauth), U5 (sidebar affordance), U10 (real SSE activity log)
- M4 (Brain History compare — needs backend feature)
- M12/M13 (architecture refactors)
- E3/E4 (PerformanceDashboard split, server.js route modules)
- HubSpot Marketing Emails API requires Marketing Hub subscription — surface to users on push failure
- LinkedIn MDP approval still pending

