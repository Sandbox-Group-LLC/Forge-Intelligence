// Precog (precognition scoring) routes, extracted from server.js during the
// route-group phase. Mounted at /api/precog with requireAuth at the mount in
// server.js (all 5 routes authed). Deps: shared pool + verifyBrandAccess. Pure
// move: bodies verbatim, only registration lines changed
// (app.METHOD('/api/precog/x', requireAuth, …) -> router.METHOD('/x', …)).
import express from 'express';
import { pool } from '../db.js';
import { verifyBrandAccess } from '../auth.js';

const router = express.Router();

router.post('/score', async (req, res) => {
  const { brandProfileId, contentId } = req.body;
  if (!brandProfileId || !contentId) {
    return res.status(400).json({ error: 'brandProfileId and contentId required' });
  }

  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;

    // 1. Get the content
    const contentRes = await pool.query(`SELECT * FROM ${contentTable} WHERE id = $1`, [contentId]);
    if (!contentRes.rows.length) return res.status(404).json({ error: 'Content not found' });
    const content = contentRes.rows[0];
    const articleJson = content.article_json || {};
    const sections = articleJson.sections || [];

    // 2. Get historical performance data
    const analyticsRes = await pool.query(`
      SELECT 
        AVG(impressions) as avg_impressions,
        AVG(clicks) as avg_clicks,
        AVG(engagement_rate) as avg_engagement,
        AVG(ctr) as avg_ctr,
        MAX(impressions) as max_impressions,
        MAX(engagement_rate) as max_engagement,
        COUNT(*) as total_posts
      FROM content_analytics 
      WHERE brand_profile_id = $1 AND impressions > 0
    `, [brandProfileId]);
    const stats = analyticsRes.rows[0] || {};

    // 3. Get top performing content patterns
    const topPerformersRes = await pool.query(`
      SELECT ca.content_id, ca.impressions, ca.engagement_rate, ca.channel
      FROM content_analytics ca
      WHERE ca.brand_profile_id = $1 AND ca.impressions > 0
      ORDER BY ca.engagement_rate DESC
      LIMIT 10
    `, [brandProfileId]);

    // 4. Get brain patterns
    const patternsRes = await pool.query(`
      SELECT pattern_type, description, confidence_score, success_rate
      FROM brain_patterns
      WHERE brand_profile_id = $1
      ORDER BY success_rate DESC
      LIMIT 20
    `, [brandProfileId]);
    const patterns = patternsRes.rows;

    // 5. Get brain mistakes (anti-patterns)
    const mistakesRes = await pool.query(`
      SELECT mistake_type, description, severity
      FROM brain_mistakes
      WHERE brand_profile_id = $1
    `, [brandProfileId]);
    const mistakes = mistakesRes.rows;

    // ── SCORING ALGORITHM (v2: citation-predictive rebalance) ──
    // Citation predictors now account for ~45/100, brand fidelity ~50/100, history 5/100.
    // Empirically: articles that score high on the new dimensions get cited; articles
    // that score high only on brand-fidelity dimensions look like prior content but
    // don't get pulled by AI engines because they don't add new structure to the
    // citation graph (no definitional language, no external authority, no worksheet).
    let score = 35; // Base (was 50; rebalanced down to make room for citation dims)
    const breakdown = {};

    // Pre-compute reusable text views.
    const title = content.title || '';
    const titleLower = title.toLowerCase();
    const bodyText = sections.map(s => (s.body || s.content || '').toLowerCase()).join(' ');
    const bodyTextRaw = sections.map(s => s.body || s.content || '').join('\n\n');

    // Pull positioning classification + strategic_injection geo_opportunities once.
    let positioningPatterns = [];
    let strategicInjectionTopics = [];
    try {
      const pcRes = await pool.query(`
        SELECT pattern_type, description
        FROM brain_patterns
        WHERE brand_profile_id = $1 AND pattern_type = 'positioning_classification'
      `, [brandProfileId]);
      positioningPatterns = pcRes.rows;
    } catch(e) { /* best-effort */ }
    try {
      // Match on topic OR derived keywords from intent_signals. Two candidate
      // classes: strategic_injection rows (the original signal) AND GEO
      // Strategist opportunities the user actually selected/briefed — those are
      // human-validated whitespace bets and previously never matched this
      // dimension at all (their intent_signals.source is unset), so articles
      // written off the cherry-pick flow scored 0 here by construction.
      const goRes = await pool.query(`
        SELECT topic, intent_signals->>'source' as source, intent_signals->>'deliverable' as deliverable, avg_score, status
        FROM geo_opportunities
        WHERE brand_profile_id = $1
          AND (intent_signals->>'source' LIKE 'strategic_injection%' OR status IN ('selected', 'briefed'))
      `, [brandProfileId]);
      strategicInjectionTopics = goRes.rows;
    } catch(e) { /* best-effort */ }

    // ───── A. Structure (0-10, was 0-15) ─────
    const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
    const sectionCount = sections.length;
    const hasHeadings = sections.filter(s => s.heading).length;

    let structureScore = 0;
    if (wordCount >= 800 && wordCount <= 2500) structureScore += 4;  // wider range; citable longform allowed
    else if (wordCount >= 500 && wordCount <= 3000) structureScore += 2;
    if (sectionCount >= 3 && sectionCount <= 10) structureScore += 3;  // wider; references/FAQ sections OK
    else if (sectionCount >= 2) structureScore += 1;
    if (hasHeadings >= 3) structureScore += 3;
    else if (hasHeadings >= 1) structureScore += 1;

    breakdown.structure = { score: structureScore, max: 10, wordCount, sectionCount, hasHeadings };
    score += structureScore;

    // ───── B. Title (0-10, was 0-15) ─────
    let titleScore = 0;
    if (title.length >= 30 && title.length <= 80) titleScore += 3;  // wider range allowed
    if (/\d/.test(title)) titleScore += 2;
    if (/how|why|what|guide|tips|secrets|mistakes/i.test(title)) titleScore += 3;
    if (!/\?$/.test(title) && title.length > 0) titleScore += 2;

    breakdown.title = { score: titleScore, max: 10, length: title.length };
    score += titleScore;

    // ───── C. Pattern Match (0-15, was 0-20) ─────
    let patternScore = 0;
    const matchedPatterns = [];

    for (const p of patterns) {
      const desc = (p.description || '').toLowerCase();
      const keywords = desc.split(' ').filter(w => w.length > 4).slice(0, 5);
      const matches = keywords.filter(k => titleLower.includes(k) || bodyText.includes(k));
      if (matches.length >= 2) {
        patternScore += Math.min(3, (p.success_rate || 0.5) * 4);
        matchedPatterns.push({ type: p.pattern_type, confidence: p.confidence_score });
      }
    }
    patternScore = Math.min(15, patternScore);
    breakdown.patternMatch = { score: patternScore, max: 15, matchedPatterns };
    score += patternScore;

    // ───── D. Anti-pattern Penalty (-10 to 0, unchanged) ─────
    let penaltyScore = 0;
    const triggeredMistakes = [];
    for (const m of mistakes) {
      const desc = (m.description || '').toLowerCase();
      const keywords = desc.split(' ').filter(w => w.length > 4).slice(0, 3);
      const matches = keywords.filter(k => titleLower.includes(k) || bodyText.includes(k));
      if (matches.length >= 2) {
        const penalty = m.severity === 'high' ? -4 : m.severity === 'medium' ? -2 : -1;
        penaltyScore += penalty;
        triggeredMistakes.push({ type: m.mistake_type, severity: m.severity });
      }
    }
    penaltyScore = Math.max(-10, penaltyScore);
    breakdown.antiPatterns = { score: penaltyScore, max: 0, triggeredMistakes };
    score += penaltyScore;

    // ───── E. History (0-5, was 0-10) ─────
    let historyScore = 0;
    if (stats.total_posts > 0) {
      if (stats.total_posts >= 20) historyScore += 3;
      else if (stats.total_posts >= 10) historyScore += 2;
      else if (stats.total_posts >= 5) historyScore += 1;
      if (stats.avg_engagement > 0.03) historyScore += 2;
      else if (stats.avg_engagement > 0.01) historyScore += 1;
    }
    breakdown.history = {
      score: historyScore,
      max: 5,
      totalPosts: parseInt(stats.total_posts) || 0,
      avgEngagement: parseFloat(stats.avg_engagement) || 0,
      avgImpressions: parseInt(stats.avg_impressions) || 0
    };
    score += historyScore;

    // ───── F. NEW: Category-Defining Language (0-10) ─────
    // Articles that define a coined term get cited as the source of record.
    // Heuristic: title contains a Forge OWNED concept (from positioning_classification),
    // body contains a definitional construction ("X is...", "X means..."), or title
    // uses category-creation language like "is not" / "vs" / "the difference between".
    let categoryDefiningScore = 0;
    const ownedTerms = [];
    const contestedTerms = [];
    for (const p of positioningPatterns) {
      // Storage format: 'OWNED — TERM: OWNED. ...' or 'CONTESTED — TERM: CONTESTED. ...'
      // Capture term between the verdict prefix and the first colon.
      const m = (p.description || '').match(/^(OWNED|CONTESTED)\s*[—\-]\s*([^:]+):/i);
      if (m) {
        const term = m[2].trim().toLowerCase();
        if (m[1].toUpperCase() === 'OWNED') ownedTerms.push(term);
        else contestedTerms.push(term);
      }
    }
    const ownedInTitle = ownedTerms.filter(t => titleLower.includes(t));
    if (ownedInTitle.length > 0) categoryDefiningScore += 5;
    // Definitional construction in body
    const definitionalRx = /\b(is not|vs\.?|versus|the difference between|defined as|means that|refers to)\b/i;
    if (definitionalRx.test(title)) categoryDefiningScore += 3;
    if (/^[A-Z][^.!?]*\b(is|means|refers to)\b/m.test(bodyTextRaw.slice(0, 500))) categoryDefiningScore += 2;
    categoryDefiningScore = Math.min(10, categoryDefiningScore);
    breakdown.categoryDefining = {
      score: categoryDefiningScore,
      max: 10,
      ownedTermsInTitle: ownedInTitle,
      hasDefinitionalLanguage: definitionalRx.test(title)
    };
    score += categoryDefiningScore;

    // ───── G. NEW: External Authoritative Citations (0-8) ─────
    // Articles that cite real external sources get pulled into citation graphs.
    // Heuristic: count markdown links AND footnote markers AND raw URLs in body.
    const mdLinkCount = (bodyTextRaw.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g) || []).length;
    const footnoteRefCount = (bodyTextRaw.match(/\[\^\d+\]/g) || []).length;
    const rawUrlCount = (bodyTextRaw.match(/https?:\/\/[^\s)]+/g) || []).length;
    const externalCitations = mdLinkCount + Math.min(footnoteRefCount, rawUrlCount); // approx unique sources
    let externalCitationsScore = 0;
    if (externalCitations >= 3) externalCitationsScore = 8;
    else if (externalCitations >= 2) externalCitationsScore = 6;
    else if (externalCitations >= 1) externalCitationsScore = 3;
    breakdown.externalCitations = {
      score: externalCitationsScore,
      max: 8,
      mdLinkCount,
      footnoteRefCount,
      rawUrlCount,
      estimatedSources: externalCitations
    };
    score += externalCitationsScore;

    // ───── H. NEW: Worksheet/Checklist Sections (0-7) ─────
    // Numbered lists, decision trees, evaluation frameworks get pulled verbatim
    // by AI engines for "how do I X" queries. Bonus for ≥3 list items in any one section.
    let worksheetScore = 0;
    const hasNumberedList = /^(\d+\.|\*\*\d|##\s*\d|\d\)\s)/m;
    const hasChecklistMarker = /^\s*[-*]\s+\[\s*[xX ]\s*\]/m;
    let worksheetSections = 0;
    for (const s of sections) {
      const body = s.body || s.content || '';
      if (hasNumberedList.test(body) && body.split('\n').filter(l => /^\d+\.\s|^\*\*\d/.test(l)).length >= 3) {
        worksheetSections += 1;
      } else if (hasChecklistMarker.test(body)) {
        worksheetSections += 1;
      }
    }
    if (worksheetSections >= 2) worksheetScore = 7;
    else if (worksheetSections === 1) worksheetScore = 5;
    breakdown.worksheetSections = {
      score: worksheetScore,
      max: 7,
      sectionsWithLists: worksheetSections
    };
    score += worksheetScore;

    // ───── I. NEW: OWNED vs CONTESTED Term Alignment (0-8) ─────
    // Articles that use OWNED terms outright AND avoid bare CONTESTED claims
    // (or reframe them with disambiguation) align with the brain's positioning
    // strategy. CONTESTED terms used without reframe = penalty (Averi/Tofu/Jasper
    // also use those terms; engines get confused which brand owns them).
    let ownedAlignmentScore = 0;
    const ownedInBody = ownedTerms.filter(t => bodyText.includes(t));
    const contestedInBody = contestedTerms.filter(t => bodyText.includes(t));
    // Owned coverage: percent of owned terms that appear in body (max 5)
    if (ownedTerms.length > 0) {
      const ownedCoverage = ownedInBody.length / ownedTerms.length;
      ownedAlignmentScore += Math.round(ownedCoverage * 5);
    }
    // Contested handling: if contested term appears, look for disambiguation language
    // within ~120 chars of it (e.g. "not just X but Y", "different from X").
    let contestedReframed = 0;
    for (const t of contestedInBody) {
      const idx = bodyText.indexOf(t);
      const window = bodyText.slice(Math.max(0, idx - 60), Math.min(bodyText.length, idx + t.length + 120));
      if (/\b(not|different|vs\.?|versus|isn't|is not|unlike|beyond|more than)\b/i.test(window)) {
        contestedReframed += 1;
      }
    }
    if (contestedInBody.length === 0) ownedAlignmentScore += 3;  // clean
    else if (contestedReframed === contestedInBody.length) ownedAlignmentScore += 3;  // all reframed
    else if (contestedReframed > 0) ownedAlignmentScore += 1;  // partial
    // else +0 — contested terms used as if owned, hurts citation clarity
    ownedAlignmentScore = Math.min(8, ownedAlignmentScore);
    breakdown.ownedTermAlignment = {
      score: ownedAlignmentScore,
      max: 8,
      ownedTermsUsed: ownedInBody,
      contestedTermsPresent: contestedInBody,
      contestedReframed
    };
    score += ownedAlignmentScore;

    // ───── J. NEW: Strategic Geo Opportunity Match (0-7) ─────
    // Articles aligned with strategic_injection geo_opportunities are betting on
    // verified whitespace. Articles on auto-discovered topics may overlap with
    // existing competitor coverage.
    // Match geo_opportunity to article. Tighter than v2.0: need a high-density overlap
    // (>=50% of opportunity's distinctive keywords) AND >=3 absolute matches. This stops
    // generic terms like 'ai content' from matching every article to a random opportunity.
    const STOPWORDS = new Set(['about','after','again','against','also','because','being','between','could','during','every','first','from','having','their','these','those','through','under','until','what','when','where','which','while','with','your','this','that','than','they','them','have','will','just','more','only','some','such','make','than','then','here','into','like','over','many','must','same','should']);
    let geoOppScore = 0;
    let matchedOpportunity = null;
    let bestMatch = { count: 0, density: 0 };
    for (const opp of strategicInjectionTopics) {
      const oppTopic = (opp.topic || '').toLowerCase();
      const oppKeywords = oppTopic.split(/\W+/).filter(w => w.length > 4 && !STOPWORDS.has(w));
      if (oppKeywords.length === 0) continue;
      const matches = oppKeywords.filter(k => titleLower.includes(k));
      const density = matches.length / oppKeywords.length;
      if (matches.length >= 3 && density >= 0.5 && (matches.length > bestMatch.count || density > bestMatch.density)) {
        bestMatch = { count: matches.length, density };
        const isPillar = (opp.deliverable || '').includes('pillar');
        geoOppScore = isPillar ? 7 : 5;
        matchedOpportunity = { topic: opp.topic, deliverable: opp.deliverable, source: opp.source || (opp.status ? `strategist_${opp.status}` : null), matchCount: matches.length, density: density.toFixed(2) };
      }
    }
    breakdown.geoOpportunityMatch = {
      score: geoOppScore,
      max: 7,
      matchedOpportunity
    };
    score += geoOppScore;

    // ───── K. NEW: Whitespace Freshness (0-5) ─────
    // Best-effort signal: if no other Forge article on this topic exists in the
    // last 90 days AND the brain has flagged it as "fresh whitespace" via
    // strategic_injection, give a small bonus. This is a cheap proxy for the
    // expensive Sonar live-check we'd ideally do per article.
    let whitespaceScore = 0;
    try {
      const dupRes = await pool.query(`
        SELECT COUNT(*) as cnt FROM ${contentTable}
        WHERE id != $1
          AND created_at > NOW() - INTERVAL '90 days'
          AND title ILIKE '%' || $2 || '%'
      `, [contentId, ownedInTitle[0] || title.split(' ').slice(0, 3).join(' ')]);
      const dupCount = parseInt(dupRes.rows[0]?.cnt || 0);
      if (dupCount === 0 && matchedOpportunity) whitespaceScore = 5;
      else if (dupCount === 0) whitespaceScore = 3;
      else if (dupCount === 1) whitespaceScore = 1;
    } catch(e) { /* best-effort */ }
    breakdown.whitespaceFreshness = {
      score: whitespaceScore,
      max: 5
    };
    score += whitespaceScore;

    // Normalize to 0-100
    score = Math.max(0, Math.min(100, score));

    // Prediction tier
    let tier, prediction, color;
    if (score >= 80) {
      tier = 'high'; prediction = 'Likely to outperform your average'; color = '#22C55E';
    } else if (score >= 60) {
      tier = 'medium'; prediction = 'Expected to perform near your average'; color = '#EAB308';
    } else if (score >= 40) {
      tier = 'low'; prediction = 'May underperform — consider revisions'; color = '#F97316';
    } else {
      tier = 'risk'; prediction = 'High risk — review before publishing'; color = '#EF4444';
    }

    // Predicted impressions range
    const predictedImpressions = stats.avg_impressions 
      ? { low: Math.round(stats.avg_impressions * (score / 100) * 0.7), high: Math.round(stats.avg_impressions * (score / 100) * 1.5) }
      : null;

    // Save score to content table
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_score INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_breakdown JSONB`).catch(() => {});
    await pool.query(`UPDATE ${contentTable} SET precog_score = $1, precog_breakdown = $2, updated_at = NOW() WHERE id = $3`, [Math.round(score), JSON.stringify(breakdown), contentId]);

    res.json({
      success: true, score, tier, prediction, color, breakdown, predictedImpressions,
      historicalContext: {
        totalPosts: parseInt(stats.total_posts) || 0,
        avgImpressions: Math.round(stats.avg_impressions) || 0,
        avgEngagement: ((parseFloat(stats.avg_engagement) || 0) * 100).toFixed(2) + '%'
      }
    });

  } catch (err) {
    console.error('[Pre-cog] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/score/:brandProfileId/:contentId', async (req, res) => {
  const { brandProfileId, contentId } = req.params;
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    
    const result = await pool.query(`SELECT precog_score, precog_breakdown FROM ${contentTable} WHERE id = $1`, [contentId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Content not found' });
    
    const row = result.rows[0];
    if (!row.precog_score) return res.json({ success: true, score: null, message: 'Score not yet calculated' });

    const score = row.precog_score;
    let tier, prediction, color;
    if (score >= 80) { tier = 'high'; prediction = 'Likely to outperform'; color = '#22C55E'; }
    else if (score >= 60) { tier = 'medium'; prediction = 'Near average'; color = '#EAB308'; }
    else if (score >= 40) { tier = 'low'; prediction = 'May underperform'; color = '#F97316'; }
    else { tier = 'risk'; prediction = 'High risk'; color = '#EF4444'; }

    res.json({ success: true, score, tier, prediction, color, breakdown: row.precog_breakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/batch', async (req, res) => {
  const { brandProfileId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_score INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_breakdown JSONB`).catch(() => {});

    const unscoredRes = await pool.query(`SELECT id FROM ${contentTable} WHERE precog_score IS NULL ORDER BY created_at DESC LIMIT 50`);

    const scored = [];
    for (const row of unscoredRes.rows) {
      try {
        const scoreRes = await fetch(`https://${req.headers.host}/api/precog/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization || '' },
          body: JSON.stringify({ brandProfileId, contentId: row.id })
        });
        const data = await scoreRes.json();
        if (data.success) scored.push({ id: row.id, score: data.score });
      } catch (e) {
        console.error(`[Pre-cog] Failed to score ${row.id}:`, e.message);
      }
    }

    res.json({ success: true, scored: scored.length, items: scored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/all/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    // Query separately to avoid RLS cross-table join issue on precog_outcomes
    const [gcRes, poRes] = await Promise.all([
      pool.query(`
        SELECT id, title, precog_score, precog_breakdown, precog_scored_at, created_at
        FROM ${contentTable}
        WHERE precog_score IS NOT NULL
           OR (precog_breakdown IS NOT NULL AND precog_breakdown->>'tier' = 'insufficient_data')
        ORDER BY created_at DESC LIMIT 100
      `),
      pool.query(`
        SELECT content_id, actual_impressions, actual_clicks, direction_correct, in_range,
               measured_at, predicted_signal, predicted_impressions_low, predicted_impressions_high
        FROM precog_outcomes WHERE brand_profile_id = $1
      `, [brandProfileId])
    ]);
    // Merge outcomes onto content rows
    const outcomesMap = {};
    for (const po of poRes.rows) outcomesMap[po.content_id] = po;
    const items = gcRes.rows.map(gc => ({ ...gc, ...( outcomesMap[gc.id] || {}) }));
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/accuracy/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)                                                              AS total_predictions,
        COUNT(*) FILTER (WHERE measured_at IS NOT NULL)                      AS measured_count,
        COUNT(*) FILTER (WHERE measured_at IS NULL)                          AS pending_count,
        COUNT(*) FILTER (WHERE direction_correct = true)                     AS direction_correct_count,
        COUNT(*) FILTER (WHERE in_range = true)                              AS in_range_count
      FROM precog_outcomes
      WHERE brand_profile_id = $1
    `, [brandProfileId]);

    const s = r.rows[0];
    const measured  = parseInt(s.measured_count)          || 0;
    const pending   = parseInt(s.pending_count)           || 0;
    const dirCorr   = parseInt(s.direction_correct_count) || 0;
    const inRange   = parseInt(s.in_range_count)          || 0;

    res.json({
      success: true,
      measuredCount: measured,
      pendingCount: pending,
      totalPredictions: parseInt(s.total_predictions) || 0,
      directionAccuracy: measured >= 3 ? Math.round((dirCorr / measured) * 100) : null,
      rangeAccuracy:     measured >= 3 ? Math.round((inRange / measured) * 100) : null,
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
