# Forge Intelligence — Context Hub → Brain Pipeline (Technical Reference)

> Portable reference for how Forge compiles a brand from raw website scrape into
> a structured intelligence profile, strategy, and content brief — and how the
> brain compounds. Source: `server.js` (the monolith) + `src/agents/*/system_prompt.md`.
> Line numbers are approximate (the file moves) — grep the function/endpoint names.

---

## 0. Mental model

Forge is an **8-stage Context Agent Architecture**. Each stage conditions the
next. This doc covers the first three (the "brand brief + strategy" path) plus
the feedback loop (Stage 8) that makes the whole thing compound:

```
Stage 1  Context Hub            scrape → brand intelligence profile
Stage 2  GEO Strategist         profile → topical opportunities (cherry-pick)
Stage 2.1 Topic Brief Builder   one opportunity (or typed topic) → content brief
Stage 3  Authenticity Enricher  brief → E-E-A-T-injected enriched brief
Stage 4  Content Generator      enriched brief → article
...
Stage 8  Brain Memory           published-content analytics → brain_patterns / brain_mistakes
                                 ↑ feeds back into Stages 1, 2, 2.1, 4
```

The **brain** is two Postgres tables (`brain_patterns`, `brain_mistakes`) scoped
per `brand_profile_id`. Every stage reads them as context; Stage 8 writes them.
That read-everywhere / write-from-performance loop is the moat.

Models in play: **Claude Opus** (Stage 1 profile synthesis — highest quality),
**Claude Sonnet 4.6** (Stage 2 tools, Stage 2.1 briefs, Stage 4 articles),
**Claude Haiku 4.5** (cheap brain ops — pattern extraction, topic checks).
Perplexity **Sonar** for competitor/ICP web research in Stage 1.

---

## 1. Stage 1 — Context Hub (scrape → profile)

**Endpoint:** `POST /api/context-hub/analyze` (softAuth — works anonymous or signed-in)
**Body:** `{ brandUrl, competitorUrls?, audienceNotes?, strategicNotes?, checkBrainFirst?, saveToBrain? }`

### 1.1 Flow

1. **Validation + cache check.** Validates domain format. If `checkBrainFirst`,
   looks up an active `brand_profiles` row for the URL. Cache is **claim-gated**:
   returns cached data only to the owning account (`clerk_user_id` match) or the
   originating anonymous session (`onboard_session_id` match, within a 24h TTL).
   Everyone else gets a `409` (`owned_by_account` / `reserved_by_other_session`).

2. **Tool 1 — Perplexity Sonar research.** Web-researches the brand to discover
   competitors, ICP, market category, differentiators, content themes. Output is
   merged context (manual `competitorUrls` override the auto-discovered ones).

3. **Tool 1.5 — Website scrape** (the heart of it; see §1.2). Fetches homepage +
   up to 8 high-signal subpages, concatenates per-page markdown (20 KB/page,
   100 KB total cap) into `siteContentSection`.

4. **Brain injection.** If the brand was analyzed before, the top 5
   `brain_patterns` and top 3 `brain_mistakes` are injected into the prompt as
   `PRIOR PERFORMANCE PATTERNS` / `CONTENT MISTAKES TO AVOID`.

5. **Tool 2 — Claude Opus profile synthesis** (see §1.3). One big prompt →
   structured JSON profile. Two-attempt parse with newline-repair fallback.

6. **Persist.** UPSERT into `brand_profiles` (UPDATE-in-place if the URL exists,
   preserving UUID + `strategic_injections` + `manual_overrides`; INSERT if new).
   Version increments on every re-scan. Anonymous scans get a 24h `expires_at`.

### 1.2 The scrape primitives (the "scrape" half)

Three layered functions. **Read the comments — they encode hard-won failure modes.**

#### `forgeScrape(url, opts)` — the one scrape primitive

Two-tier Bright Data cascade. Returns `{ success, status, html, source, latencyMs, error }`.

```
Tier 1: Bright Data Web Unlocker  (cheap, fast, returns HTTP response)
Tier 2: Bright Data Scraping Browser  (puppeteer-core CDP over WebSocket;
        real browser that JS-renders) — auto-fallback when Tier 1 returns
        an SPA shell OR fails entirely.
```

- `render: 'auto'` (default) — Unlocker, fall back to Browser on SPA shell.
- `render: 'always'` — skip Unlocker, go straight to Browser (known JS-heavy site).
- `render: 'never'` — Unlocker only.
- SPA-shell detection (`looksLikeSpaShell`): regex for empty `<div id="root|__next|app|svelte|nuxt">` + a fallback heuristic (body content < 500 chars after stripping scripts/styles).
- Tier 2 waits for **article-shaped content** (`h1` with >10 chars + ≥3 `<p>`), not just any DOM — the old "root has children" heuristic fired before the article body rendered and returned 10 KB shells.
- Tier 2 blocks images/css/fonts/media via request interception (~70% bandwidth cut; Scraping Browser is bandwidth-billed).
- Every attempt logs to `scrape_log` (Tier 1 and Tier 2 as separate rows) with a `body_sample` for audit.

Env: `BRIGHTDATA_API_KEY`, `BRIGHTDATA_UNLOCKER_ZONE`, `BRIGHTDATA_BROWSER_AUTH`
(Browser auth optional — if absent, Tier 2 is skipped).

#### `getBrandPageContent(url, opts)` — page → clean markdown

Two-tier, sits **above** forgeScrape:

```
Tier A: Jina Reader (r.jina.ai/<url>)  — semantic markdown w/ built-in JS render.
        Header X-With-Links-Summary:true appends a "Links/Buttons:" section so
        SPA nav links (pricing, blog, demo) survive readability extraction.
        Usable threshold: >500 chars.
Tier B: forgeScrape → Mozilla Readability + Turndown (htmlToMarkdown).
        For sites Jina can't reach (rate-limit, geo-block, failure).
        Usable threshold: >200 chars.
```

#### `discoverSubpages(baseUrl, max=8, {seedMarkdown, seedHtml})`

Finds up to 8 brand-defining subpages. Priority order:

1. **sitemap.xml** (follows `<sitemapindex>` to first child).
2. **seedMarkdown** — parse `[text](url)` from already-fetched Jina home markdown (zero extra latency).
3. **seedHtml** — parse `<a href>` from already-fetched home HTML.
4. **Last resort** — forgeScrape the homepage just for links (tight 20s timeout).

`rankBrandPages()` scores discovered URLs: HIGH (`/about|story|mission|team|company|why-us`) = 3,
MED (`/product|service|customer|case-stud|pricing|integration|faq|how-it-works|solution|platform`) = 2,
everything else = 1. Skips auth/legal/noise paths and non-page asset extensions.
`extractAnchorHrefs` is anchor-only (the naive `/href="..."/` regex scooped up
stylesheet/favicon/font URLs as fake "subpages").

### 1.3 The profile synthesis prompt (Stage 1 Tool 2)

Model: `claude-opus-4-6`, `max_tokens: 8192`. Single user message. Prompt skeleton:

```
You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

Analyze the brand at: {brandUrl}
{siteContentSection}      ← ACTUAL WEBSITE CONTENT (scraped — primary source, do NOT guess from domain)
{competitorSection}       ← Sonar competitor URLs
{icpSection}              ← Sonar ICP
{marketSection}           ← Sonar market context
{audienceSection}{strategicSection}   ← user notes
{patternSection}          ← PRIOR PERFORMANCE PATTERNS (from brain, if rescan)
{mistakeSection}          ← CONTENT MISTAKES TO AVOID (from brain, if rescan)

Return ONLY valid JSON (no markdown, no newlines inside string values):
{
  "brandName": "...",
  "voiceProfile": { summary, toneAttributes[5]{attribute,score,description},
                    writingStyle, keyPhrases[], industry, positioning,
                    targetPersona, visualStyle, accentColor },
  "personas": [2-3 {id,name,role,painPoints[],triggers[],skepticism,motivations[]}],
  "thirdPartySignals": [4-6 {source,signalType,value,confidence,lastChecked}],
  "competitiveGaps": [3-5 {topic,ownedBy,whitespaceOpportunity,priority}],
  "strategicMoats": [0-4 {capability,rationale,protects}],
  "strategicRecommendations": [4-6 {id,category,title,description,impact,effort}],
  "campaignArcs": [2-4 {id,title,thesis,acts[{actNumber,actTitle,actPremise}],
                        recommendedLength,targetPersona}],
  "businessProfile": { whatTheyDo, productsOrServices[], revenueModel,
                       targetBuyer, companyScale, geography },
  "discoveredCompetitors": [...],
  "marketCategory": "..."
}
```

**Key prompt design decisions (worth replicating):**
- **competitiveGaps vs strategicMoats distinction is explicit.** A "gap" is a real
  missed opportunity. A "moat" is something the brand *deliberately does NOT do*
  (planning-only, no commissions, no long-term contracts). The prompt instructs
  the model not to mislabel deliberate exclusions as gaps. This prevents Stage 2
  from suggesting topics that contradict the brand's positioning.
- **campaignArcs are narrative series, not topic lists** — "think of each arc as a
  season of television: a single argument told across multiple acts with payoff."
- **visualStyle + accentColor feed Flux hero-image generation** downstream, so the
  prompt asks the model to infer them carefully from site aesthetic.
- `thirdPartySignals.lastChecked` is **overwritten server-side** with the actual scan
  time — the LLM has no date awareness and hallucinates dates from its training prior.

### 1.4 Persistence model

`brand_profiles` (the SSOT). Key columns: `id` (UUID), `brand_url` (unique-active),
`brand_name`, `version` (increments per scan + per factualGround save),
`profile_data` (JSONB — the whole synthesized profile), `settings` (JSONB — holds
`factualGround`, `scrapeUrlOverride`), `clerk_user_id`, `onboard_session_id`,
`expires_at`, `is_active`, `cache_status`.

**Rescan preservation:** UPDATE-in-place keeps the UUID (all downstream content
tables FK to it). `strategic_injections` (append-only) and `manual_overrides`
(top-level keys overwrite synthesized fields) survive rescans so customer
corrections aren't wiped.

---

## 2. Stage 2 — GEO Strategist (profile → opportunities)

**Endpoint:** `POST /api/geo-strategist/analyze` (requireAuth)
**Body:** `{ brandProfileId, topicFocus?, additionalContext?, force? }`

Loads the Stage 1 profile + brain. Runs **three Sonnet tools in sequence**, then
persists opportunities for **user cherry-picking** (no auto-brief — see §2.2).

### 2.1 The three tools

All three are `claude-sonnet-4-6`, each a single user message returning a raw JSON array.

**Tool 1 — Topical Authority Mapper** (`max_tokens: 4000`)
Inputs: brand, personas, competitor topics, whitespace, `topicFocus`,
`factualGroundBlock`, `strategicMoatsBlock`. Identifies 8-12 topical gaps where
the brand has low AI-citation probability vs competitors.
> Output: `[{topic, geoCitationScore, owner, rationale}]`
> Hard constraint: topics must be consistent with user-verified facts and must
> NOT fall inside strategic moats (intentional exclusions, not opportunities).

**Tool 2 — GEO Opportunity Scorer** (`max_tokens: 3000`)
Takes Tool 1's top-10 gaps. Scores citation probability 0-100 across the 4 AI
platforms (ChatGPT, Perplexity, Google AI Overviews, Gemini). `quickWin=true`
when score ≥ 70 and low brand presence.
> Output: `[{platform, topic, score, quickWin}]`

**Tool 3 — Entity & Schema Mapper** (`max_tokens: 3000`)
Identifies entities needing structured markup for AI citation; flags competitor
entities the brand isn't cited for.
> Output: `[{entity, schemaTypes[], competitorCiting, priority, rationale}]`

### 2.2 Cherry-pick architecture (important design choice)

Stage 2 does **NOT** auto-generate briefs. It dedupes opportunities by topic
(merging per-platform scores), then persists each into `geo_opportunities` with
`status='discovered'`, an `avg_score`, `platform_scores`, and a
`discovery_session_id` grouping the run. Unpicked opportunities stay as **brain
food** ("user did NOT pick this" is signal). **Ignore-propagation:** if a new
opportunity is a near-duplicate (pg_trgm trigram similarity ≥ 0.55, or substring
match) of one the user previously ignored, it inherits `status='ignored'` so
dismissed topics don't resurface under renamed variants.

The legacy `geo_briefs` row is kept as a stub for backward-compat; the real
architecture is `geo_opportunities` + `geo_topic_briefs`.

---

## 3. Stage 2.1 — Topic Brief Builder (opportunity → brief)

Two entry points, identical output shape:

1. **From cherry-pick:** `POST /api/geo/opportunities/build-briefs` — runs the
   builder over user-selected opportunity IDs in parallel.
2. **From typed topic:** `POST /api/geo/topic-brief/from-topic` — the user types a
   topic (no GEO run required). Materializes a **synthetic `geo_opportunities`
   row** (so the `geo_topic_briefs.opportunity_id` FK holds) then runs the same
   builder.

### 3.1 The brief builder prompt

Model: `claude-sonnet-4-6`, `max_tokens: 6144`. Skeleton:

```
{dateContext()}
You are the Topic Brief Builder (Stage 2.1) for Forge Intelligence.

BRAND: {brand_name}
VOICE: {voiceProfile, 400 chars}
PERSONAS: {personas, 400 chars}
{FACTUAL GROUND (use verbatim) — whatWeDo / whatWeDontDo / methodology}
{BRAIN PATTERNS (respect these) — top 20 by recency}

TOPIC THE USER ENTERED: "{topic}"
{USER REFINEMENT / ANGLE NOTES (optional)}

Build a GEO-optimized content brief for THIS SPECIFIC TOPIC. Return ONLY valid JSON:
{
  "h1": "...",
  "executiveSummary": "...",
  "h2s": [{heading, intent, geoAnchor}],   ← 5-7, build a coherent argument
  "entities": [...],
  "faqStructure": [{question, answerDirection}],
  "geoAnchors": [...],
  "schemaRequirements": [...],
  "targetPlatforms": [...],
  "briefRationale": "why this angle, for this brand, now"
}
```

Off-strategy topics are built anyway but the tension is flagged in `briefRationale`.
Persisted into `geo_topic_briefs` with `status='briefed'`, embedding an
`assignedAuthor` snapshot when one is set.

---

## 4. Stage 3 — Authenticity Enricher (brief → enriched brief)

**Endpoint:** `POST /api/authenticity-enricher/analyze` (requireAuth, SSE-streamed)
**Body:** `{ brandProfileId, geoBriefId?, topicBriefId?, manualInputs?, force? }`

Brain-first (loads top-10 patterns/mistakes). Loads the topic brief
(preferred), legacy GEO brief, or latest brief. Injects E-E-A-T signals
(experience, expertise, authoritativeness, trustworthiness): SME credentials,
first-party evidence, author schema, FAQPage structure, power phrases. Output is
an `enriched_briefs` row that Stage 4 consumes. Skips cache when enriching a
specific topic brief (different topics need different enrichment). Arriving at
the page with `?topicBriefId=X` auto-fires enrichment.

---

## 5. The brain — read everywhere, written by Stage 8

### 5.1 Tables

```sql
brain_patterns (
  id UUID, brand_profile_id TEXT, pattern_type VARCHAR(100), description TEXT,
  confidence_score FLOAT, success_rate FLOAT, tags JSONB, created_at, updated_at
)
brain_mistakes (
  id UUID, brand_profile_id TEXT, mistake_type VARCHAR(100), description TEXT,
  human_feedback TEXT, guardrail_created TEXT, severity VARCHAR(20), created_at, updated_at
)
```

### 5.2 Write-back (Stage 8 — pattern extraction)

A pattern-extraction endpoint pulls per-channel published-content analytics
(impressions, clicks, CTR, reactions, reading time), summarizes top-10 and
bottom-5 performers, and asks **Claude Haiku 4.5** to extract patterns + mistakes:

```
Return ONLY a JSON object:
{
  "patterns": [{pattern_type, description, confidence_score (0-1), tags[]}],  ← 3-6
  "mistakes": [{mistake_type, description, severity (high|medium|low)}]       ← 2-4
}
Focus on content type, topic, channel, format, timing patterns.
```

Written to `brain_patterns` / `brain_mistakes` (`ON CONFLICT DO NOTHING`).
There's also an **external-editor** path: when a human edits a published draft,
the delta is captured as a `brain_mistake` (with `human_feedback` + the original
as evidence) and reusable wins as `brain_patterns`.

### 5.3 Where the brain is read (the compounding surface)

| Stage | How it uses the brain |
|-------|----------------------|
| 1 Context Hub | Injects top-5 patterns / top-3 mistakes into profile synthesis on rescan |
| 2 GEO Strategist | `brainContext` (top-10 patterns + mistakes) conditions topical mapping |
| 2.1 Brief Builder | Top-20 patterns injected as "respect these" |
| 3 Enricher | Top-10 patterns/mistakes seed E-E-A-T injection |
| 4 Content Generator | Top-8 patterns / top-5 mistakes as hard tone/angle/format constraints |
| topic-check (preflight) | Haiku scores a typed topic vs the brand's patterns/mistakes |

`brand_profiles.version` is the brain version. Stages cache against it: a brief
built on brain v3 is invalidated when the brand reaches v4 (rescan or
factualGround save).

---

## 6. Factual Ground — the human override layer

Stored at `brand_profiles.settings.factualGround` (JSONB). Customer-entered
ground truth: `whatWeDo`, `whatWeDontDo`, `companyFacts`, `methodology`,
`foundingStory`, `teamComposition`, `quotablePositions`, `authors[]`,
`competitors[]`. **It OVERRIDES scraped/inferred data.** Every generation stage
that touches brand claims injects it verbatim with the rule "NEVER hedge on what
is stated here — these are facts, not suggestions." Saving it bumps
`brand_profiles.version` (a meaningful brain update).

---

## 7. End-to-end data flow (one diagram)

```
brandUrl
   │
   ▼ Stage 1: Sonar research + getBrandPageContent×N (Jina→forgeScrape) + Opus synthesis
brand_profiles.profile_data  (+ settings.factualGround, human override)
   │
   ▼ Stage 2: 3 Sonnet tools (topical map → opportunity score → entity map)
geo_opportunities  (status: discovered | ignored | briefed)   ← user cherry-picks
   │
   ▼ Stage 2.1: Sonnet brief builder (per selected/typed topic)
geo_topic_briefs.brief_data
   │
   ▼ Stage 3: Sonnet E-E-A-T enrichment
enriched_briefs.enriched_data
   │
   ▼ Stage 4: Sonnet article generation (per-section confidence)
generated_content_<brandUUID>.article_json
   │
   ▼ Stages 5-7: compliance → publish → analytics
   │
   ▼ Stage 8: Haiku pattern extraction from analytics
brain_patterns / brain_mistakes   ──┐
   ▲                                 │ read by every stage above
   └─────────────────────────────────┘  (the compounding loop)
```

---

## 8. Key files / symbols to grep

| Concern | Symbol / endpoint |
|---------|-------------------|
| Stage 1 orchestration | `app.post('/api/context-hub/analyze'`  |
| Scrape primitives | `forgeScrape`, `getBrandPageContent`, `discoverSubpages`, `rankBrandPages`, `htmlToMarkdown` |
| Stage 2 | `app.post('/api/geo-strategist/analyze'` |
| Stage 2.1 | `app.post('/api/geo/topic-brief/from-topic'`, `/api/geo/opportunities/build-briefs` |
| Stage 3 | `app.post('/api/authenticity-enricher/analyze'` |
| Stage 4 prompt | `src/agents/stage4_content_generator/system_prompt.md` |
| Brain write-back | pattern-extraction endpoint (Haiku), `INSERT INTO brain_patterns` |
| Topic preflight | `app.post('/api/content/topic-check'` |
| Brain schemas | `CREATE TABLE ... brain_patterns / brain_mistakes` |

Prompts for Stages 1, 2, 2.1, 3 are **inline in server.js** (not in
`src/agents/`). Only Stages 4, 4.5 (social), 4.6 (email), 4.7 (ads campaign),
and 5 (compliance) have externalized `system_prompt.md` files.
