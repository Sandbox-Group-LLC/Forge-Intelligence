# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-10 — Video: real timing, fit-to-frame, per-brand pronunciation

All merged to `development`. Three voice/render-quality fixes from Brian's QA pass:
- **#334 timing + fit** — scene length now tracks the REAL audio (ElevenLabs returns exact seconds; OpenAI falls back to word-count estimate) + a ~0.85s tail, so VO no longer overlaps into the next scene. "No repeated copy" prompt rule. New `Fit` component in `DataReel.tsx` measures content and scales down to the safe area → kills out-of-frame text.
- **#336 pronunciation** — `applyPronunciations(text, dict)` rewrites tricky brand names in the **spoken VO only** (on-screen text keeps real spelling); whole-word, case-insensitive, substring-safe. Sources merge: per-brand `profile_data.pronunciations` → optional per-render override (new "Pronounce names like" UI field). **SYSOI's 3 profiles seeded** `{ "SYSOI": "Sis-Oy" }`.

#### What's next (video) — DEPLOY PENDING
- **⚠️ Run `cd remotion && npm run deploy-site` (needs `REMOTION_AWS_*` env — Render side, not the sandbox).** #334 changed the `DataReel.tsx` template (Fit component); the live `forge-reels` Lambda site won't have it until this redeploy. Pronunciation (#336) is server-side only and needs no deploy.
- Then verify ElevenLabs on Render: hit `dev.forgeintelligence.ai/api/video/tts-check` signed in, confirm the `elevenlabs` block (EL works vs. datacenter-IP blocked → silent OpenAI fallback).
- Drop `framesPerLambda: 400` once the AWS **5,000 concurrency** increase approves.

---

### 2026-06-09 (cont. 2) — Video generator → production-grade

The video generator went from "it renders" to a real product. One pattern throughout: **curated finite vocabulary the storyboard agent picks from (grounded in the brand brain), human veto via UI pickers.** Full detail in `PLAN.md` (2026-06-09 cont. 2). Architecture: brief → `storyboardFromBrief` (Claude) → `synthesizeScenes` (TTS → S3 presigned) → `renderReel` on **AWS Lambda** (`forge-reels` site). Backend `src/server/video.js` + `routes/video.js`; template `remotion/src/DataReel.tsx` (redeploy: `cd remotion && npm run deploy-site`).

**Merged to development**
- **#322 expressive voice** — structured openai.fm-style delivery instructions (not one flat sentence); voices incl. `coral`/`verse`.
- **#324 screens + upload** — `ScreensView` (browser-chrome + Ken Burns). Auto-capture (`captureProductShots`, gated by `VIDEO_SCREENS_ENABLED`) is the FALLBACK; **user upload is primary** (`POST /api/video/upload-shot` → S3 `forge-uploads/<brand>/`, brand-scoped re-presign, `ensureScreensScene` guarantees uploads appear).

**Open PRs at session end (all green) — needs your merge + a site reconcile**
- **#326** ElevenLabs provider (`VIDEO_TTS_PROVIDER` auto, OpenAI fallback) + per-scene buzzword-punch dynamics. *EL free tier blocks datacenter IPs → needs Starter (Brian upgraded; validated).*
- **#327** removed hardcoded red — hook emphasis → brand accent, 0% bars → grey.
- **#328** scene deck **7 → 18 archetypes** (bigstat/stattrio/quote/comparison/steps/grid/timeline/statement/logos/checklist/split) + "vary the beats" rule.
- **#329** **video arcs** — `POST /api/video/arcs` → 8 brand-grounded video concepts (one-click brief+length+format), like the Social Generator's campaign arcs.

#### What's next (video)
- **Reconcile the stack:** merge #326→#327→#328→#329 (trivial, different regions), then ONE final `cd remotion && npm run deploy-site` so the live Lambda template == development (it's shared state; last deploy wins).
- Drop `framesPerLambda: 400` once the AWS **5,000 concurrency increase** approves (still pending).
- Bigger swings (not built): generative B-roll (Veo/Sora/Kling) premium mode; per-brand direction locking via `manual_overrides`; bundle Inter locally.

---

### 2026-06-09 (earlier) — Video gen foundation + visual brand system + Sommers seeding

Full detail in `PLAN.md` (2026-06-09 and cont.). The base everything above builds on:
- **Lambda+S3 video pipeline** stood up (IAM/role/function/`forge-reels` site); `/app/video-generator` UI; 16:9↔9:16; music beds + ducking; visual themes; hard length control. **Env (Forge group):** `REMOTION_AWS_*` ×3, `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_LAMBDA_SERVE_URL`, `ELEVENLABS_API_KEY`. Gotcha baked in: AWS SDK reads `AWS_*` not `REMOTION_AWS_*` → mirrored at `video.js` load.
- **Visual brand capture** — Context Hub MEASURES the live site (`captureBrandVisual`: computed-CSS accent + logo), stores `profileData.brandVisual`; `buildBrand()` injects accent/bg(luma≥0.88)/logo so reels render in the brand's identity.
- **Context Hub competitor grounding (#300)** — Sonar now runs AFTER the scrape, grounded in content (killed the "forge"→GitHub/defence garbage); founder list wins; `manual_overrides` pins survive re-scans.
- **`/analyze` stuck-UI fix (#314)** — `analyzeRecovery.ts` deadline + version-bump polling. _Real fix backlogged: make `/analyze` async ack+poll._
- **Sommers House** seeded: accent `#2e5c3b`, cream bg, SVG logo, pinned competitors.
- **autoDeploy mystery (unresolved):** Production's toggle flips off around deploys; suspect another `RENDER_API_KEY` holder. Dashboard Activity feed names the actor if it recurs.

#### Carried-forward backlog (non-video)
- `/scan` lead capture (wire domain/email to CRM/DB); cold-scan rate-limiter → Redis/DB-backed; auto-generate the branded scan report; BrandSettings UI for `settings.breadcrumb`; route-inventory `parseImports` combined-import gap.

---

_Older sessions (2026-06-07 GEO arc, 2026-06-06 and earlier) archived in `PLAN.md`._
