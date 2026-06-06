# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-06 (cont.) — route-group surgery COMPLETE: 12 groups extracted

The decomposition crossed from helpers into **route GROUPS** and finished them: handlers moved into `src/server/routes/*.js` mounted via `app.use('/prefix', router)`, the guard reconstructing full paths so the snapshot stayed byte-identical the whole way (**213 → 211** only for one intentional dead-dupe cleanup). Pattern: collect each handler's span (next-statement boundaries), move verbatim, `xform` the registration line (`app.METHOD('/prefix/x', …)` → `router.METHOD('/x', …)`), re-import deps from already-extracted modules. Verify `node --check` + lint + boot-load (`import()`) + route guard + vitest.

**12 route groups → `src/server/routes/` (15 files):**
- `compliance.js` (#244, 8) · `email-campaign.js` (#245, 9) · `social-generator.js` (#247, 6) · `campaign.js` (#248, 9) · `topic-ideas.js` (#249, 5) · `precog.js` (#250, 5) · `geo-strategist.js` (#252, 3) · `analytics.js` (#253, 11) · `context-hub.js` (#254, 5) · `content.js` (#255, 6) · **zernio** (#256, 10 → `zernio.js`+`zernio-admin.js`) · **publishing** (#258/#259/#260, 20 → `publishing-queue.js`+`publishing-channels.js`+`publishing-publish.js`)
- Several routers also absorbed a route-group-only helper (`ensureComplianceColumns`, `ensureSocialPostsTable`, `enrichAngleForCampaign`, `refreshGSCToken`, `handleQuickStartSynthesis`, `runScheduledPublishes`).

**Shared modules the no-undef gate forced out:** `streams.js` (globalThis SSE registry), `content-table.js` (`ensureGeneratedContentTable`), `pipedream.js` (`pipedreamProxy` + token cache — shared by the publish dispatcher AND inline FB routes). Naive moves would've left undefined refs → silent deploy breaks; gate caught all (plus `fs`/`path`/`randomUUID`/`jwtVerify`/`clerkJWKS`/`PORT`/`RESEND_API_KEY`/the `_pd*` cache vars).

#### Publishing finale (the deferred beast) — split 3 ways
- `publishing-queue.js` (#258, 14) — also **deleted 2 dead-duplicate `backfill-queue` registrations** (only the first reachable in Express) → 213→211, snapshot regenerated.
- `publishing-channels.js` (#259, 4) · `publishing-publish.js` (#260, 2: `generate-post-copy` + the ~1,129-line dispatcher) — all three share the `/api/publishing` mount (separate files, one mount each = guard-safe).

#### Conventions + guard constraints (load-bearing — keep)
- **Auth:** router-level `requireAuth` when ALL routes authed; **per-route** when mixed. On a SHARED-prefix mount (publishing's 3 routers) auth MUST be per-route — mount-level would leak onto the other routers' routes.
- **Guard scans ONE `express.Router()` var per file** — two routers can't share a module (zernio, publishing → multiple files). One router file, one mount.
- **Mounts match on segment boundaries** — `/api/content` does NOT capture `/api/content-library`/`-generator`.
- **Boundary detection:** next-statement, not "first `^}`" (prompt template literals have `}` at col 0).

#### KNOWN GUARD GAP (open follow-up)
The guard's `parseImports` does NOT handle the combined `import Default, { Named } from '…'` form — it silently drops the default router (#260 read 209 until I split the import into 2 lines). **Harden `parseImports` for combined imports** (next task) so a future combined-import mount can't under-count.

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
