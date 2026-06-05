# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-05 — server.js decomposition (Stage 2) begins + two latent bug fixes

The monolith dismemberment is underway. `server.js` (~19.8K lines, 214 routes) is being broken into `src/server/*.js` modules, one cohesive unit at a time. **Every cut is a pure move with zero behavior change**, verified by a CI safety net built *before* the refactor started.

**Modules extracted to date (10):** `db`, `llm-json`, `utm`, `text`, `auth`, `zernio`, `scrape`, `llm`, `logging`, `lovable`. All on `development`.

This session's cuts:
- **`llm.js`** (#213) — `anthropic` client (20-min timeout, used 52×) + `dateContext()`. Kept the bare `Anthropic` class import for 4 handlers that build their own short-timeout client.
- **`logging.js`** (#214) — live-log ring buffer + console capture + error aggregation. Exports `logBuffer`/`logSSEClients`/`errorAggregates` + `installLogCapture()` (idempotent); `captureLog`/`LOG_BUFFER_SIZE` private.
- **`lovable.js`** (#215) — the whole Lovable prompt-pack integration (~324 lines, 17 helpers + 4 consts). Fully self-contained leaf: pure templating, zero external deps.

**Two latent bugs found during review, fixed on BOTH lanes:**
- **Lovable directive placeholder leak.** `lovableBuildWithDirective` guarded optional sections with `block !== 'No data available'` — a string that never matches `lovableSection()`'s real fallback, so the guard was always true. Brands with no whitespace/third-party data got scaffolding text ("Design this section to be populated later") injected into the `## BRAND INTELLIGENCE` block, which Lovable read as brand intel. Fixed: gate on the raw source via `lovableHasData()`. (#216 features, #219 development)
- **`captureLog` unguarded stringify.** Ran `JSON.stringify` on console args with no try/catch; a circular object or BigInt would throw *inside* the patched `console.log` and crash the caller. Never fired in prod, but it's the hottest path in the app. Fixed: try `JSON.stringify` → `String(a)` → `'[unserializable]'`. (#217 features, #218 development)

All five PRs merged. **`features` merged to production (`main`)** — both bug fixes are live. `development` holds the full refactor + both fixes, ready for the `development → main` rollup.

#### CI safety net (built before the refactor)
- **`npm run lint`** — ESLint flat config, `no-undef` only. Catches a missed re-import (the #1 risk of moving code out of a monolith — otherwise only crashes on deploy). `document`/`window` whitelisted for Puppeteer page-eval callbacks.
- **route-inventory guard** — static scan of `app`/`router.METHOD` registrations → sorted `"METHOD /path"` set vs `test/routes.snapshot.json` (213 routes). A pure move must not add/drop/rename a route.
- **vitest** — per-module unit tests added with each extraction (~56 tests now).
- CI job "Typecheck & Test" on PRs to `[main, development, features]`: `node --check` → lint → typecheck → vitest.
- **NOTE:** `features`/`main` CI currently runs only `node --check` + `typecheck` — the lint/vitest/route-guard gate is `development`-only so far. Promote the full gate to `features` when convenient.

#### Extraction pattern
Pure move: module imports its own deps (`pool` from `db.js`, etc.), `server.js` re-imports the public surface, internal-only helpers stay unexported. Verify `node --check` + lint + route guard + vitest before commit. The `no-undef` gate is the safety belt — it has caught 3 missed-symbol cases across earlier cuts.

#### What's next
- **More clean leaves** before route-group surgery: X OAuth/crypto cluster (`buildXOAuthHeader`, `refreshXOAuth2Token`, `buildGhostJWT`, `uploadXMedia`), then image helpers (`generateHeroImage`, `buildImagePrompt`, `generateSocialImage`, `buildSocialImagePrompt`).
- **Route GROUPS** — the big line-count win. Requires teaching the route-inventory guard mount-prefix resolution (`app.use('/prefix', router)`) *before* moving handlers behind a router, so full paths still verify. Guard change first, then the move.
- **Promote the full CI gate** (lint + vitest + route guard) to `features`/`main`.
- Tracked but not approved: scrape `format:'markdown'` no-fallback gap; `scrape_log` 15KB `body_sample` bloat.

---

### 2026-05-10 → 2026-05-23 — Stage 1 rebuild + My Website + /docs + X OAuth migration

~14 days, ~222 commits across 30+ PRs. Multi-session arc; Brian + Claude (full-stack).

#### Major shipments — themed, biggest first

**Stage 1 (Context Hub crawl) rebuilt end-to-end.** Single biggest piece of work. Old Stage 1 was raw `fetch()` with UA rotation, no anti-bot, no JS render, 3 KB body cap per page — silently returned SPA shells on most modern customer sites and built brand profiles off meta tags + JSON-LD alone. New Stage 1 is **Jina Reader primary + `forgeScrape` (BD Tier 1 → Tier 2) fallback**, with parallel page fetches, sitemap.xml-aware discovery, anchor-only link extraction. Wall-clock cut from ~60 s sequential to ~15–20 s parallel; brand profiles now capture full pricing pages, blog catalogs, security whitepapers. Real-world validation on sandbox-gtm.com produced a richer v9 profile than v8 had any way to. PRs #103–#110.

**`forgeScrape` primitive.** Single source of truth for any Bright Data scraping. Tier 1 = Web Unlocker, Tier 2 = Scraping Browser (puppeteer-core CDP, real Chromium, residential IPs) auto-fires when Tier 1 returns a SPA shell. Extracts content via Mozilla Readability + Turndown locally — no second API call. Used by Stage 1 + Site Template. Every call logs to `scrape_log` with `caller` set for audit. Honest extraction metric replaces "0/10 class names found" with "regions located via any signal" (class, data-testid, semantic landmark, content match).

**My Website channel.** New self-hosted webhook publisher. Customers publish Forge articles to their own sites via authenticated webhook with Forge-issued `forge_pub_<32hex>` bearer token. Backend: 4 admin endpoints (config / generate-token / test / disconnect) + publish-handler branch. Frontend: `<MyWebsiteForm>` with URL input, format toggle (HTML/Markdown/both), show-once token reveal, test-publish button. Sandbox-GTM is the guinea pig (Render + Neon, same stack as Forge) — receiver wired and validated end-to-end. PRs #117–#122.

**`/docs` page goes live.** Public route, syntax-highlighted markdown, sidebar grouped by category. First entry is My Website Integration with copy-paste receivers (Node/Express + Postgres, Next.js App Router, filesystem). **Share With AI** button on every doc downloads markdown + a framing preamble for Claude/ChatGPT/Cursor. PRs #120, #123–#125, #134.

**`article_base_url` respected everywhere.** Five publish handlers (Facebook x3, Reddit, Medium) + My Website canonical were rebuilding URLs from `BASE_DOMAIN + brandSlug + articleSlug` instead of brand-aware `forgeArticleUrl`. PR #121 unified all six. PR #123 also adds an explicit "Where will my articles live?" Brand Settings callout.

**Markdown leak fix on social copy.** Facebook + LinkedIn posts going out with literal `#` headings and `**bold**` markers — Haiku was writing markdown by default. PR #115 adds `stripSocialMarkdown()`, updates Facebook prompts to request plain text, applies the strip at 6 sites. Reddit left intact (renders MD natively).

**X (Twitter) OAuth migrated to x.com.** Forge was sending to `twitter.com/i/oauth2/authorize`; domain-migration redirect chain broke the login cookie → infinite "to use this App you have to be logged in" loop in fresh browsers. PR #132 swaps authorize + both token-exchange URLs to `x.com` / `api.x.com`. Runtime API endpoints (tweets, users/me, media-upload) left on `api.twitter.com` — working today via compat redirects.

**Auth-expired = Reconnect, not Reset & Retry.** PR #130 detects auth-expired patterns in `publish_log.error_message`, swaps the button for an amber "Reconnect [Channel] →" link, surfaces non-auth error messages directly.

**Facebook analytics URN bug** + one-shot backfill admin endpoint (PRs #111–#113). 2 historical Sandbox-GTM posts cleanly mapped + backfilled.

**Zernio dual-ID system landed** (5/10). LinkedIn analytics uses `zernioPostId` with legacy fallback; 14 historical LinkedIn posts backfilled via `/api/admin/zernio/raw`.

**Other notable**: Lovable integration + Build button (5/12); Quick Start no-website onramp (5/12); X v2 media upload fix (5/13); Regenerate Arcs (5/13); Vite 5→8 + Clerk/postcss security patches (5/13); GFM table rendering (5/15); `/api/admin/mark-unpublished` (5/17); GitNexus context files committed — aspirational without live MCP runtime in cloud sessions (5/21); `SESSION-PROTOCOL.md` refreshed + moved to repo root (5/22); topbar alerts bell + Get Help form (5/23).

#### State of key surfaces (end of period)

- **Stage 1 (Context Hub crawl):** Jina-first, forgeScrape fallback, parallel discovery. Reads full sites including SPAs.
- **Site Template:** Same `forgeScrape` primitive, same Tier 2 fallback. Grades by content + structural selectors.
- **Publishing channels live:** LinkedIn (Zernio), X (OAuth2, x.com migrated), Facebook (Zernio + Pipedream), Reddit (Zernio), Medium, Ghost, WordPress, Webflow, **My Website (new)**. HubSpot stripped per 5/9.
- **`/docs` surface:** Live at `forgeintelligence.ai/docs/my-website`. Share With AI on every entry.
- **GitNexus index:** 2,818 nodes / 3,968 edges / 61 clusters / 129 flows.

#### What's next (from that period — superseded items pruned)

- **Watch X OAuth in the wild** — if runtime API calls start failing the same way, apply the domain swap to those endpoints too.
- **My Website rollout copy** — landing page, email blast, in-app announcement. Feature exists + documented; awareness is the remaining gap.
