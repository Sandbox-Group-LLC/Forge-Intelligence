// Compliance Gate routes (Stage 5), extracted from server.js during the
// route-group phase of the decomposition. Mounted at /api/compliance with
// requireAuth applied at the mount in server.js
// (app.use('/api/compliance', requireAuth, complianceRouter)) — every route
// here is authed. Pure move: handler bodies are verbatim; only the
// registration lines changed (app.METHOD('/api/compliance/x', requireAuth, …)
// -> router.METHOD('/x', …)).
import express from 'express';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';
import { stripScaffoldingArtifacts } from '../text.js';
import { verifyBrandAccess } from '../auth.js';
import { findCitationSources } from '../citations.js';

const router = express.Router();

async function ensureComplianceColumns(tableName) {
  const cols = [
    ['review_mode',        'TEXT DEFAULT \'approve-to-ship\''],
    ['compliance_status',  'TEXT DEFAULT \'pending\''],
    ['compliance_report',  'JSONB'],
    ['reviewed_at',        'TIMESTAMPTZ'],
  ];
  for (const [col, def] of cols) {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
  }
}

// GET latest draft article for a brand
router.get('/latest/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
    // Check if content table exists before querying
    const tableCheck = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [tableName]
    );
    if (!tableCheck.rows.length) {
      return res.json({ success: true, articles: [], message: 'No content generated yet. Run the Content Generator first to create articles for compliance review.' });
    }
    await ensureComplianceColumns(tableName);
    const result = await pool.query(
      `SELECT * FROM ${tableName} ORDER BY created_at DESC LIMIT 10`
    );
    res.json({ success: true, articles: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST compliance critique — Claude reads article + brain mistakes, returns report
router.post('/rewrite-section', async (req, res) => {
  const { sectionBody, suggestion, brandProfileId, source } = req.body;
  if (!sectionBody || !suggestion) return res.status(400).json({ error: 'sectionBody and suggestion required' });
  try {
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceHint = profileRes.rows[0]?.profile_data?.voice_profile?.tone
      ? `Brand tone: ${profileRes.rows[0].profile_data.voice_profile.tone}.`
      : '';

    // Citation integration block — only added when a source is provided. Previously
    // this endpoint silently dropped the `source` param the UI was sending, so even
    // after the user clicked Find Sources and picked one, the rewrite ran without
    // ever seeing the URL. Users had to manually paste the citation, and the stitch
    // was awkward 9/10 times — the 90% rework rate. This block makes the citation
    // a first-class input with explicit integration rules.
    let citationBlock = '';
    if (source && source.url) {
      const titleClean = (source.title || '').replace(/\s+/g, ' ').trim();
      const yearStr = source.year ? ` (${source.year})` : '';
      const domainStr = source.domain ? ` — ${source.domain}` : '';
      citationBlock = `\n\nCITATION TO INTEGRATE:\nTitle: "${titleClean}"${yearStr}\nURL: ${source.url}${domainStr}\n\nINTEGRATION RULES:\n- Add the citation as a markdown link inline at the most natural anchor point (after the claim it supports)\n- Format options: text inline as ([Title](URL)), or for direct attribution: "According to [Title](URL), ..."\n- Match the surrounding sentence rhythm — do not stitch the URL in awkwardly or as a parenthetical after the section is otherwise complete\n- Preserve all other prose unchanged. The citation is the ONLY structural change.`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are an editorial AI. Rewrite the following article section to incorporate the editorial suggestion${source ? ' AND integrate the provided citation cleanly' : ''}. Preserve the author's voice and intent. Return only the rewritten section body — no commentary, no preamble, no labels.\n\n${voiceHint}\n\nORIGINAL SECTION:\n${sectionBody}\n\nEDITORIAL SUGGESTION:\n${suggestion}${citationBlock}\n\nREWRITTEN SECTION:` }]
    });
    const rewritten = response.content[0]?.text?.trim();
    if (!rewritten) return res.status(500).json({ success: false, error: 'AI returned empty response' });
    res.json({ success: true, rewritten });
  } catch (e) {
    console.error('[REWRITE-SECTION]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


// POST /api/compliance/rewrite-selection — AI rewrites only the selected text per user instruction
router.post('/rewrite-selection', async (req, res) => {
  const { selectedText, instruction, fullSectionText, sectionHeading, brandProfileId } = req.body;
  if (!selectedText || !instruction) return res.status(400).json({ error: 'selectedText and instruction required' });
  try {
    // Load brand voice profile
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceProfile = profileRes.rows[0]?.profile_data?.voiceProfile || profileRes.rows[0]?.profile_data?.voice_profile || null;

    let voiceBlock = '';
    if (voiceProfile) {
      voiceBlock = `\nBRAND VOICE:\n${voiceProfile.summary || ''}`;
      if (voiceProfile.toneAttributes?.length) {
        voiceBlock += `\nTone: ${voiceProfile.toneAttributes.map((t) => `${t.attribute} (${t.score}/10)`).join(', ')}`;
      }
      if (voiceProfile.writingStyle) voiceBlock += `\nStyle: ${voiceProfile.writingStyle}`;
    }

    // Load brain mistakes for this brand
    let mistakesBlock = '';
    try {
      const mistakesRes = await pool.query(
        'SELECT mistake_type, description, human_feedback FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20',
        [brandProfileId]
      );
      if (mistakesRes.rows.length) {
        mistakesBlock = '\nKNOWN MISTAKES TO AVOID:\n' + mistakesRes.rows.map((m) => `- ${m.description}${m.human_feedback ? ' → ' + m.human_feedback : ''}`).join('\n');
      }
    } catch {}

    const systemPrompt = `You are a precision editor. Rewrite ONLY the selected text according to the user's instruction.${voiceBlock}${mistakesBlock}

RULES:
- Return ONLY the rewritten text, nothing else
- No preamble, no labels, no commentary
- Preserve the same approximate length unless the instruction implies otherwise
- Maintain the brand voice described above
- Do not change meaning unless the instruction asks for it
- Match the surrounding context's tone and tense`;

    const userPrompt = `SECTION: "${sectionHeading || 'Untitled'}"\n\nFULL SECTION CONTEXT:\n${fullSectionText || ''}\n\nSELECTED TEXT TO REWRITE:\n"${selectedText}"\n\nINSTRUCTION:\n${instruction}\n\nReturn only the rewritten text:`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const rewrittenText = response.content[0]?.text?.trim();
    if (!rewrittenText) return res.status(500).json({ success: false, error: 'AI returned empty response' });

    // Feed the brain: every user correction is a signal of what the writer got wrong
    if (brandProfileId) {
      pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [
          brandProfileId,
          'user_rewrite',
          `AI wrote: "${selectedText.slice(0, 400)}"${sectionHeading ? ` (in section: ${sectionHeading})` : ''}`,
          `User instruction: "${instruction.slice(0, 400)}" | Corrected to: "${rewrittenText.slice(0, 400)}"`,
          'medium'
        ]
      ).catch(e => console.error('[REWRITE-BRAIN] mistake log error:', e.message));
      console.log(`[REWRITE-BRAIN] Logged correction for brand ${brandProfileId}`);
    }

    res.json({ success: true, rewrittenText });
  } catch (e) {
    console.error('[REWRITE-SELECTION]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Source citation agent ──────────────────────────────────────────────────────
// Called from Compliance Gate when a user clicks "Find Sources" on a factual_claim or legal_risk flag.
// Uses Perplexity sonar-pro (reasoning model) to find sources that actually SUPPORT the claim,
// with prompt-level guidance on what counts as credible, result-level filtering for quality,
// and brand/domain context so it doesn't return self-citations or cross-company contamination.
//
// Known low-quality source domains — we drop these before returning to the user. Not an exhaustive
// list; it's the ones that most commonly show up as noise in citation searches.
// findCitationSources + LOW_QUALITY_CITATION_DOMAINS moved to
// src/server/citations.js (imported at top).

router.post('/find-sources', async (req, res) => {
  const { claim, sectionBody, brandProfileId } = req.body;
  if (!claim && !sectionBody) return res.status(400).json({ error: 'claim or sectionBody required' });
  try {
    const sources = await findCitationSources({ claim, sectionBody, brandProfileId, maxResults: 3 });
    if (!sources.length) {
      return res.json({ success: false, error: 'No credible sources found for this claim. Try rewriting without a citation, or rephrase to be less specific.' });
    }
    res.json({ success: true, sources });
  } catch (e) {
    console.error('[FIND-SOURCES] caught:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── One-shot verify-and-rewrite ────────────────────────────────────────────────
// The asymmetric-friction fix: instead of forcing the user through find-sources →
// pick → click apply → manually verify the citation got integrated cleanly (the 4-step
// flow that produced a 90% rework rate), this endpoint does all of it in one call.
// Sonar finds the top source, the rewriter integrates the citation inline using the
// same prompt rules as the manual flow, and the response is a one-click-applicable
// section body. The user reviews and approves — they don't assemble.
//
// Falls back to soften-without-citation behavior if Sonar returns no qualifying source,
// so the UX is graceful when the claim genuinely can't be verified.
router.post('/verify-and-rewrite', async (req, res) => {
  const { sectionBody, claim, suggestion, brandProfileId, sectionHeading } = req.body;
  if (!sectionBody || !claim || !suggestion) {
    return res.status(400).json({ error: 'sectionBody, claim, and suggestion required' });
  }
  try {
    // Step 1: Sonar lookup. maxResults=1 — we want the single best source, not a menu.
    let topSource = null;
    try {
      const sources = await findCitationSources({ claim, sectionBody, brandProfileId, maxResults: 1 });
      topSource = sources[0] || null;
    } catch(searchErr) {
      // Sonar failure should not block the rewrite — fall through to soften path.
      console.warn('[VERIFY-AND-REWRITE] Sonar lookup failed, falling back to soften:', searchErr.message);
    }

    // Step 2: Pull voice context.
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceHint = profileRes.rows[0]?.profile_data?.voice_profile?.tone
      ? `Brand tone: ${profileRes.rows[0].profile_data.voice_profile.tone}.`
      : '';

    // Step 3: Build prompt — citation block when source found, soften block when not.
    let citationBlock = '';
    let mode = 'softened';
    if (topSource && topSource.url) {
      mode = 'cited';
      const titleClean = (topSource.title || '').replace(/\s+/g, ' ').trim();
      const yearStr = topSource.year ? ` (${topSource.year})` : '';
      const domainStr = topSource.domain ? ` — ${topSource.domain}` : '';
      citationBlock = `\n\nVERIFIED SOURCE TO INTEGRATE:\nTitle: "${titleClean}"${yearStr}\nURL: ${topSource.url}${domainStr}\n\nINTEGRATION RULES:\n- Add the citation as a markdown link inline at the most natural anchor point (after the claim it supports)\n- Format options: "([Title](URL))" inline, or "According to [Title](URL), ..." for direct attribution\n- Match surrounding sentence rhythm — do not stitch the URL in awkwardly\n- Preserve all other prose unchanged. The citation is the ONLY structural change.`;
    } else {
      citationBlock = `\n\nNO VERIFIED SOURCE FOUND — SOFTEN THE CLAIM:\n- Rewrite to remove specific named-third-party assertions that can't be verified\n- Use hedged language like "organizations including [name] have explored this area publicly" or "this is a well-documented topic across industry research"\n- Do NOT invent or infer URLs, dates, or publication titles\n- Preserve all other prose unchanged.`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are an editorial AI. Rewrite the following article section to incorporate the editorial suggestion. ${mode === 'cited' ? 'A verified source has been provided — integrate it cleanly.' : 'No verified source was found — soften the claim instead of fabricating one.'} Preserve the author's voice and intent. Return only the rewritten section body — no commentary, no preamble, no labels.\n\n${voiceHint}\n\nSECTION HEADING: ${sectionHeading || 'Untitled'}\n\nORIGINAL SECTION:\n${sectionBody}\n\nFLAGGED CLAIM:\n"${claim}"\n\nEDITORIAL SUGGESTION:\n${suggestion}${citationBlock}\n\nREWRITTEN SECTION:` }]
    });
    const rewritten = response.content[0]?.text?.trim();
    if (!rewritten) return res.status(500).json({ success: false, error: 'AI returned empty response' });

    res.json({
      success: true,
      rewritten,
      mode,                  // 'cited' or 'softened'
      source: topSource,     // null when softened, full source object when cited
    });
  } catch (e) {
    console.error('[VERIFY-AND-REWRITE]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/critique', async (req, res) => {
  const { brandProfileId, contentId } = req.body;
  if (!brandProfileId || !contentId) return res.status(400).json({ error: 'brandProfileId and contentId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;

    await ensureComplianceColumns(tableName);
    // Load article
    const articleRes = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!articleRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = articleRes.rows[0];
    const articleJson = article.article_json;

    // Load brand profile + brain mistakes
    const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brand = brandRes.rows[0];
    const mistakesRes = await pool.query(`SELECT * FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`, [brandProfileId]).catch(() => ({ rows: [] }));
    const mistakes = mistakesRes.rows;

    // Factual Ground — the user-verified facts. Without this the critique judged
    // factual claims in total isolation: it could neither clear a claim the brand
    // owner already verified (false-positive factual_claim flags on true facts)
    // nor catch a claim that CONTRADICTS what the owner stated. Both directions
    // matter; contradiction is the severe one.
    const fg = brand?.settings?.factualGround || null;
    const fgBlock = fg && Object.values(fg).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\nUSER-VERIFIED FACTS (stated by the brand owner — authoritative ground truth):
${fg.whatWeDo ? `- What this brand does: ${String(fg.whatWeDo).slice(0, 500)}\n` : ''}${fg.whatWeDontDo ? `- What this brand does NOT do: ${String(fg.whatWeDontDo).slice(0, 500)}\n` : ''}${fg.companyFacts ? `- Company facts: ${String(fg.companyFacts).slice(0, 500)}\n` : ''}${fg.foundingStory ? `- Founding story: ${String(fg.foundingStory).slice(0, 400)}\n` : ''}${fg.methodology ? `- Methodology/frameworks: ${String(fg.methodology).slice(0, 400)}\n` : ''}${Array.isArray(fg.authors) && fg.authors.length ? `- Named team: ${fg.authors.map(a => `${a.name || ''}${a.title ? ` (${a.title})` : ''}`).filter(Boolean).join(', ')}\n` : ''}
How to use these facts:
- A claim in the article that MATCHES or is directly supported by these facts is VERIFIED — do not flag it as an unverifiable factual_claim.
- A claim that CONTRADICTS these facts (wrong founder, wrong methodology, claims the brand does something listed under "does NOT do") is a RED factual_claim flag — quote the contradicting excerpt and name the verified fact it violates.
- These facts are context for judging claims, NOT article content — the flaggedExcerpt rule is unchanged: every excerpt must still be a verbatim quote from the article section being flagged.`
      : '';

    const systemPrompt = `You are a compliance and brand voice auditor for the brand "${brand?.brand_name || 'Unknown'}". Analyze this article against the brand profile and known mistakes. Return a JSON compliance report.

The article was written for the brand "${brand?.brand_name || 'Unknown'}" (${brand?.brand_url || 'no URL'}). Do NOT flag brand name usage that correctly references this brand.

CRITICAL RULES:
- ONLY flag claims, phrases, or issues that are EXPLICITLY present in the article text being audited. Do NOT reference, cite, or cross-reference content from other articles, briefs, GEO reports, or any source outside this specific article.
- Every flag must include a "flaggedExcerpt" field containing the EXACT quote from the article that triggered the flag. If you cannot quote it verbatim from THIS article, do not flag it.
- Do NOT hallucinate or infer content. If a section contains no issues, do not flag it.
- The "Known Mistakes" below are BEHAVIORAL PATTERNS to watch for (e.g. "avoid truncated sentences"). They are NOT evidence or sources. Never cite a Known Mistake as proof that a claim exists elsewhere or needs sourcing.
- When flagging a factual claim, explain why the CLAIM ITSELF is unverifiable based on what appears in the article — do not say "referenced in an internal brief" or "found elsewhere in the system."
- SECTION ISOLATION: Each flag must reference content from ONLY the section it is assigned to (by sectionIndex). Do not flag Section 5 for something that appears in Section 4. The flaggedExcerpt must be a verbatim quote from the section identified by the sectionIndex — not from any other section.

Brand Voice Profile:
${JSON.stringify(brand?.profile_data?.voice_profile || {}, null, 2)}
${fgBlock}
Known Mistakes to Avoid:
${mistakes.map(m => `- ${m.mistake_type}: ${m.human_feedback}`).join('\n') || 'None recorded yet'}

Return ONLY valid JSON in this exact structure:
{
  "overallScore": <0-100>,
  "brandVoiceScore": <0-100>,
  "factualConfidence": <0-100>,
  "autoApprovable": <true if all sections green>,
  "summary": "<2 sentence overall assessment>",
  "flags": [
    {
      "sectionIndex": <zero-based index of the section in the sections array — first section is 0, second is 1, etc>,
      "sectionHeading": "<heading>",
      "severity": "yellow" | "red",
      "type": "brand_voice" | "factual_claim" | "legal_risk" | "sme_required",
      "flaggedExcerpt": "<exact quote from the article that triggered this flag>",
      "reason": "<why flagged>",
      "suggestion": "<recommended fix>"
    }
  ],
  "mistakesApplied": ["<list of mistake patterns that influenced this critique>"]
}`;

    // Build the article-to-audit text once — reused on retry
    const articleAuditText = (() => {
      const sections = articleJson?.sections || [];
      return sections.map((s, i) => `[SECTION ${i}] heading: ${s.heading || s.title || 'Untitled'}\n${s.body || s.content || ''}`).join('\n\n---\n\n');
    })();

    // Attempt 1: standard prompt
    const callCritique = async (extraGuidance = '') => {
      const userContent = extraGuidance
        ? `${extraGuidance}\n\nArticle to audit:\n\n${articleAuditText}`
        : `Article to audit:\n\n${articleAuditText}`;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });
      return resp.json();
    };

    let critiqueData = await callCritique();
    let rawText = critiqueData.content?.[0]?.text || '{}';
    let stopReason = critiqueData.stop_reason || 'unknown';
    if (stopReason === 'max_tokens') {
      console.warn(`[COMPLIANCE] Critique hit max_tokens ceiling on attempt 1 — response truncated. Article ${contentId} has ${(articleJson?.sections || []).length} sections / ${Math.round(JSON.stringify(articleJson).length / 1024)}kb`);
    }

    let report;
    try {
      report = safeParseLLM(rawText, 'object', 'compliance-gate');
    } catch (parseErr) {
      // Attempt 2: retry with stricter JSON directive. The most common parse failure on 'end_turn'
      // responses is unescaped inner double quotes or literal newlines inside flaggedExcerpt strings
      // (Claude quotes article text verbatim and occasionally forgets to escape).
      console.warn(`[COMPLIANCE] Attempt 1 parse failed (${parseErr.message}, stop_reason=${stopReason}). Retrying with strict JSON directive...`);
      const retryGuidance = `IMPORTANT JSON OUTPUT REQUIREMENTS:
- Return a single JSON object. No markdown code fences. No prose before or after.
- Every string value MUST have all inner double quotes escaped as \\".
- Every string value MUST have all literal newlines escaped as \\n (never raw line breaks inside a string).
- When quoting article excerpts in flaggedExcerpt, you MAY paraphrase if the verbatim quote contains characters that would complicate escaping.
- Validate your JSON is parseable before responding.`;
      const retryData = await callCritique(retryGuidance);
      const retryRaw = retryData.content?.[0]?.text || '{}';
      const retryStop = retryData.stop_reason || 'unknown';
      console.warn(`[COMPLIANCE] Retry stop_reason=${retryStop}, first 200: ${retryRaw.slice(0, 200).replace(/\n/g, ' ')}`);
      try {
        report = safeParseLLM(retryRaw, 'object', 'compliance-gate-retry');
        rawText = retryRaw;
        stopReason = retryStop;
        console.log(`[COMPLIANCE] Retry succeeded for article ${contentId}`);
      } catch (retryErr) {
        console.error(`[COMPLIANCE] Both attempts failed for article ${contentId}. Attempt 1: ${parseErr.message} | Retry: ${retryErr.message} | Retry raw first 800:`, retryRaw.slice(0, 800));
        return res.status(502).json({
          success: false,
          error: retryStop === 'max_tokens'
            ? 'Compliance review response was truncated even after retry. Article may be too long — try splitting into two articles.'
            : `Compliance review could not produce parseable JSON after retry. This can happen if the article contains tricky punctuation. Retry once more, or manually approve if you've reviewed the draft.`,
          stopReason: retryStop,
          // Include a preview of the raw response so the UI can optionally show it for manual review
          rawPreview: retryRaw.slice(0, 1500)
        });
      }
    }

    // Empty-object guard: if the parse succeeded but the report has no real fields, treat that
    // as a failure too. Silent {} write was the original bug shape.
    const hasAnyContent = report && (
      typeof report.overallScore === 'number' ||
      typeof report.summary === 'string' && report.summary.trim().length > 0 ||
      Array.isArray(report.flags)
    );
    if (!hasAnyContent) {
      console.error(`[COMPLIANCE] Parsed report is empty for article ${contentId}. stop_reason=${stopReason}, raw first 400:`, rawText.slice(0, 400));
      return res.status(502).json({
        success: false,
        error: 'Compliance review returned an empty response. This usually means the article is too long or the model hit an internal limit. Please retry.',
        stopReason
      });
    }

    // Normalise sectionIndex to 0-based — Claude sometimes returns 1-based
    if (report.flags?.length && articleJson?.sections?.length) {
      const maxIdx = articleJson.sections.length - 1;
      const anyExceedsBounds = report.flags.some(f => f.sectionIndex > maxIdx);
      if (anyExceedsBounds) {
        report.flags = report.flags.map(f => ({ ...f, sectionIndex: Math.max(0, f.sectionIndex - 1) }));
      }
    }

    // Persist compliance report to article record
    await pool.query(
      `UPDATE ${tableName} SET compliance_report = $1, compliance_status = 'reviewed', updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(report), contentId]
    );

    res.json({ success: true, report });
  } catch (err) {
    console.error('[COMPLIANCE] Critique error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST dismiss-flag — user dismisses a false-positive flag, writes to brain as training signal
router.post('/dismiss-flag', async (req, res) => {
  const { brandProfileId, contentId, flagType, flagReason, sectionHeading } = req.body;
  if (!brandProfileId || !contentId) return res.status(400).json({ error: 'brandProfileId and contentId required' });
  try {
    await pool.query(
      `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
       VALUES ($1, 'false_positive_flag', $2, $3, 'low')`,
      [
        brandProfileId,
        `AI incorrectly flagged section "${sectionHeading || 'untitled'}" as ${flagType || 'unknown'} — user dismissed`,
        `False positive: ${(flagReason || '').substring(0, 500)}. Do NOT flag similar content in future critiques for this brand.`
      ]
    );
    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms)
       VALUES ('compliance_dismiss', $1, 'success', 0, 0)`,
      [brandProfileId]
    ).catch(() => {});
    res.json({ success: true });
  } catch(e) {
    console.error('[COMPLIANCE] Dismiss flag error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST approve — save human edits, write mistakes to brain, mark approved
router.post('/approve', async (req, res) => {
  const startTime = Date.now();
  const { brandProfileId, contentId, reviewMode, editedSections, decisions, editedFaqs, keyTakeaway } = req.body;
  if (!brandProfileId || !contentId) return res.status(400).json({ error: 'brandProfileId and contentId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;

    await ensureComplianceColumns(tableName);
    // Load original article
    const articleRes = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!articleRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = articleRes.rows[0];
    let articleJson = article.article_json;

    // Apply human edits to article sections
    if (editedSections && Array.isArray(editedSections)) {
      editedSections.forEach(edit => {
        if (articleJson.sections && articleJson.sections[edit.sectionIndex]) {
          const section = articleJson.sections[edit.sectionIndex];
          const orig = section.body || section.content || '';
          if (orig !== edit.content) {
            // Write to brain_mistakes (brand-scoped)
            pool.query(
              `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
               VALUES ($1, 'human_edit', $2, $3, 'medium')`,
              [
                brandProfileId,
                `Section "${section.heading || 'untitled'}": human reviewer edited content`,
                `Avoid: "${orig.substring(0, 200)}" — prefer: "${edit.content.substring(0, 200)}"`
              ]
            ).catch(e => console.error('[COMPLIANCE] Mistake write error:', e.message));
            // Update whichever field exists
            if (section.body !== undefined) {
              articleJson.sections[edit.sectionIndex].body = edit.content;
            } else {
              articleJson.sections[edit.sectionIndex].content = edit.content;
            }
          }
        }
      });
    }

    // Apply human edits to FAQs (separate field from sections, separate edit surface).
    // Same brain_mistakes write pattern so the model learns from FAQ corrections too.
    // editedFaqs format: [{ index, question, answer }] — both fields independently editable.
    if (editedFaqs && Array.isArray(editedFaqs) && Array.isArray(articleJson.faqs)) {
      editedFaqs.forEach(edit => {
        const faq = articleJson.faqs[edit.index];
        if (!faq) return;
        const origQ = faq.question || '';
        const origA = faq.answer || '';
        const newQ = edit.question != null ? edit.question : origQ;
        const newA = edit.answer != null ? edit.answer : origA;
        if (origQ !== newQ || origA !== newA) {
          pool.query(
            `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
             VALUES ($1, 'human_edit_faq', $2, $3, 'medium')`,
            [
              brandProfileId,
              `FAQ ${edit.index + 1}: human reviewer edited Q/A`,
              `Avoid Q: "${origQ.substring(0, 150)}" / A: "${origA.substring(0, 200)}" — prefer Q: "${newQ.substring(0, 150)}" / A: "${newA.substring(0, 200)}"`
            ]
          ).catch(e => console.error('[COMPLIANCE] FAQ mistake write error:', e.message));
          articleJson.faqs[edit.index] = { ...faq, question: newQ, answer: newA };
        }
      });
    }

    // Apply human edit to the Key Takeaway (TL;DR). It renders at the top of every
    // published export but was never surfaced for review — now it is. Only write on
    // an actual change; log the correction to the brain like section/FAQ edits.
    if (typeof keyTakeaway === 'string' && keyTakeaway !== (articleJson.keyTakeaway || '')) {
      pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
         VALUES ($1, 'human_edit', $2, $3, 'medium')`,
        [
          brandProfileId,
          `Key Takeaway (TL;DR): human reviewer edited`,
          `Avoid: "${(articleJson.keyTakeaway || '').substring(0, 200)}" — prefer: "${keyTakeaway.substring(0, 200)}"`
        ]
      ).catch(e => console.error('[COMPLIANCE] keyTakeaway mistake write error:', e.message));
      articleJson.keyTakeaway = keyTakeaway;
    }

    // Handle red section decisions
    const finalStatus = reviewMode === 'auto-ship' ? 'approved' :
      decisions && Object.values(decisions).some(d => d === 'rejected') ? 'rejected' : 'approved';

    // Final safety net — strip any LLM scaffolding that slipped past human review
    articleJson = stripScaffoldingArtifacts(articleJson);

    await pool.query(
      `UPDATE ${tableName} SET article_json = $1, compliance_status = $2, review_mode = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $4`,
      [JSON.stringify(articleJson), finalStatus, reviewMode || 'approve-to-ship', contentId]
    );

    // Auto-stage into publishing queue on approval
    if (finalStatus === 'approved') {
      const articleTitle = articleJson.title || article.title || 'Untitled Article';
      pool.query(
        `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'staged', NOW(), NOW())
         ON CONFLICT (content_id) DO UPDATE SET
           title = EXCLUDED.title,
           updated_at = NOW()
         WHERE publishing_queue.status = 'staged'`,
        [brandProfileId, contentId, articleTitle]
      ).catch(e => console.error('[QUEUE] Auto-stage error:', e.message));
    }

        await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage5_compliance_gate', brandProfileId, 'success', 0, Date.now()-startTime]).catch(e => console.error('[ACTIVITY LOG]', e.message));
        res.json({ success: true, status: finalStatus, contentId });
  } catch (err) {
    console.error('[COMPLIANCE] Approve error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
