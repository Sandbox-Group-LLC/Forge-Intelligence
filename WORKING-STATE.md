# WORKING-STATE

> **Sonmi-451 2.0 READY (2026-08-11)** — Forge Intelligence agent factory-reset (same treatment as SYSOI). Sessions wiped; model **Grok 4.5**; live only on `agent/forge-intelligence` == `origin/development`; operating brief 2.0. Founder barely used this agent and starts real work tomorrow — board is clean. Prior rampage footgun remains documented in the brief (never raw Neon URL).

---


**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `BUILD-HISTORY.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `BUILD-HISTORY.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

*Latest below; the full accumulated session history lives in `BUILD-HISTORY.md` § WORKING-STATE sessions log.*


---

### 2026-08-05 — Quick Copy P1–P4 merged to development (promote-ready)

**#560–#563 all merged to `development`.** Brian holding a single promote to main.

| PR | Phase | What shipped |
|----|-------|--------------|
| #560 | P1 | Core `/app/quick-copy` + `/api/quick-copy`, Sonnet, variants 1–4, inline claim check |
| #561 | P2 | Soften / Find source / recent prompts / handoff buttons |
| #562 | P3 | Email+Social handoff consumers, `/product` tile, onboarding step |
| #563 | P4 | Mark as used → weak `brain_patterns` write-back |

Docs: `docs/QUICK-COPY.md`. Surface: Stage 4.8 in README when polish lands.

**Not promoting to main until Brian's batch.**

---

### 2026-08-02 — Marketing site (`/` + `/product`) rebuilt on the new "deep blue intelligence" design system → promoted to prod

**Headline: `/` and `/product` are fully rebuilt on a new Claude-Design design system and live in production.** Started as a content sweep of `/product` vs. the working code, became a full re-skin. Six PRs, all merged to `development`, dialed in on dev, then Brian promoted `development → main`.

- **Content sweep first (in #542):** the old `/product` copy under- and mis-sold the app. Fixes: publishing caption claimed **HubSpot** (not a CMS channel — it's CRM sync + a manual email-copy flow; real channels are WordPress/Webflow/LinkedIn/X/Facebook/Reddit/Ghost/Medium per `IntegrationsPage.tsx`); removed the **Agency $499/mo** tier (doesn't exist — only the live `$99` one-time SMB plan); added the missing **Brand Intelligence (6-dimension)** and **One Brain / Every Format** (Campaign 4.5 · Email 4.6 · Ads 4.7 · Social · Video) sections. Copy passed the `ai-writing-detection` skill clean.
- **Design system (Claude Design output) vendored under `src/ds/`** (tokens + components + assets). **Scoped to a `[data-forge-ds]` wrapper** — critical: the DS `base.css` paints `body` navy and its `:root` tokens collide with the app's `--color-*`/`--radius-*`/`--shadow-*`, so unscoped it would repaint the light in-app UI at `/app/*`. Token `:root` blocks + the base reset were rewritten under the wrapper; component CSS is all `.fi-*` class-based. `src/marketing/MarketingShell.tsx` = shared canvas/nav/footer; `src/marketing/marketing-pages.css` = scoped page helpers + review tweaks.
- **Pages** (`src/Landing.tsx`, `src/Product.tsx`) rebuilt as re-skins — **copy unchanged**; Landing's scan flow (domain check, claimed/returning/new states, localStorage resume, redirect) preserved verbatim.
- **Design-review tweaks (dev):** #545 drop section eyebrows + 48px below headlines · #546 center pipeline stage labels under dots · #547 remove "Most intelligence" pricing ribbon.
- **In-app polish + screenshot:** #548 reworked `StrategyIntelPage` **Positioning Pivot** (hero statement w/ accent rail, FROM·Today → TO·The move pill cards + arrow chip, evidence/moves depth, board-slide finale — all in the app's light tokens). #549 wired the real pivot screenshot (`public/brand-intelligence.png`) into the `/product` Brand Intelligence section.

**PRs:** #542 (rebuild + sweep), #545, #546, #547, #548, #549 — all merged → `development`, promoted to `main` 2026-08-02.

**⚠️ Follow-up worth doing:** vendored `src/ds/` (23 components) loads app-wide, so the JS bundle grew to **~1.9 MB / 573 KB gzip** and first paint is a touch slower. **Code-split the marketing DS off the `/app/*` bundle** (dynamic import / route-level split) so in-app users don't download the marketing system. Not urgent, not broken — flagged to Brian.

---

### 2026-07-15 — Brand Intelligence feature RECOVERED from git history (2 PRs) + 3 fixes

**Headline: Brand Intelligence is live on `development` again.** Brian asked to "promote the Brand Intelligence page from the `strategy` branch." It turned out to be a *dead frontend* — its entire backend had been lost. Git forensics: the full 6-deliverable feature (gap-map, blind-spots, whitespace, pivot, shareable brief, compliance gate — 17 `/api/strategy/*` endpoints) was working at commit **`5b1ac6e9c6`** (Apr 19), wiped by `7fd4a9a50e` (a "sync server.js from production" wholesale overwrite), hand-restored once, then lost for good in the `1873bfb` strategy→main rebuild (which restored only STRATEGY.md + the brief frontend). STRATEGY.md still said "Built ✅"; the code was gone. Recovered verbatim from `5b1ac6e9c6` (GitHub still served the orphaned SHA).

- **PR #491 (merged) — backend + schema.** New **isolated module `src/server/routes/strategy.js`** (`/api/strategy`, 15 handlers) — NOT back in the monolith, per the WHITEBOARD post-mortem (a monolith `server.js` is exactly what let a prod-sync wipe this twice; competitive-intel stays inline and falls through). Faithful port: bodies verbatim, only route registration + model (`sonnet-4-20250514`→`sonnet-4-6`) + AI-output `JSON.parse`→`extractJSON`. Two tables (`brand_intelligence`, `brand_intelligence_shares`) reconstructed from handler SQL (DDL was never committed — created ad-hoc in prod) as boot-time `CREATE TABLE IF NOT EXISTS`. Route-inventory snapshot updated.
- **PR #492 (merged) — frontend.** Replaced dev's orphaned 2-tab `StrategyIntelPage` stub with the real **6-tab workspace** (Gap Map · PVA · Fault Lines · Blind Spots · Whitespace · Pivot + Run Compliance + Share Brief) + the token-gated public **`BrandIntelligenceBriefPage`** (`/brand-intelligence/:token`). Wiring: `/app/strategy-intel` route + Sidebar nav ("Brand Intelligence", compass icon) + TopBar titles. `tsc` clean, 199/199 tests.

**Also shipped today (separate merged PRs):**
- **#483** — Authenticity Enricher "Re-run Enrichment" was a dud (`onClick={()=>setResult(null)}` — never called runAnalysis, lost topicBriefId, no force). Now re-runs the current brief forced against the current brain version.
- **#485** — Brand-profile hallucination on scrape failure. Bright Data 200-with-empty-body counted as success + never escalated → invented voice profiles (oooagency.com). Now: empty-body 200 → fail + escalate; embedded-JSON extraction tier for Cargo/Next-style sites; on genuine scrape failure voice/messaging are *withheld* (`insufficientData`), not fabricated.
- **#489** — Publish "Live but no View-post link". A duplicate LinkedIn publish wrote a `staged` shadow row that outranked the real published row in the queue UI. Fixed row selection (published outranks staged), the sync live-status default, and a persistResults clobber guard; repaired the affected article's data in prod.


*(…older sessions → `BUILD-HISTORY.md`.)*

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

