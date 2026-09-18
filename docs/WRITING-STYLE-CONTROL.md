# Writing Style Control — Forge Intelligence

**Audience:** Agentcy-Core (and any agent/human imposing better writing across platform writers)  
**Repo:** `Sandbox-Group-LLC/Forge-Intelligence`  
**Last verified:** 2026-09-18  
**Status:** Source of truth for *how* style is applied today

---

## One-line architecture

**Prompt rules shape the prose → model writes → small deterministic sanitizers clean leaks → compliance scores voice (does not rewrite).**

Style is **mostly prompting + brand voice injection**.  
There is **no full post-write language converter / style-transfer stage**.  
There *are* hard-coded cleanup nets after write.

If you are looking for a missing “language converter” module: **it does not exist and was never built.** Brand voice is applied *during* generation.

---

## Mental model

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SYSTEM PROMPT (house style + format contract)            │
│    src/agents/<agent>/system_prompt.md                      │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│ 2. USER PROMPT (runtime brain context)                      │
│    voiceProfile + personas + GEO + enriched brief +         │
│    factual ground + brain patterns/mistakes + mandatories   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│ 3. MODEL GENERATION                                         │
│    JSON article / posts / emails / quick copy               │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│ 4. HARD-CODED BACKSTOPS (narrow, mechanical)                │
│    src/server/text.js → finalizeArticleForStorage()         │
│    - strip scaffolding placeholders                         │
│    - strip em/en dashes                                     │
│    - (content-gen) keyTakeaway fallback if missing          │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│ 5. COMPLIANCE (optional QA)                                 │
│    scores brand voice + flags issues — does NOT restyle     │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Agent system prompts (primary style control)

All live under `src/agents/`. Each file is loaded as the LLM **system** prompt at generation time.

| Agent | File | What it controls |
|---|---|---|
| Long-form article writer | `src/agents/stage4_content_generator/system_prompt.md` | Structure, voice-match, GEO/citability, human cadence, **zero em-dash rule**, section skeleton, anti-filler, CRM ban, hedges |
| Campaign angle planner | `src/agents/stage4_campaign_planner/system_prompt.md` | 8-angle diversity, content types, funnel rules, no em dashes in titles/hooks |
| Social posts | `src/agents/stage4_social_generator/system_prompt.md` | Platform limits (X 280 / IG ~150–300), 4-angle diversity, hook rules, hashtag/emoji policy |
| Quick Copy | `src/agents/stage4_quick_copy/system_prompt.md` | One-off email/DM/social format contracts |
| Email sequences | `src/agents/stage46_email_campaign/system_prompt.md` | Sequence architecture, subject-line rules, SMP discipline |
| Compliance gate | `src/agents/stage5_compliance_gate/system_prompt.md` | **Scores** brand voice + flags issues; does **not** restyle body |

### Canonical anti-AI-tell policy (long-form)

Treat this file as the house style bible for prose quality:

**`src/agents/stage4_content_generator/system_prompt.md`**

Critical sections inside it:

| Section | Purpose |
|---|---|
| `## Output Format` | JSON schema (title, metaDescription, keyTakeaway, sections, faqs, confidence tiers) |
| `## Citability mechanics (GEO)` | Stats, factual anchors, real quotes only, definition blocks, direct answers, numbered steps |
| `## Writing Rules` | Voice-match, persona targeting, GEO, E-E-A-T, length, no filler |
| `## Human Cadence: avoid the AI tells` | Em-dash absolute ban + cadence/rhetoric tells |
| `## Section Structure (required)` | Hook → problem → body → proof → CTA skeleton |
| `## Mistakes to Avoid` | No fabricated stats/quotes, CRM-disparagement ban, etc. |
| `## Self-as-Case-Study Rule` | When brand is the proof source, drop epistemic hedges |

### Em-dash rule (absolute)

From the content generator system prompt (paraphrased policy):

- **Zero em dashes (U+2014) and zero en dashes as rhetorical dashes**
- Overrides brand voice profile if the profile is dash-heavy (upstream AI contamination)
- Rewrite with comma / colon / period / parentheses
- Prompt says a deterministic sanitizer also strips leaks — do not rely on it alone

---

## 2. Runtime orchestration (where prompts load + voice injects)

These routes read the prompt file, build the **user** prompt with brand brain context, call the model, then store.

| Flow | Orchestrator file | Prompt load | Voice injection |
|---|---|---|---|
| Content Generator (main article path) | `server.js` → `GET /api/content-generator/generate` (search `content-generator/generate`, ~line 4017+) | `src/agents/stage4_content_generator/system_prompt.md` | user prompt gets `voiceProfile`, personas, GEO, enriched brief, factual ground, brain patterns/mistakes |
| Campaign article generation | `src/server/routes/campaign.js` | same content-generator prompt (~line 552) | `VOICE PROFILE (tone + style anchors)` from `profileData.voiceProfile` (~120–121) |
| Social Generator | `src/server/routes/social-generator.js` | `stage4_social_generator/system_prompt.md` (~171) | `BRAND VOICE PROFILE` + platform hard constraints in user prompt (~199) |
| Quick Copy | `src/server/routes/quick-copy.js` | `stage4_quick_copy/system_prompt.md` (~113) | voice block (~205+) |
| Email Campaign | `src/server/routes/email-campaign.js` | `stage46_email_campaign/system_prompt.md` (~271) | `BRAND VOICE PROFILE` (~294) |
| Compliance critique | `src/server/routes/compliance.js` | `stage5_compliance_gate/system_prompt.md` | voice used for scoring, not rewrite |
| Content import / Frank-edit merge | `src/server/routes/content.js` | regen prompts include voice slices (~253, ~309) | then `finalizeArticleForStorage` |

### How brand voice is produced (upstream)

Voice is **not** hardcoded per writer. It is extracted/built by Context Hub and stored on the brand profile:

- **Builder:** `src/server/routes/context-hub.js`  
  Builds `profile_data.voiceProfile` fields such as:
  - `summary`
  - `toneAttributes`
  - `writingStyle`
  - `keyPhrases`
  - (plus related visual/accent fields used by image/video paths)
- **Storage:** `brand_profiles.profile_data.voiceProfile`  
  Canonical key: `voiceProfile`  
  Legacy alias still seen in places: `voice_profile`

Writers **consume** that object as prompt context. They do not run a second style model over finished prose.

---

## 3. Hard-coded post-write sanitizers

**Single source of truth:** `src/server/text.js`

These are **mechanical backstops**, not a brand-voice rewriter.

| Function | Job |
|---|---|
| `stripEmDashes(text)` | Deterministic em/en-dash remover. Numeric ranges (`2024–2026`) → hyphen. Other dashes → comma, or semicolon if the sentence already has 2+ commas |
| `stripEmDashesFromArticle(article)` | Applies dash strip across title, metaDescription, keyTakeaway, section heading/body/content, FAQ question/answer |
| `stripScaffoldingArtifacts(article)` | Removes leaked LLM placeholders like `[SME Hook:…]`, `[TODO]`, `[NEEDS CITATION]`, `[CTA:…]`, editor notes, etc. |
| `finalizeArticleForStorage(article)` | **The one net every article write path should call** = scaffolding strip + em-dash strip |
| `stripSocialMarkdown(text)` | Strips `# headings` and `**bold**` / `__bold__` for social platforms that render markdown literally |
| `truncateStr` / `truncateAtSentence` / `quickStartTruncate` | Length utilities (not style) |

### `finalizeArticleForStorage` call sites

| File | Approx | When |
|---|---|---|
| `server.js` | ~4396 | After content-generator model JSON parse, before DB insert |
| `src/server/routes/campaign.js` | ~750 | After campaign article generation |
| `src/server/routes/compliance.js` | ~739 | On compliance approve write-back |
| `src/server/routes/content.js` | ~360 | Import / edited-content merge path |

### Content-gen-only extras (`server.js`)

After generation, the main article path also:

1. Attempts incomplete-JSON recovery if the model truncates
2. Regenerates **once** if the pass is incomplete (missing sections/faqs, max_tokens, recovered partial)
3. If `keyTakeaway` is still missing, synthesizes a TL;DR fallback from meta description / opening body, then runs `stripEmDashes` on it

### Social publish path

`src/server/routes/publishing-publish.js` imports `stripSocialMarkdown` and applies it to generated FB/IG/etc. promo copy so markdown markers don’t ship literally.

### Upstream house-style constants still in `server.js`

Near the top of `server.js`:

- `STRATEGY_NO_EM_DASH` — forbids em dashes in Brand Intelligence / strategy stage outputs
- `HUMAN VOICE` notes — keep enrichment/strategy prose from reseeding AI-tell punctuation into later writer stages

These matter because Stage 3 enrichment strings (power phrases, hooks, injections) are often reproduced close-to-verbatim by Stage 4.

---

## 4. What is *not* in the stack

- ❌ No post-write brand-voice rewriter
- ❌ No “language converter” / style-transfer pass after generation
- ❌ Compliance does **critique + score**, not restyle
- ❌ Brain Distill does not rewrite past articles

### Brain Distill (related, but not a styler)

In `server.js` (search `Brain Distill`, ~2480+):

- Converts human editorial edits into durable writing rules
- Those rules feed **future prompts / brain context**
- They do **not** retroactively restyle stored articles

---

## 5. Instructions for Agentcy-Core

Goal: impose better writing on agents inside the platform **without inventing a phantom converter**.

### Do this, in order

#### Step 1 — Decide the house style once

Treat long-form cadence rules in:

`src/agents/stage4_content_generator/system_prompt.md`

especially:

- `## Human Cadence: avoid the AI tells`
- zero em-dash absolute rule
- writing rules / mistakes to avoid

as the **canonical anti-AI-tell policy**.

#### Step 2 — Propagate into every writer agent prompt

Copy/adapt the shared hard rules into:

- `src/agents/stage4_social_generator/system_prompt.md`
- `src/agents/stage4_quick_copy/system_prompt.md`
- `src/agents/stage46_email_campaign/system_prompt.md`
- `src/agents/stage4_campaign_planner/system_prompt.md` (already has a lighter no-em-dash note)

Keep platform-specific constraints local (char limits, subject lines, angle diversity).  
Share the **human cadence / anti-tell** layer.

#### Step 3 — Keep brand voice as prompt context, not a post-processor

Voice still comes from `profile_data.voiceProfile` injected by each route.

Do **not** invent a second restyle model unless product explicitly wants a rewrite stage. Today’s design is prompt-first on purpose.

#### Step 4 — If a rule must never fail, put a backstop in `src/server/text.js`

Proven pattern:

1. Prompt forbids the tell
2. `stripEmDashes` / `finalizeArticleForStorage` guarantees it

Only add hard-coded transforms for **mechanical** tells:

- punctuation artifacts
- scaffolding placeholders
- markdown markers on plain-text surfaces

Do **not** try to code “sound more human” as regex.

#### Step 5 — Wire every new write path through `finalizeArticleForStorage`

If Core adds writers or new article write endpoints:

```js
import { finalizeArticleForStorage } from '../text.js'; // or correct relative path
// ...
parsed = finalizeArticleForStorage(parsed);
// then insert/update DB
```

Do not reimplement dash/scaffold logic per route.

#### Step 6 — Use compliance as QA, not as the style engine

- Prompt: `src/agents/stage5_compliance_gate/system_prompt.md`
- Route: `src/server/routes/compliance.js`

Should flag voice drift / factual risk / mistake patterns.  
Fixes belong in:

1. writer system prompts
2. optional human edit
3. brain rules from distill for future runs

#### Step 7 — Do not hunt for a missing converter

It isn’t missing. Looking for a post-write styler is the usual him-haw loop.

---

## 6. Fast file checklist (PR / audit)

```
# Style policy (edit these to change writing behavior)
src/agents/stage4_content_generator/system_prompt.md
src/agents/stage4_social_generator/system_prompt.md
src/agents/stage4_quick_copy/system_prompt.md
src/agents/stage46_email_campaign/system_prompt.md
src/agents/stage4_campaign_planner/system_prompt.md
src/agents/stage5_compliance_gate/system_prompt.md

# Mechanical backstops
src/server/text.js

# Orchestrators (load prompts, inject voice, call model, finalize)
server.js                                 # /api/content-generator/generate
src/server/routes/campaign.js
src/server/routes/social-generator.js
src/server/routes/quick-copy.js
src/server/routes/email-campaign.js
src/server/routes/compliance.js
src/server/routes/content.js
src/server/routes/publishing-publish.js   # stripSocialMarkdown only
src/server/routes/context-hub.js          # builds voiceProfile
```

### Useful search needles

```bash
# system prompt loads
rg -n "system_prompt\\.md" server.js src/server/routes

# finalizer
rg -n "finalizeArticleForStorage|stripEmDashes|stripScaffoldingArtifacts|stripSocialMarkdown" server.js src/server

# voice injection
rg -n "VOICE PROFILE|voiceProfile|BRAND VOICE" server.js src/server/routes
```

---

## 7. Decision guide

| You want… | Change this |
|---|---|
| Better prose quality / less AI cadence | `src/agents/*/system_prompt.md` (start with content generator Human Cadence) |
| Stronger brand voice match | Context Hub voice quality + richer `voiceProfile` injection in route user prompts; also brain patterns/mistakes |
| Guarantee no em dashes ship | Already dual-layered: prompt ban + `src/server/text.js` `stripEmDashes*` |
| Guarantee no `[SME Hook]` leaks ship | `stripScaffoldingArtifacts` via `finalizeArticleForStorage` |
| Catch bad voice after write | Compliance agent/route (score/flag only) |
| Teach from human edits | Brain Distill path in `server.js` → future prompt context |
| Full automatic rewrite into brand voice after generation | **Not built.** Product decision required; would be a new stage |

---

## 8. Bottom line

- **Want better writing?** Edit `src/agents/*/system_prompt.md` and strengthen shared anti-tell rules.
- **Want unbreakable mechanical style?** Extend `src/server/text.js` and always call `finalizeArticleForStorage`.
- **Don’t wait on a language-converter module.** Brand voice is applied *during* generation via `voiceProfile` in the user prompt.

---

## 9. Verification notes (2026-09-18)

Confirmed in-repo:

- Content generator system prompt exists and encodes house style + absolute em-dash ban
- `src/server/text.js` owns `finalizeArticleForStorage`, `stripEmDashes`, `stripScaffoldingArtifacts`, `stripSocialMarkdown`
- Content-gen (`server.js`), campaign, compliance approve, and content import call the finalizer
- Social/quick-copy/email each have their own system prompts and voice injection
- No separate post-write style-transfer service/module found

Line numbers are approximate and can drift; search the symbols/paths above rather than trusting exact offsets forever.
