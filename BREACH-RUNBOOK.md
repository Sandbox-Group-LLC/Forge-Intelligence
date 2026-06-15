# Personal Data Breach Runbook (Forge Intelligence)

> **Status: DRAFT for founder + counsel confirmation.** Operational playbook for a personal-data breach under GDPR Arts. 33–34. Items needing your/counsel input are marked **[confirm]**. Companion to `SECURITY-COMPLIANCE.md`. Not legal advice.

## What counts as a breach
A "personal data breach" = a breach of security leading to accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to personal data. For Forge that includes, e.g.: a leaked credential exposing the Neon database or a sub-processor key (cf. the 2026-06-10 AWS-key incident), an auth gap exposing cross-tenant data (cf. the admin-endpoint gaps closed in #383), unauthorized access to `reviewers` / Factual Ground author PII, or a sub-processor's breach affecting Forge data.

## Roles **[confirm]**
- **Incident Lead** — [Brian / named owner]: owns the response, decides severity, authorizes notifications.
- **DPO / privacy contact** — [name + email; or "no DPO appointed; privacy contact = legal@forgeintelligence.ai"].
- **Supervisory authority** — [the lead EU/UK supervisory authority for affected data subjects — confirm with counsel; depends on establishment / representative].

## Step 0 — Detect & contain (immediately)
1. Contain: rotate exposed credentials (Render env single-key PATCH — never the bulk PUT), revoke tokens, take the affected surface offline if needed.
2. Preserve evidence: capture the **audit log** (Settings → Audit Log / `audit_log` table — privileged + data-access events) and relevant server logs *before* remediation overwrites state.
3. Open an incident record (timestamp, what's known, who's responding).

## Step 1 — Assess (clock starts at awareness)
- What data, whose, how many records/subjects, what categories (the third-party PII surface: `reviewers`, `support_tickets`, Factual Ground authors; account holders via Clerk).
- Likelihood + severity of risk to individuals' rights and freedoms.
- Severity tiers: **Low** (no/negligible risk — document, no external notice) · **Medium/High** (risk to individuals — authority notice required) · **Critical** (high risk — also notify affected individuals).

## Step 2 — Notify the supervisory authority (Art. 33) — **within 72 hours of awareness**
Required **unless** the breach is unlikely to result in a risk to individuals. If notifying >72h late, include reasons for the delay. Notification includes: nature of the breach, categories + approximate number of data subjects and records, DPO/contact, likely consequences, and measures taken/proposed. **[confirm]** notification channel + the authority.

## Step 3 — Notify affected individuals (Art. 34) — without undue delay
Required when the breach is likely to result in a **high** risk to individuals. Communicate in clear language: nature of the breach, contact point, likely consequences, measures taken. Not required if data was encrypted/unintelligible, or if subsequent measures neutralized the high risk, or if it would involve disproportionate effort (then a public communication instead). Delivery: Resend (transactional email) to affected addresses. **[confirm]** template owner.

## Step 4 — As a processor for customers (DPA Section 8)
Where the breach affects **Customer** Personal Data and Forge is the processor, notify the affected **Customer(s) without undue delay** (DPA target: within **[72]** hours) and assist them with their own Art. 33/34 obligations. The customer (controller) generally drives authority/individual notification for their data.

## Step 5 — Document (Art. 33(5))
Record **every** breach — including those not notified — with facts, effects, and remedial action, in the incident log. This documentation is itself a compliance obligation and is what an auditor reviews.

## Step 6 — Post-incident
Root-cause writeup (PLAN.md retrospective), guardrails to prevent recurrence (e.g. the auth-gap class fix in #383, the leaked-key rotation discipline), and update this runbook if the response surfaced gaps.

## Quick reference
| Clock | Action |
|---|---|
| Immediately | Contain, rotate creds, preserve audit log |
| ASAP | Assess scope + risk tier |
| ≤ 72h from awareness | Supervisory authority (Art. 33) if risk to individuals |
| Without undue delay | Affected individuals (Art. 34) if high risk |
| ≤ [72]h | Affected customers (processor → controller, DPA §8) |
| Always | Document in the incident log (Art. 33(5)) |

## [confirm] Before this is operational
- Name the Incident Lead + privacy contact + supervisory authority.
- Confirm the processor→controller notification window in the executed DPA.
- Decide breach-notification email templates + who sends.
