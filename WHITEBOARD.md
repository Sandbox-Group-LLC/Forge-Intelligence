# Forge Intelligence — Whiteboard

> **Active working doc.** README.md is the architecture SSOT.
> This file tracks current platform state, session history, product spec, and open work.
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
All 8 stages live, auth, PayPal gate, full pipeline end-to-end.

### Phase 2 — Pro ($299/mo) ✅ Complete
- Pre-cog scoring engine — Haiku-powered, data-gated, `requireAuth`, no ALTER TABLE on hot path
- Pre-cog Predictions tab in Performance Dashboard — batch scoring, signals, predicted impressions
- Pre-cog score badge on Publishing Queue cards — lazy-loaded, color-coded, tooltip
- Ghost analytics — honest KPIs (clicks, read time, feedback — no fake impressions)
- WordPress + Webflow live publish confirmed working
- LinkedIn impressions/clicks ⏳ blocked — MDP approval submitted and under review

### Phase 3 — Intelligence Loop 🔄 Active
To be defined with Brian. Candidates:
- HubSpot Track A (UTM → deal/campaign attribution)
- Pre-cog accuracy tracking (predicted vs actual over time)
- Deeper pattern analysis (cross-article trends)
- LinkedIn impressions/clicks (unblock when MDP approved)

### Phase 4 — Scale Core (Year 2) 🔲 Not started
See MVP Build Roadmap section below.

### Phase 4.5 — Agency ($499/mo) ⏸ Parked
Multi-brand UI built in dev. Not current focus. See Agency Multi-Brand Mode section below.

---

## Session Log — April 5, 2026

### Infosec Fix — Application-Layer Brand Scoping
Every page called `GET /api/context-hub/brains` without auth — `brandProfileId` was `''` on every API call. 13 pages fixed. DB layer was never affected. Full details in session archive.

### JSON Parse Hardening
`sanitizeJson()` shared utility added to `server.js` — applied to all 6 LLM JSON.parse call sites.

### Pre-cog Scoring Engine Rewrite
Full rewrite — Haiku-powered semantic reasoning against real `brain_patterns` + `brain_mistakes`. Data gate at ≥3 articles. Percentile-based predicted impressions. `requireAuth` on all endpoints. Batch self-HTTP removed. 8 duplicate `initDB` migrations cleaned.

### Pre-cog UI
Predictions tab in Performance Dashboard + score badge on Publishing Queue cards.

### Ghost Analytics Honest KPIs
Tab now shows Clicks / Avg Read Time / Positive Feedback / Negative Feedback. Bar chart uses clicks as reach proxy. No fake impression zeros.

### Other Fixes
Sidebar active states, eyebrow labels, per-page padding, emoji → SVG audit, TypeScript cleanup across 6 pages, `startTime` undefined in compliance/approve, WordPress/Webflow confirmed live and removed from open issues, README + WHITEBOARD synced across both branches.

---

## Open Issues

| Issue | Notes |
|-------|-------|
| LinkedIn impressions/clicks | MDP approval submitted — unblock when approved |
| Medium integration | Legacy — new tokens unavailable since early 2025 |

---

## The Core Idea

Every AI content tool today solves for production volume. None solve for **compounding content intelligence** — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product.

---

---

## The 8-Stage Workflow

[1. Context Hub] → [2. GEO Strategy] → [3. Authenticity Enrichment]
↑                                                      ↓
[8. Feedback Loop] ←— [7. Performance] ←— [6. Publish] ←— [5. Compliance] ←— [4. Generation]

### Stage 1 — Context Hub *(Gap: Shared Team Context)*

**The 6 Core Tools:**

1. **Brand Scraper & Auto-Populator**
   - Crawls website, blog, case studies, social
   - Extracts implicit brand signals (sentence patterns, vocab, formality)
   - Generates draft Brand Context Profile in <5 min
   - **Goal:** Zero-manual onboarding hook for SMBs

2. **Tone & Voice Calibration Engine**
   - Sliders for Formality/Confidence/Complexity
   - Match test against sample content
   - **Output:** Locked Voice Profile

3. **Audience Persona Builder**
   - Structured templates + CRM import (HubSpot first)
   - Primary buyer / influencer / end user layering
   - **Output:** Persona Library

4. **Competitive Intelligence Snapshot**
   - Analyze 3–5 competitors
   - Identify content gaps, GEO citation presence
   - **Output:** Gap Map (feeds Stage 2)

5. **Knowledge Base Connector**
   - Index past content, GSC data, CRM objections
   - Searchable proprietary data index
   - **Output:** RAG-ready Knowledge Base

6. **Third-Party Voice Intelligence Crawler** *(Unique differentiator)*
   - Reviews: G2, Capterra, Trustpilot, Glassdoor, Reddit
   - Extracts Power Phrases, Objection Patterns, Competitor Comparisons
   - Glassdoor for internal culture signals
   - **Output:** Third-Party Voice Profile (feeds Stages 2–4)

**Stage 1 Architecture:**
```
Brand Scraper → Voice Calibration → Voice Profile
                                               ↓
Persona Builder ← CRM Import → Persona Library
                                               ↓
Competitive Snapshot → Gap Map
                       ↓
Knowledge Base ← Third-Party Voice → Proprietary Index
                       ↓
                 ACTIVE CONTEXT SESSION
```

**Stage 1 Open Questions:**
- Brand Scraper: Social included? (LinkedIn/X for voice)
- Context refresh: Manual or scheduled?
- Third-Party Voice: G2 parsing depth? Reddit weight?
- CRM: Required or optional for SMB tier?
- **Client Brain:** Per-client NeonDB with pgvector for Context Hub storage?

---

## Client Brain Architecture — The Compounding Intelligence Layer

### Core Concept
Each client gets their own **isolated NeonDB instance** with pgvector for semantic search + structured memory schema. Multi-agent shared memory fabric.

```
Client Brain (NeonDB + pgvector)
├── Memories (vector embeddings)
├── Patterns (what worked) 
├── Mistakes (what failed + why)
├── Agent Coordination Log
└── Predictive Guardrails
```

### The 4 Memory Tables

**1. Memories** (vectorized RAG)
```
content_id | embedding | metadata | raw_content | performance_outcome
```

**2. Patterns** (structured wins)
```
pattern_type | success_rate | confidence | example_id | recency_weight
```

**3. Mistakes** (failures + root cause)
```
mistake_type | content_id | human_feedback | fix_applied | guardrail_created
```

**4. Agent Coordination** (multi-agent sync)
```
agent_id | query | memory_used | decision | outcome
```

### Multi-Agent Workflow
```
Stage 1 Agent → Stage 2 → Stage 3 → Stage 4 → Stage 5
  ↓ Query Brain              ↓ Query Brain
Stage 7 WRITES → Stage 8 Updates Patterns/Mistakes
```

### Predictive Guardrails (Minority Report)
- Pre-gen: "Similar content failed. Override?"
- Pre-compliance: "Phrasing flagged in healthcare mistakes"
- Pre-publish: "Format failed on this channel before"

### Tech Stack
```
NeonDB per-client + pgvector + TimescaleDB
RLS for isolation + auto-embed triggers
Supabase/Neon edge functions for agents
```
**Cost:** ~$20/mo per active client

### Open Q1 Resolved: 3 Agents for Phase 1 MVP

**Stages 1-3 → 3 Agents (Context Intelligence Engine)**

```
Agent 1: CONTEXT AGENT (Stage 1)
├── Brand Scraper → Voice Profile
├── Persona Builder → Persona Library
├── Competitive Snapshot → Gap Map
├── Knowledge Base → Proprietary Index
└── Third-Party Voice → Customer Language
↓ Unified Context Session

Agent 2: GEO STRATEGIST (Stage 2)
├── Context + Gap Map → Topical analysis
├── GEO citation opportunities
├── Structured brief + schema map
↓ GEO Brief

Agent 3: AUTHENTICITY ENRICHER (Stage 3)
├── GEO Brief + Context
├── SME voice injection
├── E-E-A-T signals + human hooks
├── Author schema generation
↓ Enriched Brief (Phase 1 deliverable)
```

**Phase 1 Value Prop:**
Input: Company URL + 3 competitors
Output: Brand Intelligence Profile + GEO/Enriched Brief
Demo: <10 min | Price: $99/mo SMB

**Updated Phase 1 Scope — ACTUAL BUILD STATUS:**
```
Phase 1 — Context Intelligence Engine (Months 1–3)
[x] Stage 1: Context Hub — ✅ LIVE
[x] Client Brain: NeonDB/pgvector + 3 agents — ✅ LIVE
[x] Stage 2: GEO Strategy Brief — ✅ LIVE
[x] Stage 3: Authenticity Enricher — ✅ LIVE
    - UI: /authenticity-enricher, Brain selector, ShieldCheck run btn
    - Backend: E-E-A-T scoring, SME signals, voice injection, author schema
[x] Stage 4: Content Generator — ✅ LIVE
    - /content-generator — Brain selector + Enriched Brief selector + SSE streaming renderer
    - Long-form article only (MVP scope)
    - Confidence scoring per section (🟢🟡🔴)
    - Hero image generation via Flux/fal.ai
[x] Stage 5: Compliance Gate — ✅ LIVE
    - Three-mode review (Auto/Approve/Full), human edit loop → Brain Mistakes
[x] Stage 6: Publishing Queue + LinkedIn + Public Article Page — ✅ LIVE
    - /publishing-queue, Draft→Approved→Published
    - LinkedIn API publish via ugcPosts
    - Public article: forgeintelligence.ai/articles/:brandSlug/:articleSlug
    - OG meta server-side injection for social crawlers
[x] Stage 7B: Performance Dashboard styling pass — ✅ DONE (March 28, 2026)
    - KPI cards: resting shadow-sm, text-2xl value, tabular-nums
    - Section titles: xs uppercase tracking-widest muted
    - Sync button: ghost style
    - Trend chart empty state: Sync now CTA button wired
    - Table: zebra striping, tabular-nums on all numeric columns
[ ] Admin dashboard (surface agent_activity_log)
[ ] Brand brain pre-seeding script
[ ] Server-side UUID auto-generation
```

**Why Perfect MVP:**
- Ships complete value (briefs that convert)
- Technical simplicity (shared Brain, no publishing)
- Clear Phase 2 handoff (add Stage 4 generation)

**Open Questions (still active):**
1. Mistake logging: Human-only or AI self-critique?
2. Memory retention: Prune low-confidence? Time decay?
3. Cross-client: Anonymized pattern sharing by industry?
4. NeonDB: Per-client DB or RLS shared instance?

### Open Q2 Resolved: AI Self-Critique + Brain-First Protocol

**Every agent prompt opens with the same mandatory instruction:**

```
SYSTEM: Before any action, query the Client Brain.
  1. Read Mistakes relevant to this task
  2. Read Patterns that succeeded in this context
  3. Read Memories of similar past content
  4. THEN act — informed by all three
```

**Self-critique fires at two moments:**
- **Pre-output:** Agent scores its own output against Patterns before surfacing it
- **Post-performance:** When Stage 7 reports back, originating agent writes its own failure analysis to Mistakes table, tagged by root cause

Agents never start cold. Every action is preceded by a full Brain read.



### Stage 2 — GEO Strategy Brief *(Gap: GEO-Native Optimization)* ✅ LIVE

**Brain-First:** GEO Strategist Agent reads Mistakes + Patterns + Memories before every brief.

**Tool 1: Topical Authority Mapper**
- Maps brand content + competitor coverage across topical clusters
- Scores each gap by GEO citation probability
- **Writes to Brain:** Competitive topic graph (scheduled refresh)

**Tool 2: GEO Opportunity Scorer**
- Scores gaps across ChatGPT, Perplexity, Google AI Overviews, Gemini
- Weights recency bias, entity authority, structural fit
- Surfaces "quick win" topics where brand has authority but no content
- **Reads from Brain:** Past AI-citation performance
- **Writes to Brain:** GEO opportunity scores per topic

**Tool 3: Entity & Schema Mapper**
- Identifies entities needing structured markup
- Auto-generates schema: Article, FAQ, HowTo, Organization, Breadcrumb
- Maps competitor entities being cited that you aren't
- **Writes to Brain:** Schema requirements per content type

**Tool 4: Brief Generator**
- Combines Topical Map + GEO Scores + Entity Map + Stage 1 Context Session
- Outputs structured brief: H1/H2 hierarchy, entities, FAQ structure, GEO anchors
- **Reads from Brain:** All Patterns, Mistakes, Memories before generating
- **Writes to Brain:** Brief template flagged as Pattern if it converts

**Output:** GEO Brief + Opportunity Score → feeds Stage 3


### Stage 3 — Authenticity Enrichment *(Gap: E-E-A-T Signal Integration)* ✅ LIVE

**Brain-First:** Authenticity Enricher reads which SME injections previously converted vs. fell flat.

- SME voice repository match to content sections
- Flag first-person experience injection points
- Proprietary data hooks (surveys, case studies, original research)
- Author schema auto-generation
- Customer power phrases from Third-Party Voice Crawler
- Manual Input Fallback — targeted prompt cards with tooltips
- **Reads from Brain:** Voice patterns that drove engagement
- **Writes to Brain:** E-E-A-T patterns that passed compliance + converted

**Output:** Enriched Brief with SME assignments + confidence scores per section → feeds Stage 4


### Stage 4 — Multimodal Generation *(Gap: Native Multimodal)* ✅ LIVE

**Brain-First:** Generator reads ALL Brain tables before producing a single word.

**What shipped:**
- SSE streaming — per-section article generation with live progress panel
- Per-section confidence badges (🟢🟡🔴) with reason text
- E-E-A-T tags per section (key phrase, pain point, differentiation signals)
- Hero image generation — Claude writes an editorial Flux prompt from title + topic, Flux generates async post-SSE, injected at article top
- Brain Match score + citation count in meta bar
- Per-brand `generated_content_{uuid}` table auto-provisioned on first run
- Image prompt guardrails: no war rooms, no sci-fi control panels, macro/architectural editorial style

**Generated Package:**
```
├── Long-form article
│     ├── E-E-A-T injections HIGHLIGHTED
│     ├── SME hooks FLAGGED ("Insert quote — suggested: [X]")
│     └── Confidence score per section (Brain-derived)
├── Social variants (LinkedIn, X, Instagram, YouTube)
├── Email sequence
├── Video script + B-roll direction
├── Podcast outline
└── Graphic direction prompts
```

**Confidence Scoring (Brain-derived):**
- 🟢 Green — high pattern match, auto-approvable
- 🟡 Yellow — SME input needed or fact needs verification
- 🔴 Red — explicit human decision required

**Reads from Brain:** Every Pattern, Mistake, Memory
**Writes to Brain:** Raw generation log (later scored by Stage 7)

**Output:** Complete Content Package with confidence scores → feeds Stage 5

---

### Stage 5 — Compliance & Human Refinement Gate *(Gap: Enterprise Governance)* ✅ LIVE

**Three configurable modes by client risk level:**

```
MODE 1: Auto-Ship (low-risk, high-trust)
→ AI self-critique passes → auto-publishes
→ Human gets notification only

MODE 2: Approve-to-Ship (standard)
→ Human reviews yellows/reds only
→ One-click approve on greens
→ Inline edit on yellows
→ Decision required on reds

MODE 3: Full Review (regulated industries)
→ Every piece routes to named human approver
→ Compliance agent runs full check
→ Legal/medical claims escalated
→ Full audit log written to Brain
```

**The Mistakes Loop:**
Every human edit is a signal. Consistent edits to a phrasing pattern → AI self-critique flags it → writes to Mistakes → stops generating that pattern without being told twice.

**Compliance checks:**
- Industry-specific filters (healthcare, finance, legal)
- Brand voice consistency score
- Factual claim confidence check
- Approval routing (configurable by risk level)

**Reads from Brain:** Mistakes table (compliance history)
**Writes to Brain:** Human edits as Mistakes + guardrails

**Output:** Compliance Report + Approved Content Package → feeds Stage 6

### Stage 6 — Publishing & Distribution *(Gap: Cross-Channel Orchestration)* ✅ LIVE

**Brain-First:** Publishing Agent reads UTM patterns, channel performance, and timing data before scheduling anything.

---

#### Architecture: Native vs. Integrate vs. Export

**Tier 1 — Native (always, non-negotiable)**

- **UTM Intelligence Engine**
  - Auto-generates UTMs tied to Brain attribution model
  - Structured UTMs map to: content brief, persona, GEO score, originating agent
  - Stage 7 attribution breaks without this. Must be native.

- **Content Version Control**
  - Every draft, edit, human override, and compliance decision versioned
  - Brain stores deltas — what was changed, by whom, and why
  - Mistakes loop depends on this. Must be native.

- **Publishing Queue (Control Room)**
  - Single dashboard: Draft → Enriched → Approved → Scheduled → Live → Measured
  - Internal approval flow: Author → Editor → Approver (role hierarchy)
  - Reviewer hierarchy maps to Brain confidence weighting
  - Phase 1: Internal client (Marketing → Leadership)
  - Phase 2/3: External client (Agency → Client) via white-label

---

**Tier 2 — Deep Integrations (Phase 2)**

Priority 1:
- WordPress (REST API → Gutenberg blocks)
- Webflow (CMS API → collection schema)
- HubSpot (two-track — see below)
- Shopify (product + blog)

**HubSpot Two-Track Architecture:**
```
Track A: Campaign-level (Phase 2, no email required)
→ Push content performance + GEO metrics + engagement as campaign activity
→ Works for blog, social, video. No contact data needed.

Track B: Direct email campaigns (Phase 2/3)
→ Full contact + deal-level attribution
→ Requires consent management + GDPR compliance layer
→ Two different integration architectures — do not collapse
```

---

**Tier 3 — Smart Export (Phase 1)**

```
├── JSON (primary) — full Brain metadata intact
├── Markdown — universal fallback
├── HTML — paste-ready for any CMS
└── PDF — compliance/legal review workflows
```

---

**Tier 4 — Lightweight Native Social (Phase 1)**

- LinkedIn + X OAuth → publish from Publishing Queue ✅ LinkedIn LIVE
- Brain-derived optimal timing (from pattern data)
- No scheduling queue, no analytics dashboard, no audience management

---

#### ✅ Stage 6 — Live Implementation

| Feature | Status | Notes |
|---------|--------|-------|
| Publishing Queue UI | ✅ LIVE | `/publishing-queue` — Draft→Approved→Published, preview modal |
| LinkedIn API publish | ✅ LIVE | `ugcPosts` endpoint, OAuth token per brand |
| X (Twitter) publish | ✅ LIVE | OAuth 1.0a, X API v2, tweet URL uses authenticated handle |
| Facebook Page publish | ✅ LIVE | Graph API v21.0 — `/{pageId}/feed`, Haiku post copy, Page Access Token |
| Reddit publish | ✅ LIVE | OAuth script app — link post to company subreddit, token refresh on 401 |
| Medium publish | ✅ LEGACY | Integration token auth — backend live, new tokens unavailable from Medium since early 2025 |
| AI post copy | ✅ LIVE | Claude Haiku writes 3-4 para overview; ends with `Read more: [url]` |
| LinkedIn image card | ✅ LIVE | Server-side OG meta injection — `og:image`, `og:title`, `article:author` |
| Public article page | ✅ LIVE | `forgeintelligence.ai/articles/:brandSlug/:articleSlug` |
| Editorial article design | ✅ LIVE | Full-bleed hero, 740px reading column |
| Hero image generation | ✅ LIVE | `buildImagePrompt()` — full brand voice profile |
| Auto image backfill | ✅ LIVE | `/ensure-image` — generates + saves hero if NULL |
| Read time accuracy | ✅ LIVE | Reads `section.body` at 200 wpm |
| Brand byline | ✅ LIVE | Reads `brand_profiles.brand_name` column |
| OG meta — article route | ✅ LIVE | Named Express route before `express.static` |
| Campaign → publish pipeline | ✅ LIVE | Campaign articles mirror into `generated_content_{uuid}` + `publishing_queue` with `campaign_id` |
| UTM campaign slugs | ✅ LIVE | `utm_campaign` resolves to readable campaign name from `campaigns` table |

**Next for Stage 6:**
- [ ] Post scheduling (queue → auto-publish at time)
- [ ] WordPress live publish (REST API connector)
- [ ] Webflow live publish (CMS API connector)
- [ ] Ghost CMS publish (identified as next channel addition)
- [ ] Reddit — pending developer portal access resolution

---

### Stage 7 — Performance Intelligence *(Gap: Revenue Attribution)* 🔲 NOT BUILT

**Brain-First:** Performance Agent reads decay patterns, prior attribution models, and GEO citation history before scoring.

#### What We Measure

**Layer 1: Traditional SEO (GSC)**
- Ranking velocity post-publish, impressions → CTR → clicks
- Query match to intended GEO topics
- **Writes to Brain:** Ranking patterns by content type, length, schema

**Layer 2: GEO Citation Tracking** *(unique differentiator)*
- Is content cited in ChatGPT, Perplexity, Google AI Overviews, Gemini?
- Which sections quoted verbatim? Which competitor cited instead?
- **Writes to Brain:** GEO citation patterns

**Layer 3: Engagement Signals**
- Scroll depth, time on page vs. word count ratio
- Social shares, saves, comments
- **Writes to Brain:** Engagement patterns by persona, format, channel, topic

**Layer 4: Revenue Attribution**
```
Anonymous (always available):
→ UTM-tagged traffic → GA4 goal completions
→ Content → form fill → conversion event
→ Pipeline influence

Identified (CRM connected):
→ Contact touched content → deal progressed
→ Multi-touch attribution across content pieces
→ LTV correlation
```

**Layer 5: Content Decay Monitoring**
- Detects ranking/citation/engagement drop before it goes cold
- Auto-queues refresh recommendation silently
- **Writes to Brain:** Decay patterns by content type + topic

#### The ROI Dashboard

**View 1: Content Health** — live content ranked by performance score, 🟢🟡🔴 decay status
**View 2: Pattern Library** — top performing hooks, formats, lengths by channel
**View 3: Revenue Impact** — pipeline influenced, deals closed, content ROI per asset

#### Delivery Tiers

| Feature | Standard | Pro | Add-On |
|---------|----------|-----|--------|
| Performance digest | Daily/Weekly | Daily/Weekly | — |
| Live streaming DB | — | — | ✅ |
| Medium-confidence patterns | ✅ (default) | ✅ | — |
| Deep Pattern Analysis | — | ✅ | — |
| Pre-cog score | Hidden | ✅ Pay-to-view | — |
| Decay auto-monitoring | ✅ | ✅ | — |
| Industry Benchmark Reports | — | Opt-in | ✅ |

---

---

## GTM Strategy: The Sandbox Method

**Brand Name:** Forge Intelligence (forgeintelligence.ai)
**Core Promise:** "Your content works harder every time you publish."
**Primary Target:** Frustrated Directors & Agency Owners tired of "AI slop."

### Phase 0 — Sandbox GTM (Dogfooding Launch)

**Goal:** Use Forge to launch Forge.

**The Frictionless Hook:**
- Input: Just a URL. No forms, no onboarding calls, no uploading PDFs.
- 7 minutes later: Full Brand Intelligence Profile (Voice, 3 Personas, Competitive Gap Map)
- CTA: "Generate first content package" ($29 trial or $99/mo standard)

**The Magic Moment:**
User sees their brand understood better in 7 minutes than their last agency understood it in 3 months.

**Landing Page Architecture:**
- **Hero:** "Your content works harder every time you publish." / Single field: `Enter URL`
- **Interrupt:** "You don't have a volume problem. You have a compounding problem."
- **3 Pillars:** Starts Smarter (Context Hub), Gets Smarter (Client Brain), Proves Revenue (ROI Dashboard)
- **The Moat:** "After 90 days, your Client Brain is your biggest unfair advantage."
- **GEO Bait:** Structured FAQ defining "Compounding content intelligence"

### Sandbox-GTM Integration (The Differentiator)

- **Event Data = Content Intelligence:** Sandbox-GTM event registration and live experience data feeds directly into the Forge Client Brain
- **The Moat:** "We turn your live experiences into content intelligence." No standalone AI tool can replicate physical event data ingestion.

---

---

## MVP Build Roadmap

### Phase 1 — Pre-Launch Core (SMB $99/mo) ✅ COMPLETE — April 4, 2026
All 8 stages live. Full pipeline end-to-end. Auth. PayPal gate.

### Phase 2 — Pro Tier ($299/mo) ✅ COMPLETE — April 5, 2026
Pre-cog scoring, Predictions tab, Queue badges, Ghost analytics honest KPIs, WordPress + Webflow confirmed.

### Phase 3 — Intelligence Loop 🔄 Active
- HubSpot Track A — UTM → campaign/deal attribution
- Pre-cog accuracy tracking — predicted vs actual over time
- Deeper pattern analysis
- LinkedIn impressions/clicks (pending MDP)

### Phase 4 — Scale Core (Year 2)
- White-label agency layer
- External client approval portal
- Reader-level personalization (CDP integration)
- Native video + audio generation
- Industry Benchmark Reports (cross-client opt-in)
- EU AI Act compliance layer

### Phase 4.5 — Agency / Multi-Brand (Parallel Track) ⏸ Parked
Already built in dev branch. Production toggle when ready.
See Agency Multi-Brand Mode section below for full spec.

---

## Tech Stack & Implementation

### LLM Routing by Agent Task

| Agent/Task | Model | Reasoning |
|------------|-------|-----------|
| Context Agent (Stage 1) | Claude Sonnet 4.6 | Reasoning/planning: brand scraping, pattern extraction |
| GEO Strategist (Stage 2) | Claude Sonnet 4.6 | Multi-step reasoning: competitive → structured brief |
| Authenticity Enricher (Stage 3) | Gemini 2.5 Pro | Voice matching, natural E-E-A-T injections |
| Multimodal Generator (Stage 4) | Gemini 2.5 Pro | Publishable copy generation |
| Compliance Agent (Stage 5) | Claude Sonnet 4.6 | Structured rule checking, fast + precise |
| Pattern Extractor (Stage 8) | Claude Opus 4.6 | Complex reasoning: performance analysis, guardrail gen |
| Pre-cog Scorer | Claude Opus 4.6 | Probabilistic reasoning across Brain data |
| GTM Strategy layer | GPT 5.2 | Branding, tone, positioning |

**SDK:** Anthropic SDK pinned to `^0.39.0`. Do NOT upgrade without testing.

### Media Generation

| Task | Tool | Notes |
|------|------|-------|
| Blog/article hero images | Black Forest Labs Flux | Primary |
| Social graphics | Flux + brand kit overlay | — |
| Video scripts | Gemini 2.5 Pro → ElevenLabs | Script → audio |

**Stability AI:** Retired. Redundant with Flux.

### Infrastructure

| Layer | Tool | Role |
|-------|------|------|
| Client Brain | NeonDB + pgvector | Per-client DB, embeddings, RLS isolation |
| Embeddings | VoyagerAI | Brain memory retrieval |
| Hosting | Render | Agent API — auto-deploy from main |
| Email | Resend | Notifications, digests, alerts |
| Scheduled Jobs | EasyCron | Pattern Extractor, Brain refresh, decay monitoring |
| CRM | HubSpot | Track A attribution (Phase 2) |

**EasyCron Job Schedule:**
```
Weekly: Pattern Extractor → promote patterns, crystallize mistakes
Weekly: Context Hub refresh → Third-Party Voice, GEO re-score
Daily: Decay monitoring → silent refresh queue
Daily/Weekly: Performance digest → compile + Resend
```

### Integration Priority Queue

| Integration | Phase | Type | Notes |
|-------------|-------|------|-------|
| GSC | 2 | Native | SEO baseline |
| HubSpot Track A | 2 | Deep | Campaign-level attribution |
| WordPress | 2 | Deep | REST API → Gutenberg |
| Webflow | 2 | Deep | CMS API |
| LinkedIn/X OAuth | 2 | Lightweight | One-click publish ✅ LIVE |
| Facebook Page API | 1 | Lightweight | Company Page publish ✅ LIVE |
| Reddit API | 1 | Lightweight | Company subreddit ✅ LIVE (pending dev portal access) |
| Medium | 1 | Lightweight | ✅ LEGACY — new tokens unavailable from Medium since early 2025 |
| Ghost CMS | 2 | Deep | Identified as next channel addition |
| GA4 | 3 | Native | Anonymous attribution |
| HubSpot Track B | 3 | Deep | Email/contact attribution |

---

---

## Pricing Tier Summary

| Tier | Phase | Price | Core Value |
|------|-------|-------|------------|
| SMB Standard | 1 | $99/mo | Brand Intelligence + Enriched Briefs |
| Agency Standard | 1 | $499/mo | Multi-client briefs + competitive snapshots |
| Pro | 2 | $299/mo | Full content generation + approval gate |
| Agency Pro | 2 | $799/mo | Agency generation + client publishing |
| Enterprise | 3 | $599/mo | Full intelligence loop + ROI dashboard |
| Add-ons | 3+ | TBD | Live DB, Deep Patterns, Benchmarks |
| White-label | 4 | Custom | Agency network licensing |

---

---

## Architectural Decision — Pipedream Connect (OAuth Layer Migration)

> **Decision date:** April 1, 2026  
> **Status:** APPROVED — migrate to Pipedream Connect for all channel OAuth in production  
> **Replaces:** Custom per-channel OAuth (LinkedIn, X, GSC, Facebook, Reddit, Ghost)

### The Problem We're Solving

Every channel integration in the current dev build required:
1. Creating a developer app on that platform
2. Getting approved (LinkedIn MDP took weeks, Reddit portal locked, Google sensitive scope review = 1+ month)
3. Manually configuring redirect URIs per environment
4. Writing and maintaining token refresh logic per channel
5. Storing credentials in `publishing_channels` table manually

This is not Forge's core product. Intelligence is. Every hour spent in OAuth hell is an hour not spent on Pre-cog scores, GEO Citation, and Brain compounding.

### What Pipedream Connect Does

- Manages the full OAuth flow for 2,700+ apps using Pipedream's pre-approved client IDs
- Handles token storage, refresh, and rotation automatically
- Provides a frontend SDK for embedded auth (popup or redirect)
- Provides a proxy API so you make authenticated requests without ever touching tokens directly
- Has already cleared sensitive scope reviews with Google, LinkedIn, Meta, Reddit, etc.

Real-world signal: A developer blocked for a month on Google sensitive scope OAuth was unblocked in 10 minutes using Pipedream Connect.

### Migration Plan

**Phase 1 — New connections use Pipedream Connect**
All new channel connections in the Integrations page go through Pipedream Connect SDK instead of our custom OAuth flows. Existing connections in `publishing_channels` continue to work during transition.

**Phase 2 — Remove custom OAuth endpoints**
Once Pipedream Connect is stable in production, remove:
- `/api/linkedin/auth` + `/auth/linkedin/callback`
- `/api/gsc/auth` + `/auth/gsc/callback`
- Custom X OAuth 1.0a flow
- Facebook Graph API OAuth flow
- Reddit OAuth flow

**Phase 3 — Expand channel coverage**
With Pipedream handling auth, adding new channels (HubSpot, Salesforce, Notion, Slack, email) becomes hours not weeks. Each new channel = call Pipedream's proxy with authenticated token.

### What Stays the Same

The actual publishing logic stays exactly as-is. When publishing to LinkedIn, we still call the LinkedIn API with the same payload. The only change is where the access token comes from:

```
BEFORE: pool.query('SELECT credentials FROM publishing_channels WHERE...')
AFTER:  pipedream.getToken(userId, 'linkedin')
```

The `publishing_channels` table can be repurposed to store Pipedream account IDs per brand per channel instead of raw credentials. Tokens never touch our DB.

### What This Unlocks

| Channel | Current Status | With Pipedream Connect |
|---------|---------------|----------------------|
| LinkedIn | Live but no impressions (MDP blocked) | Full analytics scope available |
| GSC | Live, complex setup | One-click connect |
| Google Analytics | Not built | Available immediately |
| Reddit | Portal locked | Available immediately |
| Facebook | Live but token refresh fragile | Managed automatically |
| HubSpot | Not built | Available immediately |
| Notion | Not built | Available immediately |
| Slack | Not built | Available immediately |
| Gmail (digest delivery) | Not built | Available immediately |

### Implementation Notes

- Pipedream Connect has a frontend React SDK (`@pipedream/connect-react`)
- Backend needs a `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, and `PIPEDREAM_PROJECT_ID`
- Generate a short-lived connect token server-side, pass to frontend SDK
- Frontend SDK opens a popup/modal for the OAuth flow
- On success, Pipedream returns an `account_id` — store this in `publishing_channels` instead of raw tokens
- All subsequent API calls go through Pipedream's proxy: `pd.makeRequest(accountId, { url, method, data })`

### Cost Consideration

Pipedream Connect is priced per connected account per month. At the agency tier with multiple brands and multiple channels per brand this is a real line item — evaluate pricing at pipedream.com/pricing before production launch and factor into the $499/mo Agency tier margin calculation.

### Issues to Create

- `feat: Pipedream Connect integration — replace custom OAuth with managed auth SDK`
- `feat: Integrations page redesign — Pipedream Connect embedded auth flow`
- `feat: publishing_channels migration — store Pipedream account_id instead of raw credentials`


---

---

## Agency Multi-Brand Mode — Preserve for Production

> This section documents patterns discovered in dev while running multiple brands through Forge simultaneously. These UX patterns must be preserved and formalized for the Agency tier ($499/mo). Do not remove or collapse these features during the production recast.

### What We Discovered in Dev

Running Sandbox-XM, Sandbox-GTM, and Forge Intelligence as simultaneous brands in a single Forge instance revealed a natural agency workflow that works today without any additional build:

**1. Brand Selector Dropdowns (everywhere)**
Every agent page — Content Generator, Campaign Generator, Performance Dashboard, Brand Settings — has a brand selector dropdown. In production single-brand mode this gets hidden or pre-selected. For agency users this IS the workflow. The dropdown stays visible and prominent. Agency users think in brands, not in articles.

**2. Brand-scoped Brain Data**
All `brain_patterns`, `brain_mistakes`, `brain_citations`, `decay_alerts`, `content_analytics`, and `geo_citations` are already scoped by `brand_profile_id`. Each brand learns independently. An agency customer managing 5 clients gets 5 independent learning loops with zero cross-contamination. This is the core value prop — no additional build required.

**3. Brand Settings per Brand**
`article_base_url`, `article_url_suffix`, `logo_url`, `article_template`, `catalog_template` are all per-brand. An agency can configure sandbox-xm.com with `.html` suffix and Ghost blog with clean URLs in the same instance. Works today.

**4. Publishing Channels per Brand**
`publishing_channels` table is keyed by `brand_profile_id`. Each brand has its own LinkedIn, X, Ghost, GSC credentials. An agency user connects each client's channels independently without any credential bleeding.

**5. Performance Dashboard per Brand**
The brand dropdown in Performance filters all KPIs, trends, and pattern data to that brand. Agency users can do a weekly check-in per client in <5 minutes by switching the dropdown.

**6. Campaign Generator per Brand**
Campaigns are brand-scoped. An agency running 3 client campaigns simultaneously sees each in isolation. The campaign group UI in Publishing Queue visually separates them by brand tag.

### What Needs to Change for Agency Tier

These things currently feel like "dev workarounds" but should be first-class agency features:

**1. Global Brand Context Indicator (TopBar)**
Every page should show "Currently working in: [Brand Name]" in the TopBar when multiple brands exist. Right now you have to remember which brain you selected. This is the #1 agency UX gap.

**2. Brand Switcher in TopBar**
A quick-switch dropdown in the TopBar itself — not buried in Brand Settings — so agency users can flip between client contexts without navigating away.

**3. Agency Dashboard (new page)**
A bird's-eye view across all brands:
- Articles generated this week per brand
- Pending compliance reviews per brand
- Decay alerts across all brands
- Citation check status per brand
- "Jump to brand" quick links
One screen that tells an account manager what needs attention across their whole book.

**4. Client-Level Access Control (Phase 2)**
Today everything is one login. Agency tier needs:
- Agency admin sees all brands
- Client login sees only their brand
- Read-only client view for approval workflows
This is Phase 2 — Clerk auth + org-slug scoping already planned.

**5. Brand Duplication**
"Clone this brand's settings to a new brand" — saves setup time when onboarding clients in similar industries.

### Production Recast Rules for Agency Features

When stripping the product down for the SMB single-brand launch:
- **DO NOT remove** brand selector dropdowns — hide them via CSS when only 1 brand exists, show them when >1 brand exists (already partially implemented)
- **DO NOT remove** brand-scoped tables — they are the multi-tenancy foundation
- **DO NOT remove** per-brand publishing channels — even SMB customers may have multiple channels per brand
- **DO preserve** the Performance Dashboard brand dropdown — even single-brand users may want historical brand comparisons after a rebrand
- **DO preserve** the Brand Settings per-brand architecture — this is what makes the agency tier possible without a rebuild

### Agency Tier Positioning

The agency story is not "we added multi-brand support." The agency story is:

> "You run Forge for your clients the way we run Forge for ours. Every brand gets its own brain. Every brain learns from every publish. Your clients get smarter content over time — and you get the credit."

The dev environment running Sandbox-XM, Sandbox-GTM, and Forge Intelligence simultaneously **is the agency demo**. That's the thing to show on sales calls.


---

---

## Architecture Rules — Do Not Break

- **Never** use Render env vars `PUT` API — it replaces ALL vars. Individual updates only.
- **Never** `git merge main → production` or copy entire files between branches.
- **NEON_DATABASE_URL** must stay on `ep-odd-waterfall-akyrdo6x-pooler`.
- **requireAuth** on every endpoint that touches brand data.
- **sanitizeJson()** is a top-level shared utility in `server.js` — do not re-inline it.
- **activeBrand from useApp()** is the only source of brandProfileId on any page.
- **view-container owns all page padding** (`48px 40px 96px`) — page CSS must not add its own.
- **No emojis in UI** — Lucide SVGs only, 1.5 stroke, round caps, `currentColor`.
- GitHub Contents API commits require a freshly fetched SHA — stale SHAs fail.
- Anthropic SDK pinned at `^0.39.0` — do not upgrade without testing.

---

## Branch Differences (Production vs Main)

| Component | Production | Main (Dev) |
|-----------|-----------|------------|
| `TopBar.tsx` | No brand switcher | Multi-brand dropdown |
| `AppContext.tsx` | Single brand, Clerk auth | Multi-brand, `isSuperAdmin`, `allBrands`, `switchBrand` |
| Auth | Clerk + `requireAuth` everywhere | Same + super admin `brian@sandbox-xm.com` |
| Docs | Identical | Identical |

---

## GTM Zingers — Lines Worth Saving

> These are tweet-worthy lines that emerged organically during build sessions. Pull from this for ads, landing page copy, sales decks, cold outreach, and social. Do not let these die in a chat window.

---

**The core positioning line:**
> "The only member of your content team who will tell you when the strategy is wrong."

---

**On what every other tool gets wrong:**
> "Every AI content tool today solves for production volume. None solve for compounding content intelligence — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product."

---

**On the Brain:**
> "Your clients get smarter content over time — and you get the credit."

---

**On switching cost:**
> "Month 12: The brain is a proprietary asset. Switching means starting over."

---

**On the magic moment:**
> "User sees their brand understood better in 7 minutes than their last agency understood it in 3 months."

---

**On Forge vs agencies:**
> "Forge doesn't have a manager. It doesn't need budget approval to say the true thing."

---

**On the Pre-flight Check:**
> "Not opinion. Pattern recognition from your own data. The brain read every article you published, every compliance edit, every engagement metric — and reported back. No feelings, no politics, no 47-slide deck to justify it."

---

**On the SVP problem:**
> "Every SVP who accidentally found themselves managing a comms org is going to need a moment of reckoning. Forge doesn't water it down."

---

**On what Forge is:**
> "The intelligence layer behind modern marketing."

---

**On the agency pitch:**
> "You run Forge for your clients the way we run Forge for ours."

---

**On the dev experience (internal, not for public):**
> "The dev environment running Sandbox-XM, Sandbox-GTM, and Forge Intelligence simultaneously is the agency demo. That's the thing to show on sales calls."

---

**On Pipedream Connect (product decision rationale, not public):**
> "OAuth is not our core product. Intelligence is. Every hour spent debugging LinkedIn redirect URIs is an hour not spent on Pre-cog scores and GEO Citation."

---

### Notes on usage
- Lines marked "not public" are internal decision rationale — valuable for investor narrative but not consumer-facing
- The positioning line ("only member of your content team...") should be tested as a headline on the landing page
- "47-slide deck to justify it" is golden for LinkedIn — speaks directly to the buyer's lived experience
- Everything in this section is raw — needs copywriting polish before paid use, but the bones are here

---

## Session Archive

### April 5, 2026 — Security, Pre-cog, Ghost, Docs
- 13-page infosec fix (unscoped brains fetch)
- Pre-cog engine rewrite + Predictions tab + Queue badges
- Ghost analytics honest KPIs
- 8 duplicate initDB migrations removed
- README + WHITEBOARD restored and synced across both branches

### April 4, 2026 (Evening) — Integration Blitz
LinkedIn OAuth, HubSpot OAuth + CRM sync, Webflow OAuth, WordPress REST API, Ghost Admin API key, Super Admin role, user sync to HubSpot CRM.

### April 4, 2026 — Production Launch
Clerk auth, useActiveBrand hook, PayPal $99 gate, promo codes, God mode, brand picker removed from 13 pages, TopBar avatar, Admin dashboard, Topic Queue.

### April 2, 2026 — Production Polish
Content Library, Inline Article Editing, External Review Workflow, Queue Card title edit, live article preview link, Publishing Queue Archive.

### March 30, 2026 — Scheduling + Campaign + Ghost
Post scheduling, campaign grouping in queue, UTM injection fixed, hero image auto-generation, Ghost full publish pipeline, reverse publish per-channel, sidebar active state rewrite.

### March 29, 2026 — Mobile + Performance Dashboard
Mobile sidebar (64px icon rail, drawer, backdrop), Performance Dashboard styling, Campaign Analytics tab.

### March 28, 2026 — First Full Pipeline Run
Stage 1–6 end-to-end. First article published to LinkedIn. OG meta rendering.
