# WORKING-STATE.md

**Always read this first at the start of any session.** It's the single source of truth for what's currently in flight, what just shipped, and what the next move is. Updated at the end of every working session.

This is the _current pointer_ doc — the long-form retrospective archive lives in `WHITEBOARD.md`, and the strategic narrative lives on the `strategy` branch in `STRATEGY.md`. WORKING-STATE is meant to be ~100 lines max. If it grows past that, content belongs in WHITEBOARD.

---

## Last session

**Ended:** 2026-05-08 ~21:30 PT (~24h continuous, started prior evening)
**Operator:** Brian + Claude (full-stack) + Claude Code (LinkedIn OAuth implementation overnight)

### Major shipments — Zernio is live, Pipedream is dead

**The full Zernio migration shipped — twelve hours ahead of the Saturday plan.** Forge's LinkedIn, Facebook, and Reddit channels all route through Zernio in production. Pipedream Connect can be cancelled. The Meta App Review item is permanently off the roadmap. ~200 lines of dead Pipedream UI code went out.

**Zernio LinkedIn dispatch (`9b018732`, `3dca61e5`, `e4adbb69`, `412c6cd9`):** `zernioPublish()` helper added next to existing `callZernio()`. Per-channel dispatch in `/api/publishing/publish` — if `creds.zernioAccountId` is set, route through Zernio's `/posts` API, else fall through to the legacy direct API. Per-brand opt-in via single `UPDATE` on `publishing_channels.credentials`. Host gate added for the dev test, removed once the API path was validated. `412c6cd9` fixed a missing `publish_log` INSERT — `continue;` in the Zernio block was skipping the loop-end logger.

**Zernio Facebook dispatch (`c1e8999f` from Claude Code overnight):** same pattern as LinkedIn — `creds.zernioAccountId` triggers the dispatch, otherwise legacy three-tier fallback (workflow URL / `pipedreamProxy` / direct Graph API). Validated end-to-end on Forge's company page.

**Zernio Reddit dispatch + brand-owned allowlist (`91b52d09`, `9e0c16d8`, `de86e4b6`, `901b5078`, `6ca56b1076`):** Reddit was missing entirely from Integrations and the publish handler used the legacy direct-OAuth Reddit API code, which broke for any Zernio-migrated brand. Tonight's wire-up added:
- Server-side dispatch with **brand-owned subreddit allowlist enforcement**: brands declare `creds.allowedSubreddits[]` and Forge refuses to publish outside the list. No allowlist → publish fails with a clear error. Subreddit not in list → publish fails. Per-publish target precedence: `publishOptions.reddit.subreddit` → `creds.defaultSubreddit` → `allowedSubreddits[0]`.
- Dedicated endpoint `POST /api/publishing/channels/reddit/allowed-subreddits` that does targeted JSONB merge (preserves Zernio creds) — couldn't reuse the generic channel-save because that endpoint wholesale-overwrites credentials.
- Reddit channel + `<RedditAllowedSubreddits>` component added to `IntegrationsPage` (Reddit was missing entirely from the channel list before tonight).
- Switched from text post to **link post format** — `content` becomes the Reddit title, `platformSpecificData.url` becomes the destination, Reddit fetches OG preview. Cleaner UX than generating Haiku body copy that then becomes a malformed title.

**Zernio Reddit field-name bug (`6ca56b1076`):** the dispatch was sending `platformOptions` instead of `platformSpecificData` — the actual field name in Zernio's API. Zernio silently dropped the unknown field and posted to the connected account's default subreddit (r/marketing for the Event_Philosopher account), which is why Forge's first Reddit publish landed in r/marketing despite the allowlist correctly choosing r/ForgeIntelligence. Single character mismatch caused two wrong-subreddit posts; first correct publish to r/ForgeIntelligence after fix.

**Dead Pipedream UI cleanup (`5151e43a` + `6d1eed1f`):** Claude Code reported that the Facebook page picker was unreachable because of a `pipedreamApp` guard. Audit revealed the entire `{ch.pipedreamApp && connected && (...)}` block was dead — every channel has `pipedreamApp: undefined` after the migration. Removed ~200 lines from `IntegrationsPage.tsx`: the page picker JSX, 6 `useState` declarations, 3 handler functions (`loadFbPages`, `selectFbPage`, `saveManualFbPageId`), 1 orphaned `useEffect`. Ported the data-driven Zernio/OAuth/Pipedream provider badge into the still-live `oauthFlow` block before deletion.

**Two attribution-data fixes (`0cfcfc55` + `8a05423c`):** Claude Code review caught `item.title` (stale queue title from staging time) being used in 8 places where `article.title` (current authoritative value) belonged — across FB Zernio, FB Pipedream-workflow, FB legacy direct, Reddit. Caught the more impactful one: 5 channels were spreading raw `utmCtx` (`{channel, brandSlug, articleSlug, campaignSlug}`) into URL query strings instead of the resolved `utmString`. **Every Facebook + Reddit + Medium URL Forge has ever published has carried garbage params** like `?channel=facebook&brandSlug=...&utm_source=facebook` instead of proper `utm_campaign` + `utm_content`. Source/medium attribution worked because of hardcoded overrides; campaign and content attribution were broken. Fixed across all 5 channels — they now match the LinkedIn/X/Ghost/WordPress pattern of using already-resolved `utmString`.

**Product page screenshots partial restore (`fafb54f8`, `07c3e988`, `e821a544`, `c5b98e79`):** Product page has been showing 6 broken thumbnails for 3 weeks — commit `f0d63192` on April 15 added 6 `<img>` tags but only modified `Product.tsx`, the actual `.png` files were never `git add`'d. Brian uploaded 3 of 6 originals tonight (Brand Profile, Content Preview, GEO Strategist Opportunity Scores). Slots 4/5/6 (Content Generator, Entity & Schema Map, Performance Dashboard) commented out tonight; tomorrow's edit is mechanical when remaining originals surface.

**Brain Memory: 2 new patterns stamped for Forge:**
- `citation_outcome_validated` (`516fcd9d`, confidence 100, `success_rate 1.0`) — Google AI Mode now synthesizes Forge's positioning using Forge's coined vocabulary. Query `forgeintelligence.ai context agent` returns "Context Agent Workspace designed to solve the 'context decay' problem in content and marketing teams" with citation badges to LinkedIn + at least 2 other sources. Recorded as outcome data feeding back into PreCog v3 calibration: articles backed by FAQ + social + structured data + external citations outperform isolated thought leadership. The chain is the citation driver, not just article quality.
- `OWNED — context decay` (`b80e16f6`, confidence 95) — first OWNED positioning term that **emerged from outcome data rather than founder declaration.** Google read Forge's content, synthesized "context decay" as the customer-facing problem the architecture solves, and the term came back as evidence. Now formalized so the next pillar article uses it consistently.

Forge brain positioning vocabulary now: **9 OWNED + 8 CONTESTED.**

### What this session proved

The Context Agent Architecture article's central thesis ("the sequence is the moat — not the model") is now empirically validated by the platform's own outcomes. Compounding evidence chain visible end to end:
- May 6 evening: 8 OWNED + 8 CONTESTED positioning_classification patterns injected into brain
- May 7 morning: 21-question FAQ ships with FAQPage schema, indexed by Google in 80 minutes
- May 7 morning: Context Agent Architecture pillar article ships, cited by AI engines within 1 hour
- May 7 evening: PreCog v2 calibration based on actual citation outcomes
- May 7-8 evening: LinkedIn + Facebook posts via Zernio
- **May 7 ~10pm: Google AI Mode synthesizes Forge's positioning using Forge's coined vocabulary**
- May 8 evening: Reddit live, "context decay" formally OWNED based on outcome evidence

Brain Memory's feedback loop is the architecture; this session's outcomes are the architecture working as designed on its own product.

### Currently in flight (next session picks up here)

- **Migrate Sandbox-XM, Sandbox-GTM, Attio LinkedIn through Zernio.** Forge is migrated; the other three brands are still on direct OAuth. Per-brand opt-in just needs the Zernio Connect flow run through Integrations + the resulting `zernioAccountId` saved.
- **Cancel Pipedream Connect plan ($150/mo saved).** Validation is complete; the FB three-tier fallback is now fully unused for Forge. Cancel via Pipedream dashboard.
- **Delete orphan Pipedream server endpoints:** `/api/facebook/pipedream/list-pages` and `/api/facebook/pipedream/select-page` — the FE no longer calls them after the dead-UI cleanup. Server-side cleanup pass.
- **Remove `FACEBOOK_PIPEDREAM_WORKFLOW_URL` env vars** from Render dashboard once dust settles.
- **Fix LinkedIn OAuth callback to MERGE credentials** instead of overwriting (`server.js` ~L9262) — manually-added fields like `zernioAccountId` get nuked when a customer clicks Reconnect. Same architectural pattern as the broader credentials-write audit (see Known patterns).
- **Reddit Phase 4: per-publish subreddit picker in queue UI** + flair selection. Architecture is in place via `req.body.publishOptions.reddit.subreddit`; the picker UI is the work. Many subreddits require flair (Zernio supports `flairId`, see `Zernio_API_Docs` L9691).
- **Update STRATEGY.md (strategy branch)** with the Zernio strategic event — locked in tonight, narrative not yet written.
- **Product page slots 4/5/6:** when Brian finds the originals (Content Generator, Entity & Schema Map, Performance Dashboard), upload as `public/4.png` etc. and uncomment three blocks in `Product.tsx`. Also worth running the 1.85 MB `Content_Preview.png` through an image optimizer.
- **Bigger Compliance Gate sweep:** brain still routing too many flags as "soften" when the underlying claim is verifiable. Sonar query tuning needed in `findCitationSources()`.
- **GeoStrategistPage UI** doesn't yet badge pillar/FAQ/auto-discovered rows even though the API now returns `source`/`deliverable`/`priority`/`isInjection`.

### Known patterns (architectural concern, surfacing repeatedly)

**Write paths replacing JSONB wholesale instead of merging.** This is the single most recurring bug pattern of the past week — instances seen this session alone:
1. LinkedIn OAuth callback overwrites `credentials` JSONB on Reconnect → wipes manually-added `zernioAccountId`
2. POST `/api/publishing/channels` upserts `credentials = $3` (full replace) → couldn't be reused for the Reddit allowed-subreddits update
3. Unpublish endpoint writes `live_status` but the publish handler reads `status` → "already published" guard skips a channel that was just unpublished
4. Unpublish doesn't wipe `publishing_queue.publish_results.{channel}` → FE chip stays "published" after a successful unpublish
5. `item.title` (queue staging-time) vs `article.title` (current) — same value stored in two columns, code reads from inconsistent ones
6. `utmCtx` raw context vs `utmParams` resolved fields — 5 channels were reading the wrong one

Worth a deliberate audit pass when there's session capacity: convention doc — "all credential JSONB updates use `||` merge, document any exceptions" + helper function for safe credential writes. Full sweep of `server.js` to find every `credentials = ...` UPDATE and convert to `credentials || ...`.

### Known unresolved bugs

- Sandbox-XM article `2b744bab-...` Frank manifest in `sections` — needs re-import via `/api/content/import`
- Rare `INSERT...ON CONFLICT` race path at `server.js` L3901 doesn't run preservation logic — edge case
- Writer API for `manual_overrides` doesn't exist yet — customers can't write to it from UI
- The first wrong-subreddit Reddit post is still live at `r/marketing/comments/1t7etyz/...` — Forge's DB no longer claims it but the post itself exists. Manual delete via Event_Philosopher Reddit account or Zernio dashboard.

---

## Action items needing Brian (not Claude)

- ~~Re-enter Forge Ghost API key in Integrations on forgeintelligence.ai (current value is corrupted)~~ — still pending
- ~~Meta App Review / Business Verification~~ **PERMANENTLY RESOLVED via Zernio (May 7-8). Off the roadmap.**
- Sign up for Zernio paid tier (currently on free trial — at $18/mo for current account count)
- Cancel Pipedream Connect plan via Pipedream dashboard ($150/mo saved)
- Find originals for Product page screenshots 4/5/6 (Content Generator, Entity & Schema Map, Performance Dashboard)
- Day 2/5/7 trial nurture email sequence
- GSC sitemap resubmission + Validate Fix on Duplicate Without Canonical
- Trademark lawyer (FORGE Intelligence LLC Atlanta squatter UDRP/TTAB)
- Stripe/banking/vendor entity migration, EIN setup
- Charter Partner counter-offer to Lili (Culture+)

---

## Pointers

- **Long-form session archive:** `WHITEBOARD.md` (append-only, every meaningful session debrief). New entry tonight covers the full Zernio migration + Reddit wire-up.
- **Strategic narrative + positioning history:** `strategy` branch → `STRATEGY.md`
- **Operating protocol for any session:** `docs/SESSION-PROTOCOL.md`
- **Repo access + tokens + relay:** see top of `WHITEBOARD.md` or repo description
- **Zernio API docs:** `/mnt/project/Zernio_API_Docs` (full schema reference). Reddit-specific: L9092+. Field name is `platformSpecificData`, not `platformOptions`.
- **Key brand profile IDs:**
  - Forge `cde5feeb-b3d7-4990-adee-a54977ab9c52` — Zernio: LinkedIn ✅, Facebook ✅, Reddit ✅
  - Sandbox-XM `dd482396-6673-4675-9892-841dad29fbc3` — Zernio: pending migration
  - Sandbox-GTM `61d1f187-c00a-443c-ada2-a073afa005cd` — Zernio: pending migration
  - Attio `ecc37c27-4e21-40f9-af54-f62967221de6` — Zernio: pending migration
  - Intel `a4c11262-71a0-4ab9-a7bc-83ede613c6f0`
- **Zernio account IDs (Forge):**
  - LinkedIn: `69fd58a192b3d8e85f946586` (FORGE by Sandbox org `urn:li:organization:112436202`)
  - Facebook: `69fd5e7592b3d8e85f949c44` (page `1004505509420749`)
  - Reddit: `69fe1e8192b3d8e85f9ed161` (account `Event_Philosopher`, profile `69fdfa6cb7ff8f8d35d74e92`)
- **Active services on Render:**
  - Production `srv-d73bct6a2pns73a8c65g` → `forgeintelligence.ai` (production branch)
  - Development `srv-d726u7ea2pns739kopmg` → `dev.forgeintelligence.ai` (main branch)
  - Strategy `srv-d7g3213bc2fs73dt675g` → `strategy.forgeintelligence.ai` (strategy branch)
