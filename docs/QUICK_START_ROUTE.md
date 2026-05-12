# Quick Start Route — `/app/quick-start`

## Summary

A standalone, pre-auth entry point that lets founders build a Brand Brain from structured input (no website URL required). Designed as a partnership-agnostic onramp — currently wired to Lovable, swappable to any vibe coding platform via a single env var.

---

## Route
/app/quick-start

text

No Clerk auth required. No brand profile prerequisite. Zero gates.

---

## User Flow
/app/quick-start
│
▼
Founder Brief Form (structured fields, no URL)
│
▼
"Build My Brand Brain →" CTA
→ POST /api/analyze { factualGround: {...}, websiteUrl: null, source: "quick-start" }
→ Context Agent skips Firecrawl
→ Synthesizes brand profile from Factual Ground fields only
│
▼
Loading state
│
▼
/app/brand-profile (existing page, no modifications)
→ Brand profile rendered as normal
→ "Deploy This Brain" card visible with partner CTA
→ "Correct these?" card links to Factual Ground in Brand Settings
│
▼
User clicks "Build with Lovable" → exits to partner (no gate)
— OR —
User clicks "Run GEO Strategy" / any Stage 2+ → Clerk auth + pay gate fires

text

---

## Page: `QuickStartPage.tsx`

### Location
src/pages/QuickStartPage.tsx
src/pages/QuickStartPage.css

text

### Page Copy

**Headline:**
> Tell us what your product actually does.

**Subhead:**
> We'll build the brand brain. Then you build the product.

**Form section label:**
> The Founder Brief

**CTA button:**
> Build My Brand Brain →

**Loading state copy:**
> Building your brand brain...
> (This takes about 60 seconds. We're synthesizing your positioning, voice, personas, and competitive whitespace.)

---

### Form Fields

#### Core (always visible)

| Field | Input Type | Placeholder / Helper Text | Required |
|-------|-----------|--------------------------|----------|
| Brand Name | text | "What's it called?" | ✓ |
| What we actually do | textarea | "In plain language — what does your product do and for whom?" | ✓ |
| What we do NOT do | textarea | "What do people assume you do that you don't? What's explicitly out of scope?" | ✓ |
| Competitors | textarea | "Who are you most often compared to? Who would a buyer also evaluate?" | ✓ |
| Founding story | textarea | "Why does this exist? What happened that made you build it?" | |

#### Advanced (collapsed accordion: "Add more context ▸")

| Field | Input Type | Placeholder / Helper Text | Required |
|-------|-----------|--------------------------|----------|
| Methodology / Approach | textarea | "How do you do what you do differently than everyone else?" | |
| Team composition | textarea | "Who's building this? Relevant backgrounds, expertise." | |
| Quotable positions | textarea | "Hot takes, beliefs, contrarian stances your brand owns." | |
| Named Authors | textarea | "Real humans who should be attributed as thought leaders." | |
| Logo URL | text | "https://..." | |

---

### Validation

- Brand Name + "What we actually do" + "What we do NOT do" + Competitors = minimum required
- All textareas: no character limit enforced in UI (backend can truncate for token budget)
- Form submits disabled until required fields have content

---

## API Contract

### Request
POST /api/analyze

text

```json
{
  "websiteUrl": null,
  "source": "quick-start",
  "factualGround": {
    "brandName": "string",
    "whatWeDo": "string",
    "whatWeDoNot": "string",
    "competitors": "string",
    "foundingStory": "string | null",
    "methodology": "string | null",
    "teamComposition": "string | null",
    "quotablePositions": "string | null",
    "namedAuthors": "string | null",
    "logoUrl": "string | null"
  }
}
```

### Context Agent Behavior
IF websiteUrl === null && factualGround exists:
SKIP Firecrawl scrape entirely
Construct Claude prompt using factualGround fields as sole context
Generate brand profile (same output schema as URL-based analysis)
Store result with source: "quick-start" flag
Return brand profile to client

text

The Claude prompt for quick-start analyses should include a system instruction like:

> "The following brand context was provided directly by the founder. There is no website to scrape. Generate a complete brand profile using ONLY the provided information. Do not hallucinate details not present in the input. Where information is insufficient for a section, note what's missing rather than fabricating."

### Response

Same `BrandProfile` response shape as URL-based analysis. No schema changes needed.

---

## Session Handling (Anonymous Users)

Since no Clerk auth is required:

1. Generate a temporary session token (UUID) on form submission
2. Store the brand profile in DB keyed to this temp token
3. Set token in localStorage: `forge_quick_start_session`
4. When user later signs up via Clerk (at Stage 2 gate), migrate the temp profile to their authenticated account
5. If user never signs up, profile expires after 30 days (configurable)

---

## Deploy This Brain Card

### Current state (from screenshot)

The card currently reads:
- **"Deploy This Brain"**
- "Turn Forge Intelligence's Brand Brain into a working app."
- Button: "Build with Lovable ↗"
- Tooltip: "First time? Lovable will ask you to sign in — your brand prompt is preserved and the app starts building right after."

### Updated copy

- **"Deploy This Brain"**
- "Turn this into a working product. Your brand brain becomes the foundation."
- Button: `"Build with {partnerName} ↗"` (dynamic)
- Tooltip: "First time? {partnerName} will ask you to sign in — your brand prompt is preserved and the app starts building right after."

### Partner config

```env
VITE_DEPLOY_PARTNER=lovable
```

```ts
// src/config/deployPartner.ts
const partners = {
  lovable: {
    name: "Lovable",
    icon: "lovable-icon", // or SVG import
    url: "https://lovable.dev/new?prompt={encodedPrompt}",
    tooltip: "First time? Lovable will ask you to sign in — your brand prompt is preserved and the app starts building right after."
  },
  bolt: {
    name: "Bolt",
    icon: "bolt-icon",
    url: "https://bolt.new?prompt={encodedPrompt}",
    tooltip: "First time? Bolt will ask you to sign in — your brand prompt is preserved and the app starts building right after."
  }
  // extend as needed
}

export const activePartner = partners[import.meta.env.VITE_DEPLOY_PARTNER || 'lovable']
```

---

## Routing Setup

```tsx
// In App.tsx or router config
<Route path="/app/quick-start" element={<QuickStartPage />} />
```

No `<ProtectedRoute>` wrapper. No Clerk `<SignedIn>` gate. Fully public.

---

## Navigation / Discovery

- Link from marketing site landing page (future)
- Direct URL shared in Lovable partnership materials
- Optional: small "No website yet?" link on the existing New Analysis page (non-intrusive, below the URL input)

---

## What This Does NOT Touch

- `NewAnalysis.tsx` — unchanged, stays clean as the GTM moment
- `BrandProfile.tsx` — unchanged, just renders whatever profile exists
- `BrandSettingsPage.tsx` — unchanged, Factual Ground still lives there for correction flow
- Auth gates on Stage 2+ — unchanged, still fires on GEO Strategist / pipeline nav

---

## Build Order

| Task | Effort | Dependencies |
|------|--------|--------------|
| `QuickStartPage.tsx` + form UI | 1 day | None |
| API: conditional skip-Firecrawl logic in Context Agent | 0.5 day | None |
| Anonymous session token + localStorage | 0.5 day | None |
| Partner config + dynamic Deploy card | 0.5 day | None |
| Session migration on Clerk signup | 1 day | Auth system |
| **Total** | **~3.5 days** | |

---

## Success Metrics

- Quick Start → Brand Profile completion rate (target: >70%)
- Quick Start → "Build with Lovable" click rate
- Quick Start → Clerk signup conversion (users who hit Stage 2 gate)
- Time from form submission to profile render (<90s target)

---

## Future Extensions

- Pre-fill form from URL params (partner referral links can pass brand name, etc.)
- A/B test field count (3 required vs 5 required)
- Add "Import from LinkedIn" as an alternative quick-fill mechanism
- White-label the entire page for embedded partner experiences
