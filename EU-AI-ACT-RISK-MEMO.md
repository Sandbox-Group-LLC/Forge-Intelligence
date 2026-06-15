# EU AI Act — Risk-Tier Position Memo (Forge Intelligence)

> **Status: DRAFT for counsel review.** This is an engineering-informed position paper to support a legal determination, not legal advice. It is the artifact regulated-industry buyers' legal teams typically ask for. Items needing counsel sign-off are marked **[legal]**. Companion to `SECURITY-COMPLIANCE.md`.

## Summary position

**Forge Intelligence is a limited-risk AI system under the EU AI Act (Regulation (EU) 2024/1689).** Its only operative obligation is the **Article 50 transparency** duty (mark AI-generated content), which is implemented (see "What we've done"). Forge is **not** a high-risk AI system under Annex III, and the high-risk obligations (Articles 9–15: risk-management system, conformity assessment, technical file, registration) **do not apply**. Building that machinery would satisfy an obligation Forge does not have.

## Why not high-risk (Annex III)

Annex III is a **closed list**. A system is high-risk only if it falls within one of its enumerated use-cases — biometrics, critical infrastructure, education/vocational access, employment and worker management, access to essential private/public services (incl. creditworthiness and insurance), law enforcement, migration/asylum/border control, or administration of justice and democratic processes.

Forge **generates marketing and brand content** (articles, social posts, ads, campaign briefs) from a brand's own intelligence. It does not:
- make or materially inform decisions about a natural person's access to employment, credit, insurance, education, essential services, or benefits;
- perform biometric identification or categorization;
- operate in law-enforcement, migration, or justice contexts.

None of the Annex III categories is engaged. Forge is therefore outside the high-risk tier.

> **[legal] One conditional to confirm:** if a *customer* used Forge's output to drive an Annex III decision (e.g. generating content used in a hiring or credit process), that customer's *deployment* could be in scope — but that is the customer's obligation as deployer of *their* system, not Forge's. The Terms / Acceptable Use should prohibit using Forge output for Annex III high-risk decisioning; confirm the AUP language covers this.

## Article 50 transparency — applies, and is implemented

Art. 50 requires that AI-generated or -manipulated content be marked in a machine-readable way and that deployers disclose AI-generated text published to inform the public. This applies to Forge and is the correct, proportionate obligation for a content generator.

**What we've done (#394):**
- **Machine-readable marker:** published articles carry the IPTC `digitalSourceType = compositeWithTrainedAlgorithmicMedia` in their Article JSON-LD (the Google/IPTC-recognized signal). "Composite" reflects AI generation under human editorial review via the Compliance Gate.
- **Human-visible disclosure:** a disclosure line in the public article footer.
- **Voiceover:** the video pipeline already discloses synthetic AI voice.

**[legal] Open:** whether the same disclosure should ride on copies syndicated to external CMSs (HubSpot/Webflow/etc.). Currently scoped to Forge's own controlled render; appending to syndicated bodies is a product decision (see SECURITY-COMPLIANCE.md).

## Provider vs. deployer; GPAI

Forge is a **deployer** of general-purpose AI models (Claude, GPT), not a **provider** of them. The GPAI model obligations (Article 53 et seq. — training-data summaries, copyright policy, model documentation) fall on the upstream model providers (Anthropic, OpenAI), not on Forge. Forge's obligations are the downstream, lighter deployer/transparency duties addressed above.

## Timeline

- **Aug 2025** — GPAI obligations (on the model providers, not Forge).
- **Aug 2026** — Art. 50 transparency obligations apply. Forge's implementation is in place ahead of this.
- High-risk obligations (not applicable to Forge) phase in 2026–2027.

## Recommended posture for buyer due-diligence

When a regulated-industry prospect's legal team asks "is this a high-risk AI system / what's your AI Act conformity status," the answer is: *Forge is a limited-risk system; it meets the Art. 50 transparency obligation (machine-readable marker + disclosure); it is not an Annex III high-risk system and does not make decisions about individuals; GPAI obligations sit with the underlying model providers.* This memo + the DPA + the sub-processor list are the package.

## [legal] Items for counsel
- Confirm the Annex III analysis and the AUP prohibition on high-risk decisioning use of Forge output.
- Confirm the deployer/provider characterization for GPAI.
- Confirm whether any Forge feature (e.g. ICP/persona scoring of named individuals) could be read as profiling that changes the analysis.
