# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `WHITEBOARD.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. If it grows past that, content belongs in WHITEBOARD.

---

## Last sessions

**Refresh covers 2026-05-10 → 2026-05-23** (~14 days, ~222 commits since the previous WORKING-STATE snapshot). Multi-session arc; Brian + Claude (full-stack) across all of it.

### Major shipments — themed, newest first

**Stage 1 (Context Hub crawl) rebuilt end-to-end.** The single biggest piece of work in this window. Old Stage 1 was raw `fetch()` with UA rotation, no anti-bot, no JS render, 3 KB body cap per page — silently returned SPA shells on most modern customer sites and built brand profiles off meta tags + JSON-LD alone. New Stage 1 is **Jina Reader primary + `forgeScrape` (BD Tier 1 → Tier 2) fallback**, with parallel page fetches, sitemap.xml-aware discovery, and proper anchor-only link extraction. Stage 1 wall-clock cut from ~60 s sequential to ~15–20 s parallel; brand profiles now capture full pricing pages, blog catalogs, security whitepapers, etc. Real-world validation on sandbox-gtm.com produced a richer v9 profile than v8 had any way to. PRs #103, #104, #105, #106, #107, #108, #109, #110.

**`forgeScrape` primitive ships.** Single source of truth for any Bright Data scraping. Tier 1 = Web Unlocker, Tier 2 = Scraping Browser (puppeteer-core CDP, real Chromium, residential IPs) auto-fires when Tier 1 returns a SPA shell. Extracts content via Mozilla Readability + Turndown locally — no second API call. Used by Stage 1 AND Site Template AND any future code that needs to scrape. Every call logs to `scrape_log` with `caller` set for full audit. Honest extraction metric replaces "0/10 class names found" with "regions located via any signal" (class, data-testid, semantic landmark, content match).

**My Website channel — new publishing destination.** Customers can publish Forge articles to their own self-hosted sites via authenticated webhook. Forge POSTs the article payload with a Forge-issued `forge_pub_<32hex>` bearer token; customer's receiver decides storage + rendering. Backend: 4 admin endpoints (config / generate-token / test / disconnect) + publish-handler branch + analytics. Frontend: `<MyWebsiteForm>` component with URL input, format toggle (HTML/Markdown/both), show-once token reveal, test-publish button with inline result panel. Sandbox-GTM is the guinea pig (Render + Neon, same stack as Forge) — receiver wired and validated. PRs #117–122.

**`/docs` page goes live.** Real customer-facing documentation at `forgeintelligence.ai/docs`, public route (no auth). Left sidebar grouped by category (Integrations / Concepts / Reference), right pane renders markdown via `react-markdown` + `remark-gfm` + `react-syntax-highlighter`. First entry is My Website Integration with copy-paste-ready receiver samples (Node/Express + Postgres, Next.js App Router, filesystem). **Share With AI** button on every doc — downloads the markdown with a framing preamble so users can hand it to Claude/ChatGPT/Cursor for setup help. PRs #120, #123, #124, #125, #134.

**Article-base-URL respected everywhere.** Five publish handlers (Facebook x3, Reddit, Medium) plus My Website canonical were rebuilding article URLs from `BASE_DOMAIN + brandSlug + articleSlug` instead of the brand-aware `forgeArticleUrl`. Customers with `article_base_url` configured were seeing Forge-hosted URLs in social posts instead of their own domain. PR #121 unified all six on `forgeArticleUrl`. PR #123 also adds an explicit "Where will my articles live?" callout in Brand Settings → Publishing so the default hosting destination isn't a surprise.

**Markdown-leak fix on social copy.** Facebook + LinkedIn posts were going out with literal `#` headings and `**bold**` markers — Haiku was writing markdown by default and the publish path didn't strip it. PR #115 adds `stripSocialMarkdown()` helper, updates Facebook prompts to request plain text, applies the strip at 6 sites. Reddit left intact (renders MD natively).

**X (Twitter) OAuth migrated to x.com.** Forge was sending users to `twitter.com/i/oauth2/authorize`. Twitter's domain-migration redirect chain was breaking the login cookie across `twitter.com` ↔ `x.com`, producing a "to use this App you have to be logged in" infinite loop in fresh browsers. PR #132 swaps the authorize URL plus both token-exchange URLs (`api.twitter.com/2/oauth2/token` → `api.x.com/2/oauth2/token`). Runtime API endpoints (tweets, users/me, media upload) left on `api.twitter.com` — working today via compat redirects.

**Auth-expired errors now show Reconnect, not Reset & Retry.** Publishing Queue was masking the actual error message AND showing "Reset & Retry" for tokens that couldn't be retried. PR #130 detects auth-expired patterns in `publish_log.error_message`, swaps the button for an amber "Reconnect [Channel] →" link to `/app/integrations`, and surfaces non-auth error messages directly (truncated to 120 chars, full text in `title` attr).

**Facebook analytics URN bug.** Facebook publishes via Zernio were storing only the platform URN; the analytics sync passed that URN to Zernio's `/analytics` endpoint which expects Zernio's internal `_id` — every Facebook post returned HTTP 404. PR #111 captures `zernioPostId` at publish time + uses it for sync (mirrors LinkedIn pattern). PRs #112/#113 ship a one-shot admin backfill endpoint that maps existing URNs → Zernio `_id`s; ran cleanly against the 2 historical Sandbox-GTM posts.

**Zernio dual-ID system landed** (5/10). `zernioPublish()` returns both `platformPostId` and `_id`; LinkedIn analytics sync uses `zernioPostId` with legacy-API fallback. 14 historical LinkedIn posts backfilled via `/api/admin/zernio/raw`.

**Other notable** (chronological, lighter):
- 5/12 Lovable integration — prompt-pack endpoint, "Build with Lovable" button on Brand Profile, first-use hint
- 5/12 Quick Start no-website onramp (`/quick-start` route, partner-agnostic Deploy card)
- 5/13 X v2 media upload fix (branch by auth method — v2 for OAuth2, v1.1 for OAuth1)
- 5/13 Social Generator: Regenerate Arcs button + modal (rescan-free arc regeneration)
- 5/13 Security: Vite 5 → 8, Clerk + postcss patches
- 5/13 X analytics structured logging + OAuth2 token refresh on 401
- 5/14 Articles library canonical + robots SSR fix
- 5/14 Promo + gate URL params (`?promo=NANGO`, `?gate=open`)
- 5/14 Deep-link no-flash on `?brand=` first load
- 5/15 GFM table rendering for article markdown
- 5/17 `/api/admin/mark-unpublished` endpoint
- 5/21 GitNexus context files committed (`CLAUDE.md`, `AGENTS.md`, `.claude/skills/gitnexus/`) — aspirational without live MCP runtime in cloud Claude Code sessions
- 5/22 `SESSION-PROTOCOL.md` refreshed and moved to repo root
- 5/23 Topbar alerts bell + Get Help support form

### Recurring patterns logged

- **Build the primitive once, share it everywhere.** `forgeScrape` replaced 3+ ad-hoc fetchers. Channel-specific URL construction (the 6 sites that ignored `forgeArticleUrl`) accumulated because each new channel re-derived from scratch instead of using the shared helper.
- **Stdio MCP doesn't reach cloud sessions.** GitNexus is genuinely useful but its MCP transport is stdio-only — FleetView/cloud Claude Code can't connect to a remote install. Committed the context files as aspirational; the live graph tools are unavailable until either GitNexus ships HTTP/SSE MCP or FleetView gains custom-MCP support.
- **Test fixes against a controlled case first.** The whole sandbox-gtm.com diagnostic loop (PRs #103–110) was driven by one URL where Brian knew ground truth. Saved several wrong-direction guesses.
- **"Reset & Retry" for any error" is dishonest.** Auth-expired needs a Reconnect action with a real link, not the same button that just failed. The principle generalizes — every error UI should match the action that actually fixes it.

### State of key surfaces (end of period)

- **Stage 1 (Context Hub crawl):** Jina-first, forgeScrape fallback, parallel discovery. Reads full sites including SPAs.
- **Site Template (Stage 4 article import):** Same `forgeScrape` primitive, same Tier 2 fallback. Grades by content + structural selectors, not just class names.
- **Publishing channels live:** LinkedIn (Zernio), X (OAuth2 + x.com migrated), Facebook (Zernio + Pipedream), Reddit (Zernio), Medium, Ghost, WordPress, Webflow, **My Website (new)**. HubSpot stripped per 5/9.
- **`/docs` surface:** Live at `forgeintelligence.ai/docs/my-website`. Public, syntax-highlighted, Share With AI on every entry.
- **Brand Settings:** Hosting-destinations callout explains default vs BYO. Article Base URL + URL Suffix preview live.
- **Bootstrap files at repo root:** `CLAUDE.md`, `AGENTS.md`, `SESSION-PROTOCOL.md`, `WORKING-STATE.md`, `WHITEBOARD.md`, `.claude/skills/gitnexus/`. Skills aspirational without MCP runtime.
- **GitNexus index:** 2,818 nodes / 3,968 edges / 61 clusters / 129 flows. Re-run `npx gitnexus@latest analyze` after significant code work.

---

## What's next

- **Nurture email** framing the Stage 1 upgrade as a free product enhancement. Two before/after proof points ready: sandbox-gtm.com v8 → v9 and forgeintelligence.ai v11 → v12. Brian queued this.
- **Watch X OAuth in the wild** — confirm the `twitter.com → x.com` migration doesn't bite any edge case. If runtime API calls (tweets/users/me/media-upload) start failing, apply the same domain swap to those endpoints in a follow-up.
- **My Website rollout copy** — landing page, email blast, in-app announcement. The feature exists and is documented; awareness is the remaining gap.
- **GitNexus runtime** — if FleetView adds custom MCP support or upstream ships HTTP/SSE MCP transport, register `gitnexus mcp` and the architectural-awareness skills become live instead of aspirational.

**Endpoint count:** ~205 HTTP endpoints in server.js (up from ~191 per the 5/9 baseline; added forgeScrape primitive + My Website's 4 admin endpoints + Facebook backfill + various smaller).
