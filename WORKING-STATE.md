# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `WHITEBOARD.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. If it grows past that, content belongs in WHITEBOARD.

---

## Last session

**Ended:** 2026-05-09 ~04:15 PT (~13h continuous, single-session arc)
**Operator:** Brian + Claude (full-stack)

### Major shipments

**MCP server live for Viktor (Slack assistant integration).** `POST /mcp` endpoint, JSON-RPC 2.0, dual-auth (Bearer + X-Api-Key). Three read-only tools exposed: `list_email_campaigns`, `list_emails_in_campaign`, `get_email_copy`. New scope namespace: `mcp:campaigns:read`, `mcp:emails:read`. Brian's API key minted: `fik_live_c2310c2c…b12f` scoped to the Forge brand only.

**Attio CSV export shipped on the Email Campaign Generator.** Per-email CSV download with subject-variant picker (benefit / curiosity / pattern_interrupt, default benefit). Two columns matching Attio's "Generated Emails" Object attributes exactly so the importer auto-maps. Filename: `attio-import-{campaignId8}-{variant}.csv`. RFC-compliant escaping + UTF-8 BOM. Brian's manual Attio Object setup made this a 30-line FE feature instead of a multi-day OAuth integration.

**Landing page polish.** "Read your brand to filth" subline replaced with strategist-framed brand voice. Footer split to two rows with **Published by Forge** linking to `/articles/forgeintelligence-ai` (brand-specific public article hub).

**HubSpot integration full strip + replace with clipboard copy.** Four rebuild rounds across ~6 hours ended in the right answer: HubSpot's public API gates email-template creation behind Marketing Hub Pro+ at every endpoint accessible to Sales Hub Starter (Brian's tier). Replaced with **"Copy for HubSpot" button** on each email card — formats email body as paste-ready HTML, writes to clipboard, user pastes into HubSpot Sales > Templates > New > Source view manually. Same UX shape as Attio CSV export. All `/api/hubspot/*` endpoints, the IntegrationsPage HubSpot card, and the `publishing_channels` row for hubspot are deleted.

**Email Campaign Generator polish (Phase 1 + 2 + 3):**

1. **Render bugs fixed** — P.S. duplication, inline `{{cta_url}}`, `[NEEDS_PROOF]` token leakage. System prompt rewritten with explicit field-separation rules; render-side `sanitizeBody()` helper as defense in depth so existing campaigns clean up retroactively.

2. **Inline edit + flag actions.** New endpoints: `PATCH /api/email-campaign/email/:id`, `POST /api/email-campaign/email/:id/resolve-flag`, `POST /api/email-campaign/email/:id/dismiss-flag-as-false-positive`. Edit mode on every EmailCard makes subject_lines + body + ps + cta_text + cta_url_placeholder all editable. Per-flag actions: Mark resolved / Add citation / Dismiss as false positive. Dismissals write to `brain_mistakes` so the Compliance Gate's brain learns to suppress false-positive patterns on future runs.

3. **Sequence Assessment readability.** System prompt now asks LLM for three short paragraphs (arc / tone / brand-voice shaping) in plain English with no `[bracket_identifiers]`. Render-side cleanup strips legacy bracket tokens + orphan commas + tightens punctuation.

**DB migration applied via SQL relay:**
```sql
ALTER TABLE email_campaign_emails ADD COLUMN flag_resolutions JSONB DEFAULT '{}'::jsonb;
```

**HubSpot OAuth app rotated:** Old app's scope state was unrecoverable in the dev portal. New app: App ID `39088507`, Client ID `78a09da5-3d3f-4c4b-b00e-74310739be3e`. Render `HUBSPOT_CLIENT_ID` updated via single-var PATCH. Brian rotated `HUBSPOT_CLIENT_SECRET` directly. Both prod + dev redeployed to refresh `process.env`. App is now obsolete since HubSpot integration was stripped, but the new credentials are in place if it ever comes back.

### Recurring patterns logged

- **Half-applied state from intermediate-assertion crashes:** for multi-step edits to a single file, do everything in memory first, sanity-check before any commit, then ONE atomic PUT. Two scripts crashed mid-edit today, requiring fix-up commits.
- **Propose simplest workable path FIRST before architecting OAuth flows.** Brian's CSV-via-Attio-Object outpaced my OAuth dive.
- **When same paywall appears twice in different shapes = stop pivoting, call it.** I burned ~90 minutes on HubSpot endpoint pivots when the answer was visible after the second 403.
- **Render-side defense-in-depth is only valuable where the default is broken.** Sentence-boundary split on sequence_notes was over-engineering that fragmented good content.

### State of key surfaces (end of session)

- **Email Campaign Generator:** clean, editable, brain-feedback-loop wired. Most polished it has ever been.
- **Integrations page:** HubSpot card removed. LinkedIn / Facebook / Reddit / Ghost / Medium / WordPress / Webflow / X all live.
- **MCP server:** live at `/mcp`, 3 tools, ready for Viktor.
- **Brain Memory:** Forge brain has 9 OWNED + 8 CONTESTED positioning patterns. `brain_mistakes` is now actively written to by user dismissals (closes the feedback loop on Compliance Gate flags).

---

## What's next

**Validation pass on the new prompts:**
- Generate a fresh test campaign to confirm sequence_notes produces 3 paragraphs (arc / tone / brand-voice) as designed
- Generate a fresh test campaign to confirm body has no inline P.S. / `{{cta_url}}` / `[NEEDS_PROOF]` after the prompt rewrite

**Zernio cleanup (deferred from May 8):**
- Sandbox-XM, Sandbox-GTM, Attio LinkedIn migrations through Zernio (Forge done; others still on direct OAuth)
- Cancel Pipedream Connect ($150/mo savings)
- Remove `FACEBOOK_PIPEDREAM_WORKFLOW_URL` env var from Render (stale)
- LinkedIn OAuth callback to MERGE credentials instead of overwriting (server.js ~L9262)

**Reddit Phase 4:** per-publish subreddit picker in queue UI + flair selection.

**Strategy branch update:** WHITEBOARD on main captures session technical detail, but `STRATEGY.md` on the `strategy` branch should get the Email Campaign Generator improvements + HubSpot-paywall lesson woven into the broader Voice of Market positioning thread.

**Endpoint count:** ~191 HTTP endpoints in server.js + 3 logical MCP tools (down from 194 net after HubSpot strip + 3 email-campaign edit/flag endpoints added).
