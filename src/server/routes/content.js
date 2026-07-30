// Content routes (article reads / regenerate-image / topic-check / import),
// extracted from server.js during the route-group phase. Mounted at /api/content
// with NO mount-level auth — MIXED group (GET /:safeId/latest and PATCH
// /:brandSafeId/:contentId are open; the rest are requireAuth; /import adds
// requireApiKeyScope). Auth stays per-route. NOTE: app.use('/api/content', …)
// matches on segment boundaries, so the separate /api/content-library and
// /api/content-generator routes (still in server.js) are NOT captured here.
// Pure move: bodies verbatim, only registration lines changed.
import express from 'express';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';
import { requireAuth, requireApiKeyScope } from '../auth.js';
import { finalizeArticleForStorage } from '../text.js';
import { buildImagePrompt, generateHeroImage } from '../images.js';

const router = express.Router();

router.post('/regenerate-image/:contentId', requireAuth, async (req, res) => {
  const { contentId } = req.params;
  const { brandProfileId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
    const artRes = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!artRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = artRes.rows[0];

    const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brand = brandRes.rows[0] || {};
    const profileData = brand.profile_data || {};
    const regenBody = (article.article_json?.sections?.[0]?.body || article.article_json?.sections?.[0]?.content || '').slice(0, 250);
    const fluxPrompt = await buildImagePrompt(article.title, profileData?.voice_profile || {}, regenBody);

    const imageUrl = await generateHeroImage(fluxPrompt);

    await pool.query(`UPDATE ${tableName} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
      [imageUrl, fluxPrompt, contentId]);

    res.json({ success: true, imageUrl, prompt: fluxPrompt });
  } catch (err) {
    console.error('[REGEN-IMAGE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:safeId/latest', async (req, res) => {
  try {
    const tableName = `generated_content_${req.params.safeId}`;
    const result = await pool.query(
      `SELECT id, title, article_json, overall_confidence, brain_match_score, compliance_status, hero_image_url, created_at
       FROM ${tableName} WHERE created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`
    );
    if (!result.rows.length) return res.json({ success: false });
    const r = result.rows[0];
    const article = r.article_json || {};
    res.json({ success: true, article: { ...article, contentId: r.id, title: r.title, overallConfidence: r.overall_confidence, brainMatchScore: r.brain_match_score, heroImageUrl: r.hero_image_url } });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/:safeId/:contentId', requireAuth, async (req, res) => {
  try {
    const { safeId, contentId } = req.params;
    const tableName = `generated_content_${safeId}`;
    const r = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Article not found' });
    res.json({ success: true, article: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/topic-check', requireAuth, async (req, res) => {
  const { brandProfileId, topic } = req.body;
  if (!brandProfileId || !topic) return res.status(400).json({ error: 'brandProfileId and topic required' });
  try {
    const [pRes, mRes] = await Promise.all([
      pool.query('SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8', [brandProfileId]),
      pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 5', [brandProfileId])
    ]);

    const patterns = pRes.rows;
    const mistakes = mRes.rows;

    // If no brain data yet return neutral
    if (!patterns.length && !mistakes.length) {
      return res.json({ success: true, signal: 'strong', confidence: 'No prior data', reason: 'No performance patterns have been extracted yet for this brand. Generate and publish content, then run Pattern Extraction to unlock topic intelligence.', reframe: null });
    }

    const prompt = `You are a content strategy advisor for a B2B brand. A user wants to write about this topic:
"${topic}"

Here is what has worked for this brand (brain patterns):
${patterns.map(p => `- [${p.pattern_type}] ${p.description} (${Math.round((p.confidence_score||0)*100)}% confidence)`).join('\n') || 'None yet'}

Here is what has underperformed (brain mistakes):
${mistakes.map(m => `- [${m.severity} severity] ${m.mistake_type}: ${m.description}`).join('\n') || 'None yet'}

Evaluate the user's topic against this brand's performance data and return ONLY a JSON object:
{
  "signal": "strong" | "caution" | "weak",
  "confidence": "one short phrase like '92% alignment' or 'Low confidence'",
  "reason": "2-3 sentences explaining why this topic will or won't perform based on the brain data",
  "reframe": "If signal is caution or weak, return ONLY the reframed topic as a short phrase — just the topic the user should write about instead, no explanation. If strong, return null.",
  "reframeRationale": "If reframe is not null, explain in 1-2 sentences why this angle aligns better with the brand's brain data. If strong, return null."
}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData = await aiRes.json();
    const raw = aiData.content?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = safeParseLLM(clean, 'object', 'topic-check');
    // Guard: if Anthropic returned an error, parsed will be empty — don't send a blank card
    if (!parsed.signal) {
      return res.json({ success: true, signal: 'strong', confidence: 'Check unavailable', reason: 'Could not evaluate topic against brain data right now. Proceed with generation.', reframe: null });
    }
    res.json({ success: true, ...parsed });
  } catch(e) {
    console.error('[TOPIC-CHECK]', e.message);
    res.json({ success: true, signal: 'strong', confidence: 'Check unavailable', reason: 'Could not evaluate topic against brain data right now. Proceed with generation.', reframe: null });
  }
});

router.patch('/:brandSafeId/:contentId', async (req, res) => {
  const { brandSafeId, contentId } = req.params;
  const { article_json, title } = req.body;
  const tableName = `generated_content_${brandSafeId}`;
  try {
    const updates = [];
    const params = [];
    let pi = 1;
    if (title !== undefined) { updates.push(`title = $${pi++}`); params.push(title); }
    if (article_json !== undefined) { updates.push(`article_json = $${pi++}`); params.push(JSON.stringify(article_json)); }
    if (!updates.length) return res.json({ success: true });
    updates.push(`updated_at = NOW()`);
    params.push(contentId);
    await pool.query(
      `UPDATE ${tableName} SET ${updates.join(', ')} WHERE id = $${pi}`,
      params
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/import', requireAuth, requireApiKeyScope('content:import'), async (req, res) => {
  const { brandProfileId, url, rawText, title: manualTitle, originalContentId, editReason } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  if (!url && !rawText) return res.status(400).json({ error: 'url or rawText required' });

  // Edit-reconciliation mode: if originalContentId is provided, we're importing
  // an externally-edited version of a Forge-generated article. The audit shifts
  // from 'score this net-new piece' to 'diff this edit vs. the draft and extract
  // brain-worthy deltas.' Powered by Frank (ForgeOS webmaster) who edits articles
  // before publishing them to Sandbox-XM and whose edits we want to learn from.
  let originalArticle = null;
  if (originalContentId) {
    try {
      const safeIdLookup = brandProfileId.replace(/-/g, '_');
      const origRes = await pool.query(
        `SELECT id, title, article_json FROM generated_content_${safeIdLookup} WHERE id = $1`,
        [originalContentId]
      );
      if (origRes.rows.length) {
        originalArticle = origRes.rows[0];
      }
    } catch(e) {
      // Non-fatal — fall through to standard audit mode if original not found
      console.warn('[IMPORT] originalContentId lookup failed:', e.message);
    }
  }

  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;

    // 1. Get content — scrape URL or use raw text
    let rawContent = rawText || '';
    let sourceTitle = manualTitle || '';

    if (url && !rawText) {
      try {
        const fetchRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeIntelligence/1.0)' },
          signal: AbortSignal.timeout(8000)
        });
        const html = await fetchRes.text();
        // Strip HTML tags, extract readable text
        rawContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s{3,}/g, '\n\n')
          .trim()
          .slice(0, 12000);

        // Try to extract title from <title> tag
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) sourceTitle = titleMatch[1].replace(/\s*(\||\u2013|\u2014|-).*$/, '').trim();
      } catch(e) {
        return res.status(400).json({ error: `Could not fetch URL: ${e.message}` });
      }
    }

    // 2. Load brand profile for Brain context.
    // voice_profile lives inside profile_data JSONB (not as a top-level column) — extract it here.
    // personas/competitive_gaps were previously SELECTed but never used in the audit prompt, so dropped.
    const brandRes = await pool.query(
      `SELECT brand_name, brand_url, profile_data->'voice_profile' as voice_profile
       FROM brand_profiles WHERE id = $1`,
      [brandProfileId]
    );
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // 3. Load brain patterns + mistakes
    const patternsRes = await pool.query(
      'SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8',
      [brandProfileId]
    ).catch(() => ({ rows: [] }));
    const mistakesRes = await pool.query(
      'SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 6',
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // 4. Claude Sonnet: parse + audit. Two modes:
    //   (a) standard import — score an outside article against the brand brain
    //   (b) edit-reconciliation — compare Frank's edit to the Forge draft and
    //       extract brain-worthy deltas (patterns Frank applied, mistakes he caught)
    const originalBody = originalArticle
      ? (originalArticle.article_json?.sections || [])
          .map(s => `### ${s.heading || ''}\n${s.body || s.content || ''}`)
          .join('\n\n').slice(0, 6000)
      : '';

    const auditPrompt = originalArticle ? `You are the Forge Intelligence Brain Auditor in EDIT-RECONCILIATION mode.

Frank, an external editor (ForgeOS), reviewed and edited a Forge-generated article before publishing. Your job is to extract brain-worthy signal from Frank's edits — not to score the article, but to learn from the delta.

BRAND: ${brand.brand_name} (${brand.brand_url})
VOICE PROFILE: ${JSON.stringify(brand.voice_profile || {}).slice(0, 500)}
EXISTING BRAIN PATTERNS: ${patternsRes.rows.map(p => p.description).join('; ').slice(0, 600)}
EXISTING BRAIN MISTAKES: ${mistakesRes.rows.map(m => m.description).join('; ').slice(0, 400)}

ARTICLE TITLE: ${originalArticle.title}
EDITOR'S STATED REASON: ${editReason || '(not provided)'}

═══ FORGE DRAFT (original) ═══
${originalBody}

═══ FRANK'S EDIT (published version) ═══
${rawContent.slice(0, 6000)}

Your job:
1. Identify what Frank CHANGED between the draft and the published version.
2. For each meaningful change, classify: is it a PATTERN (something Frank improved that Forge should do next time) or a MISTAKE (something Forge got wrong that Frank had to fix)?
3. Ignore purely cosmetic edits (whitespace, punctuation, inline typos). Focus on structural, voice, factual, or strategic changes.
4. Be specific. 'Frank tightened the intro' is useless. 'Frank removed hedging language (maybe, perhaps, somewhat) that softened the core claim' is useful.
5. Skip changes that are one-off (specific to this article only). Only surface patterns Forge could apply going forward.

CRITICAL — TWO SEPARATE OUTPUTS:
- The "sections" array reproduces the PUBLISHED ARTICLE PROSE VERBATIM. Each section is one H2/H3 from Frank's published version. The "body" field contains the EXACT prose Frank published under that heading, copied word-for-word from the published version above. Do NOT summarize. Do NOT describe what Frank changed. Do NOT write meta-commentary about Frank's pipeline operations or page infrastructure. The "body" field is the actual article content as a reader would encounter it on the page.
- The "brainPatterns" and "brainMistakes" arrays are where you describe Frank's changes and edits. ALL change-analysis goes in those fields, NEVER in section bodies.
- If a heading in Frank's published version is purely structural (e.g. a TL;DR block, FAQ, or CTA box), the body field still contains the literal text that appears under that heading on the page — not a description of why it was added.

Return ONLY valid JSON:
{
  "title": "article title",
  "editSummary": "1-2 sentence summary of what Frank changed overall",
  "editImpactScore": 0-100,
  "sections": [
    {
      "heading": "section heading from Frank's published version",
      "body": "VERBATIM PROSE under that heading from Frank's published version — the literal article text as published, not a description of changes. If you find yourself writing 'Frank added' or 'Forge's draft did X', you are doing this WRONG — that goes in brainPatterns/brainMistakes instead.",
      "confidence": 0-100,
      "flags": []
    }
  ],
  "brainPatterns": [
    {
      "pattern_type": "voice|structural|factual|strategic",
      "description": "specific, actionable pattern Forge should apply next time",
      "evidence": "quote or paraphrase of the Frank edit that demonstrates it"
    }
  ],
  "brainMistakes": [
    {
      "mistake_type": "voice|structural|factual|strategic",
      "description": "specific mistake Forge made that Frank had to fix",
      "severity": "low|medium|high",
      "evidence": "quote from the Forge draft showing the mistake"
    }
  ]
}` : `You are the Forge Intelligence Brain Auditor. An article was written OUTSIDE of Forge and is being imported for scoring.

BRAND: ${brand.brand_name} (${brand.brand_url})
VOICE PROFILE: ${JSON.stringify(brand.voice_profile || {}).slice(0, 500)}
BRAIN PATTERNS (what works): ${patternsRes.rows.map(p => p.description).join('; ').slice(0, 600)}
BRAIN MISTAKES (what fails): ${mistakesRes.rows.map(m => m.description).join('; ').slice(0, 400)}

IMPORTED ARTICLE TITLE: ${sourceTitle || 'Unknown'}

IMPORTED CONTENT:
${rawContent.slice(0, 6000)}

Your job:
1. Parse this article into structured sections
2. Score it against the brand brain
3. Identify voice deviations, missing depth, and structural issues
4. Be honest. This was written outside the system. Show it.

Return ONLY valid JSON:
{
  "title": "article title",
  "metaDescription": "one sentence summary",
  "overallConfidence": 0-100,
  "brainMatchScore": 0-100,
  "voiceDeviationScore": 0-100,
  "importVerdict": "brief honest verdict (1-2 sentences)",
  "sections": [
    {
      "heading": "section heading",
      "body": "section body text",
      "confidence": 0-100,
      "flags": ["flag1", "flag2"]
    }
  ],
  "brainFlags": ["top-level issues the brain detected"],
  "suggestions": ["concrete improvements the brain recommends"]
}`;

    const auditRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: auditPrompt }]
      })
    });
    const auditData = await auditRes.json();
    const auditText = auditData.content?.[0]?.text || '';
    const parsed = JSON.parse(auditText.replace(/```json|```/g, '').trim());

    // 5. Insert (net-new) or UPDATE (edit-reconciliation) into generated_content.
    //    Edit-reconciliation preserves the original article's id + queue placement
    //    so Frank's edit replaces the draft in-place rather than spawning a dup.
    const cleanedParsed = finalizeArticleForStorage(parsed);
    let contentId;
    if (originalArticle) {
      // Merge cleanedParsed (which has Frank's edited sections) into the existing article_json,
      // preserving any fields we don't want to overwrite (keyTakeaway, faqs, hero_image, etc.
      // unless Frank's audit produced new values).
      const mergedJson = {
        ...(originalArticle.article_json || {}),
        ...cleanedParsed,
        editedBy: 'external_editor',
        editedAt: new Date().toISOString(),
        editReason: editReason || null,
        editImpactScore: parsed.editImpactScore || null,
      };
      await pool.query(
        `UPDATE ${tableName} SET article_json = $1, title = $2, narrative_identity = COALESCE($3::jsonb, narrative_identity), updated_at = NOW() WHERE id = $4`,
        [JSON.stringify(mergedJson), cleanedParsed.title || originalArticle.title, cleanedParsed.narrativeIdentity ? JSON.stringify(cleanedParsed.narrativeIdentity) : null, originalArticle.id]
      );
      contentId = originalArticle.id;
    } else {
      const insertRes = await pool.query(
        `INSERT INTO ${tableName} (brand_profile_id, title, article_json, overall_confidence, brain_match_score, status, review_mode, compliance_status, narrative_identity)
         VALUES ($1, $2, $3, $4, $5, 'staged', 'approve-to-ship', 'pending', $6) RETURNING id`,
        [
          brandProfileId,
          cleanedParsed.title || sourceTitle || 'Imported Article',
          JSON.stringify({
            ...cleanedParsed,
            importedFrom: url || 'manual',
            importedAt: new Date().toISOString()
          }),
          parsed.overallConfidence || 50,
          parsed.brainMatchScore || 50,
          JSON.stringify(cleanedParsed.narrativeIdentity || null)
        ]
      );
      contentId = insertRes.rows[0].id;
    }

    // 6. Stage in publishing queue (only for net-new imports, not edit-reconciliation
    //    — edit-reconciliation updates an EXISTING article, it doesn't create a new queue item)
    if (!originalArticle) {
      await pool.query(
        `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'staged', NOW(), NOW())
         ON CONFLICT (content_id) DO NOTHING`,
        [brandProfileId, contentId, parsed.title || sourceTitle]
      );
    }

    // 7. Close the learning loop — stage brain contributions from this import/edit.
    //    Uses source_channel='external_editor' so Brian can filter these in review
    //    and they don't silently influence future generations until promoted.
    let brainPatternsAdded = 0;
    let brainMistakesAdded = 0;
    try {
      if (originalArticle && Array.isArray(parsed.brainPatterns)) {
        for (const p of parsed.brainPatterns) {
          if (!p?.description) continue;
          const description = String(p.description).slice(0, 1000);
          const evidence = p.evidence ? String(p.evidence).slice(0, 500) : null;
          const tags = [p.pattern_type || 'general', 'source:external_editor'].filter(Boolean);
          await pool.query(
            `INSERT INTO brain_patterns (brand_profile_id, pattern_type, description, confidence_score, success_rate, tags, source_channel, example_titles)
             VALUES ($1, $2, $3, 50, 0, $4, 'external_editor', $5)`,
            [brandProfileId, p.pattern_type || 'voice', evidence ? `${description}\n\nEvidence: ${evidence}` : description, JSON.stringify(tags), JSON.stringify([originalArticle.title])]
          );
          brainPatternsAdded++;
        }
      }
      if (originalArticle && Array.isArray(parsed.brainMistakes)) {
        for (const m of parsed.brainMistakes) {
          if (!m?.description) continue;
          const description = String(m.description).slice(0, 1000);
          const evidence = m.evidence ? String(m.evidence).slice(0, 500) : null;
          await pool.query(
            `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity, guardrail_created)
             VALUES ($1, $2, $3, $4, $5, false)`,
            [brandProfileId, m.mistake_type || 'voice', evidence ? `${description}\n\nEvidence: ${evidence}` : description, `source: external_editor | article: ${originalArticle.title}`, m.severity || 'medium']
          );
          brainMistakesAdded++;
        }
      }
    } catch(brainErr) {
      // Brain writes are best-effort — don't fail the import if they error
      console.error('[IMPORT] brain write failed (non-fatal):', brainErr.message);
    }

    res.json({
      success: true,
      contentId,
      editMode: !!originalArticle,
      brainPatternsAdded,
      brainMistakesAdded,
      title: parsed.title || sourceTitle,
      overallConfidence: parsed.overallConfidence,
      brainMatchScore: parsed.brainMatchScore,
      voiceDeviationScore: parsed.voiceDeviationScore,
      importVerdict: parsed.importVerdict,
      brainFlags: parsed.brainFlags || [],
      suggestions: parsed.suggestions || [],
      sectionCount: parsed.sections?.length || 0
    });

  } catch(e) {
    console.error('[CONTENT-IMPORT]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
