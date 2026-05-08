# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `WHITEBOARD.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. If it grows past that, content belongs in WHITEBOARD.

---

## Last session

**Ended:** 2026-05-07 ~07:50 PT (then 8h sleep, resumed ~16:00 PT for cleanup)
**Operator:** Brian + Claude (full-stack)

### Major shipments

**FAQ play (live at https://forgeintelligence.ai/faq):**
- 21-question FAQ page with FAQPage JSON-LD schema, validated by GSC ("1 valid item detected")
- Indexed by Google within 80 minutes of publish (IndexNow paid off)
- 5 answers sharpened to anchor "Brain Memory" + "Context Agent Architecture" as named Forge concepts citation engines can attribute back

**Brand brain v9 → v10 (Forge brand profile `cde5feeb-b3d7-4990-adee-a54977ab9c52`):**
- Real competitors loaded: Averi, Tofu, Sight AI, GrackerAI, Jasper, Writer, Salespeak (replacing phantoms)
- `marketCategory` shifted to "AI-Powered Brand Intelligence and Content Strategy Platforms"
- 16 `positioning_classification` patterns: 8 OWNED + 8 CONTESTED with explicit reframe rules
- 27 prioritized `geo_opportunities` (6 pillars + 21 FAQ entries) — see `intent_signals.source = 'strategic_injection_2026_05_06'`
- `strategic_injections.injection_2026_05_06` stamped in `profile_data` for traceability

**First pillar article shipped through the new brain:**
- Title: "Context Agent Architecture Is Not Prompt Engineering — And the Difference Is Why Your AI Content Stack Keeps Resetting to Zero"
- URL: `/articles/forgeintelligence-ai/context-agent-architecture-is-not-prompt-engineering-and-the-difference-is-why-y`
- Edits applied post-Compliance Gate: collapsed redundant sections, added 5-question buyer's checklist, killed defensive language and the off-positioning $99 line, added inline citations to Anthropic + Weaviate

**Platform fixes (5 bugs, 2 UX overhauls):**
- `085b1c4c` — `manual_overrides` + `strategic_injections` preservation across Context Hub rescans
- `d8ae5b2b` — `initDB()` migration idempotency + orphan FK handling (was silently dropping FK on every boot)
- `9e194bd7` + `45dce9ff` — `/api/geo/opportunities/:brandProfileId` surfaces strategic_injection rows + defensive `JSON.parse` for plain-text `topical_authority_context`
- `5df6a0f5` + `ff555716` — Compliance Gate "Verify & Cite" one-shot UI (collapses 4-step citation flow to 1 click, kills the 90% rework rate)
- `a8bc3b8f` + `11a469bb` — `renderBody()` upgrade in PublicArticlePage: markdown links + `[^N]` footnote refs + auto-detect References sections rendered as `<ol>`. Articles can now use academic-style superscript citations + numbered references list. Article `e4214303` reformatted to use this pattern.

**PreCog v2 (`59994171` + `cb03b0d9`):** scoring rebalanced and 6 citation-predictive dimensions added (categoryDefining, externalCitations, worksheetSections, ownedTermAlignment, geoOpportunityMatch, whitespaceFreshness). Driven by empirical observation: 'Attribution Black Hole' v1=93 → 0 citations in 12 days; 'Context Agent Architecture' v1=85 → cited in 1 hour. v2 inverts direction (Attribution ~75, Context ~92). Calibration recorded as `precog_calibration` brain_pattern (id `22979dea`) and a STRATEGY.md entry on the strategy branch.

**Compliance Gate render bug (`7e6eb966`):** the read-only `<HighlightedBody>` was bound to the original `section.body` prop instead of `editedSections[idx]`. After Verify & Cite or Soften, the label flipped to "Cited & Applied" / "Softened & Applied" but the visible prose didn't change — making it look like the rewrite hadn't applied. One-line fix in two render sites; both now read from `editedSections[idx] ?? section.body`. Single click → outcome footer + new prose appear together.

**Social image render bug (`75dcdadb` + `bb6dd035` + `b47ee3dc`):** `image_done` SSE events emitted camelCase `{postId, imageUrl}` from server but FE read snake_case `{post_id, image_url}` (matching `/recent` endpoint convention). Every event was a silent no-op against `id === undefined`. fal.ai images generated, DB rows had image_url, UI spun forever. Fixed by aligning SSE to snake_case + added 60s `/recent` fallback poll for any post still pending after the SSE window — protects against proxy buffering, tab idle, mobile network handoffs.

**Strategy branch BI routes restored (`aa0dbe6b`):** the April 26 catastrophic block-replacement that deleted 1,684 lines from `main` ALSO hit the strategy branch. The `main` deletion was fixed cleanly the same night; the strategy branch deletion was only partially fixed. 14 Brand Intelligence routes (gap-map, blind-spots, whitespace, pivot, compliance, compliance-fix, share, shares, brief — both GET cached and POST generate variants) were silently broken on strategy for 11 days. Discovered when the Intel Corp shareable brief at `/brand-intelligence/22bdf7db…` rendered empty. Routes verbatim-restored from `be034a91` (last good state, 1 hour before the deletion); `competitive-intel` POST/GET handlers were byte-identical between versions, confirming no surrounding fixes needed merging into the deleted block. Brief now renders all 6 tabs (Gap Map / PVA / Blind Spots / Faultlines / Whitespace / Pivot) populated from existing brand_intelligence rows. **Lesson:** when a 1,684-line restore happens, immediately diff against known-good across ALL branches — not just the branch where the disaster occurred.

**Brief footer copyright (`21e6dc97`):** `BrandIntelligenceBriefPage.tsx` footer updated `Sandbox Group LLC` → `Forge Intelligence LLC`.

**🚀 ZERNIO VALIDATED AS PIPEDREAM REPLACEMENT (May 7-8 strategic event)**

Tonight's biggest finding. Zernio (`https://zernio.com`) was tested end-to-end on dev as a possible replacement for the Pipedream Connect + Meta App Review integration that's been blocking Facebook publishing for weeks. Three diagnostic endpoints under `/api/admin/zernio/*` were added (commit `78e5b071`, dev-only, host-gated). Test results:

- ✅ **LinkedIn:** posted live to Forge Intelligence company page in 18.6 seconds. URL: `https://www.linkedin.com/feed/update/urn:li:share:7458359837815545856/`
- ✅ **Facebook:** posted live to Forge Intelligence FB page in ~15 seconds. URL: `https://www.facebook.com/1004505509420749_122109949628737674`. Page connected through Zernio's already-approved Meta app — **zero Meta App Review or Business Verification required on Forge's side**.
- ✅ **White-label by default:** the connected app shown in Facebook's Business Settings reads "Social Connector App" — no Zernio branding visible to end users. Same generic disposition expected on LinkedIn.
- ✅ **Pricing structure favorable:** $18/mo at 5 accounts, $258/mo at 100, $1,158/mo at 1,000, $2,158/mo at 2,000. Marginal cost asymptotes to ~$1/account at scale (vs ~$3.60/account at small scale). All 14 platforms + analytics + inbox + ads API bundled, no add-ons.
- ✅ **Format integrity:** posts rendered fully intact on both platforms — em-dashes preserved, paragraph breaks intact, link preview cards generated correctly.

Strategic implication: Forge stops carrying integration debt for every new platform. The "Meta App Review / Business Verification" item that's been sitting in this list for weeks is no longer needed. Pipedream Connect ($150/mo) can be cancelled. The three-tier FB publish fallback in `server.js` can be deleted. ~200 lines of Pipedream-specific code goes away.

**Migration plan (Saturday May 9-10):**
1. Add `zernioPublish(brandProfileId, platform, content)` helper to `server.js`
2. Replace Pipedream FB call site with the helper; verify against dev
3. Replace Integrations card "Pipedream Workflow URL" UI with a Zernio OAuth proxy: customer clicks Connect → redirected to Zernio's connect URL → returns to Forge with account ID stored in brand_settings
4. Migrate Forge + Sandbox-XM + Sandbox-GTM + Attio's existing FB/LinkedIn through new flow
5. Cancel Pipedream Connect plan ($150/mo saved)
6. Pull `FACEBOOK_PIPEDREAM_WORKFLOW_URL` env var and the Pipedream-specific code out
7. Update STRATEGY.md (strategy branch) with the strategic event
8. Strike Meta App Review item from action items list permanently

Net effect at current scale: **+13 platforms, –$150/mo Pipedream, +$18-78/mo Zernio = net positive cash AND functional Facebook AND LinkedIn AND X AND TikTok AND Instagram AND 9 more.** At 100-customer scale: ~$13/customer for unlimited multi-platform publishing with analytics + ads API. Gross margin ~95-98% on social publishing.

Tonight's dev-only Zernio test endpoints (`78e5b071`) stay in place until migration completes; they come out as part of the Saturday cleanup.

### Currently in flight (next session picks up here)

- **🟦 Saturday May 9-10: Zernio migration.** This is the priority. Replace Pipedream FB integration with Zernio across the publishing pipeline. Sign up for Zernio paid tier first ($18/mo at current account count). Then add `zernioPublish()` helper, OAuth proxy in Integrations card, migrate Forge + Sandbox-XM + Sandbox-GTM + Attio's existing FB/LinkedIn, cancel Pipedream Connect plan ($150/mo saved), delete three-tier fallback code. Dev test endpoints at `/api/admin/zernio/*` (commit `78e5b071`) stay until migration completes — keep them as a sandbox during cutover.
- **Bigger Compliance Gate sweep:** the Verify & Cite improvement is shipped, but the **brain is still routing too many flags as "soften"** when the underlying claim is verifiable. See discussion in WHITEBOARD entry for 2026-05-07 about Sonar query tuning — "what's the canonical/original source for X publishing on Y, prefer official domains, recent dates" is the queryshape that needs to land in `findCitationSources()`.
- **GeoStrategistPage UI** doesn't yet badge pillar topics vs FAQ entries vs auto-discovered, even though the API now returns `source`, `deliverable`, `priority`, `isInjection` per row. Frontend ticket.
- **Frank-as-SME article** seeded in WHITEBOARD entry for 2026-05-05. Not started.

### Known unresolved bugs

- Sandbox-XM article `2b744bab-...` still has Frank's manifest in `sections` — needs re-import via `/api/content/import`.
- Rare `INSERT...ON CONFLICT` race path at `server.js` L3901 in `/api/context-hub/analyze` doesn't run preservation logic — edge case (only fires when two simultaneous `/analyze` calls hit the same brand_url).
- Writer API for `manual_overrides` doesn't exist yet — customers can't write to it from UI, only via SQL relay.

---

## Action items needing Brian (not Claude)

- Re-enter Forge Ghost API key in Integrations on forgeintelligence.ai (current value is corrupted)
- ~~Meta App Review / Business Verification — blocks Facebook integration~~ **RESOLVED via Zernio (May 7-8) — Zernio handles Meta app at their layer; Forge no longer needs its own Meta App Review. Item removed from roadmap.**
- Day 2/5/7 trial nurture email sequence
- GSC sitemap resubmission + Validate Fix on Duplicate Without Canonical
- Trademark lawyer (FORGE Intelligence LLC Atlanta squatter UDRP/TTAB)
- Stripe/banking/vendor entity migration, EIN setup
- Charter Partner counter-offer to Lili (Culture+)

---

## Pointers

- **Long-form session archive:** `WHITEBOARD.md` (append-only, ~2900 lines, every meaningful session debrief)
- **Strategic narrative + positioning history:** `strategy` branch → `STRATEGY.md`
- **Operating protocol for any session:** `docs/SESSION-PROTOCOL.md`
- **Repo access + tokens + relay:** see top of `WHITEBOARD.md` or repo description
- **Key brand profile IDs:**
  - Forge `cde5feeb-b3d7-4990-adee-a54977ab9c52`
  - Sandbox-XM `dd482396-6673-4675-9892-841dad29fbc3`
  - Sandbox-GTM `61d1f187-c00a-443c-ada2-a073afa005cd`
  - Attio `ecc37c27-4e21-40f9-af54-f62967221de6`
- **Active services on Render:**
  - Production `srv-d73bct6a2pns73a8c65g` → `forgeintelligence.ai` (production branch)
  - Development `srv-d726u7ea2pns739kopmg` → `dev.forgeintelligence.ai` (main branch)
  - Strategy `srv-d7g3213bc2fs73dt675g` → `strategy.forgeintelligence.ai` (strategy branch)
