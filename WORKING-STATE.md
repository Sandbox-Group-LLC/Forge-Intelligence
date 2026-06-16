# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `PLAN.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `PLAN.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-06-16 — Closed-world grounding guardrail (anti-confabulation)

A published SYSOI article (`field-event-attribution…`) recommended an attribution model SYSOI doesn't offer (W-shaped), named a competitor (Cometly), and dumped pricing without terms. Root cause traced: the article faithfully echoed a **polluted brand profile** (`profile_data.voiceProfile` literally said *"openly names competitors, publishes real prices"*; pricing baked in bare), while the strong **Factual Ground** guardrail was **NULL for SYSOI** (so inert), and even when present it only says "don't *contradict*" — not closed-world.

- **Fix (this PR):** added an **unconditional closed-world GROUNDING rule** to both generation user-prompts (`server.js` content-generator + `src/server/routes/campaign.js`): ground every concrete claim in Brand Profile / Factual Ground / briefs; do NOT introduce prices, named competitors, named methodologies/models, stats, customers, case studies, dates, credentials, or product names not present; never a bare price (always with terms); never name/disparage competitor products. Applies even when Factual Ground is empty (the SYSOI case).
- **Done out-of-band (DB):** SYSOI brand `profile_data` de-polluted (competitor-naming voice directive removed; pricing now carries terms). The live article + Forge source `article_json` were corrected to SYSOI's real models (multi-touch time-decay 180d + last-touch).
- **Next:** populate SYSOI's `settings.factualGround` (now that it'll be obeyed); confirm the facts-UI writes to `factualGround` for every brand; consider a pre-publish fact-gate on the `compliance/precog` path.

---

### 2026-06-12 (cont. 3) — Evening: docs race fixed, Opus truncation, UI copy, generation-surface sweep

All merged to `development` same evening.

- **#371 docs-race reconcile** — a parallel session double-wrapped its docs (into `development` via #366 AND directly onto `main` via 764aa6a) and #367's update-branch merge clobbered the SYSOI-reel block out of WORKING-STATE. Merged main back into development, restored block ordering, made development a strict superset. Lessons: never commit docs directly to main; eyeball WORKING-STATE when two sessions wrap the same day (GitHub's auto-merge picks a side silently).
- **#372 Context Hub truncation** — triple `[safeParseLLM] TOTAL FAILURE` on SYSOI re-scan = Opus hitting `max_tokens: 8192` mid-profile (richer post-#353 input → longer output). Fixed: 8192→16384, `stop_reason` logging, `closeTruncatedJson` salvage. Verified first-pass on SYSOI v8 (~262s scan — the +2min vs last month is the competitor crawl + bigger Opus profile, accepted).
- **#374 stage 1-3 UI copy** — descriptions caught up to the measured pipeline; GEO progress display gained a "Live Citation Probe" stage with the longest slot (it was parking on "Generating GEO Brief" through the entire probe).
- **#375/#376/#377 generation-surface sweep** (Campaign/Social/Ads) — every surface audited fetched-vs-applied; every surface upgraded with measured blocks (probe/crawl/cluster+info-gain territories). Real bugs found: Campaign's `territoriesBlock`+`factualGroundBlock` were **dead variables** (articles shipped without writer-level Factual Ground); Ads' VOICE block rendered empty since shipping (wrong key `voice_profile` + nonexistent schema fields) and persona pain read `pain_points` vs the schema's `painPoints`. Social was cleanest; its arc regen gained Factual Ground ("never stake a thesis the brand contradicts") + brain + probe. Ads gained MEASURED SEARCH INTENT (invisible probe questions = literal buyer queries → keywords/headlines).
- **product-video-creation skill v3** (external package, delivered as zip) — rewritten from the generic scaffold-your-own-Remotion flow (which sent a session rogue) to the real DataReel architecture: one composition, closed 19-archetype scene vocabulary, buildBrand identity, EL-primary TTS, audio-driven timing; infra endpoints/env names deliberately omitted.

#### What's next
- **Generation validation on dev:** one campaign article + one social batch + one ad pack on a probed brand — confirm the new blocks land (ads: voice/persona populated for the first time; keywords mining invisible questions).
- (Carried) dev validation of the pipeline arc · phase 2 precog (#368, wk of 07-13) · `remotion deploy-site` · `ADMIN_RELAY_PASSWORD` rotation · `development → main` promotion (now carrying 20+ PRs).

---

### 2026-06-12 (cont. 2) — Full-pipeline audit: every stage reads the measured layer

All merged to `development` same day. Continued the stage-by-stage "is it fetching AND applying?" audit through the whole pipeline; every stage failed it; every stage fixed. (Shipped via the Composio GitHub connection for part of the arc — this session's native GitHub MCP auth broke mid-day, served a Google Drive turndown page from its OAuth flow [reported to Anthropic], then self-healed.)

- **#359 Tool 3 (Entity & Schema Mapper)** — was blind to all of #351/#353: 400-char truncation, no probe (despite `competitorCiting` being literally what the probe measures), no crawl, ~2 topics of context. Now gets full gaps (w/ cluster + info-gain), both measured blocks, grounding rules (observed cited domains drive `competitorCiting`).
- **#361 Stage 3 (Authenticity Enricher)** — the leakiest stage: brain tables loaded but reached ZERO prompts; E-E-A-T scorer judged authenticity from 1,200 chars total; probe/crawl/moats invisible. Five context blocks injected across Tools 2-4 (brain finally applied; injections target who-AI-cites-instead + the topic's info-gain angle; authoritativeness scored vs crawled competitor claims); caps lifted ~3-4×; `from-topic` route gained `assignedAuthorId` parity (batch path was verified NOT broken).
- **#363 Stage 4 + Compliance + Precog** — writer: `citationProbe` was inside the char-level `trimTo(geoBrief,4000)` (random truncation), crawl/moats never extracted → three explicit blocks ("write the piece the incumbents would have to cite" / "write what they demonstrably cannot say"); territories now carry cluster + info-gain angle from the RAW gaps (the normalized map drops both). Compliance: Factual Ground as two-way ground truth (verified claims un-flagged; contradictions = RED naming the violated fact). Precog: geo-match dimension only saw `strategic_injection%` rows — **cherry-picked Strategist topics scored 0 by construction**; now includes `selected`/`briefed` (same 0-7 scale, no re-base).
- **#365 Precog shadow dimension (phase 1)** — `measuredVisibilityShadow` (0-10, `includedInScore:false`): invisible-question overlap + brand visibility gap + validated-whitespace-with-probe, from the brand-level citationProbe. Score byte-identical to v2; signal accumulates per scored article. **Phase 2 = issue #368** (correlate shadow vs `precog_outcomes` + `geo_citations`; analysis-only, target **week of 2026-07-13**, prerequisite ~15+ outcome-bearing articles). **Phase 3 = issue #369** (promote as explicit v3.0 model with `model_version` stamp + segmented accuracy tracking; target **week of 2026-07-27**, hard-gated on #368's verdict — not-predictive closes it as not-planned).

#### What's next
- **Dev validation across the arc:** re-scan a brand → force GEO analyze → build brief → enrich → generate → compliance → precog-score; check each stage's new blocks/log lines land (validation steps per PR body).
- **Phase 2 precog correlation** once enough scored articles have outcomes (relay analysis, no deploy).
- Unaudited remainder: Stage 6 Publishing · Stage 7→8 (does Brain pattern extraction see the citation tracker's measured results? "what got cited" should feed "what we learned").

---

### 2026-06-12 — SYSOI product reel · DataReel round-trip hardening (#347, #370 — merged)

Built the 60s SYSOI product video **with DataReel rendered locally** (no Lambda), which forced template gaps closed — shipped via **#347 + #370 (both merged 2026-06-12; #370 went directly to `main`, reconciled back into `development` the same day)**:

- **`ScreensScene.motion: "static" | "dynamic"`** — default unchanged (static, per #344's no-Ken-Burns rule). `dynamic` = 3D fly-in, one hard 6-frame punch-in per shot that holds, slide-over spring transitions. Brian's review killed an earlier sheen-sweep ("diminishes the product").
- **`ScreensScene.shotAspect`** — viewport matches the capture's native ratio (SYSOI captures are 2940×1414 ≈ 2.08:1; the hardcoded 16:9 cropped both edges). Dynamic card: wider (1640) + brand-accent outer glow.
- **`brand.wordmark`** — full lockup image replaces the TYPED brand name in the Stage corner + CTA title (system font butchers custom wordmarks).
- **`assetSrc()`** — `shots`/`logo`/`music.src` accept bare filenames via `staticFile()` (audio's convention); https URLs pass through, Lambda path untouched.
- **`onAccent` palette key** — dark-ink text on light accents (SYSOI amber); replaces hardcoded white on CTA button / statement / pipeline highlight / orbit core / steps / checklist.
- **PipelineView** — rounded squares → auto-width pills with accent outer glow (the squares clipped their labels).
- **VO via Composio ElevenLabs** (key wasn't in the SYSOI session env): Charlie/`verse`, stability 0.35 / style 0.6, mp3_44100_128 → exact seconds = bytes/16000. **Music**: `scripts/sysoi-music.mjs`, original CC0 driving bed (122 BPM, sidechained).
- `sysoi-reel.props.json` + `public/shots`/`audio` committed = reproducible example. Rendered both cuts (16:9 1907f/63.6s + 9:16 portrait — zero layout changes needed); Brian approved. Renders gitignored (`remotion/.gitignore`: `out/`, generated wav).
- **Audio-silent false alarm**: the mp4's AAC track was healthy (max −6.8 dB via `@ffmpeg-installer/ffmpeg` volumedetect — npm-packaged binary, no system ffmpeg); chat inline preview plays muted.

#### What's next
- **Redeploy `forge-reels`** (`cd remotion && npm run deploy-site`) so Lambda picks up the merged template changes (#344 static screens + #347/#370 dynamic mode) — ONE redeploy covers all of today's template work.
- Decide where the rendered mp4s live (SYSOI repo `marketing/`?) — currently container-only.
- Backend storyboard agent doesn't emit `motion`/`shotAspect`/`wordmark` yet — wire when a productized reel should use them.

---

### 2026-06-12 (cont.) — GEO overhaul: measured whitespace, not priors

All merged to `development`. Sprung from a gap analysis against an external GEO skill (Princeton KDD 2024) + a depth trace of the competitive-intel pipeline (verdict: whitespace was pure LLM inference over 700 chars of cached Stage 1 data; competitor sites never crawled; geoProbe unused by the Strategist).

- **#348 citability mechanics + engine-aware scoring** — Stage 4 system prompt gained a "Citability mechanics (GEO)" section (statistical/factual anchors, real-people-only expert quotes via Factual Ground authors, definition blocks, 40-55 word direct answers under question H2s, numbered steps); Tool 2 scores each platform per-engine (ChatGPT authority · Perplexity freshness/community · AI Overviews E-E-A-T long-tail · Gemini brand-domain) instead of a uniform rubric.
- **#349 pipeline description refreshed** — canonical 8-stage copy now lives as a standing "do not archive" section at the bottom of this file.
- **#351 Tool 1 measured citations** — `/analyze` Step 1.5 probes the 4 real engines (`coldScan`) with 8 generated brand-free buyer questions; Tool 1 receives visibility %, per-engine rates, who-AI-cites-instead, and the invisible questions as ground truth. Truncation killed (400/300 → 4000/2000/1500 chars). Gaps now carry `cluster` (pillar grouping) + `informationGainAngle` (no original angle = scored down) — both additive. Tool 2 anchors on the measured baseline; probe persists on `brief_data.citationProbe`. Best-effort: no engine keys → old inference-only path.
- **#353 competitor crawl (Stage 1 Tool 1.6)** — up to 4 competitor homepages crawled via `getBrandPageContent`, Haiku extracts measured positioning/topics/claims, Opus grounds `competitiveGaps` in it, persists `profile_data.competitorAnalysis`; GEO Tool 1 reads it as COMPETITOR SITE COVERAGE (measured outranks inferred).

#### What's next (GEO)
- **Validate on dev:** re-scan a brand (fills `competitorAnalysis`), then `force: true` analyze — expect `[GEO] Probe: visibility N% …` + `[Context Hub] Tool 1.6: analyzed N/M…` log lines, `cluster`/`informationGainAngle` on gaps, `citationProbe` on the brief row. Existing brands need a re-scan before competitor coverage appears.
- Cost note: uncached analyze +1 Sonnet call + ≤8×4 engine probes (~one public cold-scan); Stage 1 re-scan +15-25s.
- Tier-2 backlog from the review: per-article JSON-LD at publish · internal-link/cluster awareness in Stage 2.1 briefs · sameAs entity strategy · site crawlability (llms.txt / AI-bot access) probe · freshness re-audit loop · off-site mention strategy (Ahrefs: brand mentions ~3× backlinks for AI visibility).

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

---

## Pipeline description (standing section — canonical copy, do not archive)

Forge runs an 8-stage Context Agent Architecture where every stage conditions the next. By stage four, the writer isn't writing from a prompt, it's writing from a fully constructed competitive worldview.

1. **Context Hub** — crawls the brand site, extracts voice profile, personas, competitive set, strategic moats, and topical territories. Jina Reader first, falls back to Bright Data Web Unlocker, then Bright Data Scraping Browser for SPAs; sitemap-aware parallel crawl. Captures the brand's visual identity (accent color, logo) straight from the live site's computed CSS. Competitor discovery is Sonar-grounded in the actual scraped content, and the human stays in command: Factual Ground (user-verified facts about what the brand does, doesn't do, and who it actually competes with) and pinned manual overrides survive every re-scan and bind every downstream stage. Outputs the Brand Profile.

2. **GEO Strategist** — maps topical authority gaps competitors haven't claimed, constrained by Factual Ground and strategic moats so it never pitches topics the brand has deliberately walked away from. Scores every opportunity per engine against what that engine actually rewards: ChatGPT (authority and entity recognition), Perplexity (freshness and community signal), Google AI Overviews (E-E-A-T on long-tail questions), Gemini (brand-owned domains). No auto-brief: opportunities land in a table, the user cherry-picks, and Stage 2.1 builds a full per-topic brief for each selection — H1/H2 structure with citation anchors per section, FAQ structure, entities, schema requirements, target platforms, and an assigned SME author snapshotted into the brief. Unpicked topics stay behind as brain food, and dismissed topics propagate: a near-duplicate of something the user already ignored arrives pre-ignored.

3. **Authenticity Enricher** — injects E-E-A-T signals (experience, expertise, authoritativeness, trustworthiness) into the brief: SME credentials from the brand's named author roster, first-party evidence, author schema, FAQ structure, power phrases. Pulls from Brain patterns, Factual Ground, and live competitor signal.

4. **Content Generator** — writes long-form articles voice-matched to the brand, GEO-optimized, with per-section confidence scoring (green/yellow/red). Built citable by construction: a mandatory TL;DR block shaped for LLM extraction, standalone FAQs, statistical and factual anchors (exact tools, dates, versions — never invented), definition blocks for core terms, direct 40-55-word answers under question-form headings, and expert quotes gated to real people from the author roster — a quote it can't source becomes an SME placeholder, never a fabrication. Human-cadence rules strip the AI tells. When the brand's own documented outcomes are the evidence, it says so plainly instead of hedging. Streams via Claude Sonnet 4.6; hero image generated via Flux in parallel.

5. **Compliance Gate** — critiques every draft before it ships. Flags fabrications, unsupported claims, brand-voice drift, and missing citations — then goes further: a citation agent (Perplexity Sonar) finds real supporting sources for flagged claims using a source-quality hierarchy (peer-reviewed and primary sources first, content farms blocked), and a verify-and-rewrite flow integrates the citation or softens the claim when no source exists. Every human edit, rewrite, and dismissed false positive is captured. Reviews are approve-to-ship by default.

6. **Publishing Queue** — schedules and distributes across channels: My Website (self-hosted webhook with FAQ schema on the receiving end), LinkedIn, Facebook, X, Reddit, HubSpot CMS, Webflow CMS, the brand's own custom domain, email. Logs IndexNow pings, UTM tracking, per-channel metadata.

7. **Performance Dashboard** — pulls real engagement data back from each surface (analytics, social, indexation). Sourced from the platforms' own APIs, not estimated. Now includes a live Citation Tracker that probes four real AI engines — ChatGPT, Perplexity, Gemini, and Google AI Overviews — and records whether the brand was actually cited, per question, per engine. Precog predicts each article's citation probability across eleven scoring dimensions before publish, then checks its own predictions against measured outcomes.

8. **Brain Memory** — extracts patterns from what performed and mistakes from what underperformed, plus everything the humans taught it along the way: compliance edits, dismissed flags, rejected topics, verified facts. Writes it all back to `brain_patterns` and `brain_mistakes`. The brain is versioned — when it learns, stale briefs built on the old version are flagged and rebuilt. Every future brief is conditioned by everything that came before.

The same intelligence layer now feeds more than articles: campaign arcs, social posts, Google Ads asset packs, and brand-grounded video reels all generate from the same brain.

The result: each cycle gets smarter than the last. Forge does not generate content from a prompt and a topic. Forge generates content from the brand's own intelligence layer — and that layer compounds with every published article, every human correction, and every measured citation.
