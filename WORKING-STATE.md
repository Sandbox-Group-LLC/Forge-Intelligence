# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-12 — Env-group incident root-caused · Ken Burns killed

- **"Lost super admin" root-caused — it was the env group, not Clerk.** Brian's leaked-key rotation (2026-06-10 18:55) replaced the Render env group with "Forge Intelligence Environment Group Updated" but left it **linked to zero services**; the 18:56 redeploys booted Production/Development without `NEON_DATABASE_URL` or the Clerk keys. `/api/auth/me` computed `isSuperAdmin: true` from the JWT, then 500'd on the DB query → the FE's `useActiveBrand` defaulted `isSuperAdmin` to false. Brian relinked the group; live `SELECT 1` via the relay confirmed recovery. Lesson: **Render service-level env vars override group vars** — both services carried stale pre-rotation copies (old `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, X/LinkedIn/HubSpot secrets) that were silently shadowing the rotated group. Brian deleted them; post-check is clean (service level now holds only the intentional per-env keys: `BASE_URL`, `BASE_DOMAIN`, `DATA_DIR`, dev's `GSC_REDIRECT_URI`).
- **#344 Ken Burns killed** — `ScreensView` in `remotion/src/DataReel.tsx` pushed every product screenshot scale 1.05→1.13 with an upward drift; it read as filler and kept the UI soft. Screenshots now hold static in the browser chrome; multi-shot crossfade unchanged. Merged to `development`.
- Side observation: the **SYSOI brand profile** was re-tethered 2026-06-10 from Brian's sandbox-xm Clerk user to `user_3Ebb…` = brian@sysoi.ai (separate account, created 2026-06-03). Not a bug — just know it moved.

#### What's next
- **⚠️ Run `cd remotion && npm run deploy-site`** (needs `REMOTION_AWS_*`) — #344 changed the template; the live `forge-reels` Lambda site keeps the zoom until this redeploy. Same footgun as #334.
- **Rotate `ADMIN_RELAY_PASSWORD`** — it was NOT part of the rotation (group value == old value) and it surfaced in session tool logs. Single-key update in the env group.
- (Carried) Activate the bootstrap hooks · automate `deploy-site` via GH Action on `remotion/**` · drop `framesPerLambda: 400` after the AWS concurrency increase · verify ElevenLabs via `/api/video/tts-check`.

---

### 2026-06-11 — Arc production envelope · web bootstrap · forge-reels deploy

- **#339 arc production envelope** — `videoArcs` pitched concepts the renderer can't make (human VO, live footage, talking-head/behind-the-scenes shoots). Storyboard was always safe (bounded by the 18 archetypes); the leak was the arc-idea prompt. Added a PRODUCTION ENVELOPE block: every concept must be achievable with animated text/data scenes + synthetic AI voiceover + optional uploaded screenshots + music. Filmed angles get recast (testimonial → on-screen pull-quote, demo → screenshots+callouts).
- **#340 Claude Code web bootstrap** — adapted Brian's `claude-web-bootstrap-template`. SessionStart brief (branch · behind `development` · commits · newest WORKING-STATE block) + UserPromptSubmit live status line (`branch · behind · gate · now · missing-env`) + PreToolUse capability gate. `capabilities.json` is source of truth; provider secrets are **watched** (surface loudly, never block). Adaptations: base `development`; reuses WORKING-STATE/PLAN (no STATE/WORKLOG); no Composio (harness MCPs direct). **Activation is a human step (NOT yet done): `cp .claude/settings.json.example .claude/settings.json` + commit, then fresh session.**
- **ElevenLabs VO**: confirmed it's a plain REST API (no MCP). Generated SYSOI product-video narration (7 scenes, Bill voice, stability 0.5/style 0.35) from `narration.json`. Gotcha: all-caps "SIS-oy" makes EL spell it (acronym detection) → use mixed-case "Sis-Oy" in the spoken text.
- **`forge-reels` redeployed** ✅ — the #334 Fit/timing template is now live on the shared Lambda site (serve URL unchanged). Surfaced + Brian fixed a real security event mid-deploy: the `remotion` IAM key was quarantined by AWS (`AWSCompromisedKeyQuarantineV3` = leaked-key auto-deny). Keys already rotated + updated in Render and the web env; quarantine policy detached; deploy then succeeded.

#### What's next
- **Activate the bootstrap hooks** (human step above) — the files are merged but inert until `.claude/settings.json` exists.
- **Automate the site deploy (proposed, not built):** a GitHub Action on `remotion/**` push to `development`/`main` running `deploy-site` with `REMOTION_AWS_*` as repo secrets — kills the "forgot to redeploy → stale template" footgun. The deploy is genuinely manual today (only `deploy-site` is, not the app — Render auto-deploys the dyno).
- Drop `framesPerLambda: 400` once the AWS **5,000 concurrency** increase approves.
- Verify ElevenLabs on Render: `dev.forgeintelligence.ai/api/video/tts-check` (signed in) → confirm `elevenlabs.ok` (vs. silent OpenAI fallback).

---

### 2026-06-10 — Video: real timing, fit-to-frame, per-brand pronunciation

All merged to `development`. Three voice/render-quality fixes from Brian's QA pass:
- **#334 timing + fit** — scene length now tracks the REAL audio (ElevenLabs returns exact seconds; OpenAI falls back to word-count estimate) + a ~0.85s tail, so VO no longer overlaps into the next scene. "No repeated copy" prompt rule. New `Fit` component in `DataReel.tsx` measures content and scales down to the safe area → kills out-of-frame text.
- **#336 pronunciation** — `applyPronunciations(text, dict)` rewrites tricky brand names in the **spoken VO only** (on-screen text keeps real spelling); whole-word, case-insensitive, substring-safe. Sources merge: per-brand `profile_data.pronunciations` → optional per-render override (new "Pronounce names like" UI field). **SYSOI's 3 profiles seeded** `{ "SYSOI": "Sis-Oy" }`.

#### Deploy status
- ✅ **`forge-reels` redeployed 2026-06-11** — the Fit/timing template is live (see the 2026-06-11 block above). Pronunciation (#336) was server-side only, no deploy needed.

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
