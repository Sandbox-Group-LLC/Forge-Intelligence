# EU AI Act — Risk-Tier Position Memo (Forge Intelligence)

> **Status: DRAFT for counsel review.** This is an engineering-informed position paper to support a legal determination, not legal advice. It is the artifact regulated-industry buyers' legal teams typically ask for. Items needing counsel sign-off are marked **[legal]**. Companion to `SECURITY-COMPLIANCE.md` and `TOS-AI-OUTPUT-LIABILITY-REDLINE.md`.

## Summary position

**Forge Intelligence is a limited-risk AI system under the EU AI Act (Regulation (EU) 2024/1689).** Its only operative obligation is the **Article 50 transparency** duty (mark AI-generated content), which is implemented for text and voice (see "What we've done") and has an **open implementation item for image/video/audio** (see synthetic-media section). Forge is **not** a high-risk AI system under Annex III, and the high-risk obligations (Articles 9–15: risk-management system, conformity assessment, technical file, registration) **do not apply**. Building that machinery would satisfy an obligation Forge does not have.

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

## Synthetic image / video / audio (fal) — Art. 50(2) and 50(4)

> Added 2026-06-30 following the ToS AI-output-liability review (`TOS-AI-OUTPUT-LIABILITY-REDLINE.md`), which formally brings **images, video, and audio** into scope as Generated Content produced via third-party models (e.g. fal). The Art. 50 analysis above was written for **text** (articles) and synthetic **voice**; visual/audio media needs its own line.

Art. 50 splits into a provider-side marking duty and a deployer-side disclosure duty, and both bite harder for synthetic visual/audio media than for text:

- **Art. 50(2) — machine-readable marking.** Outputs of AI that generate synthetic audio, image, video, or text must be marked, in a machine-readable format, as artificially generated or manipulated. For text/voice this is handled (#394). **[eng] Confirm** each image/video/audio artifact from fal carries an equivalent marker — C2PA Content Credentials and/or the IPTC `digitalSourceType` (`trainedAlgorithmicMedia` for fully generated, `compositeWithTrainedAlgorithmicMedia` for edited) — either embedded by fal or attached by Forge's pipeline on export.
- **Art. 50(4) — deepfake disclosure.** Deployers of AI that generates or manipulates image/audio/video constituting a "deep fake" must disclose that the content is artificially generated or manipulated. Brand imagery that does not depict real, identifiable persons/places/events may fall outside the strict deepfake definition, but the safe, low-cost posture is to **disclose/label all AI-generated visual and audio media**, not to adjudicate deepfake status per asset.

**[eng] Implementation gaps to confirm before Aug 2026:**
- Does fal output embed C2PA / Content Credentials, or must Forge attach the marker on generation/export? If the latter, it is not yet built for image/video the way #394 built it for article text.
- The video pipeline discloses synthetic **voice** — extend the same disclosure to fully AI-generated **video frames/scenes**, not just the audio track.
- Syndication: same open question as text — whether markers/disclosure ride on media copied to external platforms.

**[legal] Positioning.** For the generation feature Forge is the party placing AI-generated media into use, so the Art. 50(4) deployer-disclosure hook is the relevant one; the Art. 50(2) marking duty should be satisfied on export regardless. This does **not** change the limited-risk tier — it is still an Article 50 transparency duty, extended to new media types. It is **separate from** the IP-infringement risk the ToS amendment allocates: transparency labeling and IP indemnity are different regimes and both need handling.

## Provider vs. deployer; GPAI

Forge is a **deployer** of general-purpose AI models (Claude, GPT) — and of third-party image/video/audio generators made available through the Service (e.g. fal) — not a **provider** of them. The GPAI model obligations (Article 53 et seq. — training-data summaries, copyright policy, model documentation) fall on the upstream model providers (Anthropic, OpenAI, and the image/video model providers), not on Forge. Forge's obligations are the downstream, lighter deployer/transparency duties addressed above.

## Timeline

- **Aug 2025** — GPAI obligations (on the model providers, not Forge).
- **Aug 2026** — Art. 50 transparency obligations apply. Forge's implementation is in place for **text and voice**; **image/video/audio marking is the open item** (see synthetic-media section).
- High-risk obligations (not applicable to Forge) phase in 2026–2027.

## Recommended posture for buyer due-diligence

When a regulated-industry prospect's legal team asks "is this a high-risk AI system / what's your AI Act conformity status," the answer is: *Forge is a limited-risk system; it meets the Art. 50 transparency obligation (machine-readable marker + disclosure); it is not an Annex III high-risk system and does not make decisions about individuals; GPAI obligations sit with the underlying model providers.* This memo + the DPA + the sub-processor list are the package.
