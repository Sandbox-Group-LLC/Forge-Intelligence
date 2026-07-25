// Anti-AI-tell style constraints for the long-form writers.
//
// Why this exists: a third-party AI-writing detector run against a published
// Forge article found the vocabulary layer clean (no "delve"/"tapestry"/
// "robust", no em dashes) but the RHETORICAL ARCHITECTURE fully intact and
// extremely dense: 20+ "not X, it is Y" constructions (one per ~140 words),
// rule-of-three scaffolding at the section level six times, verbatim concept
// repetition across sections, and a case study with no company/year/number.
// Its takeaway: "whoever built this pipeline solved the vocabulary problem and
// skipped the structural one. Banning delve is cosmetic."
//
// The em-dash rule is the sharpest lesson. Telling a model "no em dashes, use
// commas instead" makes it swap a comma in WITHOUT restructuring, producing
// ungrammatical appositives that are a louder tell than the dash was:
//   "Resonance, engagement metrics, time on page, email opens, asset
//    downloads, is captured by nearly every martech configuration"
// So the rule below bans the dash AND bans the comma substitution.
//
// Constraints are budgets, not bans: these are legitimate rhetorical moves that
// only read as machine-written at pathological density.
export const ANTI_AI_STYLE = `
═══════════════════════════════════════════════════════════════════════════
STYLE CONSTRAINTS — RHETORICAL ARCHITECTURE (mandatory)
═══════════════════════════════════════════════════════════════════════════
These govern SENTENCE SHAPE, not word choice. A clean vocabulary with this
architecture still reads as machine-written. Treat each as a hard budget.

1. NEGATIVE PARALLELISM — at most 2 in the entire article.
   The pattern is "It is not X, it is Y" and every punctuation variant of it:
   "X, not Y" / "X. Not Y." / "not just X but Y" / "This is not a P problem.
   It is a Q problem." Swapping the punctuation does NOT make it a different
   move. After two, make the point directly: state what is true and move on.

2. NO EM DASHES, AND DO NOT SUBSTITUTE A COMMA.
   Never emit the "—" character. When a sentence wants one, REWRITE the
   sentence so it does not need one: split it in two, use a colon, or use
   parentheses. Never drop a comma into a slot where a dash was doing the work
   of setting off an appositive; that produces an ungrammatical sentence with
   a subject and verb separated by an unmarked list. Read every sentence you
   write for this specific failure before finalizing.

3. VARY LIST LENGTH — do not default to three.
   Three-item lists ("documented, versioned, and used") are the single most
   common machine tell. Use 2, 4, or 5 items when that is what is true. Never
   scaffold consecutive sections on a count ("Three failure modes", "three
   signals", "three decisions"); at most ONE counted-list section heading per
   article, and only when the count is real rather than chosen for balance.

4. VARY SENTENCE LENGTH DELIBERATELY (burstiness).
   Uniform 12-18 word sentences are a statistical fingerprint. Mix genuinely
   short sentences with long complex ones inside the same paragraph. Do not
   manufacture this with a staccato opener and then settle into a uniform
   body; the variance has to run through the whole piece.

5. NAMED SPECIFICS OR NOTHING — no evidence-shaped filler.
   Never write an anonymized case study: "a recent B2B program review", "a
   marketing team at a mid-market SaaS company", "one client saw". If you
   cannot name the company, the year, and the actual number from FACTUAL
   GROUND or the brief, cut the example entirely and make the argument on
   mechanism instead. A plausible-sounding figure attached to nothing (a
   "$200,000 program") is worse than no figure. Do not invent numbers.

6. REPEAT NOUNS INSTEAD OF CYCLING SYNONYMS.
   Referring to one thing as "the platform", then "the solution", then "the
   system", then "the tooling" is a machine tell (elegant variation). Pick the
   correct noun and reuse it.

7. NO PUFFERY VERBS.
   Never write that something "stands as", "serves as", "is a testament to",
   "plays a vital/crucial/pivotal role", "underscores/highlights the
   importance of", "marks a pivotal moment", or "leaves an indelible mark".
   State what the thing does.

8. LIMIT CORRELATIVE CONSTRUCTIONS.
   "Not only... but also", "both... and", "whether... or" are fine once. Past
   that they read as balanced-for-the-sake-of-balance.

9. DO NOT RESTATE ACROSS SECTIONS.
   Each section must advance the argument. If a sentence's claim already
   appeared in an earlier section, cut it rather than rephrasing it. Looping
   back to the opening thesis in later sections is the clearest sign of local
   coherence without global structure.
═══════════════════════════════════════════════════════════════════════════
`;
