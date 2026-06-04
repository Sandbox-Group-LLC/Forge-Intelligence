# Forge Intelligence — Product & Platform Reference

> This README is the product/platform reference for Forge Intelligence — what the platform does, what's live, the 8-stage architecture, infrastructure, and the architecture rules that must not be broken.
>
> **Agent / session instructions live elsewhere now.** Start here on every session:
>
> 1. **`CLAUDE.md`** — the single source of truth for agent/session rules: code-graph orientation (GitNexus output) plus the operational rules (branch + PR workflow, Render ops, DB safety, communication norms). Consolidates the former `SESSION-PROTOCOL.md` and `AGENTS.md`.
> 2. **`WORKING-STATE.md`** — what's in flight, what just shipped, what's next. Newest session on top.
> 3. **`PLAN.md`** — long-form retrospective archive.
> 4. **THIS FILE** — product/platform reference (less frequently changed than the above).
>
> URL pattern: frontend routes match product names (e.g. `/context-hub`, `/geo-strategist`), API routes follow `/api/{product-slug}/`.

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

## Platform Status (May 23, 2026)

### All 8 Stages Live

| Stage | Name | Status | Model |
|-------|------|--------|-------|
| 1 | Context Hub | ✅ LIVE | Perplexity Sonar (research) + **Jina Reader (primary content extraction) + forgeScrape Tier 1→2 fallback** (BD Web Unlocker → Scraping Browser) + Claude Opus 4.6 (profile) + Claude Haiku 4.5 (brain ops). Stage 1 rebuilt 2026-05-21 — see Recent Major Work below. |
| 2 | GEO Strategist | ✅ LIVE | Claude Sonnet 4.6 (3 tools) |
| 3 | Authenticity Enricher | ✅ LIVE | Perplexity Sonar (SME signals) + Claude Sonnet 4.6 (EEAT/injection/assembly) — SSE progress, enriched brief selector |
| 4 | Content Generator | ✅ LIVE | Claude Sonnet 4.6 — requires enriched brief, published briefs filtered |
| 4.5 | Campaign Generator | ✅ LIVE | Claude Sonnet 4.6 |
| 4.6 | Email Campaign Generator | ✅ LIVE | Mistral Large — inline edit + per-flag actions (resolve/cite/dismiss) + brain feedback loop on false-positive dismissals + render-side sanitization for P.S./CTA/proof-token leakage |
| 5 | Compliance Gate | ✅ LIVE | Claude Sonnet 4.6 |
| 6 | Publishing & Distribution | ✅ LIVE | Queue + multi-channel: LinkedIn (Zernio), X (OAuth2 — x.com migrated 2026-05-23), Facebook (Zernio + Pipedream), Reddit (Zernio), Medium, Ghost, WordPress, Webflow, **My Website (new — self-hosted webhook publisher, see `/docs/my-website`)** |
| 7 | Performance Intelligence | ✅ LIVE | LinkedIn + X + Ghost + GSC + GEO + Facebook + Reddit. **All Zernio-routed channels (LinkedIn / Reddit / Facebook) use dual-ID sync** (zernioPostId for analytics lookup, platform URN for display); Facebook URN→_id backfill admin endpoint shipped 2026-05-22 |
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

### Recent Major Work (May 12–23, 2026)

**Stage 1 (Context Hub crawl) rebuilt end-to-end (May 21):** Single biggest piece of work in this window. Old Stage 1 was raw `fetch()` with UA rotation, no anti-bot, no JS render, 3 KB body cap per page — silently returned SPA shells on most modern customer sites and built brand profiles off meta tags + JSON-LD alone. **New Stage 1 = Jina Reader primary + `forgeScrape` (BD Tier 1 → Tier 2) fallback** with parallel page fetches, sitemap.xml-aware discovery, and anchor-only link extraction. Wall-clock cut from ~60 s sequential to ~15–20 s parallel; brand profiles now capture full pricing pages, blog catalogs, security whitepapers. Validated on sandbox-gtm.com (v9 profile materially richer than v8) and forgeintelligence.ai (v12, with the GitNexus-aware brain profile). PRs #103–#110.

**`forgeScrape` primitive (May 21):** Single source of truth for any Bright Data scraping. Tier 1 = Web Unlocker, Tier 2 = Scraping Browser (puppeteer-core CDP, real Chromium, residential IPs) auto-fires when Tier 1 returns an SPA shell. Extracts content via Mozilla Readability + Turndown locally — no second API call. Used by Stage 1 + Site Template. Every call logs to `scrape_log` with `caller` set for audit. Honest extraction metric replaces "0/10 class names found" with "regions located via any signal" (class, data-testid, semantic landmark, content match).

**My Website channel (May 22):** Brand-new self-hosted webhook publisher. Customers publish Forge articles to their own sites via authenticated webhook with Forge-issued `forge_pub_<32hex>` bearer token. Backend: 4 admin endpoints (config / generate-token / test / disconnect) + publish-handler branch + analytics. Frontend: `<MyWebsiteForm>` with URL input, format toggle (HTML / Markdown / both), show-once token reveal, test-publish button. Public docs at `/docs/my-website` with copy-paste receiver samples (Node/Express + Postgres, Next.js App Router, filesystem). PRs #117–#122.

**`/docs` page (May 22):** Public-route documentation site at `forgeintelligence.ai/docs`. Left sidebar grouped by category (Integrations / Concepts / Reference), syntax-highlighted markdown via `react-markdown` + `remark-gfm` + `react-syntax-highlighter`. **Share With AI button** on every doc downloads the markdown with a framing preamble for Claude/ChatGPT/Cursor. PRs #120, #123–#125, #134.

**`article_base_url` respected everywhere (May 23):** Five publish handlers (Facebook x3, Reddit, Medium) + My Website canonical were rebuilding URLs from `BASE_DOMAIN + brandSlug + articleSlug` instead of brand-aware `forgeArticleUrl`. Customers with `article_base_url` set were seeing Forge-hosted URLs in social posts instead of their own domain. PR #121 unified all six on `forgeArticleUrl`. PR #123 also adds an explicit "Where will my articles live?" Brand Settings callout so the default hosting destination isn't a surprise.

**Markdown leak fix on social copy (May 22):** Facebook + LinkedIn posts going out with literal `#` headings and `**bold**` markers — Haiku was writing markdown by default and the publish path didn't strip it. PR #115 adds `stripSocialMarkdown()` helper, updates Facebook prompts to request plain text, applies the strip at 6 sites. Reddit left intact (renders MD natively).

**X (Twitter) OAuth migrated to x.com (May 23):** Forge was sending users to `twitter.com/i/oauth2/authorize`. Twitter's domain-migration redirect chain was breaking the login cookie across `twitter.com` ↔ `x.com`, producing a "to use this App you have to be logged in" infinite loop in fresh browsers. PR #132 swaps the authorize URL plus both token-exchange URLs (`api.twitter.com/2/oauth2/token` → `api.x.com/2/oauth2/token`). Runtime API endpoints (tweets, users/me, media-upload) left on `api.twitter.com` — working today via compat redirects.

**Auth-expired = Reconnect, not Reset & Retry (May 23):** PR #130 detects auth-expired patterns in `publish_log.error_message`, swaps the button for an amber "Reconnect [Channel] →" link to `/app/integrations`, surfaces non-auth error messages directly.

**Facebook analytics URN bug + backfill (May 22):** Facebook publishes via Zernio were storing only the platform URN; the analytics sync passed that URN to Zernio's `/analytics` endpoint which expects Zernio's internal `_id` — every Facebook post returned HTTP 404. PR #111 captures `zernioPostId` at publish time + uses it for sync (mirrors the LinkedIn pattern landed 2026-05-10). PRs #112/#113 ship a one-shot admin backfill endpoint that maps existing URNs → Zernio `_id`s; ran cleanly against the 2 historical Sandbox-GTM posts. **Facebook is now on dual-ID treatment, matching LinkedIn.**

**GitNexus context files installed (May 22):** `npx gitnexus@latest analyze` against the repo produced `CLAUDE.md`, `AGENTS.md`, and `.claude/skills/gitnexus/` (6 skill files). 2,818 nodes / 3,968 edges / 61 clusters / 129 execution flows. **Aspirational without live MCP runtime** — GitNexus MCP is stdio-only, so cloud Claude Code sessions can't connect to it today; files ship as orientation for the day FleetView gains custom MCP support or upstream ships HTTP/SSE transport.

**SESSION-PROTOCOL refresh + bootstrap consolidation (May 22):** `SESSION-PROTOCOL.md` rewritten for the current local-edit + git + draft-PR workflow (the original was for a deprecated GitHub Contents API + Python script flow) and moved from `docs/` to repo root alongside `CLAUDE.md`, `AGENTS.md`, `WORKING-STATE.md`, `PLAN.md`. PR #128.

**Other notable (chronological):**
- 2026-05-12 Lovable integration — prompt-pack endpoint, "Build with Lovable" button on Brand Profile, first-use hint
- 2026-05-12 Quick Start no-website onramp (`/quick-start` route, partner-agnostic Deploy card)
- 2026-05-13 X v2 media upload fix (branch by auth method — v2 for OAuth2, v1.1 for OAuth1)
- 2026-05-13 Social Generator: Regenerate Arcs button + modal (rescan-free brand arc regeneration)
- 2026-05-13 Security: Vite 5 → 8 upgrade, Clerk + postcss patches
- 2026-05-13 X analytics: structured logging + OAuth2 token refresh on 401
- 2026-05-14 Articles library: canonical + robots SSR; promo + gate URL params (`?promo=NANGO`, `?gate=open`); brand deep-link no-flash on first load
- 2026-05-15 GFM table rendering for article markdown (single-line-flat → `<table>`)
- 2026-05-17 `/api/admin/mark-unpublished` endpoint
- 2026-05-23 Topbar alerts bell + Get Help support form

---

## Infrastructure

| Service | Details |
|---------|---------|
| **Repo** | `github.com/Sandbox-Group-LLC/Forge-Intelligence` |
| **Branch: main** | Production → `forgeintelligence.ai` |
| **Branch: development** | Staging → `dev.forgeintelligence.ai` (all feature/fix work integrates here first) |
| **Render (dev)** | `forge-dev` watching `development` |
| **Render (prod)** | `forge-production` watching `main` |
| **Render env vars** | Shared between prod + dev via **Linked Environment Group** |
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
- **Stage 1 fetch = Jina-first, forgeScrape fallback.** As of 2026-05-21 the Context Hub crawl is Jina Reader primary (`r.jina.ai/<url>` — accept if returns > 500 chars markdown), `forgeScrape` (BD Tier 1 → Tier 2 cascade) fallback, with parallel page fetch. Sitemap.xml-first subpage discovery, anchor-only link extraction, asset blocklist. Up to 100 KB markdown injected with "ACTUAL WEBSITE CONTENT" header. **Do NOT revert to the pre-2026-05-21 direct-`fetch()` + UA-rotation + 3 KB-cap design** — that silently returned SPA shells and built brand profiles off meta tags alone.
- **`forgeScrape` is the only Bright Data primitive.** Tier 1 = Web Unlocker, Tier 2 = Scraping Browser (puppeteer-core CDP, residential IPs) auto-fires on SPA shell. Used by Stage 1 + Site Template. Every call logs to `scrape_log` with `caller` set. If a new feature needs BD scraping, use `forgeScrape()` — do not build a parallel fetcher.
- **`forgeArticleUrl` is the canonical article URL.** Every publish handler MUST use `forgeArticleUrl` (which honors `brand.article_base_url` if set, falls back to `forgeintelligence.ai/articles/<brandSlug>/<slug>`). Do NOT rebuild URLs from `BASE_DOMAIN + brandSlug + articleSlug` — that bypasses BYO-domain configuration and was the source of the cross-channel article-URL bug landed pre-2026-05-23 (PR #121 fixed 6 sites).
- **Context Hub re-analyze** updates brand in place (same UUID) — never creates a new UUID, preserving all content tables, queue, analytics, and brain data
- **GEO briefs endpoint** filters by brandProfileId — prevents cross-brand data leakage
- **Promo code flow** uses softAuth + brandProfileId resolution fallback (auth token → clerk_user_id → most recent active brand)
- **All GateModal instances** pass `brandProfileId={activeBrand?.id}` — required for promo codes to flip `is_paid`
- **Neon daily snapshots** enabled on production branch (expires rolling 35 days)
- **HubSpot integration is clipboard-copy only** — the HubSpot public API gates email-template creation behind Marketing Hub Pro+ at every tier-accessible endpoint. Sales Hub Starter cannot create email templates via API. Do NOT rebuild OAuth-based HubSpot push. The "Copy for HubSpot" button is the durable answer.
- **Zernio dual-ID** — every `zernioPublish()` returns `{ postId, zernioPostId, ... }`. `postId` is the platform-native ID (LinkedIn URN, X tweet ID, Reddit post slug); `zernioPostId` is Zernio's internal `_id`. The analytics sync MUST use `zernioPostId` when calling Zernio's `/analytics` endpoint — it does NOT accept platform-native IDs. **In place for LinkedIn (2026-05-10) and Facebook (2026-05-22, PR #111).** Reddit sync path on the same pattern; verify before adding any new Zernio-routed channel.
- **Strip markdown from social-platform copy.** Haiku defaults to writing markdown. Facebook, LinkedIn, and X DON'T render `#` headings or `**bold**` — they show the raw characters. Apply `stripSocialMarkdown()` to any Haiku-generated post copy (already wired at all 6 sites as of PR #115). Reddit is the exception — it renders markdown natively, leave intact.
- **X (Twitter) OAuth uses `x.com`, not `twitter.com`.** As of 2026-05-23 the authorize endpoint is `https://x.com/i/oauth2/authorize` and the token exchange is `https://api.x.com/2/oauth2/token`. The legacy `twitter.com` URLs serve but chain through a domain-migration redirect that breaks the login cookie → infinite login loop in fresh browsers. Runtime API endpoints (tweets, users/me, media-upload) still on `api.twitter.com` and working via compat redirects — leave alone unless they actually break.
- **My Website channel uses webhook + bearer auth, not OAuth.** Customer provides a `POST` endpoint URL; Forge generates a `forge_pub_<32hex>` token (shown ONCE on generate/rotate, masked thereafter) and POSTs the article payload with `Authorization: Bearer <token>`. Customer receiver decides storage. Full payload schema + receiver samples at `/docs/my-website`.
- **Auth-expired error in Publishing Queue → Reconnect, not Reset & Retry.** Publish handlers throw `"<Channel> authentication expired. Please reconnect <Channel> in Integrations."` on token revocation. The frontend (PR #130) detects auth-expired patterns in `publish_log.error_message` and renders an amber Reconnect link to `/app/integrations` instead of the misleading Reset & Retry button. Don't roll back — Reset & Retry can't fix an auth-expired error since credentials are already cleared.
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

### Branch Strategy (updated May 22, 2026)

**Trunk → integration → production model.** The old `main`/`production`/`Intel`/`strategy` surgical-patch model was retired; the `production` branch no longer exists.

| Branch | Role |
|--------|------|
| `main` | **Production.** Render's production service (`forgeintelligence.ai`) deploys from here. |
| `development` | **Integration.** Render's dev service (`dev.forgeintelligence.ai`) deploys from here. All feature/fix work merges here first. |
| `Intel` | Separate deployment target — kept in sync with `main` for the Intel-branded customer surface. |
| `strategy` | Same content as the others EXCEPT Brand Intelligence sidebar entry is exposed (others hide it) + holds `STRATEGY.md`, the long-form strategic narrative. |

**Standard flow per change** (see `CLAUDE.md` for the full recipe):

1. `git fetch origin development` → `git switch -c <feature|fix|chore>/<slug> origin/development`
2. Edit locally via `Edit` / `Write` tools (NOT GitHub Contents API)
3. Syntax check (`node --check server.js`) + type check (`npx tsc --noEmit`)
4. Commit with multi-line conventional-commit message + session URL
5. Push + open **draft PR** against `development` via the GitHub MCP tools
6. Brian reviews + merges. Never merge your own PR unless explicitly authorized.
7. **Promotion to `main`** = a separate `development → main` rollup PR (e.g., PR #102 was the Stage 1 rebuild rollup). Brian merges that too.

`Intel` and `strategy` get the same architectural fixes as `main`, applied as separate merges when relevant.

---

## Repo Structure

```
/
├── README.md              ← THIS FILE. SSOT. Read before touching anything.
├── PLAN.md          ← Active working doc. Session state, pending work, known issues.
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
| LinkedIn analytics for legacy pre-Zernio posts | Low | 14 Forge LinkedIn articles published April 17 – May 7 won't sync analytics. Pre-Zernio credentials were overwritten by the migration. Articles are live with real engagement; only the sync into Performance Dashboard is broken. Bounded gap — will not grow. Backfilled via `/api/admin/zernio/raw` 2026-05-10. |
| GitNexus MCP runtime in cloud sessions | Medium | `CLAUDE.md` + `.claude/skills/gitnexus/` are committed and aspirational. GitNexus MCP is stdio-only — FleetView/cloud Claude Code can't spawn it. Live until either GitNexus ships HTTP/SSE MCP transport or FleetView gains custom-MCP support. |
| X runtime API on `twitter.com` | Low | OAuth (authorize + token exchange) migrated to `x.com` 2026-05-23. Runtime API calls (tweets, users/me, media-upload) still hit `api.twitter.com` and work via compat redirects. If they start failing the same way, apply the domain swap (PR #132 pattern). |
| Webflow live API publish | Medium | Pipedream Connect wired, logic pending |
| authToken rollout | Medium | Remaining unauthenticated fetches in PublishingQueuePage |
| Full light mode CSS sweep | Medium | PerformanceDashboardPage.css + remaining PublishingQueue sections |
| LinkedIn Insight Tag | Low | Port to production index.html |
| GSC dev callback URL | Low | Add to Google Cloud Console |
| Pre-cog Score Dashboard | Backlog | Base implementation live (Haiku-powered, percentile-based, Predictions tab in Performance Dashboard). Phase 3 upgrade: Voyage AI embeddings + pgvector semantic similarity scoring — parked. |
| Agency Dashboard | Backlog | Cross-brand bird's-eye view |
| Pen test | Backlog | Required before Agency tier launch |
| Medium integration | Legacy | New tokens unavailable since early 2025 |

**Recently resolved** (removed from the list): WordPress live API publish (LIVE via REST + Application Password); Facebook analytics URN bug (PR #111); markdown-in-social-copy (PR #115); Publishing Queue auth-expired UX (PR #130); X OAuth login loop (PR #132); article URL ignoring `article_base_url` across 6 channels (PR #121).

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
2. Read WORKING-STATE.md for what's in flight and pending work (PLAN.md is the long-form retrospective archive)
3. Fetch and read the specific file before editing — never write blind
4. The Anthropic SDK is pinned at `^0.39.0` — do not change
5. `NEON_DATABASE_URL` points to `ep-odd-waterfall-akyrdo6x-pooler` — this is correct and must not change
6. All feature/fix work commits to `development` (auto-deploys to dev.forgeintelligence.ai for testing). Promotion to production is a `development → main` rollup PR that Brian merges once stable — never commit straight to `main`
7. Render auto-deploys on every push — no manual step needed
8. Brian is direct, works fast, expects commits not instructions. No narration. No confirmation requests.

**Owner:** Brian — Founder, Sandbox Group LLC (Portland, OR)
Sandbox Group: **Sandbox-XM** (experience marketing) + **Sandbox-GTM** (event registration + GTM platform) + **Forge Intelligence** (the intelligence layer)

---

## Updated: May 23, 2026

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

For session-level technical detail, see `WORKING-STATE.md` (current pointer) and `PLAN.md` (archive). Recent major entries:

- **May 23** — X OAuth migrated to `x.com` (PR #132); auth-expired errors → Reconnect action in Publishing Queue (PR #130); `article_base_url` respected across Facebook/Reddit/Medium/My Website (PR #121); topbar alerts bell + Get Help support form
- **May 22** — My Website channel live (self-hosted webhook publisher; PRs #117–#122); `/docs` page live with Share With AI button (PRs #120, #134); GitNexus context files installed; SESSION-PROTOCOL refreshed + moved to repo root; Facebook URN→Zernio _id fix + backfill (PRs #111–#113); markdown stripping for FB + LinkedIn social copy (PR #115)
- **May 21** — Stage 1 (Context Hub crawl) rebuilt end-to-end: Jina-first + forgeScrape Tier 1→2 fallback, parallel discovery (PRs #103–#110)
- **May 17** — `/api/admin/mark-unpublished` endpoint
- **May 15** — GFM table rendering for article markdown
- **May 14** — Articles library canonical + robots SSR; promo + gate URL params (`?promo=NANGO`, `?gate=open`); brand deep-link no-flash on first load
- **May 13** — Social Generator regenerate-arcs feature; X v2 media upload fix (branch by auth method); Vite 5→8 security upgrade; Clerk + postcss patches; X analytics OAuth2 token refresh on 401
- **May 12** — Lovable integration (prompt-pack endpoint + Build with Lovable button); Quick Start no-website onramp
- **May 10–11** — Zernio dual-ID analytics fix (LinkedIn); publish-status mirror bug (100% failure rate caught); Copilot Autofix incident + revert
- **May 9** — MCP server live for Viktor; Attio CSV export; HubSpot demolition (4 rebuild rounds → clipboard copy); Email Campaign Generator Phase 1+2+3
- **May 8** — Zernio LinkedIn migration for Forge brand
- **April 17** — Cherry-pick architecture in GEO Strategist; Compliance Gate AI rewrite + Find Sources; Factual Ground + Territory injection
