# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `WHITEBOARD.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. **When it grows past that, archive the oldest session block into `WHITEBOARD.md` and remove it from here.** Newest session on top.

---

## Sessions log (newest first)

---

### 2026-05-10 → 2026-05-23 — Stage 1 rebuild + My Website + /docs + X OAuth migration

~14 days, ~222 commits across 30+ PRs. Multi-session arc; Brian + Claude (full-stack).

#### Major shipments — themed, biggest first

**Stage 1 (Context Hub crawl) rebuilt end-to-end.** Single biggest piece of work. Old Stage 1 was raw `fetch()` with UA rotation, no anti-bot, no JS render, 3 KB body cap per page — silently returned SPA shells on most modern customer sites and built brand profiles off meta tags + JSON-LD alone. New Stage 1 is **Jina Reader primary + `forgeScrape` (BD Tier 1 → Tier 2) fallback**, with parallel page fetches, sitemap.xml-aware discovery, anchor-only link extraction. Wall-clock cut from ~60 s sequential to ~15–20 s parallel; brand profiles now capture full pricing pages, blog catalogs, security whitepapers. Real-world validation on sandbox-gtm.com produced a richer v9 profile than v8 had any way to. PRs #103–#110.

**`forgeScrape` primitive.** Single source of truth for any Bright Data scraping. Tier 1 = Web Unlocker, Tier 2 = Scraping Browser (puppeteer-core CDP, real Chromium, residential IPs) auto-fires when Tier 1 returns a SPA shell. Extracts content via Mozilla Readability + Turndown locally — no second API call. Used by Stage 1 + Site Template. Every call logs to `scrape_log` with `caller` set for audit. Honest extraction metric replaces "0/10 class names found" with "regions located via any signal" (class, data-testid, semantic landmark, content match).

**My Website channel.** New self-hosted webhook publisher. Customers publish Forge articles to their own sites via authenticated webhook with Forge-issued `forge_pub_<32hex>` bearer token. Backend: 4 admin endpoints (config / generate-token / test / disconnect) + publish-handler branch. Frontend: `<MyWebsiteForm>` with URL input, format toggle (HTML/Markdown/both), show-once token reveal, test-publish button. Sandbox-GTM is the guinea pig (Render + Neon, same stack as Forge) — receiver wired and validated end-to-end. PRs #117–#122.

**`/docs` page goes live.** Public route, syntax-highlighted markdown, sidebar grouped by category. First entry is My Website Integration with copy-paste receivers (Node/Express + Postgres, Next.js App Router, filesystem). **Share With AI** button on every doc downloads markdown + a framing preamble for Claude/ChatGPT/Cursor. PRs #120, #123–#125, #134.

**`article_base_url` respected everywhere.** Five publish handlers (Facebook x3, Reddit, Medium) + My Website canonical were rebuilding URLs from `BASE_DOMAIN + brandSlug + articleSlug` instead of brand-aware `forgeArticleUrl`. PR #121 unified all six. PR #123 also adds an explicit "Where will my articles live?" Brand Settings callout.

**Markdown leak fix on social copy.** Facebook + LinkedIn posts going out with literal `#` headings and `**bold**` markers — Haiku was writing markdown by default. PR #115 adds `stripSocialMarkdown()`, updates Facebook prompts to request plain text, applies the strip at 6 sites. Reddit left intact (renders MD natively).

**X (Twitter) OAuth migrated to x.com.** Forge was sending to `twitter.com/i/oauth2/authorize`; domain-migration redirect chain broke the login cookie → infinite "to use this App you have to be logged in" loop in fresh browsers. PR #132 swaps authorize + both token-exchange URLs to `x.com` / `api.x.com`. Runtime API endpoints (tweets, users/me, media-upload) left on `api.twitter.com` — working today via compat redirects.

**Auth-expired = Reconnect, not Reset & Retry.** PR #130 detects auth-expired patterns in `publish_log.error_message`, swaps the button for an amber "Reconnect [Channel] →" link, surfaces non-auth error messages directly.

**Facebook analytics URN bug** + one-shot backfill admin endpoint (PRs #111–#113). 2 historical Sandbox-GTM posts cleanly mapped + backfilled.

**Zernio dual-ID system landed** (5/10). LinkedIn analytics uses `zernioPostId` with legacy fallback; 14 historical LinkedIn posts backfilled via `/api/admin/zernio/raw`.

**Other notable**: Lovable integration + Build button (5/12); Quick Start no-website onramp (5/12); X v2 media upload fix (5/13); Regenerate Arcs (5/13); Vite 5→8 + Clerk/postcss security patches (5/13); GFM table rendering (5/15); `/api/admin/mark-unpublished` (5/17); GitNexus context files committed — aspirational without live MCP runtime in cloud sessions (5/21); `SESSION-PROTOCOL.md` refreshed + moved to repo root (5/22); topbar alerts bell + Get Help form (5/23).

#### Recurring patterns logged

- **Build the primitive once, share it everywhere.** `forgeScrape` replaced 3+ ad-hoc fetchers. The 6 channels that ignored `forgeArticleUrl` accumulated because each new channel re-derived from scratch instead of using the shared helper.
- **Stdio MCP doesn't reach cloud sessions.** GitNexus is useful but its MCP transport is stdio-only — FleetView/cloud Claude Code can't connect to a remote install. Committed the context files as aspirational; the live graph tools are unavailable until either GitNexus ships HTTP/SSE MCP or FleetView gains custom-MCP support.
- **Controlled test cases prevent wrong-direction guesses.** sandbox-gtm.com diagnostic loop (PRs #103–#110) was driven by one URL where Brian knew ground truth — saved several wrong-direction fixes.
- **Error UIs must match the action that actually fixes the error.** "Reset & Retry" for auth-expired is dishonest; users need a Reconnect path with a real link.

#### State of key surfaces (end of period)

- **Stage 1 (Context Hub crawl):** Jina-first, forgeScrape fallback, parallel discovery. Reads full sites including SPAs.
- **Site Template:** Same `forgeScrape` primitive, same Tier 2 fallback. Grades by content + structural selectors.
- **Publishing channels live:** LinkedIn (Zernio), X (OAuth2, x.com migrated), Facebook (Zernio + Pipedream), Reddit (Zernio), Medium, Ghost, WordPress, Webflow, **My Website (new)**. HubSpot stripped per 5/9.
- **`/docs` surface:** Live at `forgeintelligence.ai/docs/my-website`. Share With AI on every entry.
- **Bootstrap files at repo root:** `CLAUDE.md`, `AGENTS.md`, `SESSION-PROTOCOL.md`, `WORKING-STATE.md`, `WHITEBOARD.md`, `.claude/skills/gitnexus/`. Skills aspirational without MCP runtime.
- **GitNexus index:** 2,818 nodes / 3,968 edges / 61 clusters / 129 flows.

#### What's next

- **Nurture email** framing the Stage 1 upgrade as a free product enhancement. Two before/after proof points ready: sandbox-gtm.com v8→v9 and forgeintelligence.ai v11→v12.
- **Watch X OAuth in the wild** — if runtime API calls start failing the same way, apply the domain swap to those endpoints too.
- **My Website rollout copy** — landing page, email blast, in-app announcement. Feature exists + documented; awareness is the remaining gap.
- **GitNexus runtime** — register `gitnexus mcp` if FleetView adds custom MCP support, or if upstream ships HTTP/SSE MCP transport.

**Endpoint count:** ~205 HTTP endpoints in server.js (up from ~191 baseline; added forgeScrape primitive + My Website's 4 admin endpoints + Facebook backfill + various smaller).

---

### 2026-05-09 — Email Campaign Generator polish, MCP for Viktor, HubSpot strip

**Ended:** 2026-05-09 ~04:15 PT (~13h continuous, single-session arc)
**Operator:** Brian + Claude (full-stack)

#### Major shipments

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

#### Recurring patterns logged

- **Half-applied state from intermediate-assertion crashes:** for multi-step edits to a single file, do everything in memory first, sanity-check before any commit, then ONE atomic PUT. Two scripts crashed mid-edit today, requiring fix-up commits.
- **Propose simplest workable path FIRST before architecting OAuth flows.** Brian's CSV-via-Attio-Object outpaced my OAuth dive.
- **When same paywall appears twice in different shapes = stop pivoting, call it.** I burned ~90 minutes on HubSpot endpoint pivots when the answer was visible after the second 403.
- **Render-side defense-in-depth is only valuable where the default is broken.** Sentence-boundary split on sequence_notes was over-engineering that fragmented good content.

#### State of key surfaces (end of session)

- **Email Campaign Generator:** clean, editable, brain-feedback-loop wired. Most polished it has ever been.
- **Integrations page:** HubSpot card removed. LinkedIn / Facebook / Reddit / Ghost / Medium / WordPress / Webflow / X all live.
- **MCP server:** live at `/mcp`, 3 tools, ready for Viktor.
- **Brain Memory:** Forge brain has 9 OWNED + 8 CONTESTED positioning patterns. `brain_mistakes` is now actively written to by user dismissals (closes the feedback loop on Compliance Gate flags).

#### What's next

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
