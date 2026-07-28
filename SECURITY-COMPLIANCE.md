# SECURITY-COMPLIANCE.md

Working tracker for Forge Intelligence's security + data-protection posture, anchored to issue **#25 (EU AI Act Compliance Layer, P0)**. Read alongside `WORKING-STATE.md` (live pointer) and `BUILD-HISTORY.md` (archive).

**Not legal advice** — this is engineering-informed analysis to *prepare data and structure the work*. The Annex-III high-risk determination, lawful-basis calls, and any DPIA are decisions for counsel. Items below marked **[legal]** need a human legal gut-check before they're considered closed.

---

## Compliance Checklist

Adapted from the GDPR implementation playbook (community skill, `gdpr-data-handling`), annotated with Forge's real status. Status key: ✅ done · 🟡 partial · ⬜ todo · ⛔ N/A (with reason).

### Legal Basis
- ⬜ **[legal]** Documented legal basis (Art. 6) for each processing activity — esp. the `reviewers` / email-campaign contact emails (the B2B legitimate-interest grey zone)
- ⬜ Consent mechanisms meet GDPR requirements (see "Consent" below — currently no consent layer; the LinkedIn Insight Tag is the only third-party tracker and is disclosed)
- ⬜ **[legal]** Legitimate-interest assessments completed (competitor-crawl personal data; `reviewers`)

### Transparency
- ✅ Privacy policy clear and accessible (`/privacy`, PrivacyPage.tsx; refreshed 2026-06-12 #357 — added Jina/Bright Data/OpenAI/Gemini/ValueSERP processors)
- ✅ Processing purposes clearly stated (Privacy §2/§4)
- 🟡 Data retention periods documented (privacy policy states some; not enforced in code — see Retention)
- ✅ **AI-content transparency (EU AI Act Art. 50, applies Aug 2026):** machine-readable IPTC `digitalSourceType` (compositeWithTrainedAlgorithmicMedia) in the public article JSON-LD + a visible reader disclosure in the article footer (#394). Video skill already discloses AI voice. _Pending:_ disclosure on externally-syndicated copies (HubSpot/Webflow/etc.) — a content-mutation product decision, deferred.

### Data Subject Rights (DSAR) — must respond within 30 days
- ✅ Access request (Art. 15) — `dsar.lookup` across reviewers / support tickets / Factual Ground authors (#391)
- ✅ Erasure request (Art. 17) — `dsar.erase`: reviewers deleted, support tickets redacted (row kept as evidence), authors pulled from JSONB (#391)
- ✅ Portability export (Art. 20) — JSON export from the Data Requests page (#391)
- 🟡 Rectification (Art. 16) — authors editable in Brand Settings today; no unified cross-table rectify (deferred)
- ⬜ 30-day deadline tracking (no self-service intake yet — DSAR is super-admin-operated)

### Security
- ✅ Encryption in transit (TLS everywhere — Render/Neon)
- 🟡 Encryption at rest for PII — Neon encrypts at rest at the platform level; **no app-level field encryption** on PII (author bios, contact emails). Acceptable for many buyers; enterprise/regulated may ask for more. **[legal]/buyer-driven**
- ✅ Access controls — Clerk JWT + RLS + ownership checks (3-layer, per privacy §5)
- ✅ **Audit logging** — unified `audit_log` table + `recordAudit()` + Settings → Audit Log (read/filter/CSV-export, super-admin only); shipped #388. Live write seams: relay queries, brand mutations, exports, **DSAR access/erase (#391)**. _Pending follow-ons:_ read-view logging.

### Breach Response
- 🟡 Breach detection mechanisms — incident discipline + audit-log evidence capture documented in `BREACH-RUNBOOK.md`; no automated anomaly alerting yet.
- 🟡 **[legal]** 72-hour authority notification process — documented (`BREACH-RUNBOOK.md` Steps 2–4); needs the supervisory authority + DPO/contact confirmed.
- ✅ Breach documentation system — runbook Step 5 + incident-log discipline (Art. 33(5)); the audit log is the evidence substrate.

### Documentation
- 🟡 Records of processing activities (Art. 30) — DPA Annex I (processing details) + the sub-processor SSOT now cover the substance (#396); not yet a standalone RoPA document.
- ⬜ **[legal]** DPIA (if required — judgment call)
- ✅ Data Processing Agreement (DPA) + sub-processor list — live shareable pages `/dpa` + `/subprocessors` and an attorney-review Word export (#396). _Binding contract language pending counsel finalization._
- 🟡 **[legal]** EU AI Act risk-tier memo: drafted in `EU-AI-ACT-RISK-MEMO.md` (limited-risk position, Art. 50 only, not Annex III, deployer-not-provider for GPAI). Pending counsel sign-off + an AUP clause prohibiting high-risk decisioning use of Forge output.

### Data Residency / Transfers
- 🟡 **[legal]** International-transfer basis (SCCs / adequacy) — now *documented* in DPA §11 + the sub-processors page transfers section (#396); Forge remains US-all-the-way (Render US, Neon `us-west-2`, Anthropic/OpenAI/Jina/Bright Data/ValueSERP US), so the SCC completion + transfer-impact assessment still need counsel sign-off. **The real enterprise-EU-deal blocker, not "high-risk."**

---

## Regime reframe (why the #25 title is a trap)

Issue #25 conflates three regimes with very different cost and applicability:

1. **GDPR** — real, present, applies today. The actual work. Driven by "required for regulated industries" = a *documentation + evidence-export* need for procurement, not a re-architecture.
2. **EU AI Act Art. 50 (transparency)** — real, applies **Aug 2026**, cheap. AI-content must be machine-readably marked. The only AI Act obligation that genuinely bites a marketing-content generator.
3. **EU AI Act high-risk (Annex III + Art. 9–15)** — **almost certainly N/A.** Generating marketing content is not on the Annex III list. Do **not** build conformity-assessment machinery; write a one-page position memo instead. **[legal]** to confirm, esp. if a customer uses Forge output in an HR/credit context (could pull *their* deployment into high-risk, not Forge's).

## Forge's actual personal-data surface (from the 2026-06-12 pipeline audit)

- **Personal data (the GDPR-sensitive set):** Factual Ground `authors` (name/title/bio/LinkedIn), `competitorAnalysis` crawl (can surface named execs), `reviewers` / email-campaign recipient emails (third-party PII — the hottest spot). _(`outreach_contacts` was here — removed 2026-06-13, #384; see change log.)_
- **Deliberately NOT personal data (a design win):** the GEO citation probe sends *brand-free buyer questions* (constraint written into #351); "who AI cites instead" is domains, not people. Forge's newest subsystem is clean by construction — state this in any compliance doc.
- **Not personal data:** brain patterns/mistakes (derived from content performance), citation-tracker results (domains).

---

## Audit Log — build spec (the #25 substrate)

Single page under **Settings → Audit Log**, super-admin-gated (same as Mission Control). Every DSAR/consent/retention feature writes to this; build it first.

### Auth
- **Server (every endpoint):** `requireAuth` → `if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403)` (the `logs/stream` pattern — the *strict* MC gate, not the dashboard one).
- **Client nav:** extend `Sidebar.tsx:568` filter to gate `'audit-log'` alongside `'admin'` on `isSuperAdmin`.

### Table — `audit_log` (model on `agent_activity_log`, idempotent `CREATE TABLE IF NOT EXISTS`)
`id` UUID PK · `actor_clerk_user_id` TEXT · `actor_email` TEXT (best-effort) · `action` TEXT (closed vocab) · `target_type` TEXT · `target_id` TEXT (no FK — survives deletes) · `brand_profile_id` TEXT (null = platform-level) · `summary` TEXT · `metadata` JSONB · `ip` TEXT · `user_agent` TEXT · `created_at` TIMESTAMPTZ. Indexes on `created_at DESC`, `(actor, created_at)`, `(brand, created_at)`, `(action, created_at)`. **No auto-purge** — this is the evidence; the boot-time orphan purge must never touch it.

### Write helper — `src/server/audit.js`
`recordAudit({ req, action, targetType, targetId, brandProfileId, summary, metadata })` — best-effort, try/catch, never throws/blocks (the `raiseAnomaly`/`void notifyX` discipline). `actor_clerk_user_id` = `req.userId` (always); `actor_email` best-effort (JWT carries only `sub`, so resolve from the users table or Clerk; don't block on it).

### Write seams (the personal-data + privileged surfaces)
DSAR export/delete · admin relay query (persist the truncated-SQL line it already console-logs) · Mission Control access · CRM/handoff PII pushes · reads/writes of `reviewers`/email recipients/Factual Ground authors · brand deletion/reset · **audit-log export itself** (self-documenting).

### Read/export API — `GET /api/admin/audit-log`
Strict gate. Filters: `actor`, `action`, `targetType`, `brandProfileId`, `from`, `to`, `limit` (≤500), `offset`, `format=csv`. CSV = the compliance evidence artifact (`Content-Disposition: attachment`); the export call writes its own `audit_log.export` row.

### UI — `AuditLogPage` → `/app/audit-log`
`AppShell`, reuse `AdminPage`'s `getToken()`+fetch. Filter bar (date/actor/action/brand) → debounced refetch · table (Time · Actor · Action chip · Target · Summary, row-expand metadata JSON) · **Export CSV** button (honors filters) · offset pagination. Genuinely one page.

### Scope boundary
This is the audit subsystem only — table, helper+seams, read/export API, page. **Not** the DSAR endpoints, consent management, DPA page, or AI-content transparency (those build *on top* and *call into* it).

---

## #25 decomposition (recommended sub-issues)

1. **Audit log subsystem** (spec above) — ✅ **BUILT (#388)**, the substrate. Follow-on: read-view logging (DSAR write seams now wired via #391).
2. **GDPR DSAR endpoints** — ✅ **BUILT (#391)**: access/export/erase across reviewers, support tickets, and Factual Ground authors; writes to the audit log. Deferred: rectification, self-service intake, 30-day-deadline tracking.
3. **AI-content transparency** (Art. 50 marker on articles) — ✅ **BUILT (#394)**: JSON-LD IPTC marker + visible footer disclosure on the Forge-controlled public render. Deferred: external-CMS body disclosure (product decision).
4. **DPA + sub-processor page + RoPA** — ✅ **BUILT (#396)**: `/dpa` + `/subprocessors` live pages, the sub-processor SSOT (privacy policy renders from it), and the attorney-review Word export. RoPA substance lives in DPA Annex I. Remaining: counsel finalizes the binding DPA terms; a standalone RoPA if desired.
5. **EU AI Act risk-tier memo** (limited-risk, not high-risk) — 🟡 **DRAFTED** (`EU-AI-ACT-RISK-MEMO.md`); counsel sign-off pending. Did **not** build conformity machinery (correctly N/A).
6. **Data-residency / transfer basis** — **[legal]** assessment; the real enterprise-EU blocker.
7. **Breach-notification runbook** — 🟡 **DRAFTED** (`BREACH-RUNBOOK.md`); needs Incident Lead / DPO / supervisory authority named + the DPA processor-notification window confirmed.

---

## Change log

### 2026-06-15 — Risk-tier memo + breach runbook drafted
The two remaining #25 documents drafted for review (no code): `EU-AI-ACT-RISK-MEMO.md` (Forge = limited-risk, Art. 50 transparency only — implemented in #394 — not Annex III high-risk; deployer-not-provider for GPAI; with the buyer-due-diligence posture) and `BREACH-RUNBOOK.md` (GDPR Arts. 33–34 playbook grounded in the real stack — audit-log evidence capture, Render single-key cred rotation, Resend notification, DPA processor→controller step). Both bannered DRAFT with `[legal]`/`[confirm]` placeholders for the items only counsel/founder decide (supervisory authority, DPO/Incident-Lead, notification windows, AUP clause). This closes out everything in #25 that doesn't require counsel's own words — what remains is sign-off, not authoring.

### 2026-06-13 — Shareable DPA + sub-processor pages + SSOT (#396)
Live, no-nav pages a customer's legal team gets by URL: `/subprocessors` (Art. 28 list as a dated table, Forge sub-processors vs customer-directed integrations) and `/dpa` (standard SaaS DPA terms + Annexes, execute-by-contact). Sub-processor data centralized in `src/data/subprocessors.ts` (SSOT); Privacy Policy Section 6 now renders from it, killing the #357 drift. Footer-linked. An attorney-review Word export (DPA with the sub-processor list as Annex III, Forge-specific Annexes I/II) was delivered to Brian for counsel. Closes the DPA/sub-processor procurement-artifact line; binding contract language + transfer-mechanism completion remain with counsel.

### 2026-06-13 — AI-content transparency marker shipped (#394)
Sub-issue #3 (EU AI Act Art. 50, the cheap time-boxed one): the public server-rendered article now emits a machine-readable IPTC `digitalSourceType = compositeWithTrainedAlgorithmicMedia` on its Article JSON-LD (the Google/IPTC-recognized AI-content signal; "composite" = AI draft under Compliance-Gate human review), and the public React article footer carries a visible reader disclosure. Closes the Transparency checklist line. Deferred: disclosure appended to externally-syndicated article bodies (HubSpot/Webflow/Ghost/WordPress/Medium) — that mutates published content and is a product decision, not a unilateral one.

### 2026-06-13 — DSAR access/export/erase shipped (#391)
Sub-issue #2 built and is the first real writer into the audit log: `POST /api/admin/dsar/lookup` (`dsar.access`) + `POST /api/admin/dsar/erase` (`dsar.erase`, `confirm:true`-gated) across reviewers (deleted), support tickets (redacted — row kept as request evidence), and Factual Ground authors (removed from the brand JSONB); Settings → Data Requests page with JSON export (portability). Honest coverage note: free-text surfaces (competitorAnalysis/personas/article bodies) aren't key-erasable → flagged for manual review. Closes the DSAR access/erasure/portability checklist lines; rectification + 30-day-deadline tracking + self-service intake remain.

### 2026-06-13 — Audit log subsystem shipped (#388)
Sub-issue #1 built: `src/server/audit.js` (`audit_log` table, self-creating, never auto-purged; `recordAudit()` best-effort writer) + `GET /api/admin/audit-log` (filter/paginate/CSV) + `.../actions` + the Settings → Audit Log page, all strict super-admin gated. v1 write seams: `relay.query`, `brand.reset_paid`, `brand.seed`, and the CSV export self-logs. This is the substrate every later GDPR feature writes into. Deferred: read-view logging (noise) and DSAR seams (endpoints not built yet — sub-issue #2).

### 2026-06-13 — Dead cold-outreach feature + its PII removed (#384)
The `outreach_contacts` table flagged above as "the hottest spot" is **gone**. It was a one-time April cold-email experiment (126 real contacts loaded Apr 10–11, dormant since, owned by no one); outreach now runs through HubSpot. Brian CSV-exported the contacts + log for historical records, then authorized full removal: the `/api/outreach/*` routes + cold `/unsubscribe` deleted from `server.js`, the `outreach_contacts` + `outreach_log` DDLs removed from `init-schema.sql`, route snapshot regenerated, and both tables DROPPED from prod Neon (126 + 78 rows). Prod carried an `outreach_log_contact_id_fkey` not in the committed schema — **schema-drift flag** for the eventual fresh-DB setup. Net: a documented-PII liability eliminated rather than governed.

### 2026-06-13 — Admin-auth hardening + this doc
First concrete security item. Audited all 22 `/api/admin/*` routes; password-gated utilities (relay, backfills, api-keys, indexnow, digest, scrape-log, facebook/diag, mark-unpublished) are correctly gated. Fixed five gaps (PR pending):
- `/api/admin/activity` — was **unauthenticated**; added `requireAuth` + super-admin gate.
- `/api/admin/stats` — was **unauthenticated**; added `requireAuth` + super-admin gate.
- `/api/admin/seed-brain` — was **unauthenticated WRITE** (creates brand profiles); added relay-password gate (fails closed).
- `/api/admin/mission-control` — `requireAuth` only; added super-admin gate (the originally-flagged item).
- `/api/admin/reset-brand-paid` — removed a dead precedence-buggy gate (`!x === y`); the real password gate beneath it was already correct, so this was a landmine, not a live hole.
None of the three unprotected endpoints had any in-app or script caller, and the MC UI always sends a Bearer token — so the fixes break nothing. Closes the "Audit logging enabled / Access controls" checklist line's most urgent prerequisite. Audit-log *subsystem* still to build (spec above).
