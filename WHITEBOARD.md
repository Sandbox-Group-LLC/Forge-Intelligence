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

## Session Log — April 5, 2026 (continued)

### Phase 2 Completion

- **Pre-cog scoring engine** — full rewrite: Haiku-powered semantic reasoning, real data gate (≥3 articles), percentile-based predicted impressions, `requireAuth` on all endpoints, `ALTER TABLE` moved to `initDB`, batch uses shared fn not self-HTTP. 8 duplicate `initDB` migrations cleaned.
- **Predictions tab** — new tab in Performance Dashboard: all scored articles, batch scoring button, signals (positive/negative/neutral), recommended actions, predicted impressions range vs historical avg
- **Pre-cog badge** — Publishing Queue cards: lazy-loaded colored score pill, tooltip with prediction + first action, honest "No data yet" state for new brands
- **Ghost analytics** — KPIs now show Clicks / Avg Read Time / Positive Feedback / Negative Feedback (not fake impressions). Bar chart uses clicks as reach proxy. `AnalyticsTotals` interface updated.
- Phase 1 and Phase 2 declared complete. Phase 3 Intelligence Loop is active.

## Session Log — April 5, 2026

### Critical Infosec Fix — Application-Layer Brand Scoping

**Root cause:** Every page called `GET /api/context-hub/brains` without an auth token. For authenticated users this returned an empty array, causing `brandProfileId` to be `''` on every API call. Content, topics, analytics, and settings were being sent to the void or potentially wrong brand.

**DB layer was never affected** — per-brand tables and `brand_profile_id` column scoping were correct. The breach was application-layer only.

**13 pages fixed:** PublishingQueuePage, ContentLibraryPage, ContentImportPage, TopicQueuePage, GeoStrategistPage, AuthenticityEnricherPage, ContentGeneratorPage, CampaignGeneratorPage, ComplianceGatePage, PerformanceDashboardPage, BrandSettingsPage, IntegrationsPage, AdminPage

**Pattern applied:** Remove `brands` state + unauthenticated fetch + picker dropdown. Replace with:
```typescript
const { activeBrand } = useApp();
const brandProfileId = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
```

**Admin stats** (`GET /api/admin/stats`) — added `requireAuth`, scoped all queries to `WHERE clerk_user_id = $1`. Was returning platform-wide counts including all dev/test scans.

### JSON Parse Hardening

**Root cause:** Claude streams JSON with literal newlines/tabs inside string values — `JSON.parse` fails on long section bodies.

**Fix:** `sanitizeJson(str)` — shared top-level utility in `server.js`. Walks char-by-char, escapes bare control chars inside strings only. Applied to 6 LLM parse points: context agent, content generator (×2), campaign plan, campaign articles (×8), compliance critique.

### Other Fixes
- `startTime is not defined` in `/api/compliance/approve`
- Sidebar active state — transparent background, accent text + left bar (matches GEO tab style)
- Settings sidebar group — `/app/admin` added to active/open detection
- Eyebrow labels — `Stage 6` → `Publishing`, `Content` → `Publishing` (Library + Import)
- Per-page padding — removed from `ContentLibraryPage.css` and `ContentImportPage.css` (was doubling `view-container` padding)
- Emoji audit — Compliance Gate + Import Article: all emojis → Lucide SVGs (1.5 stroke, round caps)
- TypeScript cleanup across BrandSettingsPage, IntegrationsPage, TopicQueuePage, ContentImportPage

---

## Session Log — April 4, 2026 (Evening) — Integration Blitz

6 of 7 channels LIVE. Full OAuth flows. CRM sync.

- LinkedIn OAuth: Personal Profile + Company Page
- HubSpot OAuth: Full CRM + CMS, blog/KB target selectors, auto user sync on login
- Webflow OAuth: Site + collection discovery
- WordPress: REST API + Application Passwords
- Ghost: Admin API key
- Facebook: Parked (OAuth bureaucracy)
- Medium: Legacy badge (API deprecated early 2025)
- Super Admin role: Brian sees all brands, purple shield dropdown in TopBar (dev only)
- User sync to HubSpot: Every Clerk login auto-upserts contact to Forge's HubSpot CRM

---

## Session Log — April 4, 2026 — Production Launch

**forgeintelligence.ai is LIVE.**

- Clerk auth fully wired — `requireAuth`/`softAuth` middleware, JWKS verification
- `useActiveBrand` hook — single source of truth for active brand + `isPaid` state
- Gate flow: free Context Hub → PayPal $99 → full suite unlocked permanently
- Promo codes: `FORGEFRIEND`, `EARLYBIRD`, `SANDBOX100` (unlimited)
- God mode: `?god=ForgeCanvas` / `?ungod`
- Brand picker surgically removed from all 13 pages (first pass — auth fix completed April 5)
- TopBar: avatar dropdown when signed in, Sign In link when not
- Admin dashboard: KPIs + reviewer management
- Topic Queue live at `/app/topic-queue`

**Production migration:**
- `main` → `production` branch fast-forwarded (442 commits)
- `NEON_DATABASE_URL` on `ep-odd-waterfall-akyrdo6x-pooler` (NEVER revert)

---

## Session Log — April 2, 2026 — Production Polish

- Content Library (`/app/content-library`) — searchable archive, hero thumbs, preview modal
- Inline Article Editing — click-to-edit title, meta, sections, saves on blur
- External Review Workflow (`/review/[token]`) — VP approval, no Forge account needed
- Queue Card inline title edit, live article preview link
- Publishing Queue Archive — archive button, Show Archived toggle

---

## Session Log — March 30, 2026 — Scheduling + Campaign + Ghost

- Post scheduling — 60s poll, `publishing` flag prevents double-fire
- Campaign grouping in Queue — week lanes, campaign badges
- UTM injection fixed across all channels
- Hero image auto-generation at publish time (Haiku + Flux)
- Ghost CMS full pipeline — JWT auth, HTML, hero, canonical, reverse delete
- Reverse publish per-channel — LinkedIn, X, Ghost, WordPress, Facebook
- Sidebar active state — fully URL-based via `NAV_ROUTES`

---

## Session Log — March 28, 2026 — First Full Pipeline Run

**First end-to-end: Stage 1 → 6 completed.**
- Article: `forgeintelligence.ai/articles/sandbox-gtm-com/first-sales-hire-playbook...`
- LinkedIn post published, OG meta rendering correctly
- Brand: Sandbox GTM (`ac6b7ff1-5e6c-4fe6-a3bb-441c2f969779`)

---

## Build Status

### Phase 1 — SMB ($99/mo) ✅ Complete
All 8 stages live, auth, PayPal gate, full pipeline.

### Phase 2 — Pro ($299/mo) ✅ Complete
- Pre-cog scoring engine (Haiku-powered, data-gated, auth-scoped)
- Pre-cog Predictions tab in Performance Dashboard
- Pre-cog score badge on Publishing Queue cards
- Ghost analytics — honest KPIs (clicks, read time, feedback — no fake impressions)
- WordPress + Webflow live publish confirmed
- Ghost CMS publish + analytics confirmed

### Phase 3 — Intelligence Loop 🔄 Active
To be defined with Brian. Candidates:
- HubSpot Track A (UTM → deal/campaign attribution)
- Pre-cog accuracy tracking (predicted vs actual over time)
- Deeper pattern analysis (cross-article trends)
- LinkedIn impressions/clicks (⏳ blocked on MDP approval — submitted)

### Phase 4.5 — Agency ($499/mo) ⏸ Parked
Not current focus. Multi-brand UI already built in dev branch.
- Brand Switcher in TopBar
- Agency Dashboard (bird's-eye view)
- Client-level access control (Clerk org-slug)

## Open Issues

| Issue | Notes |
|-------|-------|
| LinkedIn impressions/clicks | MDP approval submitted, under review — unblock when approved |
| Medium integration | Legacy — new tokens unavailable since early 2025 |

---

## Architecture Rules — Do Not Break

- **Never** use Render env vars `PUT` API — it replaces ALL vars. Individual updates only.
- **Never** `git merge main → production` or copy entire files between branches.
- **NEON_DATABASE_URL** must stay on `ep-odd-waterfall-akyrdo6x-pooler`.
- **requireAuth** on every endpoint that touches brand data — no unauthenticated brand reads.
- **sanitizeJson()** is a top-level shared utility in `server.js` — do not re-inline it.
- **activeBrand from useApp()** is the only source of brandProfileId — no page fetches brains directly.
- **view-container owns all page padding** (`48px 40px 96px`) — page CSS classes must not add padding.
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

## Product Spec

### The 8-Stage Workflow

```
[1. Context Hub] → [2. GEO Strategy] → [3. Authenticity Enrichment]
↑                                                      ↓
[8. Feedback Loop] ←— [7. Performance] ←— [6. Publish] ←— [5. Compliance] ←— [4. Generation]
```

### Stage Details

**Stage 1 — Context Hub**
- Brand Scraper → voice signals → Brand Context Profile (<5 min)
- Tone & Voice Calibration — Formality/Confidence/Complexity sliders
- Audience Persona Builder — 3 personas with pain points + trigger events
- Competitive Intelligence Snapshot — gap map vs 3–5 competitors
- Third-Party Voice Crawler — G2, Capterra, Reddit → power phrases, objection patterns

**Stage 2 — GEO Strategy**
- Topical Authority Mapper — coverage gaps, GEO citation probability
- GEO Opportunity Scorer — ChatGPT, Perplexity, AI Overviews, Gemini
- Entity & Schema Mapper — Article, FAQ, HowTo, Organization schema
- Brief Generator — H1/H2 hierarchy, entities, GEO anchors

**Stage 3 — Authenticity Enrichment**
- SME voice repository match
- First-person experience injection points
- Proprietary data hooks (surveys, case studies)
- Author schema auto-generation

**Stage 4 — Content Generator**
- SSE streaming — live progress panel
- Per-section confidence badges (🟢🟡🔴)
- E-E-A-T tags per section
- Hero image via Flux/fal.ai
- Brain-First: reads brain_patterns + brain_mistakes before generating

**Stage 4.5 — Campaign Generator**
- 8-article angle planner
- Per-angle full article generation
- Mirrors into `generated_content_{uuid}` + `publishing_queue` with `campaign_id`
- Week/day scheduling via Campaign Scheduler

**Stage 5 — Compliance Gate**
- Auto-Ship: AI passes → auto-publish
- Approve-to-Ship: review yellows/reds, one-click greens
- Full Review: named approver (enterprise, shelved)
- Every human edit → writes to `brain_mistakes`

**Stage 6 — Publishing**
- Multi-channel: LinkedIn, X, Facebook, Ghost, WordPress, Webflow, HubSpot
- UTM Intelligence Engine — per-channel templates, auto-inject at publish
- Smart Export — HTML (site-template-aware), Markdown, JSON, UTM Link
- Schedule — datetime picker, 60s server poll

**Stage 7 — Performance**
- LinkedIn, X, Ghost, GSC tabs
- Campaign Analytics tab
- Pattern Dashboard (What's Working / What to Avoid)
- Decay Alerts — 50%+ engagement drop flags
- GEO Citation Tracker — brand mention detection in AI search

**Stage 8 — Feedback Loop (auto)**
- Pattern Extractor (Claude Haiku) — analyzes `content_analytics`
- Writes to `brain_patterns` and `brain_mistakes`
- Feeds back into all upstream agents

### Auth Flow

```
Landing → free Context Hub (unauthenticated)
  → Brand Profile reveal
  → Click locked feature → GateModal
      → Promo code OR PayPal $99
      → is_paid = true
      → Signed in: reload → useActiveBrand → gate drops
      → Not signed in: localStorage → Clerk sign-up → auto-tether → gate drops
```

- Promo codes: `FORGEFRIEND` · `EARLYBIRD` · `SANDBOX100` (unlimited)
- Dev reset: `POST /api/admin/reset-brand-paid` `{ brandProfileId, adminPassword: "ForgeCanvas" }`
- God mode: `?god=ForgeCanvas` / `?ungod`

### Agency Multi-Brand Mode (Phase 4.5 — built in dev, not yet production)

Already built in `main`:
- Brand selector dropdowns on every page
- Per-brand Brain data, settings, publishing channels
- Performance Dashboard brand filter
- Super Admin role (brian@sandbox-xm.com)

Needs building for Agency tier:
- Brand Switcher in TopBar
- Agency Dashboard (bird's-eye view)
- Client-level access control (Clerk org-slug)
- White-label architecture

### Pricing

| Tier | Price | Value |
|------|-------|-------|
| SMB Standard | $99/mo | Full 8-stage pipeline |
| Agency Standard | $499/mo | Multi-client + competitive snapshots |
| Pro | $299/mo | + Pre-cog score |
| Agency Pro | $799/mo | + client publishing |
| Enterprise | $599/mo | + ROI dashboard |

---

## GTM Zingers

> Pull for ads, landing page, sales decks.

**Core:**
> "The only member of your content team who will tell you when the strategy is wrong."

**On the gap:**
> "Every AI content tool solves for production volume. None solve for compounding content intelligence."

**On the Brain:**
> "Your clients get smarter content over time — and you get the credit."

**On switching cost:**
> "Month 12: The brain is a proprietary asset. Switching means starting over."

**On the magic moment:**
> "User sees their brand understood better in 7 minutes than their last agency understood it in 3 months."

**On Pre-flight:**
> "Not opinion. Pattern recognition from your own data. No feelings, no politics, no 47-slide deck."
