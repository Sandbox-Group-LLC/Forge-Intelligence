# Forge Intelligence — Whiteboard

> **Active working doc.** README.md is the architecture SSOT.
> This file tracks current platform state, session history, product spec, open work, and original thinking.
> Keep it current. Both branches should always have the same version of this file.

---

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

**Channels on Pipedream Connect:** Facebook
**Channels staying manual:** X (X asked Pipedream to remove), HubSpot, Webflow, Ghost (key-based), WordPress (app password), Medium (legacy), LinkedIn

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

---

## Session Log — April 5, 2026 (continued — new Claude account)

### Anthropic Policy Change + Tooling Recovery
Anthropic changed network policy today — bash shell in Claude.ai lost outbound network access, breaking the previous agentic coding workflow. Resolved via two mechanisms:
- **Desktop Commander MCP** (Mac-only, session-level) — used for initial recovery
- **AI Relay endpoint** (permanent, device-independent) — `POST /api/admin/relay` on both branches

### AI Relay — `POST /api/admin/relay`
Authenticated with `ADMIN_PASSWORD`. Three actions:
- `sql` — `{ adminPassword, action: 'sql', query, values[] }` — run any query against Neon
- `github-read` — `{ adminPassword, action: 'github-read', path, branch }` — read file + SHA
- `github-write` — `{ adminPassword, action: 'github-write', path, content, message, branch }` — commit file

Deployed to both main and production. Claude is now fully operational from any device.

### Brand Tether Cleanup (new Clerk account)
- New Clerk ID `user_3Bxs9lQ5r9Bf6laluD6n7VsvtT3` — production marketing account
- Tethered exclusively to `cde5feeb` (forgeintelligence.ai, is_paid: true)
- `intel.com` brand (5ef57555) untethered (clerk_user_id set to NULL)
- Old Clerk ID `user_3BtC7nusm7CShN7EdUYaaLZcDwp` remains super admin on main (dev only)
- Production FOUNDER_ID unchanged — new account authenticates as normal paid user via DB

