# SECURITY-COMPLIANCE.md

Working tracker for Forge Intelligence's security + data-protection posture, anchored to issue **#25 (EU AI Act Compliance Layer, P0)**. Read alongside `WORKING-STATE.md` (live pointer) and `PLAN.md` (archive).

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
- ⬜ **AI-content transparency (EU AI Act Art. 50, applies Aug 2026):** machine-readable "AI-generated" marker on published articles. Video skill already discloses AI voice; articles need a JSON-LD/meta marker. *Cheapest + most clearly-applicable AI Act obligation.*

### Data Subject Rights (DSAR) — must respond within 30 days
- ⬜ Access request (Art. 15) — export a person's data across the personal-data tables
- ⬜ Erasure request (Art. 17) — delete across the same, with legal-hold exceptions
- ⬜ Portability export (Art. 20) — JSON machine-readable
- ⬜ Rectification (Art. 16)
- ⬜ 30-day deadline tracking

### Security
- ✅ Encryption in transit (TLS everywhere — Render/Neon)
- 🟡 Encryption at rest for PII — Neon encrypts at rest at the platform level; **no app-level field encryption** on PII (author bios, contact emails). Acceptable for many buyers; enterprise/regulated may ask for more. **[legal]/buyer-driven**
- ✅ Access controls — Clerk JWT + RLS + ownership checks (3-layer, per privacy §5)
- 🟡 **Audit logging** — fragmented (relay console lines, `agent_activity_log`, brain trails). **No unified audit log yet** → spec below; this is the #25 substrate.

### Breach Response
- ⬜ Breach detection mechanisms
- ⬜ **[legal]** 72-hour authority notification process
- ⬜ Breach documentation system

### Documentation
- 🟡 Records of processing activities (Art. 30) — privacy policy + sub-processor list cover most; not a formal RoPA
- ⬜ **[legal]** DPIA (if required — judgment call)
- ⬜ Data Processing Agreement (DPA) + signable sub-processor list (the artifact regulated buyers ask procurement for)
- ⬜ **[legal]** EU AI Act risk-tier memo: position Forge as a *limited-risk* system (Art. 50 transparency only), **not** Annex-III high-risk. One page; it's what regulated buyers' legal teams actually want.

### Data Residency / Transfers
- ⬜ **[legal]** International-transfer basis (SCCs / adequacy) — Forge is US-all-the-way (Render US, Neon `us-west-2`, Anthropic/OpenAI/Jina/Bright Data/ValueSERP US). EU customer data leaving the EU is a transfer question. **The real enterprise-EU-deal blocker, not "high-risk."**

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

1. **Audit log subsystem** (spec above) — BUILD FIRST, the substrate.
2. **GDPR DSAR endpoints** (export/delete/rectify across the personal-data tables) — BUILD, writes to the audit log.
3. **AI-content transparency** (Art. 50 marker on articles) — BUILD, small, time-boxed to Aug 2026.
4. **DPA + sub-processor page + RoPA** — DOCUMENT (the procurement artifacts).
5. **EU AI Act risk-tier memo** (limited-risk, not high-risk) — DOCUMENT one page, **don't build** conformity machinery. **[legal]**
6. **Data-residency / transfer basis** — **[legal]** assessment; the real enterprise-EU blocker.
7. **Breach-notification runbook** — DOCUMENT.

---

## Change log

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
