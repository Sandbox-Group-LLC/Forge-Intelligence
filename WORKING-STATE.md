# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-06 (cont.) — route-group surgery: 6 groups extracted + 2 shared modules

The decomposition crossed from helpers into **route GROUPS**: handlers move into `src/server/routes/*.js` mounted via `app.use('/prefix', router)`, with the guard reconstructing full paths so the snapshot stays byte-identical (213 throughout).

- **Guard mount-prefix (#242)** — taught `test/route-inventory.mjs` to resolve `app.use('/prefix', router)` mounts: reads the router module and prefixes its `router.METHOD('/sub')` as `/prefix/sub`. Pure core `resolveRoutes()` + helpers, unit-tested. (Bare `/api/x` route → `router.METHOD('/')`.)

**6 route groups extracted → `src/server/routes/`:**
- `compliance.js` (#243→#244, 8 routes) + moved `ensureComplianceColumns`
- `email-campaign.js` (#245, 9) — surfaced shared SSE registry → **`streams.js`** (`activeStreams`)
- `social-generator.js` (#247, 6) + moved `ensureSocialPostsTable`; reaches into 7 prior modules (x/images/streams/llm/db/auth/llm-json)
- `campaign.js` (#248, 9, **per-route** auth) + moved `enrichAngleForCampaign`; surfaced shared table helper → **`content-table.js`** (`ensureGeneratedContentTable`)
- `topic-ideas.js` (#249, 5) — cleanest, pool-only
- `precog.js` (#250, 5)

**2 shared modules** the no-undef gate forced into the open: `streams.js` (globalThis SSE Map shared with still-inline handlers), `content-table.js` (per-brand `generated_content_<id>` schema helper, shared by content-generator + campaign). Naive moves would've left undefined refs → silent deploy breaks. Gate caught both.

#### Router auth convention
- **Router-level** `requireAuth` when **all** routes are authed (compliance, email-campaign, social-generator, topic-ideas, precog).
- **Per-route** auth when **mixed** (campaign has a public `GET /:id`; mount without auth, keep per-route middleware).

#### Lessons logged this phase
- **Mis-merge (#243→#244):** a stacked PR's base retarget didn't take before merge → compliance landed on the wrong branch, never reached `development`. Caught (missing `routes/` dir), re-landed. **Re-read a retargeted PR to confirm the base flipped; prefer branching the child fresh off `development` over deep stacks.**
- **Prompt-template boundary hazard:** the campaign/social handlers contain template literals with `}` at column 0, which broke naive "first `^}`" function-end detection mid-build (caught by `node --check`, restored from git, re-cut). **Default to next-statement boundary detection for route extractions, not brace-matching.**

#### What's next (route groups) — the remaining are the hard ones
- **Publishing DEFERRED to last** (Brian's call): 22 routes scattered 943→11570, mixed auth, a **1,138-line `publish` dispatcher** + `pipedreamProxy`. Do it (likely split) when the dep web is smallest.
- Remaining lean scattered/mixed → multi-span + per-route care: `/api/analytics` (11, mixed), `/api/content` (6, scattered+mixed+`requireApiKeyScope`), `/api/context-hub` (5, scattered+mixed), `/api/geo-strategist` (3, mixed).
- **zernio subsystem pass** — ~15 routes across 4 prefixes (`/api/zernio`, `/auth/zernio`, `/integrations/zernio`, `/api/admin/zernio`) + mixed auth → one dedicated module, not piecemeal.

---

### 2026-06-06 — decomposition continues (5 more cuts) + 3 production fixes

Kept dismembering `server.js`, same pure-move discipline + CI safety net. **16 modules out now** (14 files; `text.js` grew):

- **`x.js`** (#224) — X/Twitter primitives: `buildXOAuthHeader`, `uploadXMedia`, `refreshXOAuth2Token`.
- **`images.js`** (#225) — `buildImagePrompt`/`generateHeroImage` + `buildSocialImagePrompt`/`generateSocialImage` + private `HERO_IMAGE_NEGATIVE_PROMPT`; imports `anthropic` from `llm.js`.
- **`text.js` grew** (#232) — added `quickStartTruncate` + `stripScaffoldingArtifacts` (consolidate, don't sprawl).
- **`marketing.js`** (#233) — public SSR cluster: FAQ content, JSON-LD, `MARKETING_META`, `renderMarketingPage`. Static templating, fully self-contained.
- **`citations.js`** (#234) — `findCitationSources` (Perplexity Sonar) + private `LOW_QUALITY_CITATION_DOMAINS`; imports `pool`.

**Three production fixes, shipped both lanes (`features` → prod + `development` mirror):**
- **fal.ai image quality** (#226/#227) — `expand_prompt: true → false` (MagicPrompt was rewriting our carefully-tuned prompts and re-injecting the AI-stock look — likely the "weird images" complaints) + `AbortSignal.timeout(60000)`.
- **JWT clock skew** (#229/#230) — Compliance Gate "Invalid token" that self-healed on retry = **token expiry**, not the Clerk template (Brian confirmed template healthy). Added `clockTolerance: '30s'` to all 7 `jwtVerify` sites + frontend retry forces a fresh token (`skipCache: true`) + clears the stale banner.
- **Citation recency** (#235/#236) — `findCitationSources` applied `search_recency_filter: 'year'` to **every** query, starving definitional/historical/statistical claims of the older authoritative sources the prompt explicitly allows. Now scoped to **trend claims only** + Sonar `AbortSignal.timeout(45000)` + honest 429 message. (Likely root of Brian's citation issues.)

**CI gate promoted to `features`** (#222) — the prior block's NOTE is resolved: the `features` lane now runs the ESLint `no-undef` gate too (route guard + vitest were already there). Gate is on both lanes.

#### What's next
- **Thin leaves left:** `normalizeGeoData` (GEO transform), `buildGhostJWT` (Ghost), `PROMO_CODES`. Quick cuts.
- **Route GROUPS** — the structural payoff. Lead with teaching the route-inventory guard mount-prefix resolution (`app.use('/prefix', router)`) so full paths still verify, THEN move handlers behind routers.
- Tracked but not approved: scrape `format:'markdown'` no-fallback gap; `scrape_log` 15KB `body_sample` bloat; citation `search_results → citations[]` fallback (needs a live Sonar response to confirm the shape).
- Aside surfaced during the JWT dig: a **LinkedIn Insight Tag** is loaded inside the authed app (`/app/*`) capturing click + hashed-email data — worth a look at where it's injected.

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
