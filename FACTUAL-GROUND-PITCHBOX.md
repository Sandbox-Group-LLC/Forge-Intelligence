# Forge Intelligence — Optimized Factual Ground for Pitch Box (handoff)

**For:** the Forge Intelligence repo agent (#forge-intelligence-agent) · **Author:** Gibson · **Date:** 2026-07-29
**Assumption:** this is for the **Pitch Box** brand profile (the GTM push we've been building — email, DMs, site,
LinkedIn page). If it's a different brand profile, repoint and I'll re-draft. Brian confirms the facts; I do NOT
invent numbers (the whole pipeline is grounded-never-invented).

---

## Why this matters (the diagnosis)

Factual Ground is `brand_profiles.settings.factualGround` — "founder-provided facts and credentials, used as
**verbatim** source material" (`marketing.js`). It feeds the content generator, social generator, compliance gate,
and geo-strategist. Every downstream stage is starved without it: the generator can only produce **statistical
anchors, factual anchors, and self-as-case-study proof** if the facts exist here. A thin Factual Ground →
qualitative, hedged, uncitable content and `[NEEDS CITATION]` flags everywhere. Optimizing it = the single highest
-leverage GEO move, same failure mode as the DM writer being starved of `connectedOn`.

**The biggest lever is dated, numeric, first-party outcomes** — a won pitch, time saved, a win-rate change. Those
become the statistical anchors + self-as-case-study proof GEO rewards most (Princeton KDD: sources +30–115%, stats
+40%, quotes +30–40%). That's the gap only Brian can fill — marked `[BRIAN: ADD REAL NUMBER]` below.

---

## The Factual Ground (copy) — fits the schema in `context-hub.js` exactly

Required: `brandName, whatWeDo, whatWeDoNot, competitors`. Optional but high-value: `foundingStory, methodology,
teamComposition, quotablePositions, namedAuthors`. (Char caps: whatWeDo/whatWeDoNot 2000, competitors/foundingStory/
methodology/quotablePositions 1500, teamComposition 1000, namedAuthors 800.)

### brandName
`Pitch Box`

### whatWeDo
Pitch Box is an AI-native RFP and pitch engine built specifically for experiential and creative agencies. It ingests
an incoming RFP, extracts every requirement and evaluation criterion, identifies the buying committee, and drafts
every section of the response from the agency's OWN case studies and knowledge base — grounded in the agency's real
evidence, never invented. It parses a full RFP (~26 sections) in about 60 seconds `[BRIAN VERIFY: current metric]`,
keeps 100% of claims traceable to a source, and produces 0 hallucinated facts. It ships with a self-building
knowledge base that scrapes the agency's own site and past work so the library compounds with every pursuit, a Bid
Qualifier that gives a go/no-go call before the team sinks senior hours into a long shot, and unlimited seats so the
whole pursuit team works in one place. The human sharpens and owns the final pitch; Pitch Box removes the blank-page
grind and the scramble to find the right proof point.

Pitch Box's coverage doesn't stop at the win. Its Consistency Engine picks up the moment an RFP is marked won: it
locks a versioned "North-Star" (the goals, KPIs, audience, voice, themes, and scope the agency actually committed to
in the winning bid), then as the team's real delivery work lands (decks, docs, planning artifacts), a forensic scan
diffs that work against the North-Star across seven dimensions and surfaces drift, including scope creep and gap,
the SOW-drift problem most RFP tools never touch because they stop at proposal submission. Every flagged drift is
human-reviewed, and every dismissal teaches the system what to ignore next time.

### whatWeDoNot  (→ becomes strategicMoats, NOT competitiveGaps)
Pitch Box is NOT a generic AI writer and NOT a content spinner. It does not invent facts, statistics, or client
outcomes — every claim it drafts is traceable to the agency's own evidence, which is the whole point: an AI that
fabricates your proof points loses you the pitch. It is not a full proposal-management suite or a CRM, and it does
not replace the pursuit team, the creative, or the strategy — it makes a strong team faster and turns their past
wins into compounding, retrievable evidence. It is not built for generic enterprise IT/security questionnaires; it
is built for the creative and experiential agency pitch motion specifically.

### competitors / who buyers also evaluate
The default alternative is the status quo: senior people hand-assembling responses in Google Docs or Word under
deadline, hunting proof points across old decks and people's heads. Buyers also evaluate: (a) generic AI writers used
raw (ChatGPT, Jasper, Copy.ai) — fast but ungrounded, they hallucinate claims an agency cannot stand behind; (b)
enterprise RFP-response platforms (Loopio, Responsive/RFPIO, Qvidian) — built for repeatable IT/SaaS security
questionnaires, not creative competitive pitches; (c) proposal/document tools (PandaDoc, Qwilr) — polish and
e-sign, not grounded drafting. `[BRIAN VERIFY: which of these you actually position against — do not list a
competitor you don't mean to name.]` The wedge vs. all of them: grounded in the agency's own evidence, and built for
the creative pitch rather than a generic writer.

### foundingStory
Pitch Box comes out of Sandbox Group LLC, founded by Brian Morgan — a designer, coder, and operator with 15 years in
brand experience and experiential marketing who has lived the RFP grind from the inside, subcontracting for
experiential agencies (Czarnowski, Sommers House) and delivering for clients like Intel and HubSpot.
`[BRIAN: ADD the specific moment that made you build it — a brutal pursuit weekend, a pitch you should have won, the
realization that win rate is an evidence problem before it's a writing problem. First-person + dated = high-value.]`

### methodology
Grounded generation. Pitch Box (1) ingests the RFP and extracts requirements, evaluation criteria, and the buying
committee; (2) retrieves matching proof from the agency's own case-study library and self-building knowledge base;
(3) drafts each section with 100% of claims traceable to that evidence and 0 invented facts; (4) runs a Bid
Qualifier go/no-go so senior time only goes to winnable pursuits; (5) hands a sharp draft to the human, who owns the
final. The principle: AI as a disciplined evidence engine, never a magic word generator.

### teamComposition
`[BRIAN: solo-founder-led out of Sandbox Group LLC (+ any collaborators). Add any real credential that lifts E-E-A-T —
e.g., "built by an operator who has personally run/won N agency pursuits" if true. Keep it factual.]`

### quotablePositions / hot takes  (this is the ONLY source the generator may quote from — real positions you'd defend)
- "The RFP grind is a capacity problem, not a talent problem. Your best people aren't slow; the evidence is scattered."
- "An AI that invents your proof points will lose you the pitch. Grounding isn't a feature, it's the whole game."
- "Win rate is an evidence problem before it's a writing problem."
- "Your best case studies are trapped in old decks and in people's heads. That's the real bottleneck."
- "You don't need a faster blank page. You need your own wins, retrievable at pursuit speed."
- "Winning the RFP isn't where agency risk ends. It's where it starts: scope creep and SOW drift happen after the
  signature, and almost nobody instruments it."
`[BRIAN: cut/rewrite to your actual voice; add the ones you'd say on a stage.]`

### namedAuthors  (the only humans the generator may attribute quotes to)
Brian Morgan — Founder, Sandbox Group LLC / Pitch Box. 15 years in brand experience and experiential marketing; fine
arts (Penn State); building on the web since 2001; has delivered for Intel and HubSpot and subcontracted for major
experiential agencies. `[BRIAN: confirm the exact title/byline you want, + add any other real, quotable teammate.]`

---

## `[BRIAN: ADD REAL NUMBERS]` — the highest-value gap (dated, first-party, verifiable)

These are what turn hedged prose into cited authority. Only add ones that are TRUE:
- A real pursuit outcome: "cut a [Czarnowski] RFP response from **X days to Y**," or "drafted a 26-section RFP in
  **~60 seconds** vs. a typical **N-hour** first pass."
- A win: "used Pitch Box on **[named/anonymized pursuit]**, **won**, **$X** engagement" (dated).
- Adoption: seats, agencies onboarded, RFPs processed to date — any real count with a date.
- Anything you'd put your name behind on-chain. Leave blank rather than estimate; the generator flags gaps itself.

---

## Instructions for the Forge agent

1. **Target:** the **Pitch Box** brand profile in Forge Intelligence's `brand_profiles`. Confirm the row before writing.
2. **Load:** set `settings.factualGround` to the object above (keys verbatim: `brandName, whatWeDo, whatWeDoNot,
   competitors, foundingStory, methodology, teamComposition, quotablePositions, namedAuthors`) via the Context Hub
   path (`context-hub.js` `handleQuickStartSynthesis` / the Factual Ground input). Stamp `_updatedAt`.
3. **Strip the `[BRIAN ...]` / `[BRIAN VERIFY]` placeholders** before saving — do NOT persist bracketed instructions
   as facts. Any field Brian hasn't filled: omit it rather than ship a placeholder as source material.
4. **Do not fabricate.** Only Brian-verified facts go in. Where a number is missing, leave it out; the generator
   correctly emits `[NEEDS CITATION]` and yellow/red confidence, which is the intended behavior.
5. **After load:** regenerate one article + one social post and check that `overallConfidence`/`brainMatchScore`
   climb and that sections now carry statistical + factual anchors instead of qualitative filler. That's the proof
   the Factual Ground optimization landed.

**Scope guard:** Pitch Box brand profile only. Do not touch other brands' Factual Ground.
