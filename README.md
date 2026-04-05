# Forge Intelligence — Master SSOT

> **This README is the single source of truth for all AI sessions, dev work, and project decisions.**
> Always read this file top to bottom before touching anything.
> Always read WHITEBOARD.md second — it is the active working doc.
> Always read the current file and capture its SHA before writing — never write blind.
> Always commit with a descriptive message using conventional commits (feat:, fix:, refactor:, style:)
> Never give Brian code to run themselves — make the commit directly.
> Render auto-deploys on every push to production — no manual deploy step needed.
> DO NOT narrate or ask Brian to confirm changes.
> URL pattern: frontend routes match product names (e.g. /context-hub, /geo-strategist), API routes follow /api/{product-slug}/

---

## 🚀 Production Launch — April 4, 2026

**forgeintelligence.ai is LIVE.**

| | |
|---|---|
| **URL** | https://forgeintelligence.ai |
| **Dev** | https://dev.forgeintelligence.ai |
| **Branch** | `production` → Render auto-deploy |
| **Price** | $99 one-time via PayPal |

---

## What Is This

**Forge Intelligence** is a premium B2B marketing intelligence platform.

**The core idea:** Every AI content tool solves for production volume. None solve for *compounding content intelligence* — where the system gets measurably smarter and more commercially effective with every publish cycle. That's the gap. That's the product.

**One-liner:** Forge Intelligence turns fragmented marketing activity into clear intelligence and confident action.

**Descriptor:** The intelligence layer behind modern marketing.

---

## Platform Status (April 5, 2026)

### All 8 Stages Live

| Stage | Name | Status | Model |
|-------|------|--------|-------|
| 1 | Context Hub | ✅ LIVE | Claude Sonnet 4.5 |
| 2 | GEO Strategist | ✅ LIVE | Claude Sonnet 4.5 |
| 3 | Authenticity Enricher | ✅ LIVE | Claude Sonnet 4.5 |
| 4 | Content Generator | ✅ LIVE | Claude Sonnet 4.5 |
| 4.5 | Campaign Generator | ✅ LIVE | Claude Sonnet 4.5 |
| 5 | Compliance Gate | ✅ LIVE | Claude Sonnet 4.5 |
| 6 | Publishing & Distribution | ✅ LIVE | Queue + multi-channel |
| 7 | Performance Intelligence | ✅ LIVE | LinkedIn + X + Ghost + GSC + GEO |
| 8 | Feedback Loop | ✅ LIVE | Pattern Extractor (Claude Haiku) |

### Auth Architecture
- **Clerk** — Google, GitHub, email/password
- `isPaid` derived from `activeBrand?.isPaid` — computed, not state
- `GateModal` returns null if `!isLoaded || isSignedIn` — never flashes for authed users
- All gated pages: `if (brandLoading) return null` before gate check
- Auto-marks `is_paid = true` on every Clerk auth in `/api/auth/me`

### Brand Scoping (Critical)
- **Every page** reads `activeBrand` from `useApp()` — the single source of truth for `brandProfileId`
- No page fetches `/api/context-hub/brains` without an auth token
- No page renders a brand picker dropdown (production is single-brand per user)
- All API endpoints that touch brand data require `requireAuth`
- Admin stats scoped to `WHERE clerk_user_id = $1` — no cross-user data

### JSON Parse Hardening
- `sanitizeJson()` — shared top-level utility in `server.js`
- Applied at every LLM JSON.parse call: context agent, content generator (2 paths), campaign plan, campaign articles (×8), compliance critique
- Handles bare newlines/tabs/control chars inside Claude's streamed string values

---

## Infrastructure

| Service | Details |
|---------|---------|
| **Repo** | `github.com/Sandbox-Group-LLC/Forge-Intelligence` |
| **Branch: main** | Development → `dev.forgeintelligence.ai` |
| **Branch: production** | Public app → `forgeintelligence.ai/app/*` |
| **Render (dev)** | `forge-dev` watching `main` |
| **Render (prod)** | `forge-production` watching `production` |
| **Database** | NeonDB `ep-odd-waterfall-akyrdo6x-pooler` — **never revert to ep-cool-firefly** |
| **Auth** | Clerk — org-slug multi-tenancy Phase 2 |
| **Email** | Resend |
| **Images** | fal.ai Flux |
| **CMS** | Ghost Admin API |

### Architecture Rules — Do Not Break
- **Never** use Render env vars `PUT` API — replaces ALL vars. Individual updates only.
- **Never** `git merge main → production` or copy entire files between branches
- **NEON_DATABASE_URL** must stay on `ep-odd-waterfall-akyrdo6x-pooler`
- **requireAuth** on every endpoint that touches brand data
- **sanitizeJson()** is a top-level shared utility — do not re-inline it
- **activeBrand from useApp()** is the only source of brandProfileId — no direct brains fetches from pages
- GitHub Contents API commits require a freshly fetched SHA — stale SHAs fail

### Branch Differences

| Component | Production | Main (Dev) |
|-----------|-----------|------------|
| `TopBar.tsx` | No brand switcher | Multi-brand dropdown |
| `AppContext.tsx` | Single brand, Clerk auth | Multi-brand, isSuperAdmin, allBrands, switchBrand |
| Auth pattern | Clerk + requireAuth everywhere | Same + super admin brian@sandbox-xm.com |

---

## Repo Structure

```
/
├── README.md              ← THIS FILE. SSOT. Read before touching anything.
├── WHITEBOARD.md          ← Active working doc. Session state, pending work, known issues.
├── server.js              ← Express server + all API routes + shared utilities (sanitizeJson, buildImagePrompt, extractJSON)
├── src/
│   ├── context/
│   │   └── AppContext.tsx  ← activeBrand, isPaid, brandLoading — single source of truth
│   ├── hooks/
│   │   └── useActiveBrand.ts ← auth-scoped brand resolution
│   ├── components/
│   │   ├── Sidebar.tsx    ← Nav, Settings group (brand-settings + integrations + admin)
│   │   └── TopBar.tsx     ← Brand pill, avatar dropdown
│   ├── layouts/
│   │   └── AppShell.tsx   ← view-container owns all page padding (48px 40px 96px)
│   └── pages/             ← All stage pages — brandProfileId from activeBrand only
├── public/                ← Static assets, landing page
├── package.json
└── vite.config.ts
```

---

## UI Design System

### 12-Directive System (Non-Negotiable)

1. **Dark foundation** — `#0F1720` base, `#1E293B` cards/panels
2. **Intelligence Blue accent** — `#3563FF` primary CTA, active states
3. **Signal Teal secondary** — `#14B8A6` for positive states, insight signals
4. **Proof Amber highlight** — `#F5B942` sparingly, never dominant
5. **Inter/Geist typography** — strong hierarchy, generous spacing
6. **Slightly rounded corners** — 10–14px radius
7. **Lucide icons** — 1.5 stroke weight, round caps, `currentColor`, consistent across all UI. **No emojis anywhere in the UI.**
8. **Subtle motion** — purposeful transitions only
9. **Grid-based layout** — modular, reusable components
10. **Real product UI** — no abstract decoration
11. **Calm UX** — no noise, no gratuitous animation
12. **Brand continuity** — landing page = app visual language, no seam

### Layout Rule
`view-container` in `WorkspaceLayout.css` owns all page padding: `padding: 48px 40px 96px`.
Page-level CSS classes (`.cl-page`, `.ci-page`, etc.) must NOT add their own padding — they stack and break the layout.

### Sidebar Active States
- Active item: `background: transparent`, `color: var(--color-accent)`, `border-left-color: var(--color-accent)`
- No gradient blobs, no fill backgrounds
- Settings group opens and highlights on `/app/brand-settings`, `/app/integrations`, **and** `/app/admin`

---

## The 8-Stage Workflow

```
[1. Context Hub] → [2. GEO Strategy] → [3. Authenticity Enrichment]
↑                                                      ↓
[8. Feedback Loop] ←— [7. Performance] ←— [6. Publish] ←— [5. Compliance] ←— [4. Generation]
```

### What Each Stage Does

| Stage | Route | Key Output |
|-------|-------|------------|
| 1 | `/app/context-hub` | Brand voice profile, personas, competitive gaps |
| 2 | `/app/geo-strategist` | Topical authority map, GEO opportunities, entity schema |
| 3 | `/app/authenticity-enricher` | E-E-A-T signals, SME injection map, author schema |
| 4 | `/app/content-generator` | Full article (SSE stream), confidence tiers, hero image |
| 4.5 | `/app/campaign-generator` | 8-article campaign plan + generation |
| 5 | `/app/compliance-gate` | AI critique + human refinement → brain_mistakes write |
| 6 | `/app/publishing-queue` | Multi-channel publish, UTM, schedule, Smart Export |
| 7 | `/app/performance` | LinkedIn/X/Ghost/GSC analytics, decay alerts, GEO citations, pattern dashboard |
| 8 | (auto) | Pattern extractor writes brain_patterns + brain_mistakes from analytics |

### Supporting Pages

| Page | Route | Notes |
|------|-------|-------|
| Content Library | `/app/content-library` | Card grid, search, status tabs, preview modal |
| Content Import | `/app/content-import` | URL or paste → Brain audit → Publishing Queue |
| Topic Queue | `/app/topic-queue` | Idea capture, send to generator |
| Brand Settings | `/app/brand-settings` | Identity, BYO domain, site template scraper, billing |
| Integrations | `/app/integrations` | Per-channel credentials, UTM templates |
| Admin | `/app/admin` | KPIs (auth-scoped), reviewer management |

---

## Brain Architecture

Each brand gets isolated storage. Multi-agent shared memory.

```
brand_profiles                  ← voice profile, personas, competitive gaps
generated_content_{uuid}        ← per-brand article table (auto-provisioned)
publishing_queue                ← staged → approved → published
publish_log                     ← channel publish results
content_analytics               ← impressions, clicks, engagement per article
brain_patterns                  ← what worked (confidence, recency weighted)
brain_mistakes                  ← what failed + human feedback + guardrails
geo_citations                   ← brand mention detection in AI search results
decay_alerts                    ← 50%+ engagement drop flags
agent_activity_log              ← every agent call, tokens, latency
```

**Brain-First Protocol (mandatory on every agent):**
```
BEFORE generating:
  1. Read brain_mistakes relevant to this task
  2. Read brain_patterns that succeeded in this context
  3. THEN generate — informed by both
```

---

## Key API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/context-hub/analyze` | optional | Stage 1 — brand analysis + caching |
| POST | `/api/geo-strategist/analyze` | required | Stage 2 — GEO opportunities |
| POST | `/api/authenticity-enricher/analyze` | required | Stage 3 — E-E-A-T enrichment |
| GET | `/api/content-generator/generate` | required | Stage 4 — SSE article stream |
| POST | `/api/campaign/plan` | required | Stage 4.5 — 8 angle profiles |
| POST | `/api/campaign/create` | required | Save campaign to DB |
| POST | `/api/compliance/critique` | required | Stage 5 — AI critique JSON |
| POST | `/api/compliance/approve` | required | Save edits + write brain_mistakes |
| GET | `/api/publishing/queue/:brandProfileId` | required | Queue items |
| POST | `/api/publishing/publish` | required | Publish to channel |
| POST | `/api/analytics/sync/:brandProfileId` | required | Sync channel analytics |
| POST | `/api/analytics/extract-patterns/:brandId` | required | Stage 8 — pattern extraction |
| GET | `/api/admin/stats` | required | Auth-scoped KPIs |
| GET | `/articles/:brandSlug/:articleSlug` | public | Server-rendered article page |

---

## LLM Routing

| Agent | Model | Reason |
|-------|-------|--------|
| Context Agent (Stage 1) | Claude Sonnet 4.5 | Structured JSON, brand reasoning |
| GEO Strategist (Stage 2) | Claude Sonnet 4.5 | Multi-step competitive reasoning |
| Authenticity Enricher (Stage 3) | Claude Sonnet 4.5 | E-E-A-T analysis |
| Content Generator (Stage 4) | Claude Sonnet 4.5 | Long-form, Brain-First |
| Campaign Generator (Stage 4.5) | Claude Sonnet 4.5 | 8-angle planner + article gen |
| Compliance Gate (Stage 5) | Claude Sonnet 4.5 | Structured rule checking |
| Pattern Extractor (Stage 8) | Claude Haiku | Fast, cheap, pattern analysis |
| Post copy generation | Claude Haiku | LinkedIn/X/Facebook post copy |
| Topic pre-flight check | Claude Haiku | Pattern/mistake signal check |
| Image prompts | Claude Haiku + fal.ai Flux | Hero image generation |

---

## Known Issues & Backlog

| Item | Priority | Notes |
|------|----------|-------|
| LinkedIn impressions/clicks | Medium | Requires MDP approval — reactions/comments live |
| WordPress live API publish | Medium | Pending |
| Webflow live API publish | Medium | Pipedream Connect wired, logic pending |
| Pre-cog Score Dashboard | Backlog | Voyage AI embeddings, pgvector — Phase 3 |
| Agency Dashboard | Backlog | Cross-brand bird's-eye view |
| Medium integration | Legacy | New tokens unavailable since early 2025 |

---

## For AI Sessions — Start Here

1. Read this README top to bottom
2. Read WHITEBOARD.md for current session state and pending work
3. Fetch and read the specific file before editing — never write blind
4. The Anthropic SDK is pinned at `^0.39.0` — do not change
5. `NEON_DATABASE_URL` points to `ep-odd-waterfall-akyrdo6x-pooler` — this is correct and must not change
6. All production commits go to the `production` branch
7. Render auto-deploys on every push — no manual step needed
8. Brian is direct, works fast, expects commits not instructions. No narration. No confirmation requests.

**Owner:** Brian — Founder, Sandbox Group LLC (Portland, OR)
Sandbox Group: **Sandbox-XM** (experience marketing) + **Sandbox-GTM** (event registration + GTM platform) + **Forge Intelligence** (the intelligence layer)
