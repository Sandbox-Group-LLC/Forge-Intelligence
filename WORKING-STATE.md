# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-09 — AI Video Generation live end-to-end (Remotion Lambda + S3) + visual brand system

PRs #296→#314, all in prod same-day. Full retrospective in `PLAN.md` (2026-06-09).

**1. Video generation is a production feature.** Brief → storyboard agent (Sonnet) → per-scene TTS (`gpt-4o-mini-tts`/`ash` → S3 presigned) → H.264 render on **AWS Lambda** (never the web dyno). `remotion/` at repo root is the versioned template (`DataReel`: data-driven, 7 scene archetypes, `calculateMetadata` derives duration+canvas from props; redeploy via `npx remotion lambda sites create src/index.ts --site-name=forge-reels`). Backend `src/server/video.js` + async `routes/video.js` (`POST /api/video/generate` 202+poll, `generated_videos`). UI at `/app/video-generator` (#298) with **16:9 / 9:16 toggle** (#304 — template rescales by `k=width/designWidth`). Cost: ~$0.011/70s landscape, ~$0.002/15s portrait.
- **Env (Forge group):** `REMOTION_AWS_*` ×3, `REMOTION_LAMBDA_FUNCTION_NAME` (`remotion-render-4-0-474-mem3008mb-disk2048mb-240sec`), `REMOTION_LAMBDA_SERVE_URL` (`forge-reels` site).
- **Gotchas baked into code:** AWS SDK reads `AWS_*` not `REMOTION_AWS_*` → mirrored at `video.js` load (#302). New-AWS-account concurrency cap 10 → `framesPerLambda: 400` pinned; **drop it when the requested 5,000 increase approves** (still pending).

**2. Visual brand system — reels render in the BRAND's identity, not Forge's** (#306/#308/#310/#312). Context Hub now MEASURES visuals during scan: `captureBrandVisual` loads the homepage in the headless browser *with CSS* and reads computed styles (weighted accent from CTAs/nav/links; logo = header img → touch-icon → biggest favicon → og:image last). Stored as `profileData.brandVisual`; the guessed `voiceProfile.accentColor` is overwritten with the measured hex (prompt now forbids hex-guessing). `buildBrand()` injects accent/accent2/bg(luma≥0.88 only)/logo into the reel; `BrandMark` shows the real logo, Forge diamond only for Forge. **Populating visuals requires a re-scan per brand.** Validated in prod (duolingo `#a5ed6e`; deterministic on Sommers).

**3. Sommers House (demo customer) fully seeded.** Competitors were domain-keyword garbage ("forge" → GitHub/defence) → #300 grounds Sonar in scraped content (runs AFTER the scrape now) + founder list wins; data pinned via `manual_overrides` (`moremas.com`/`experiencenve.com`/`atypikal.co`). Visuals measured: accent `#2e5c3b`, bg `#fbf8f1`, SVG logo — both active profiles seeded. **The branded reel re-generation has NOT been run yet** — next Video Generator run on Sommers comes out cream/green/their mark.

**4. Stuck-scan UI fixed (#314).** `/analyze` holds one connection 3–4 min; a drop left the UI spinning while the server finished. `src/lib/analyzeRecovery.ts` (deadline + version-bump polling recovery) wired into all 3 scan paths. **Real fix backlogged: convert `/analyze` to async ack+poll like video gen.**

**5. autoDeploy mystery (unresolved).** Production's toggle flips off around deploys. Ruled out: Blueprints (none; fossil `render.yaml` deleted), our code (read-only Render API), visible event log. Suspect: another holder of the shared `RENDER_API_KEY`. If it recurs → dashboard Activity feed names the actor; rotating the key isolates it.

#### What's next
- **Run the branded Sommers reel** (seeded, one click in the UI).
- **Video generator round 2** (Brian queued the conversation): music bed + ducking, local Inter font, real app footage (Playwright), richer storyboards/archetypes, publish-to-channels wiring.
- Drop `framesPerLambda` after the AWS concurrency increase approves.
- Async `/analyze` refactor; BrandSettings UI for `settings.breadcrumb`; `/scan` lead capture.

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

#### What's next (carried forward)
- **`/scan` lead capture** — CTA links out for now; wire domain/email to a CRM/DB (the actual lead loop). Deliberate fast-follow.
- **Rate-limiter hardening** — `/api/geo/cold-scan` limiter is in-memory (approximate across Render instances). Redis/DB-backed before promoting `/scan` hard.
- **Auto-generate the branded report** from the scan JSON (currently the shareable artifact is hand-assembled).
- **Open guard gap (still):** route-inventory `parseImports` doesn't handle combined `import Default, { Named }` — harden it.

---

_Older sessions (2026-06-06 and earlier) archived in `PLAN.md`._
