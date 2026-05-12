# Feature: Forge Intelligence × Lovable Integration

**Feature ID:** FI-LOVABLE-001
**Branch:** `feature/lovable-integration`
**Owner:** Brian Morgan (Sandbox Group LLC)
**Dev Agent:** Claude Code
**Priority:** P0 — Partnership enablement
**Status:** Ready for implementation
**Target:** Demo-quality ship before Lovable enterprise partner meeting
**Repo:** `github.com/Sandbox-Group-LLC/Forge-Intelligence`

---

## 1. Overview

### 1.1 Summary

Ship a one-click "Build with Lovable" integration that transforms any Forge Intelligence Brand Profile into a URL-encoded app-generation prompt for Lovable's public Build with URL API. Users click the button inside Forge → Lovable opens with a fully pre-loaded, brand-aware app build already in progress.

### 1.2 Strategic Rationale

This is the demo artifact for an enterprise partnership conversation with Lovable. It proves three things simultaneously:

1. Forge is a brand intelligence substrate that makes AI-generated apps dramatically better on first build.
2. Forge is technically integration-ready (clean API, deterministic output, no BD dependencies required to ship).
3. Forge users can become Lovable users with zero friction, creating a net-new enterprise activation channel.

### 1.3 User Story

> As a Forge user who has generated a Brand Intelligence Profile, I want to click a single button and launch a fully brand-aware Lovable app build, so I can turn my brand strategy into working software in minutes instead of hours.

### 1.4 Success Criteria

A marketer can:

1. Open an existing Brand Intelligence Profile in Forge.
2. Click **Build with Lovable**.
3. Land in Lovable with a pre-submitted app-generation prompt containing their full brand context.
4. Watch Lovable begin generating a branded Content Command Center in real time.

If the prompt exceeds safe URL length, the user can copy the full prompt and paste it into Lovable manually with zero data loss.

---

## 2. Context

### 2.1 Platform Context

Forge Intelligence is a B2B brand intelligence platform. Users drop a URL → Forge generates a Brand Intelligence Profile (~7 min) containing:

- Voice profile (formality, confidence, complexity, vocabulary, anti-patterns, tone summary)
- Target personas (pain points, trigger events, skepticism objections)
- Competitive whitespace analysis
- GEO / AI citation brief
- Third-party voice themes (reviews, complaints, testimonials)
- Enriched brief (E-E-A-T hooks, SME signals)

Profiles are stored in Neon (`forge_platform` DB). Per-client brains live in `forge_brain_{uuid}` schemas. Stack: Express + React + TypeScript on Render.

### 2.2 External API Context

Lovable's public Build with URL API:
https://lovable.dev/?autosubmit=true#prompt=<URL_ENCODED_PROMPT>

text

- Prompt parameter accepts up to 50,000 characters
- Browsers generally truncate URLs around 12,000 characters → dual compact/full prompt modes required
- No authentication or partnership required to use — purely public API

### 2.3 Non-Negotiable Rules

- Brain-First: read existing brand profile data; do NOT regenerate intelligence
- No LLM calls in the packer — deterministic templating only (speed + cost + reliability)
- No new database tables
- Do not break existing endpoints — run build before committing
- Match existing repo conventions (routes, types, components, styling)
- One task per commit, conventional commit messages
- Strict TypeScript

---

## 3. Scope

### 3.1 In Scope

- Backend endpoint: `POST /api/forge/prompt-pack/lovable`
- Frontend component: `BuildWithLovableButton`
- Button placement on Brand Profile / Brand Brain view
- Structured Lovable-ready prompt generation from existing profile data
- URL encoding + Lovable Build URL construction
- Fallback behavior for oversized prompt URLs
- Minimal README documentation
- Preserve all existing Forge functionality

### 3.2 Out of Scope

- Full Lovable marketplace integration
- Lovable OAuth
- MCP server implementation
- New database tables
- New Brand Profile generation logic
- Any new LLM calls
- Lovable logo or brand asset usage without permission
- OpenAPI spec publication (separate follow-up task)
- Additional app type templates beyond `content-command-center`

---

## 4. Implementation Plan

### 4.1 Execution Order

**Two tasks. Hard stop gate between them.**

1. **Task L-1:** Backend endpoint `POST /api/forge/prompt-pack/lovable`
2. **⛔ STOP. Verify curl response against a real brand profile.**
3. **Task L-2:** `BuildWithLovableButton` component on the Brand Profile page

Do not start L-2 until L-1 returns a valid, testable Lovable URL.

### 4.2 Step 0: Repository Discovery (Required First Step)

Before writing any code, inspect the repo for:

1. Existing API route structure and registration pattern in `src/server.ts`
2. Existing Brand Profile retrieval logic and DB access patterns (`pg` with connection pooling for Neon)
3. Frontend pages that display Brand Profiles, Context Hub, Campaign Generator
4. Existing TypeScript types for `BrandProfile`, `GeoBrief`, `EnrichedBrief`, `Personas`
5. Shared frontend component patterns: button styles, loading states, toasts, modals
6. UUID validation utility (must reuse — raw strings to Postgres caused a prior Context Agent failure)

**Use existing conventions for everything. Do not invent new patterns.**

---

## 5. Task L-1: Backend Endpoint

### 5.1 Files to Create
src/services/lovablePromptPackService.ts # Prompt builder + URL encoder
src/services/lovablePromptTemplates.ts # App-type templates
src/routes/lovable.ts # Express route
src/types/lovable.ts # TypeScript types

text

### 5.2 Files to Modify
src/server.ts # Register route (follow existing pattern)

text

### 5.3 Endpoint Contract

**Route:** `POST /api/forge/prompt-pack/lovable`

**Request body:**

```ts
{
  brandProfileId: string;          // UUID, required
  appType?: string;                // default "content-command-center"
  compact?: boolean;               // default true (for URL safety)
  customNotes?: string;            // optional, appended to prompt
}
```

**Supported `appType` values (v1):**

- `"content-command-center"` — ship fully
- `"geo-monitor"` — stub with TODO
- `"campaign-planner"` — stub with TODO
- `"brand-voice-studio"` — stub with TODO

### 5.4 Response Schema (200)

```ts
{
  success: true;
  data: {
    platform: "lovable";
    brandProfileId: string;
    appType: string;
    recommendedAppName: string;      // e.g. "Acme Content Intelligence Command Center"
    prompt: string;                   // full, unencoded
    promptLength: number;
    encodedPrompt: string;
    encodedLength: number;
    buildUrl: string;                 // full Lovable URL
    isUrlSafe: boolean;               // true if buildUrl.length <= 12000
    fallbackRequired: boolean;        // true if URL exceeds safe browser limit
    brainConsumption: {
      voiceProfile: boolean;
      personas: boolean;
      competitiveWhitespace: boolean;
      geoBrief: boolean;
      thirdPartyVoice: boolean;
      enrichedBrief: boolean;
    };
  }
}
```

### 5.5 Error Contract

| Status | Condition | Body |
|--------|-----------|------|
| 400 | `brandProfileId` missing or invalid UUID | `{ success: false, error, details }` |
| 404 | No brand profile found for UUID | `{ success: false, error, details }` |
| 500 | Unexpected error | `{ success: false, error, details }` |

Invalid UUIDs must return 400 — do NOT let raw strings hit Postgres.

### 5.6 Logic Flow

1. Validate `brandProfileId` as UUID (reuse existing validator)
2. Query `forge_platform.brand_profiles` for the profile; 404 if missing
3. Pull supporting context where available: `geo_briefs`, `enriched_briefs`, brain patterns
4. Load template for `appType` from `lovablePromptTemplates.ts`
5. Interpolate template with brand data using null-safe fallbacks (see 5.9)
6. Apply section character limits if `compact: true` (see 5.7)
7. URL-encode with `encodeURIComponent()`
8. Build URL: `https://lovable.dev/?autosubmit=true#prompt=${encodedPrompt}`
9. Compute `isUrlSafe = buildUrl.length <= 12000`
10. Compute `fallbackRequired = !isUrlSafe`
11. Populate `brainConsumption` based on which blocks had data
12. Return response

### 5.7 Compact Mode Character Limits

When `compact: true` (default), apply per-section limits:

| Section | Max chars |
|---------|-----------|
| Brand summary | 1,200 |
| Voice profile | 1,000 |
| Personas | Max 3 personas, 500 chars each |
| Competitive whitespace | 1,500 |
| Third-party voice | 1,200 |
| GEO opportunities | 1,200 |
| Screens / data model / integrations | Concise bullet lists |

When `compact: false`, include full data (used for copy-to-clipboard fallback).

### 5.8 Required Helper Functions

```ts
function truncateText(value: unknown, maxLength: number): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 24).trim()}... [truncated]`;
}

function safeJoinArray(arr: unknown[], maxLength: number): string {
  if (!Array.isArray(arr)) return "";
  return truncateText(arr.map(String).join(", "), maxLength);
}

function hasMeaningfulData(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}
```

### 5.9 Null-Safe Fallback Patterns

```ts
const brandName = profile?.company_name || profile?.brand_name || profile?.name || "this brand";
const voiceProfile = profile?.voice_profile || {};
const personas = profile?.personas || [];
const whitespace = profile?.competitive_whitespace || {};
const thirdPartyVoice = profile?.third_party_voice || {};
const geoBrief = profile?.geo_brief || {};
```

When a section is empty, insert a graceful placeholder:
No third-party voice data available yet. Design this section to be populated later.

text

### 5.10 Prompt Template — `content-command-center`

```markdown
You are building a production Brand Intelligence Command Center for {{COMPANY_NAME}}.

## APP CONCEPT
A {{APP_TYPE_DESCRIPTION}} that helps {{COMPANY_NAME}}'s marketing team turn brand intelligence into shipped content. The app must feel like a strategic GTM operating system, not a generic AI content generator.

## BRAND VOICE (apply to ALL UI copy and generated content)
- Formality: {{FORMALITY_SCORE}}/10
- Confidence: {{CONFIDENCE_SCORE}}/10
- Complexity: {{COMPLEXITY_SCORE}}/10
- Brand vocabulary: {{BRAND_VOCAB}}
- Anti-patterns to avoid: {{ANTI_PATTERNS}}
- Tone summary: {{TONE_SUMMARY}}

## TARGET PERSONAS
{{PERSONAS_FORMATTED}}
(Each persona: role, pain points, trigger events, skepticism objections)

## COMPETITIVE WHITESPACE
{{WHITESPACE_SUMMARY}}
Unclaimed positioning territory: {{UNCLAIMED_TERRITORY}}

## THIRD-PARTY VOICE THEMES
Top customer language patterns from reviews, complaints, testimonials:
{{THIRD_PARTY_THEMES}}

## AI SEARCH / GEO OPPORTUNITIES
Top citation opportunities to optimize for:
{{GEO_OPPORTUNITIES}}

## REQUIRED SCREENS
1. Dashboard — brand health, content velocity, AI citation score
2. Brand Brain — voice profile, personas, whitespace (read-only)
3. Content Generator — articles/social/email with confidence scores
4. Campaign Planner — 8-article campaign with rotating angles
5. AI Citation Monitor — track GEO opportunities and citation status
6. Approval Queue — review with E-E-A-T flags before publish

## DATA MODEL (use Supabase — Lovable native)
- brand_context (singleton, holds profile passed in this prompt)
- generated_content (id, type, body, confidence_scores, status, created_at)
- campaigns (id, topic_cluster, article_count, status)
- citation_opportunities (id, prompt, current_status, target_status)

## CORE WORKFLOW
1. User opens dashboard.
2. User reviews the Brand Brain.
3. User selects a topic cluster or content opportunity.
4. App generates a campaign plan.
5. User reviews generated content with confidence scores, source needs, and E-E-A-T flags.
6. User approves or edits outputs.
7. Approved content moves into publishing queue.

## INTEGRATIONS
- Supabase for persistence (Lovable native)
- Resend for content preview emails
- Stripe (optional, for app monetization)

## VISUAL DIRECTION
- Match brand colors: {{BRAND_COLORS}}
- Typography: clean sans-serif, generous spacing
- UI copy tone: matches brand voice profile above
- Avoid generic AI-app aesthetics (no purple gradients, no robot icons)

## SUCCESS CRITERIA
A marketer at {{COMPANY_NAME}} should say "this knows our brand better than our agency does" within 2 minutes of opening the app.

{{CUSTOM_NOTES_IF_PRESENT}}

## TECHNICAL NOTES
Forge Intelligence API base: https://api.forgeintelligence.ai/v1
Brand Profile ID: {{BRAND_PROFILE_ID}}
(Optional: prompt user for FORGE_API_KEY env var to enable live content generation. If not provided, scaffold with static brand data from this prompt.)
```

### 5.11 Acceptance Criteria — Task L-1

- [ ] `curl -X POST http://localhost:PORT/api/forge/prompt-pack/lovable -H "Content-Type: application/json" -d '{"brandProfileId":"<real-uuid>"}'` returns 200 with valid `buildUrl`
- [ ] Same curl with `"compact": false` returns longer prompt with `fallbackRequired: true` when appropriate
- [ ] Pasting `buildUrl` into a browser opens Lovable and begins building (manual test)
- [ ] Missing profile returns 404 (not 500)
- [ ] Invalid UUID returns 400 (not Postgres error)
- [ ] `brainConsumption` accurately reflects which blocks had data
- [ ] Prompt is always generated even with partial profile data (graceful fallbacks)
- [ ] No secrets or internal env vars are included in the prompt
- [ ] `npm run build` passes
- [ ] Existing endpoint smoke tests still pass

### 5.12 ⛔ Gate Before L-2

Stop. Share the curl response output with Brian. Demonstrate the Lovable URL opens correctly in a browser. Do not proceed until verified.

---

## 6. Task L-2: Frontend Button Component

### 6.1 Files to Create
src/components/BuildWithLovableButton.tsx

text

### 6.2 Files to Modify
src/pages/BrandProfilePage.tsx # Or wherever the complete profile view lives — discover first

text

### 6.3 Component API

```tsx
<BuildWithLovableButton
  brandProfileId={profile.id}
  brandName={profile.company_name}
  appType="content-command-center"
/>
```

**Props:**

```ts
interface BuildWithLovableButtonProps {
  brandProfileId: string;
  brandName?: string;
  appType?: string;
  variant?: "primary" | "secondary";
}
```

### 6.4 State Machine
idle → loading → (success | fallback | error)

text

### 6.5 Click Behavior

1. Set `loading`. Button label: **"Packing brand brain..."**
2. Call `POST /api/forge/prompt-pack/lovable` with `{ brandProfileId, appType, compact: true }`
3. **On success + `isUrlSafe === true`:**
   - `window.open(data.buildUrl, '_blank', 'noopener,noreferrer')`
   - Button shows **"Opening Lovable..."** then returns to idle
4. **On success + `fallbackRequired === true`:**
   - Show inline panel/modal containing:
     - Scrollable preview of `data.prompt`
     - **"Copy Prompt"** button → copies `data.prompt` to clipboard
     - **"Open Lovable"** button → opens `https://lovable.dev` (without prompt)
     - Helper text: "This Brand Brain is too rich for a safe one-click URL. Copy the prompt and paste it into Lovable."
5. **On error:**
   - Inline toast: "Could not generate Lovable prompt. Try again."
   - Retry button visible

### 6.6 Visual Spec

- Match existing Forge button styles (consistent with GEO Strategist / Auth Enricher run buttons)
- Icon: external-link or rocket-style icon (do NOT use Lovable's logo without confirmed usage rights)
- Primary label: **"Build with Lovable"**
- Subtitle: "Turn this Brand Brain into a working app"
- Disabled state: when `voice_profile` is empty on the profile (profile incomplete)
- Mobile responsive

### 6.7 Placement

On the Brand Profile page, add a new section titled **"Deploy This Brain"** directly below the profile summary card.

- The Lovable button is the first (and currently only) action in this section
- Leave visual space for future siblings: Base44, Replit, Bolt
- Section should feel like a natural extension of the profile, not a detached CTA

### 6.8 Acceptance Criteria — Task L-2

- [ ] Button renders on any valid brand profile page
- [ ] Click triggers API call and opens Lovable in new tab when URL is safe
- [ ] Fallback modal/panel appears when `fallbackRequired: true`
- [ ] "Copy Prompt" button copies full prompt to clipboard successfully
- [ ] Loading state visible during request
- [ ] Error state visible on API failure (no silent failures)
- [ ] Button disabled when profile incomplete (no voice_profile)
- [ ] Mobile responsive
- [ ] Matches existing Forge button styles (no new design system fragments)
- [ ] `npm run build` passes

---

## 7. Explicit Do-Nots

- ❌ Do NOT modify the brand profile generation pipeline
- ❌ Do NOT add new database tables
- ❌ Do NOT call any LLM (Claude/GPT/Gemini) in the packer — deterministic templating only
- ❌ Do NOT add authentication beyond what existing endpoints use
- ❌ Do NOT commit Lovable's logo or wordmark without confirming usage rights
- ❌ Do NOT start L-2 before L-1 is verified working
- ❌ Do NOT flesh out stub `appType` templates in v1 — stub with TODO returns only
- ❌ Do NOT invent new architectural patterns — match existing conventions
- ❌ Do NOT expose secrets, API keys, internal env vars, or database URLs in prompts

---

## 8. Open Questions (Resolve Before Starting)

| # | Question | Recommended Default |
|---|----------|---------------------|
| 1 | Are brand logos / color swatches stored at public URLs for Lovable `images` parameter? | Ship v1 with no image refs; add in v1.1 |
| 2 | Ship all 4 `appType` templates or just `content-command-center`? | Ship `content-command-center` fully; stub the other 3 |
| 3 | Is `api.forgeintelligence.ai/v1` live, or use Render URL in prompt? | Use whatever URL is currently deployed; easy to swap in template |
| 4 | Does the repo have an existing toast/notification system? | Inspect during discovery step; reuse if present |

---

## 9. Manual Test Plan

### 9.1 Backend Tests

```bash
# Happy path — compact mode
curl -X POST http://localhost:PORT/api/forge/prompt-pack/lovable \
  -H "Content-Type: application/json" \
  -d '{
    "brandProfileId": "<REAL_UUID>",
    "appType": "content-command-center",
    "compact": true
  }'

# Full prompt mode (fallback verification)
curl -X POST http://localhost:PORT/api/forge/prompt-pack/lovable \
  -H "Content-Type: application/json" \
  -d '{
    "brandProfileId": "<REAL_UUID>",
    "compact": false
  }'

# Invalid UUID (expect 400)
curl -X POST http://localhost:PORT/api/forge/prompt-pack/lovable \
  -H "Content-Type: application/json" \
  -d '{"brandProfileId": "not-a-uuid"}'

# Missing profile (expect 404)
curl -X POST http://localhost:PORT/api/forge/prompt-pack/lovable \
  -H "Content-Type: application/json" \
  -d '{"brandProfileId": "00000000-0000-0000-0000-000000000000"}'
```

### 9.2 Frontend Tests

1. Navigate to a completed Brand Intelligence Profile in Forge
2. Verify "Deploy This Brain" section renders below profile summary
3. Click **Build with Lovable**
4. Verify loading state appears ("Packing brand brain...")
5. Verify Lovable opens in new tab with prompt pre-loaded
6. Confirm the generated Lovable app references the correct brand
7. Test with a large/rich profile that triggers `fallbackRequired`
8. Verify fallback panel appears, copy-prompt works, manual paste into Lovable works
9. Test with incomplete profile — button should be disabled
10. Verify no console errors

---

## 10. Deliverables

### 10.1 Pull Request

**Title:** `feat(lovable): Build with Lovable integration — endpoint + UI button`

**Description must include:**

1. curl example with a real response (full output, not abbreviated)
2. Screenshot of the `BuildWithLovableButton` in the Forge UI
3. The resulting Lovable URL (clickable, so Brian can test the demo flow before merge)
4. Screenshot of the fallback modal (if triggered during testing)
5. Notes on any open questions resolved during implementation

### 10.2 Documentation Updates

- `README.md` — add "Lovable Integration" section:

```md
## Lovable Integration Demo

Forge can generate Lovable-ready prompt packs from Brand Intelligence Profiles.

### Endpoint

`POST /api/forge/prompt-pack/lovable`

### Use Case

This powers the **Build with Lovable** button in Forge. It turns a Forge Brand Brain into a structured app-generation prompt that can be passed to Lovable's Build with URL flow.

### Output

The endpoint returns:

- Lovable-ready prompt
- URL-encoded prompt
- Build with Lovable URL
- URL safety metadata
- Copy-prompt fallback support
```

- `Whiteboard.md` — add "Stage 5+ — Deploy Targets" section noting Lovable as first deploy target shipped

### 10.3 Commit Convention

One commit per task. Do not squash.
feat(lovable): add prompt-pack endpoint for Lovable Build with URL
feat(lovable): add Build with Lovable button to Brand Profile page

text

---

## 11. Post-Ship Follow-Ups (Out of Scope for This PR)

Do NOT build these now. Track as separate feature specs after the Lovable meeting validates direction:

- **L-3:** Publish public OpenAPI spec at `/api/forge/openapi.json`
- **L-4:** Create `/docs/lovable-integration` public docs page
- **L-5:** Flesh out remaining `appType` templates (`geo-monitor`, `campaign-planner`, `brand-voice-studio`)
- **L-6:** MCP server prototype for build-time brand context injection
- **L-7:** Image reference support (logo/color swatches as public URLs in Lovable `images` param)
- **L-8:** LLM polish pass option for prompt refinement (trade cost/latency for quality)
- **L-9:** Base44 OpenAPI connector + template submission
- **L-10:** Replit Connectors framework integration

---

## 12. Strategic Context (Why This Matters)

This feature is the technical artifact that closes an enterprise partnership conversation with Lovable. Brian has a warm intro to their Head of Enterprise Marketing (former Klaviyo client). The meeting strategy is demo-first, not pitch-first.

The one-click "URL → branded Lovable app" demo is the kind of moment that gets screenshotted and Slacked to Lovable's product team within an hour of the meeting. Ship it tight, ship it working, ship it fast.

**No Lovable partnership agreement is required to deploy this feature.** The Build with URL API is public. Forge can launch this independently and hand Lovable a live integration rather than a pitch deck.
