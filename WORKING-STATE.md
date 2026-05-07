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

### Currently in flight (next session picks up here)

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
- Meta App Review / Business Verification — blocks Facebook integration
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
