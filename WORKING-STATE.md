# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-07 — GEO scan made REAL (4 engines) + public `/scan` lead magnet + dev→main rollup shipped

Big arc, all live in prod. **`development` and `main` are now equal** (rollup PR #276 merged + deployed green; all four engines verified healthy on prod).

**1. The GEO "we measure AI citations" claim was half-true — fixed.** Two separate surfaces, easily conflated:
- **GEO Strategist scan** (Stage 2, `/api/geo-strategist/analyze`): per-engine 0–100 "citation probability" numbers were **Claude-imagined, never measured** (one Sonnet call estimating all four engines → the tell was lockstep, near-constant per-engine offsets). **Left as-is on purpose** — it's a *modeled estimate* by design (Brian confirmed). Not a bug.
- **Performance Dashboard "Run Citation Check"** (`/api/geo/track` → `geo_citations`): the *real* measured analytics. Was probing only **2 engines** (Perplexity + OpenAI) while we marketed four. **Extended to all 4** (#266): added Gemini (Search grounding) + Google AI Overviews (SerpAPI). Unified the two duplicated inline blocks into one engine-agnostic loop over `CITATION_ENGINES` in `src/server/geoProbe.js`.

**2. New: public AI Visibility lead magnet at `/scan`** (#269, light theme + real DiamondIcon logo #273). Drop a domain → `POST /api/geo/cold-scan` scrapes the homepage, Claude writes 10 brand-free buyer questions, probes all 4 engines, returns measured visibility % + per-engine + "who AI cites instead" (competitors/namesakes). `coldScan` + `scanVisibility`/`brandTokens`/`aggregateSources` in `geoProbe.js`. Public + rate-limited (3/IP/hr + 250/day global cap; `adminPassword` bypass).

**3. Gemini saga (the diagnostic paid off):** every scan showed Gemini 0%. `/api/geo/debug` (extended with live Gemini+SerpAPI tests, #271) revealed **two stacked bugs**: expired `GEMINI_API_KEY` (rotated) + retired model `gemini-2.0-flash` → bumped to **`gemini-2.5-flash`** (#272). Also made all 4 probes **throw on API errors** so a dead engine renders **"n/a"**, never a false 0% (#272). Nike now reads a realistic 75% (was a fake 0).

**4. Content em-dash sanitizer** (#264): `stripEmDashes` deterministic backstop in `text.js` (comma, or semicolon when the sentence already has 2+ commas) + strict prompt rule — applied at content-gen write path.

**5. LinkedIn Insight Tag scoped to marketing pages** (#267): gated `!location.pathname.startsWith('/app')` so it never loads in the authed app. GTM/GA4/Google Ads stay site-wide (confirmed firing on `/scan`).

**6. The dev→main rollup (the "scary" one), reconciled clean.** dev was 111 ahead, main 23 ahead (prod hotfixes + feature-lane merges never folded back into the decomposed branch). Verified **development is a true superset** before resolving: **0 route gaps** (all 210 main routes present), all 6 main hotfixes present — except the **fal.ai `expand_prompt:false` + 60s timeout** fix, which was **missing from development** (would've silently regressed "weird images" in prod). Ported it (#275), merged `main`→`development` resolving the 4 collisions (`server.js`/`package.json`/`PLAN.md`/`WORKING-STATE.md`) to development, then promoted #276.

Also: fixed CLAUDE.md's stale relay doc (`ADMIN_PASSWORD` → `ADMIN_RELAY_PASSWORD`, the pinned item).

#### What's next
- **`/scan` lead capture** — CTA links out for now; wire domain/email to a CRM/DB (the actual lead loop). Deliberate fast-follow.
- **Rate-limiter hardening** — `/api/geo/cold-scan` limiter is in-memory (approximate across Render instances). Redis/DB-backed before promoting `/scan` hard.
- **Auto-generate the branded report** from the scan JSON (currently the shareable artifact is hand-assembled).
- Optional: GTM **History Change** trigger / SPA `dataLayer.push` so client-side nav to `/scan` registers a pageview.
- **Open guard gap (still):** route-inventory `parseImports` doesn't handle combined `import Default, { Named }` — harden it.

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


_Older sessions (2026-06-05 and earlier) archived in `PLAN.md`._
