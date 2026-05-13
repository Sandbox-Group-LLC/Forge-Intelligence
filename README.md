# Forge Intelligence — Master SSOT

> **This README is the single source of truth for all AI sessions, dev work, and project decisions.**
> Always read this file top to bottom before touching anything.
> Always read WHITEBOARD.md second — it is the active working doc.
> Always read the current file and capture its SHA before writing — never write blind.
> Always commit with a descriptive message using conventional commits (feat:, fix:, refactor:, style:)
> Never give Brian code to run themselves — make the commit directly.
> Render auto-deploys on every push to production — no manual deploy step needed.
> DO NOT narrate or ask Brian to confirm changes.
> URL pattern: frontend routes match product names (e.g. /context-hub, /geo-strategist), API routes follow /api/{product-slug}/

---

## 🚀 Production Launch — April 4, 2026

**forgeintelligence.ai is LIVE.**

| | |
|---|---|
| **URL** | https://forgeintelligence.ai |
| **Dev** | https://dev.forgeintelligence.ai |
| **Branch** | `production` → Render auto-deploy |
| **Price** | $99 one-time via PayPal |

---

## What Is This

**Forge Intelligence** is a premium B2B marketing intelligence platform.

**The core idea:** Every AI content tool solves for production volume. None solve for *compounding content intelligence* — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product.

**One-liner:** Forge Intelligence turns fragmented marketing activity into clear intelligence and confident action.

**Descriptor:** The intelligence layer behind modern marketing.

---

## Platform Status (May 11, 2026)

### All 8 Stages Live

| Stage | Name | Status | Model |
|-------|------|--------|-------|
| 1 | Context Hub | ✅ LIVE | Perplexity Sonar + Website Scraper + Claude Opus 4.6 (profile) + Claude Haiku 4.5 (brain ops) |
| 2 | GEO Strategist | ✅ LIVE | Claude Sonnet 4.6 (3 tools) |
| 3 | Authenticity Enricher | ✅ LIVE | Perplexity Sonar (SME signals) + Claude Sonnet 4.6 (EEAT/injection/assembly) — SSE progress, enriched brief selector |
| 4 | Content Generator | ✅ LIVE | Claude Sonnet 4.6 — requires enriched brief, published briefs filtered |
| 4.5 | Campaign Generator | ✅ LIVE | Claude Sonnet 4.6 |
| 4.6 | Email Campaign Generator | ✅ LIVE | Mistral Large — inline edit + per-flag actions (resolve/cite/dismiss) + brain feedback loop on false-positive dismissals + render-side sanitization for P.S./CTA/proof-token leakage |
| 5 | Compliance Gate | ✅ LIVE | Claude Sonnet 4.6 |
| 6 | Publishing & Distribution | ✅ LIVE | Queue + multi-channel |
| 7 | Performance Intelligence | ✅ LIVE | LinkedIn + X + Ghost + GSC + GEO + Facebook + Reddit (Zernio-routed for LinkedIn/Reddit/Facebook with dual-ID sync as of May 11) |
| 8 | Feedback Loop | ✅ LIVE | Pattern Extractor (Claude Haiku 4.5) |
| — | Hero Image Generation | ✅ LIVE | Claude Haiku 4.5 (prompt) + Flux Schnell via fal.ai (render) |

### Model Economics (Multi-Model Architecture)
- **Claude Opus 4.6** — Context Hub brand profile construction (foundational analysis that conditions every downstream decision)
- **Claude Sonnet 4.6** — GEO, Enricher, Content Gen, Compliance (strategic depth + voice fidelity)
- **Claude Haiku 4.5** — Brain pattern matching, topic preflight, image prompts (speed over depth)
- **Perplexity Sonar** — Live web research: competitor discovery, SME signals, citation tracking
- **Mistral Large** — Email campaigns (lead-gen focused, conversational, fast)
- **Flux Schnell (fal.ai)** — Hero image generation (brand-voice-aware prompts, sub-2s render)

### Auth Architecture
- **Clerk** — Google, GitHub, email/password
- `isPaid` derived from `(is_paid OR trial.active)` server-side in `/api/auth/me` — then passed through to FE via `activeBrand.isPaid`
- 17+ FE pages check `useApp().isPaid` to decide whether to render content or `GateModal`
- All gated pages: `if (brandLoading) return null` before gate check
- **Super Admins** (hardcoded in `server.js` `SUPER_ADMIN_IDS`):
  - `user_3BtC7nusm7CShN7EdUYaaLZcDwp` (brian@sandbox-xm.com) — primary login, owns Sandbox-XM + 10 other flagship brands
  - `user_3CJmE0WkOj1RJC5yF99scEuwUpO` (therosethyme) — super-admin viewer only, owns no brands
- **Other Brian-owned logins (NOT super admin):**
  - `user_3BvMphl4EThg9WSOdhH5BNVXIHL` — legacy login, permanently tethered to `Sandbox-GTM` (61d1f187-c00a-443c-ada2-a073afa005cd) as the "second user" test account
- FI account intentionally excluded from super-admin list for dogfooding.

### 7-Day Full-Access Trial (LIVE May 2, 2026)
- **Trial trigger:** Clerk signup completion (the moment Forge tethers an anonymous brand to a `clerk_user_id`)
- **Trial scope:** Per-user, not per-brand. `MIN(trial_started_at)` across all the user's brands defines the start.
- **Trial duration:** 7 days from start. After expiration, `isPaid` flips false and gated pages re-render `GateModal` with "Your 7-day trial ended" copy + PayPal $99 flow.
- **Lead capture:** anonymous user clicks any non-Brain stage → `GateModal` shows "Start your free 7-day trial" CTA → redirects to Clerk signup with `forge_pending_brand_id` in localStorage → returns post-signup, brand auto-tethers, trial starts.
- **Eligibility gate:** `TRIAL_LAUNCH_MARKER` env var (default `2026-05-02T00:00:00Z`). Users whose first brand was created before this date are not eligible — they stay in the existing free-tier behavior. New signups from this date forward get the trial.
- **Permanent unlock:** PayPal $99 flips `is_paid = true` — wins regardless of trial state.
- **Single source of truth:** `getUserTrialState(clerkUserId)` helper in `server.js` returns `{ active, eligible, daysRemaining, trialStartedAt, trialEndsAt }`. Used by `/api/auth/me` to derive `isPaid` and to build the `trial` block returned to FE.
- **TopBar countdown pill:** yellow gradient pill (`.topbar-trial-pill`) renders during active trial showing days remaining. Hides when trial expires or user converts.
- **Onboarding email:** `sendTrialWelcomeEmail()` fires fire-and-forget at tether time (regular-user paths only — super admin tether skipped). Pulls email + first_name from Clerk API, sends via Resend with Brian's from-address. Idempotency-guarded by `brand_profiles.welcome_email_sent_at` column.
- **Brand columns added:** `trial_started_at TIMESTAMPTZ`, `welcome_email_sent_at TIMESTAMPTZ`.

### Brand Scoping (Critical)
- **Every page** reads `activeBrand` from `useApp()` — the single source of truth for `brandProfileId`
- No page fetches `/api/context-hub/brains` without an auth token
- **Brain version tracking:** `geo_briefs` and `enriched_briefs` store `brain_version`. Cache auto-busts when stale. Yellow banner warns users.
- **Stale brief cleanup:** GEO + Authenticity DELETE old briefs before INSERT on re-run — corrections override, no accumulation
- Brand picker dropdown gated on `isSuperAdmin` (regular users see only the simple brand pill, not a dropdown)
- All API endpoints that touch brand data require `requireAuth`
- Admin stats scoped to `WHERE clerk_user_id = $1` — no cross-user data

### JSON Parse Hardening
- `sanitizeJson()` — shared top-level utility in `server.js`
- Applied at every LLM JSON.parse call: context agent, content generator (2 paths), campaign plan, campaign articles (×8), compliance critique
- Handles bare newlines/tabs/control chars inside Claude's streamed string values

### Recent Major Work (May 7–11, 2026)

**Zernio LinkedIn migration (May 7–8):** Forge LinkedIn publishing migrated from direct OAuth to Zernio's API. Sandbox-XM, Sandbox-GTM, and Attio still on direct OAuth pending migration. **Critical:** Zernio's `/analytics` endpoint requires Zernio's internal `_id`, NOT the platform-native `postId`. `zernioPublish()` returns both: `{ postId: platformPostId, zernioPostId: post._id, ... }`. Analytics sync uses `zernioPostId` when present, falls back to legacy LinkedIn API path when absent.

**Email Campaign Generator polish (May 9–10):** Three rendering bugs fixed (duplicate P.S., inline `{{cta_url}}`, `[NEEDS_PROOF]` tokens) — both at source (prompt rewrite at `src/agents/stage46_email_campaign/system_prompt.md`) and at render (sanitization helper). Edit mode on every EmailCard (subject_lines + body + ps + cta_text + cta_url_placeholder all editable). Per-flag actions: Mark resolved / Add citation / Dismiss as false positive. **Dismissals write `brain_mistakes` rows with `mistake_type='compliance_false_positive:<type>'` so the Compliance Gate's brain learns to suppress patterns** — closes the feedback loop on AI-generated flags. Sequence Assessment readability: plain English, three paragraphs, no `[bracket_identifiers]`.

**MCP server live (May 9):** `POST /mcp` endpoint exposes 3 read-only tools to external MCP clients (Viktor/Slack assistant): `list_email_campaigns`, `list_emails_in_campaign`, `get_email_copy`. JSON-RPC 2.0, dual-auth (Bearer + X-Api-Key), new scope namespace `mcp:campaigns:read` / `mcp:emails:read`.

**Attio CSV export (May 9):** Per-email CSV download with subject-variant picker (benefit / curiosity / pattern_interrupt). Two columns matching Attio's "Generated Emails" Object attributes exactly. RFC-compliant escaping + UTF-8 BOM. Same pattern adopted for HubSpot copy-to-clipboard.

**HubSpot integration stripped (May 9):** Four rebuild attempts confirmed HubSpot's public API gates email-template creation behind Marketing Hub Pro+ at every tier-accessible endpoint. Sales Hub Starter users can manually create email templates via HubSpot's UI but not via any public API. Replaced API push with a "Copy for HubSpot" button on each email card — formats email as paste-ready HTML and writes to clipboard. User pastes into HubSpot Sales > Templates > New > Source view. No OAuth, no scope drama, works on every tier.

**Publish-status mirror bug (May 10):** 100% failure rate caught by Brian noticing one specific article was missing in Performance Dashboard. Investigation found `/api/publishing/publish` updated `publishing_queue.status` + `publish_log` + `memories` but never the parent `generated_content_<brand>.status` row. 25 of 25 published articles across 3 brands were stuck at `status='draft'` despite being live. Backfilled + added the missing 5th UPDATE so future publishes self-correct.

**Copilot Autofix disabled (May 10):** 7 unsupervised auto-merge PRs overnight broke dev's `IntegrationsPage.tsx`. Reverted single-file from last-known-good commit. Autofix bot disabled at repo level. CodeQL findings still surface in Security tab; just no auto-PRs.

**Lessons logged (folded into ARCHITECTURE_RULES below):**
- **Probe before pivot.** A 30-second API call to validate a theory beats 90 minutes of pivot-based-on-inference. Used `/api/admin/zernio/raw` to confirm Zernio analytics ID requirements before writing a fix.
- **Multi-table write contracts need to live somewhere visible.** The publish flow needed to update 5 tables (publishing_queue, publish_log, memories, agent_activity_log, and the parent content table). Knowing the contract lived only in "whoever last touched this code remembered." 25 articles were silently broken because of it.
- **Same paywall in different shapes = stop pivoting, call it.** Cost: 90 min of HubSpot endpoint pivots before recognizing the Marketing Hub Pro+ tier gate.
- **Atomic single-PUT commits when editing one file across multiple in-memory steps.** Two scripts crashed mid-edit and left main with self-inconsistent state. Convention: do everything in memory first, sanity-check, then ONE PUT.
- **API auth state is fragile across migrations.** The Zernio migration overwrote Forge's LinkedIn `publishing_channels.credentials.accessToken`. **TODO: LinkedIn OAuth callback should MERGE credentials, not REPLACE.**

---

## Infrastructure

| Service | Details |
|---------|---------|
| **Repo** | `github.com/Sandbox-Group-LLC/Forge-Intelligence` |
| **Branch: main** | Development → `dev.forgeintelligence.ai` |
| **Branch: production** | Public app → `forgeintelligence.ai/app/*` |
| **Render (dev)** | `forge-dev` watching `main` |
| **Render (prod)** | `forge-production` watching `production` |
| **Database** | NeonDB `ep-odd-waterfall-akyrdo6x-pooler` — **never revert to ep-cool-firefly** |
| **Auth** | Clerk — org-slug multi-tenancy Phase 2 |
| **Email** | Resend |
| **Images** | fal.ai Flux |
| **CMS** | Ghost Admin API |
| **Backups** | Neon daily snapshots — production branch, rolling 35-day retention |

### Architecture Rules — Do Not Break
- **Never** use Render env vars `PUT` API — replaces ALL vars. Individual updates only.
- **Never** `git merge main → production` or copy entire files between branches
- **NEON_DATABASE_URL** must stay on `ep-odd-waterfall-akyrdo6x-pooler`
- **requireAuth** on every endpoint that touches brand data
- **sanitizeJson()** is a top-level shared utility — do not re-inline it
- **activeBrand from useApp()** is the only source of brandProfileId — no direct brains fetches from pages
- **Website Scraper (Tool 1.5)** — Context Hub crawls homepage + /about + /product + /blog pages before Claude analysis. Up to 8K chars injected with "ACTUAL WEBSITE CONTENT" header. Without this, Claude hallucinates from domain names.
- **Context Hub re-analyze** updates brand in place (same UUID) — never creates a new UUID, preserving all content tables, queue, analytics, and brain data
- **GEO briefs endpoint** filters by brandProfileId — prevents cross-brand data leakage
- **Promo code flow** uses softAuth + brandProfileId resolution fallback (auth token → clerk_user_id → most recent active brand)
- **All GateModal instances** pass `brandProfileId={activeBrand?.id}` — required for promo codes to flip `is_paid`
- **Neon daily snapshots** enabled on production branch (expires rolling 35 days)
- **HubSpot integration is clipboard-copy only** — the HubSpot public API gates email-template creation behind Marketing Hub Pro+ at every tier-accessible endpoint. Sales Hub Starter cannot create email templates via API. Do NOT rebuild OAuth-based HubSpot push. The "Copy for HubSpot" button is the durable answer.
- **Zernio dual-ID** — every `zernioPublish()` returns `{ postId, zernioPostId, ... }`. `postId` is the platform-native ID (LinkedIn URN, X tweet ID, Reddit post slug); `zernioPostId` is Zernio's internal `_id`. The analytics sync MUST use `zernioPostId` when calling Zernio's `/analytics` endpoint — it does NOT accept platform-native IDs. Sync code already in place for LinkedIn at L11427; **Reddit and Facebook sync paths still need the same dual-ID treatment** (followup queued).
- **Multi-table write contracts** — the publish flow updates 5 tables: `publishing_queue.status`, `publishing_queue.publish_results`, `publish_log` (insert), `memories` (insert), and the brand-scoped `generated_content_<brand>.status`. All 5 must be updated atomically for the article to be visible across the system. Missing the 5th caused 100% of published articles to be invisible in Performance Dashboard prior to May 10.
- **X media upload — branch by auth method.** As of 2026-05-13, X enforces v1.1 media upload deprecation for OAuth 2.0 user-context tokens. `uploadXMedia()` MUST branch:
  - **OAuth 2.0 Bearer** → `POST https://api.x.com/2/media/upload` with multipart `media` (binary) + `media_category=tweet_image`. Returns `data.id`.
  - **OAuth 1.0a signature** (env-var fallback) → `POST https://upload.twitter.com/1.1/media/upload.json` with `media_data` (base64) + optional `additional_owners` (csv). Returns `media_id_string`.
  - The response parser uses `upData.media_id_string || upData.data?.id` so downstream `POST /2/tweets` works for both shapes. **Don't unify the two paths** — v1.1 doesn't accept OAuth 2.0 tokens and v2 doesn't accept OAuth 1.0a multipart bodies.
- **Probe before pivot.** When writing code that integrates with an external API or parses an external service's output, FIRST step is a probe. `curl` the endpoint with the exact auth + body Forge would use, look at the actual response bytes. Then write the code. This rule has saved hours of pivot-debugging on Zernio analytics, and cost hours when skipped on HubSpot (4 endpoint pivots before recognizing the Marketing Hub Pro+ tier gate). Use the `/api/admin/zernio/raw` pattern for any new external integration's first development sessions — a dev-only generic raw-probe endpoint lets you validate API behavior without redeploying.
- **expires_at on owned brands is broken.** Almost every brand with `clerk_user_id IS NOT NULL` (i.e., paid/owned) has an `expires_at` in the past despite being `is_active=true`. The Context Hub brand endpoint (`/api/context-hub/brand/:brandId`) filters on `expires_at IS NULL OR expires_at > NOW()` and silently 404s on these brands. Workaround: use `/api/context-hub/brains/:id` instead (no expiry filter). Followup queued to either NULL out expires_at on tethered brands or update the filter to accept tethered brands.

### Pipeline UX Flow (Critical — updated April 17, 2026)
Every stage persists results and points forward:
1. **New Analysis** → "View Strategy Brief →" | "Skip to GEO Strategy"
2. **Brand Profile** → Re-analyze | Export JSON | Strategy Brief → | Run GEO Strategy →
3. **Strategy Brief** → Export Brief | Run GEO Strategy →
4. **GEO Strategist** → 10 topics surfaced → user cherry-picks → **Build Briefs (N)** → Stage 2.1 builds per-topic briefs
5. **GEO Brief tab** → N brief cards with H1/H2s/FAQs → **Enrich Now →** (per brief) | **→ Backlog** (park for later)
6. **Authenticity Enricher** → auto-fires when arriving with `?topicBriefId=X` → Continue to Content Generator →
7. **Content Generator** → "Your recent batch" shows all enriched briefs as selectable cards → Generate from selected → batch progress footer tracks pending/generated/published
8. **Compliance Gate** → Approve → Publishing Queue
9. Published channel badges are links to the live post (no accidental republish)

**Cherry-pick architecture (April 17):** GEO Strategist no longer auto-picks one topic and builds one brief. Users cherry-pick which topics to brief. Unpicked topics stay in the repo as brain food (`user_rejection` patterns). Each topic gets its own brief → enrichment → article.
- All CTA buttons use consistent 36px height, `<button>` elements only, inline styles (no CSS class interference)
- TopBar title updates dynamically per Brain sub-view (Brand Profile, Strategy Brief, Brain History)
- Landing page has Sign In button in header
- Post-auth redirects to current page, not always /app/context-hub

### Mission Control (`/app/mc`)
- Super-admin only — hidden from customer sidebar via `isSuperAdmin` filter
- **Deploy Status:** Production + Development cards, last 8 deploys, failed builds highlighted red with commit messages
- **Content Table Sizes:** Monitors all `generated_content_*` tables, alerts at 500KB threshold
- **Error Aggregation:** Deduped by pattern (strips UUIDs/timestamps), count + last seen
- **Live Log Tail:** SSE stream from 500-entry ring buffer, color-coded errors/warnings, pause/resume/filter/clear
- Reviewers section moved to Brand Settings (accessible to all customers)

### DevOps Hardening (April 14, 2026)
- **Concurrent scan protection:** `UNIQUE INDEX idx_bp_active_url ON brand_profiles (brand_url) WHERE is_active = true` + `ON CONFLICT` on both INSERT paths
- **Primary key:** `brand_profiles_pkey PRIMARY KEY (id)` — was missing entirely
- **Duplicate SSE stream guard:** `activeStreams` Map tracks brand+stage, returns `busy` event if already running, stale cleanup every 2 min (10-min max)
- **Expiry race fix:** `useActiveBrand` checks DB before expiring localStorage brands — promo codes survive 24hr window
- **Ghost brand cleanup:** Auth/me returns no brand → localStorage wiped. Unauthenticated: brand verified against API on mount, 404 = cleared
- **Timer reset:** `sessionStorage.removeItem('forge_run_start')` on every new analysis — no more zombie timers
- **Brand name from Claude:** Added `brandName` to Claude response schema — actual website name instead of domain parse
- GitHub Contents API commits require a freshly fetched SHA — stale SHAs fail

### Branch Strategy (updated April 19, 2026)

**Four branches. Three are identical. One has a feature flag.**

| Branch | Role |
|--------|------|
| `main` | Staging — new features built and tested on `dev.forgeintelligence.ai` |
| `production` | Live — validated work ported via surgical patches only (`forgeintelligence.ai`) |
| `Intel` | Identical to main/production — separate deployment target |
| `strategy` | Identical to the rest **except** Brand Intelligence menu item is exposed in the sidebar (all other branches hide it) |

**Rules:**
- Never `git merge` between branches — surgical patches only
- `main`, `production`, and `Intel` must stay byte-identical across shared files
- `strategy` differs **only** on the Brand Intelligence sidebar/page files — never let other deltas creep in
- When shipping any fix, port to all four branches in the same session unless it's strategy-specific
- Test on dev first, port to production (+ Intel + strategy) when validated

---

## Repo Structure

```
/
├── README.md              ← THIS FILE. SSOT. Read before touching anything.
├── WHITEBOARD.md          ← Active working doc. Session state, pending work, known issues.
├── server.js              ← Express server + all API routes + shared utilities (sanitizeJson, buildImagePrompt, extractJSON)
├── src/
│   ├── context/
│   │   └── AppContext.tsx  ← activeBrand, isPaid, brandLoading — single source of truth
│   ├── hooks/
│   │   └── useActiveBrand.ts ← auth-scoped brand resolution
│   ├── components/
│   │   ├── Sidebar.tsx    ← Nav, Settings group (brand-settings + integrations + admin)
│   │   └── TopBar.tsx     ← Brand pill, avatar dropdown
│   ├── layouts/
│   │   └── AppShell.tsx   ← view-container owns all page padding (48px 40px 96px)
│   └── pages/             ← All stage pages — brandProfileId from activeBrand only
├── public/                ← Static assets, landing page
├── package.json
└── vite.config.ts
```

---

## UI Design System

### 12-Directive System (Non-Negotiable)

1. **Dark foundation** — `#0F1720` base, `#1E293B` cards/panels
2. **Intelligence Blue accent** — `#3563FF` primary CTA, active states
3. **Signal Teal secondary** — `#14B8A6` for positive states, insight signals
4. **Proof Amber highlight** — `#F5B942` sparingly, never dominant
5. **Inter/Geist typography** — strong hierarchy, generous spacing
6. **Slightly rounded corners** — 10–14px radius
7. **Lucide icons** — 1.5 stroke weight, round caps, `currentColor`, consistent across all UI. **No emojis anywhere in the UI.**
8. **Subtle motion** — purposeful transitions only
9. **Grid-based layout** — modular, reusable components
10. **Real product UI** — no abstract decoration
11. **Calm UX** — no noise, no gratuitous animation
12. **Brand continuity** — landing page = app visual language, no seam

### Layout Rule
`view-container` in `WorkspaceLayout.css` owns all page padding: `padding: 48px 40px 96px`.
Page-level CSS classes (`.cl-page`, `.ci-page`, etc.) must NOT add their own padding — they stack and break the layout.

### Sidebar Active States
- Active item: `background: transparent`, `color: var(--color-accent)`, `border-left-color: var(--color-accent)`
- No gradient blobs, no fill backgrounds
- Settings group opens and highlights on `/app/brand-settings`, `/app/integrations`, **and** `/app/admin`

---

## The 8-Stage Workflow

```
[1. Context Hub] → [2. GEO Strategy] → [3. Authenticity Enrichment]
↑                                                      ↓
[8. Feedback Loop] ←— [7. Performance] ←— [6. Publish] ←— [5. Compliance] ←— [4. Generation]
```

### What Each Stage Does

| Stage | Route | Key Output |
|-------|-------|------------|
| 1 | `/app/context-hub` | Brand voice profile, personas, competitive gaps |
| 2 | `/app/geo-strategist` | Topical authority map, GEO opportunities, entity schema |
| 3 | `/app/authenticity-enricher` | E-E-A-T signals, SME injection map, author schema |
| 4 | `/app/content-generator` | Full article (SSE stream), confidence tiers, hero image |
| 4.5 | `/app/campaign-generator` | 8-article campaign plan + generation |
| 4.6 | `/app/email-campaign` | Brief-driven email sequences, 3 subject variants, HubSpot push |
| 5 | `/app/compliance-gate` | AI critique + human refinement → brain_mistakes write |
| 6 | `/app/publishing-queue` | Multi-channel publish, UTM, schedule, Smart Export |
| 7 | `/app/performance` | LinkedIn/X/Ghost/GSC analytics, decay alerts, GEO citations, pattern dashboard |
| 8 | (auto) | Pattern extractor writes brain_patterns + brain_mistakes from analytics |

### Supporting Pages

| Page | Route | Notes |
|------|-------|-------|
| Content Library | `/app/content-library` | Card grid, search, status tabs, preview modal |
| Content Import | `/app/content-import` | URL or paste → Brain audit → Publishing Queue |
| Topic Queue | `/app/topic-queue` | Idea capture, send to generator |
| Brand Settings | `/app/brand-settings` | Identity, BYO domain, site template scraper, billing |
| Integrations | `/app/integrations` | Per-channel credentials, UTM templates |
| Admin | `/app/admin` | KPIs (auth-scoped), reviewer management |

---

## Brain Architecture

Each brand gets isolated storage. Multi-agent shared memory.

```
brand_profiles                  ← voice profile, personas, competitive gaps
generated_content_{uuid}        ← per-brand article table (auto-provisioned)
publishing_queue                ← staged → approved → published
geo_opportunities              ← discovered → briefed → enriched → ignored (brain food)
geo_topic_briefs               ← briefed → backlog → enriched (per user-selected topic)
publish_log                     ← channel publish results
content_analytics               ← impressions, clicks, engagement per article
brain_patterns                  ← what worked (confidence, recency weighted)
brain_mistakes                  ← what failed + human feedback + guardrails
geo_citations                   ← brand mention detection in AI search results
decay_alerts                    ← 50%+ engagement drop flags
agent_activity_log              ← every agent call, tokens, latency
```

**Brain-First Protocol (mandatory on every agent):**
```
BEFORE generating:
  1. Read brain_mistakes relevant to this task
  2. Read brain_patterns that succeeded in this context
  3. THEN generate — informed by both
```

---

## Key API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/context-hub/analyze` | optional | Stage 1 — brand analysis + caching |
| POST | `/api/geo-strategist/analyze` | required | Stage 2 — GEO opportunities (persists to `geo_opportunities`) |
| GET | `/api/geo/opportunities/:brandProfileId` | required | Stage 2 — list discovered topics |
| POST | `/api/geo/opportunities/build-briefs` | required | Stage 2.1 — build per-topic briefs |
| GET | `/api/geo/topic-briefs/:brandProfileId` | required | Stage 2.1 — list topic briefs |
| POST | `/api/geo/topic-brief/:id/backlog` | optional | Park a topic brief |
| POST | `/api/geo/topic-brief/:id/resurface` | optional | Unpark a topic brief |
| POST | `/api/geo/opportunities/mark-ignored` | auto | Brain food — unpicked topics become patterns |
| POST | `/api/authenticity-enricher/analyze` | required | Stage 3 — E-E-A-T enrichment (accepts `topicBriefId`) |
| GET | `/api/content-generator/enriched-briefs/:brandProfileId` | required | Stage 4 — batch UI data with article status |
| GET | `/api/content-generator/generate` | required | Stage 4 — SSE article stream |
| POST | `/api/campaign/plan` | required | Stage 4.5 — 8 angle profiles |
| POST | `/api/campaign/create` | required | Save campaign to DB |
| POST | `/api/compliance/critique` | required | Stage 5 — AI critique JSON |
| POST | `/api/compliance/approve` | required | Save edits + write brain_mistakes |
| GET | `/api/publishing/queue/:brandProfileId` | required | Queue items |
| POST | `/api/publishing/publish` | required | Publish to channel |
| POST | `/api/analytics/sync/:brandProfileId` | required | Sync channel analytics |
| PATCH | `/api/email-campaign/email/:id` | required | Stage 4.6 — update body/ps/cta/subject_lines on one email |
| POST | `/api/email-campaign/email/:id/resolve-flag` | required | Stage 4.6 — mark a compliance flag resolved (edited/cited/dismissed) |
| POST | `/api/email-campaign/email/:id/dismiss-flag-as-false-positive` | required | Stage 4.6 — dismiss flag + write `brain_mistakes` row for future suppression |
| POST | `/mcp` | required (Bearer or X-Api-Key) | MCP server — JSON-RPC 2.0, 3 read-only tools for external MCP clients |
| POST | `/api/admin/zernio/raw` | dev/strategy + admin password | Generic Zernio API probe — `{method, path, body?}` → forwards to Zernio |
| POST | `/api/social-generator/regenerate-arcs/:brandProfileId` | required | Stage 4.5 — regenerate `profile_data.campaignArcs` in-place. Body: `{leanIntoMoats?, leanIntoPersonas?, leanIntoGaps?, guidance?}`. Replaces (not appends) the arc set. Existing titles passed to model as 'do not duplicate'. |
| POST | `/api/analytics/extract-patterns/:brandId` | required | Stage 8 — pattern extraction |
| GET | `/api/admin/stats` | required | Auth-scoped KPIs |
| GET | `/articles/:brandSlug/:articleSlug` | public | Server-rendered article page |

---

## LLM Routing

| Agent | Model | Reason |
|-------|-------|--------|
| Context Agent (Stage 1) | Claude Sonnet 4.6 | Structured JSON, brand reasoning |
| GEO Strategist (Stage 2) | Claude Sonnet 4.6 | Multi-step competitive reasoning |
| Authenticity Enricher (Stage 3) | Claude Sonnet 4.6 | E-E-A-T analysis |
| Content Generator (Stage 4) | Claude Sonnet 4.6 | Long-form, Brain-First |
| Campaign Generator (Stage 4.5) | Claude Sonnet 4.6 | 8-angle planner + article gen |
| Compliance Gate (Stage 5) | Claude Sonnet 4.6 | Structured rule checking |
| Pattern Extractor (Stage 8) | Claude Haiku 4.5 | Fast, cheap, pattern analysis |
| Post copy generation | Claude Haiku 4.5 | LinkedIn/X/Facebook post copy |
| Topic pre-flight check | Claude Haiku 4.5 | Pattern/mistake signal check |
| Image prompts | Claude Haiku 4.5 + fal.ai Flux | Hero image generation |

---

## Known Issues & Backlog

| Item | Priority | Notes |
|------|----------|-------|
| LinkedIn analytics for legacy pre-Zernio posts | Low | 14 Forge LinkedIn articles published April 17 – May 7 won't sync analytics. Pre-Zernio credentials were overwritten by the migration. Articles are live with real engagement; only the sync into Performance Dashboard is broken. Bounded gap — will not grow. Going forward, Zernio dual-ID (postId + zernioPostId) ensures every new publish syncs correctly. |
| WordPress live API publish | Medium | Pending |
| Webflow live API publish | Medium | Pipedream Connect wired, logic pending |
| authToken rollout | Medium | Remaining unauthenticated fetches in PublishingQueuePage |
| Full light mode CSS sweep | Medium | PerformanceDashboardPage.css + remaining PublishingQueue sections |
| LinkedIn Insight Tag | Low | Port to production index.html |
| GSC dev callback URL | Low | Add to Google Cloud Console |
| Pre-cog Score Dashboard | Backlog | Base implementation live (Haiku-powered, percentile-based, Predictions tab in Performance Dashboard). Phase 3 upgrade: Voyage AI embeddings + pgvector semantic similarity scoring — parked. |
| Agency Dashboard | Backlog | Cross-brand bird's-eye view |
| Pen test | Backlog | Required before Agency tier launch |
| Medium integration | Legacy | New tokens unavailable since early 2025 |

---

### Key Architecture Additions (April 17, 2026)

- **Factual Ground** — user-verified facts in `brand_profiles.settings.factualGround` (JSONB). Fields: whatWeDo, whatWeDontDo, companyFacts, methodology, foundingStory, teamComposition, quotablePositions, authors[]. Injected as "USER-VERIFIED FACTS YOU MUST USE VERBATIM" at TOP of Content Generator prompt.
- **Territory injection** — Topical Authority Map sorted by citation probability, top 8 rendered as "STRATEGIC TERRITORIES THIS BRAND OPERATES IN" block in Content Generator prompt. Writer can't drift outside brand's territory.
- **Article SSR body** — full article prose server-rendered inside `<article>` off-screen for AI crawlers. GPTBot/PerplexityBot/Googlebot see complete content, not empty SPA shell.
- **Enriched brief slimming** — writer prompt receives only article-directing fields (title, H1, sections, FAQs, powerPhrases, contentHooks), not full 38KB diagnostic blob.
- **Per-topic enrichment** — Enricher cache bypassed when `topicBriefId` present. Each topic gets independent enrichment.
- **Facebook publish** — posts directly to stored `pageId` via Pipedream proxy (skips `/me/accounts` discovery). Blocked on Pipedream token permissions (#36).

## For AI Sessions — Start Here

1. Read this README top to bottom
2. Read WHITEBOARD.md for current session state and pending work
3. Fetch and read the specific file before editing — never write blind
4. The Anthropic SDK is pinned at `^0.39.0` — do not change
5. `NEON_DATABASE_URL` points to `ep-odd-waterfall-akyrdo6x-pooler` — this is correct and must not change
6. All production commits go to the `production` branch
7. Render auto-deploys on every push — no manual step needed
8. Brian is direct, works fast, expects commits not instructions. No narration. No confirmation requests.

**Owner:** Brian — Founder, Sandbox Group LLC (Portland, OR)
Sandbox Group: **Sandbox-XM** (experience marketing) + **Sandbox-GTM** (event registration + GTM platform) + **Forge Intelligence** (the intelligence layer)

---

## Updated: May 13, 2026

### Auth Architecture
- Clerk JWT template `jwt-template-600` — 600 second token lifetime
- All authenticated fetches use `getToken({ template: 'jwt-template-600' })`
- `authFetch()` pattern in Compliance Gate — auto-retries once on 401 with fresh token
- `freshToken()` helper calls Clerk directly at request time, never relies on stale state

### Compliance Gate (Stage 5) — Production Ready
- AI critique → inline flagged excerpt highlighting (red/amber by claim type)
- Find Sources: Perplexity sonar → `search_results` → 3 source candidates
- Accept Suggestion → Sonnet rewrite incorporating editorial suggestion + optional citation
- Rewrite with Source → weaves selected citation naturally into rewritten section
- Edits persisted to localStorage per article, cleared on approve
- ComplianceGateContent / ComplianceGatePage split — hooks-safe architecture
- Auto-approved badge only shows on green sections with zero flags
- HighlightedBody: quoted phrase matching + sliding window fallback for unquoted flag reasons
- `authFetch()` + `freshToken()` — auto-retries on 401, eliminates stale token failures

### Compliance Gate — AI Endpoint Architecture (Critical — do not patch blindly)
- `POST /api/compliance/rewrite-section` — claude-sonnet-4-6 rewrites flagged section
- `POST /api/compliance/find-sources` — Perplexity sonar, returns 3 source candidates
- `POST /api/compliance/critique` — Claude Sonnet critique, returns structured JSON report
- `POST /api/compliance/approve` — saves edits, writes brain_mistakes, marks approved
- All 4 endpoints use `requireAuth`
- Model string must be `claude-sonnet-4-6` — `claude-sonnet-4-5` is invalid and causes silent failure
- Never restore a full server.js to fix compliance endpoints — splice only the compliance block
- Canonical working state: commit `4d1e2c5af6e2` (April 8 01:11) has all 4 endpoints correct

### Campaign Generator (Stage 4.5)
- Full DB persistence — campaign_articles + generated_content_{uuid} mirror
- Resume generation — resets frozen articles, resumes from correct index
- Recent Campaigns list — loads and restores all 8 articles from DB
- Send All to Compliance Gate CTA on completion

### Publishing Queue — Campaign Scheduler
- Channel picker — selects publish destination
- Smart date scheduling — Article 1 on exact chosen date, rest follow day-of-week cadence
- Writes channels + status:'scheduled' — cron job publishes automatically

### Light Mode Design System
- `--color-bg-base: #EDF1FF` blueberry, `--color-bg-card: #FFFFFF`
- `--color-text-emphasis: #0F172A` for titles/quotes
- `--shadow-card` blue-tinted outer glow
- `--shadow-chrome-x/y` for sidebar/topbar floating effect
- Sidebar + TopBar: white, no border, chrome shadow

---

### Recent Updates Index

For session-level technical detail, see `WHITEBOARD.md`. Recent major entries:

- **May 13** — Social Generator regenerate-arcs feature (in-place brand arc regen with moat/persona/gap emphasis); X v2 media upload fix (X enforced v1.1 deprecation for OAuth 2.0 tokens today — `uploadXMedia()` now branches by auth method); Performance Dashboard pending-row placeholder fix (zero-row content_analytics on Zernio 202 so new articles appear immediately)
- **May 10–11** — Zernio dual-ID analytics fix; publish-status mirror bug (100% failure rate caught); Copilot Autofix incident; Morgan Chasser personal-brand experiment
- **May 9** — MCP server live; Attio CSV export; HubSpot demolition (4 rebuild rounds → clipboard copy); Email Campaign Generator Phase 1+2+3 (rendering bugs + edit mode + flag actions + readable Sequence Assessment)
- **May 8** — Zernio LinkedIn migration for Forge brand
- **April 17** — Cherry-pick architecture in GEO Strategist; Compliance Gate AI rewrite + Find Sources; Factual Ground + Territory injection
