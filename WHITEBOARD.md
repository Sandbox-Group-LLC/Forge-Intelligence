# Forge Intelligence — Whiteboard

> **Active working doc.** README.md is the architecture SSOT.
> Whiteboard tracks current state, product thinking, open decisions, and session history.
> Keep it current. Both branches must always have the same version of this file.

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
- Pre-cog scoring engine (Haiku-powered semantic reasoning, data-gated ≥3 articles, auth-scoped)
- Pre-cog Predictions tab in Performance Dashboard (signals, predicted impressions, batch scoring)
- Pre-cog score badge on Publishing Queue cards (lazy-loaded, color-coded, tooltip)
- Ghost analytics — honest KPIs: clicks, read time, feedback. No fake impressions.
- WordPress + Webflow live publish confirmed working
- Ghost CMS publish + analytics confirmed

### Phase 3 — Enterprise ($599/mo) 🔄 Active
To be defined. Candidates from the original spec:
- HubSpot Track A (UTM → campaign-level deal attribution — no email required)
- Stage 7 full depth: revenue attribution, ROI dashboard
- Deep Pattern Analysis add-on
- Pre-cog accuracy tracking (predicted vs actual over time)
- LinkedIn impressions/clicks (⏳ blocked — MDP approval submitted and under review)

### Phase 4 — Scale Core (Year 2) 🔲 Future
- Reader-level personalization via CDP
- Native video + audio generation
- EU AI Act compliance layer
- GA4 native attribution
- Cross-client opt-in pattern sharing → Industry Benchmark Reports

### Phase 4.5 — Agency ($499/mo) ⏸ Parked
Not current focus. Multi-brand data model, per-brand tables, and brand selectors are **already built in dev**. This phase is UX, access control, and commercial packaging only.
See "Agency Multi-Brand Mode" section below.

---

## Open Issues

| Issue | Notes |
|-------|-------|
| LinkedIn impressions/clicks | MDP approval submitted, under review — unblock when approved |
| HubSpot Track A | Phase 3 — campaign attribution, no email required |
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

---

### Stage 1 — Context Hub *(Gap: Shared Team Context)*

**The 6 Core Tools:**

1. **Brand Scraper & Auto-Populator** — Crawls website, blog, case studies, social. Extracts implicit brand signals. Generates Brand Context Profile in <5 min. Goal: zero-manual onboarding hook for SMBs.

2. **Tone & Voice Calibration Engine** — Formality/Confidence/Complexity sliders. Output: Locked Voice Profile.

3. **Audience Persona Builder** — Structured templates + CRM import (HubSpot first). Primary buyer / influencer / end user layering. Output: Persona Library.

4. **Competitive Intelligence Snapshot** — Analyze 3–5 competitors, identify content gaps and GEO citation presence. Output: Gap Map (feeds Stage 2).

5. **Knowledge Base Connector** — Index past content, GSC data, CRM objections. Output: RAG-ready Knowledge Base.

6. **Third-Party Voice Intelligence Crawler** *(Unique differentiator)* — G2, Capterra, Trustpilot, Glassdoor, Reddit. Extracts Power Phrases, Objection Patterns, Competitor Comparisons. Output: Third-Party Voice Profile (feeds Stages 2–4).

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

**Open Questions:**
- Brand Scraper: Social included? (LinkedIn/X for voice)
- Context refresh: Manual or scheduled?
- CRM: Required or optional for SMB tier?
- Third-Party Voice: G2 parsing depth? Reddit weight?

---

### Stage 2 — GEO Strategy *(Gap: GEO-Native Optimization)* ✅ LIVE

**Brain-First:** GEO Strategist reads Mistakes + Patterns + Memories before every brief.

- **Topical Authority Mapper** — Maps brand + competitor coverage, scores gaps by GEO citation probability. Writes to Brain: competitive topic graph.
- **GEO Opportunity Scorer** — Scores across ChatGPT, Perplexity, AI Overviews, Gemini. Surfaces "quick wins" where brand has authority but no content. Reads/Writes Brain: GEO opportunity scores per topic.
- **Entity & Schema Mapper** — Article, FAQ, HowTo, Organization schema auto-generation. Maps competitor entities you aren't targeting.
- **Brief Generator** — Combines all above + Stage 1 context. Outputs structured brief: H1/H2 hierarchy, entities, FAQ, GEO anchors.

---

### Stage 3 — Authenticity Enrichment *(Gap: E-E-A-T Signal Integration)* ✅ LIVE

**Brain-First:** Enricher reads which SME injections previously converted vs fell flat.

- SME voice repository match to content sections
- First-person experience injection points
- Proprietary data hooks (surveys, case studies, original research)
- Author schema auto-generation
- Customer power phrases from Third-Party Voice
- Manual Input Fallback — prompt cards with tooltips

**Reads from Brain:** Voice patterns that drove engagement
**Writes to Brain:** E-E-A-T patterns that passed compliance + converted

---

### Stage 4 — Content Generator *(Gap: Native Multimodal)* ✅ LIVE

**Brain-First:** Generator reads ALL Brain tables before producing a single word.

- SSE streaming — per-section generation with live progress panel
- Per-section confidence badges (🟢🟡🔴) with reason text
- E-E-A-T tags per section
- Hero image generation — Haiku prompt → Flux/fal.ai async post-SSE
- Brain Match score + citation count in meta bar
- Per-brand `generated_content_{uuid}` table auto-provisioned on first run

**Confidence Scoring:**
- 🟢 Green — high Brain pattern match, auto-approvable
- 🟡 Yellow — SME input needed or fact needs verification
- 🔴 Red — explicit human decision required

**Full Content Package (spec, not all built):**
```
├── Long-form article (LIVE)
├── Social variants (LinkedIn, X, Instagram, YouTube)
├── Email sequence
├── Video script + B-roll direction
├── Podcast outline
└── Graphic direction prompts
```

---

### Stage 5 — Compliance Gate *(Gap: Enterprise Governance)* ✅ LIVE

**Three configurable modes:**

```
MODE 1: Auto-Ship (low-risk, high-trust)
→ AI self-critique passes → auto-publishes → human notified only

MODE 2: Approve-to-Ship (standard)
→ Human reviews yellows/reds only
→ One-click approve on greens, inline edit on yellows

MODE 3: Full Review (regulated industries)
→ Every piece routes to named human approver
→ Full audit log written to Brain
→ STATUS: Shelved — re-enable for enterprise tier
```

**The Mistakes Loop:** Every human edit is a signal. Consistent edits → writes to Brain Mistakes → stops generating that pattern without being told twice.

---

### Stage 6 — Publishing & Distribution *(Gap: Cross-Channel Orchestration)* ✅ LIVE

**Architecture: Native vs. Integrate vs. Export**

**Tier 1 — Native (always, non-negotiable)**
- UTM Intelligence Engine — auto-generates UTMs tied to Brain attribution model. Stage 7 attribution breaks without this.
- Content Version Control — every draft, edit, and override versioned. Brain stores deltas.
- Publishing Queue — Draft → Approved → Scheduled → Live → Measured.

**Tier 2 — Deep Integrations**
- WordPress ✅ LIVE (REST API + Application Passwords)
- Webflow ✅ LIVE (v2 CMS Collections API)
- Ghost ✅ LIVE (JWT auth, HTML, hero image, canonical)
- HubSpot — Two-track architecture (see below)

**HubSpot Two-Track Architecture:**
```
Track A: Campaign-level (Phase 3, no email required)
→ Content performance + GEO metrics as campaign activity
→ Works for blog, social, video

Track B: Direct email campaigns (Phase 4)
→ Full contact + deal-level attribution
→ Requires consent management + GDPR compliance layer
→ Different integration architecture — do NOT collapse into Track A
```

**Tier 3 — Smart Export** ✅ LIVE
HTML (site-template-aware), Markdown, JSON, UTM Link

**Tier 4 — Lightweight Social** ✅ LIVE
LinkedIn, X, Facebook, Ghost

| Channel | Status |
|---------|--------|
| LinkedIn | ✅ LIVE |
| X (Twitter) | ✅ LIVE |
| Facebook | ✅ LIVE |
| Ghost CMS | ✅ LIVE |
| WordPress | ✅ LIVE |
| Webflow | ✅ LIVE |
| HubSpot | Track A → Phase 3 |
| Medium | ✅ LEGACY — new tokens unavailable since early 2025 |
| Reddit | ✅ LIVE (pipeline exists, pending dev portal access) |

---

### Stage 7 — Performance Intelligence *(Gap: Revenue Attribution)* ✅ LIVE (partial)

**What We Measure:**

**Layer 1: Traditional SEO (GSC)** — ranking velocity, impressions → CTR → clicks. Writes to Brain: ranking patterns by content type, length, schema.

**Layer 2: GEO Citation Tracking** — is content cited in ChatGPT, Perplexity, AI Overviews, Gemini? Which sections? Writes to Brain: GEO citation patterns.

**Layer 3: Engagement Signals** — scroll depth, shares, comments. Writes to Brain: engagement patterns by persona, format, channel, topic.

**Layer 4: Revenue Attribution (Phase 3+)**
```
Anonymous (always available):
→ UTM-tagged traffic → GA4 goal completions → pipeline influence

Identified (CRM connected):
→ Contact touched content → deal progressed → LTV correlation
```

**Layer 5: Content Decay Monitoring** ✅ LIVE — flags 50%+ engagement drop from peak, auto-queues refresh recommendation. Writes to Brain: decay patterns.

**ROI Dashboard (Phase 3):**
- View 1: Content Health — live content ranked by performance score, 🟢🟡🔴 decay status
- View 2: Pattern Library — top performing hooks, formats, lengths by channel
- View 3: Revenue Impact — pipeline influenced, deals closed, content ROI per asset

**Delivery Tiers:**

| Feature | Standard | Pro |
|---------|----------|-----|
| Performance digest | ✅ | ✅ |
| Medium-confidence patterns | ✅ | ✅ |
| Deep Pattern Analysis | — | ✅ |
| Pre-cog score | Hidden (runs for all) | ✅ Pay-to-view |
| Decay monitoring | ✅ | ✅ |
| Pre-cog accuracy tracking | — | ✅ Phase 3 |
| Industry Benchmark Reports | — | Opt-in Phase 4 |

---

### Stage 8 — The Feedback Loop *(Gap: Compounding Intelligence)* ✅ LIVE (Pattern Extractor)

**Pattern Extractor Agent — runs on demand + cadence.**

**4 Automated Actions:**

**1. Pattern Promotion**
```
IF performance_score > threshold AND sample_size > medium_confidence_minimum:
  → Extract: hook, format, length, persona, GEO structure, SME style
  → Write to brain_patterns: success_rate + confidence_score + recency weight
```

**2. Mistake Crystallization**
```
IF content underperformed OR human edits > threshold OR compliance rejection:
  → Write brain_mistakes: type, root cause, severity
  → Generate prevention guardrail
```

**3. Persona Refinement**
```
IF engagement deviates from persona assumption:
  → Update vocabulary preferences
  → Adjust pain point weighting
  → Flag persona drift if deviation > threshold
```

**4. Context Hub Refresh (Phase 3)**
```
  → Re-run Third-Party Voice Crawler
  → Re-score competitive gap map
  → Update GEO opportunity scores
  → Refresh decay queue
```

**The Pre-Cog Score — runs for all tiers, pay-to-view at Pro:**
```
BEFORE Stage 6 publishes:
  → Haiku scores content against brain_patterns + brain_mistakes + historical analytics
  → Outputs: predicted impressions range, signals, recommended actions
  → Standard: score visible on Queue card (current behavior)
  → Pro: full Predictions tab in Performance Dashboard (current behavior)
```

*Free users feel the platform is better. They just don't know why. That's the upgrade hook.*

**The Compounding Effect:**
```
Day 1:    Brain empty. Agents start from brand context only.
Week 4:   10–15 patterns. Agents prefer proven structures.
Month 3:  50+ patterns. 20+ guardrails. Human edit rate drops ~30%.
Month 6:  Personas behavioral. Agents self-correct before human review.
Month 12: Brain is a proprietary asset. Switching = starting over.
```

**Cross-Client Pattern Sharing — Default OFF. Explicit opt-in.**
Value exchange: share anonymized patterns → unlock Industry Benchmark Reports for your vertical.

---

## Client Brain Architecture

Each brand gets isolated storage. Multi-agent shared memory.

```
Client Brain (NeonDB)
├── brand_profiles           — voice profile, personas, competitive gaps
├── generated_content_{uuid} — per-brand article table (auto-provisioned)
├── brain_patterns           — what worked (success rate, confidence, recency weighted)
├── brain_mistakes           — what failed + human feedback + guardrails
├── content_analytics        — impressions, clicks, engagement per article per channel
├── geo_citations            — brand mention detection in AI search results
├── decay_alerts             — 50%+ engagement drop flags
├── publishing_queue         — staged → approved → published
├── publish_log              — channel publish results + live status
└── agent_activity_log       — every agent call, tokens, latency
```

**Brain-First Protocol (mandatory on every agent):**
```
BEFORE generating:
  1. Read brain_mistakes relevant to this task
  2. Read brain_patterns that succeeded in this context
  3. THEN generate — informed by both
```

**Predictive Guardrails (Minority Report — Phase 3):**
- Pre-gen: "Similar content failed. Override?"
- Pre-compliance: "Phrasing flagged in previous mistakes"
- Pre-publish: "Format underperformed on this channel before"

---

## Auth Architecture

```
Landing → free Context Hub (unauthenticated)
  → Brand Profile reveal
  → Click locked feature → GateModal
      → Promo code OR PayPal $99
      → is_paid = true
      → Signed in: reload → useActiveBrand → gate drops
      → Not signed in: localStorage → Clerk sign-up → auto-tether → gate drops
```

- Promo codes: `FORGEFRIEND` · `EARLYBIRD` · `SANDBOX100` (unlimited, server-side only)
- Dev reset: `POST /api/admin/reset-brand-paid` `{ brandProfileId, adminPassword: "ForgeCanvas" }`
- God mode: `?god=ForgeCanvas` / `?ungod`
- Clerk URLs: sign-in/up at `accounts.forgeintelligence.ai`

**Key decisions locked:**
- `ClerkProvider` wraps `BrowserRouter` — single instance
- `requireAuth` middleware guards all brand-data endpoints — no exceptions
- `clerk_user_id` on `brand_profiles` — auto-tethered on `/api/auth/me`
- `activeBrand` from `useApp()` is the ONLY source of `brandProfileId` on any page
- $99 = 1 brand, 1 account. More brands = more $99.

---

## Agency Multi-Brand Mode — Preserve for Phase 4.5

> Do not remove or collapse these features during any production work. The data model is the foundation of the agency tier — built, working, waiting for the UX and commercial layer.

**What's already built in dev (zero additional backend required):**
- Brand selector dropdowns on every page (hidden in production via single-brand logic, visible for agency)
- Per-brand `brain_patterns`, `brain_mistakes`, `geo_citations`, `decay_alerts`, `content_analytics` — each brand learns independently, zero cross-contamination
- Per-brand `publishing_channels` — each brand has its own LinkedIn, X, Ghost, GSC credentials
- Performance Dashboard brand filter — agency weekly check-in per client in <5 min
- Campaign Generator per brand — campaigns are brand-scoped, visually separated in queue

**What needs building for Phase 4.5:**
- Brand Switcher in TopBar — quick-switch between client contexts
- Global brand context indicator — "Currently working in: [Brand]" in TopBar
- Agency Dashboard — bird's-eye across all brands: articles this week, pending compliance, decay alerts, citation status
- Client-level access control — Clerk org-slug (admin sees all, client sees own, read-only approval view)
- Brand duplication — "Clone settings to new brand"
- White-label architecture — UI skinning, custom domain

**Production rules — never break these:**
- DO NOT remove brand-scoped tables — they are the multi-tenancy foundation
- DO NOT remove per-brand publishing channels — even SMB users have multiple channels
- DO preserve the Brand Settings per-brand architecture

**The agency pitch:**
> "You run Forge for your clients the way we run Forge for ours. Every brand gets its own brain. Every brain learns from every publish. Your clients get smarter content over time — and you get the credit."

The dev environment running Sandbox-XM, Sandbox-GTM, and Forge Intelligence simultaneously **is the agency demo.** That's the thing to show on sales calls.

---

## Architectural Decision — Pipedream Connect

> **Decision date:** April 1, 2026 | **Status:** APPROVED for new channel OAuth

**The problem:** Every channel OAuth required creating a developer app, getting approved (LinkedIn MDP = weeks, Reddit portal locked, Google sensitive scope = 1+ month), writing token refresh logic per channel. OAuth is not Forge's core product. Intelligence is.

**What Pipedream Connect does:** Manages full OAuth for 2,700+ apps using pre-approved client IDs. Handles token storage, refresh, rotation. Frontend SDK for embedded auth. Proxy API so tokens never touch our DB. Has already cleared Google, LinkedIn, Meta, Reddit sensitive scope reviews.

**What stays the same:** All publishing logic is unchanged. Only difference:
```
BEFORE: pool.query('SELECT credentials FROM publishing_channels WHERE...')
AFTER:  pipedream.getToken(userId, 'linkedin')
```

**What this unlocks with no additional work:**
- LinkedIn full analytics scope (once MDP approved — Pipedream has it)
- Reddit (portal was blocked — Pipedream has access)
- HubSpot, Notion, Slack, Gmail as future channels

**Implementation notes:**
- Frontend: `@pipedream/connect-react` SDK, or iframe direct: `pipedream.com/_static/connect.html?token=xxx&app=slug`
- Backend: generate short-lived connect token, return `account_id` on success, store in `publishing_channels`
- Key learning: building the iframe directly (not the SDK) was the correct call — SDK token resolution was broken

**Cost note:** Priced per connected account per month. Evaluate at pipedream.com/pricing before Phase 4.5 launch and factor into $499/mo Agency margin.

---

## Tech Stack

### LLM Routing

| Agent | Model | Reason |
|-------|-------|--------|
| Context Agent (Stage 1) | Claude Sonnet 4.5 | Brand reasoning, structured JSON |
| GEO Strategist (Stage 2) | Claude Sonnet 4.5 | Multi-step competitive reasoning |
| Authenticity Enricher (Stage 3) | Claude Sonnet 4.5 | E-E-A-T analysis |
| Content Generator (Stage 4) | Claude Sonnet 4.5 | Long-form, Brain-First |
| Campaign Generator (Stage 4.5) | Claude Sonnet 4.5 | 8-angle planner + article gen |
| Compliance Gate (Stage 5) | Claude Sonnet 4.5 | Structured rule checking |
| Pre-cog Scorer | Claude Haiku | Fast, cheap, semantic scoring |
| Pattern Extractor (Stage 8) | Claude Haiku | Pattern/mistake extraction from analytics |
| Post Copy | Claude Haiku | LinkedIn/X/Facebook post copy |
| Image Prompts | Claude Haiku → Flux/fal.ai | Hero image generation |

*SDK pinned at `^0.39.0` — do not upgrade without testing.*

### Infrastructure

| Layer | Tool | Notes |
|-------|------|-------|
| Client Brain | NeonDB + pgvector | Per-brand tables, RLS isolation |
| Embeddings | VoyageAI | Brain memory retrieval (Phase 3) |
| Hosting | Render | Auto-deploy from branch |
| Email | Resend | Notifications, review workflow |
| Scheduled Jobs | EasyCron | Pattern Extractor, decay monitoring |
| Images | fal.ai Flux | Hero image generation |
| CMS | Ghost Admin API | Publish + analytics sync |

### EasyCron Schedule (Phase 3)
```
Weekly: Pattern Extractor → promote patterns, crystallize mistakes
Weekly: Context Hub refresh → Third-Party Voice, GEO re-score
Daily:  Decay monitoring → silent refresh queue
Daily:  Performance digest → compile + Resend
```

---

## Pricing

| Tier | Phase | Price | Core Value |
|------|-------|-------|------------|
| SMB Standard | 1 | $99/mo | Full 8-stage pipeline |
| Agency Standard | 4.5 | $499/mo | Multi-client + competitive snapshots |
| Pro | 2 | $299/mo | + Pre-cog score dashboard |
| Agency Pro | 4.5 | $799/mo | + Client publishing |
| Enterprise | 3 | $599/mo | + ROI dashboard + revenue attribution |
| White-label | 4 | Custom | Agency network licensing |

---

## Architecture Rules — Do Not Break

- **Never** use Render env vars `PUT` API — replaces ALL vars. Individual updates only.
- **Never** `git merge main → production` or copy entire files between branches.
- **NEON_DATABASE_URL** must stay on `ep-odd-waterfall-akyrdo6x-pooler`.
- **requireAuth** on every endpoint that touches brand data — no exceptions.
- **sanitizeJson()** is a top-level shared utility in `server.js` — do not re-inline it.
- **activeBrand from useApp()** is the only source of brandProfileId — no page fetches brains directly.
- **view-container owns all page padding** (`48px 40px 96px`) — page CSS classes must not add their own.
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

## GTM Zingers

> Pull for ads, landing page, sales decks, cold outreach, social. Do not let these die in a doc.

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

**On the agency pitch:**
> "You run Forge for your clients the way we run Forge for ours."

**On what Forge is:**
> "The intelligence layer behind modern marketing."

---

## Session Log — April 5, 2026

### Morning — Infosec + Stability
- **Critical infosec fix** — 13 pages were calling `/api/context-hub/brains` without auth, `brandProfileId` was `''` on every API call. DB layer was fine; application layer was broken. All 13 pages fixed to read `activeBrand` from `useApp()`.
- **Admin stats scoped** — `GET /api/admin/stats` now `requireAuth` + `WHERE clerk_user_id = $1`. Was returning platform-wide counts.
- **JSON parse hardening** — `sanitizeJson()` shared utility applied to all 6 LLM parse points. Handles bare newlines/tabs/control chars in Claude's streamed JSON.
- **`startTime` fix** — `/api/compliance/approve` was crashing on activity log write.
- **Sidebar** — active state → transparent bg, accent text + left bar (matches GEO tab style). Settings group now includes `/app/admin`.
- **Eyebrows** — `Stage 6` → `Publishing`, `Content` → `Publishing`.
- **Padding** — removed per-page padding from ContentLibrary + ContentImport CSS.
- **Emoji audit** — Compliance Gate + Import Article: all emojis → Lucide SVGs.
- **TypeScript cleanup** — unused vars across BrandSettingsPage, IntegrationsPage, TopicQueuePage, ContentImportPage.

### Afternoon — Pre-cog + Performance + Ghost
- **Pre-cog engine rewrite** — Haiku-powered semantic scoring, real data gate (≥3 articles), percentile-based predicted impressions, `requireAuth` on all 3 endpoints, `ALTER TABLE` moved to `initDB`, batch uses shared function not self-HTTP. Cleaned 8 duplicate `initDB` hero_image migration blocks.
- **Predictions tab** — new tab in Performance: all scored articles, batch scoring, signals, recommended actions, predicted impressions range vs historical avg.
- **Pre-cog badge on Queue cards** — lazy-loaded, colored score pill, tooltip with prediction + first action.
- **Ghost analytics** — KPIs now show Clicks / Avg Read Time / Positive Feedback / Negative Feedback. Bar chart uses clicks as reach proxy. `AnalyticsTotals` interface updated.
- **WHITEBOARD restored** — pre-nuke content from commit `904acc3fa119` merged back in with clean structure.

---

## Session Log — April 4, 2026 — Integration Blitz + Production Launch

- LinkedIn, HubSpot, Webflow OAuth live. WordPress REST API + Application Passwords live.
- Super Admin role in dev (brian@sandbox-xm.com) — purple shield dropdown in TopBar.
- User sync to HubSpot: every Clerk login auto-upserts contact.
- forgeintelligence.ai LIVE. $99 PayPal gate. God mode. All 13 pages stripped of brand picker.
- Reviewer approval flow: Resend email + signed token URL, no Forge account needed.

---

## Session Log — April 2, 2026 — Production Polish

- Content Library — searchable archive, hero thumbs, status tabs, preview modal.
- Inline Article Editing — click-to-edit title, meta, sections. Saves on blur.
- External Review Workflow — signed token URL, VP approval without login. First verdict: "Slay." ✅
- Queue Card inline title edit + live article preview link.

---

## Session Log — March 30, 2026 — Scheduling + Campaign + Ghost

- Post scheduling — 60s poll, `publishing` flag prevents double-fire.
- Campaign grouping in Queue — week lanes, campaign badges.
- UTM injection fixed across all channels.
- Ghost CMS full pipeline — JWT auth, HTML, hero, canonical, reverse delete.
- Reverse publish per-channel live.
- Sidebar active state — fully URL-based via `NAV_ROUTES`.

---

## Session Log — March 28, 2026 — First Full Pipeline Run

**First end-to-end Stage 1→6 completed in production.**
- Article: `forgeintelligence.ai/articles/sandbox-gtm-com/first-sales-hire-playbook...`
- LinkedIn post published, OG meta rendering correctly.
- Brand: Sandbox GTM (`ac6b7ff1-5e6c-4fe6-a3bb-441c2f969779`)
