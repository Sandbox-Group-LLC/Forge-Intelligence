// Brand Intelligence (Strategy) routes — RECOVERED.
// The full 6-deliverable Brand Intelligence backend (gap-map, blind-spots,
// whitespace, pivot, shareable brief, compliance gate) was built on the old
// strategy lineage and working at commit 5b1ac6e9c6 (2026-04-19), then wiped by
// a "sync server.js from production" overwrite and lost in the later strategy→main
// branch rebuild. Restored here from that commit VERBATIM in body, with only:
//   - route registration rewritten app.METHOD('/api/strategy/x') → router.METHOD('/x')
//   - model IDs ported claude-sonnet-4-20250514 → claude-sonnet-4-6 (current house Sonnet)
//   - AI-output JSON.parse → extractJSON (house hardened parser)
// Isolated into a module (not back into server.js) per the WHITEBOARD's own
// post-mortem lesson: a monolith server.js is what let a prod-sync wipe it twice.
// Mounted at /api/strategy. Mixed auth: brief/:token is PUBLIC (board share link),
// everything else requireAuth. competitive-intel GET/POST stay inline in server.js
// (they survived) — this module owns the 15 recovered handlers.
import express from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';
import { extractJSON } from '../llm-json.js';
import { requireAuth } from '../auth.js';

const router = express.Router();

// Container-type normalizers for stored deliverable JSONB. Historically one
// gap_map row was persisted double-encoded (data.gaps = a JSON *string*, not an
// array — the pg driver parses the outer JSONB but leaves the inner string),
// which crashed the frontend's gaps.map(). These recover a double-encoded value
// and enforce the array/object contract so the API never emits a wrong type.
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
const asObject = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; } catch { return null; } }
  return null;
};

router.get('/gap-map/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const r = await pool.query(
      'SELECT data, brain_version, updated_at FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
      [brandProfileId, 'gap_map']
    );
    if (!r.rows.length) return res.json({ success: true, gaps: [], cached: false });
    const profile = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const currentVersion = profile.rows[0]?.version || 1;
    const stale = r.rows[0].brain_version < currentVersion;
    res.json({ success: true, gaps: asArray(r.rows[0].data?.gaps), cached: true, stale, updatedAt: r.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST generate gap map (Tool 1: aggregation + synthesis from existing pipeline data)
router.post('/gap-map/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { force = false } = req.body || {};

  // SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    const profileRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profileRes.rows.length) { send('error', { error: 'Brand not found' }); return res.end(); }
    const profile = profileRes.rows[0];
    const pd = profile.profile_data || {};
    const brainVersion = profile.version || 1;

    // Check cache
    if (!force) {
      const cached = await pool.query(
        'SELECT data, brain_version FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
        [brandProfileId, 'gap_map']
      );
      if (cached.rows.length && cached.rows[0].brain_version >= brainVersion) {
        send('result', { gaps: asArray(cached.rows[0].data?.gaps), cached: true });
        return res.end();
      }
    }

    // ── Source 1: GEO topical authority map (gapsByCluster) ──
    send('progress', { detail: 'Pulling topical authority gaps from GEO...' });
    const geoRes = await pool.query(
      "SELECT brief_data->'topicalMap'->'gapsByCluster' as gaps FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1",
      [brandProfileId]
    );
    const gapsByCluster = geoRes.rows[0]?.gaps || [];
    send('detail', { detail: `${gapsByCluster.length} topical gaps found` });

    // ── Source 2: Discovered competitors from Context Hub ──
    send('progress', { detail: 'Reading competitor positioning from Context Hub...' });
    const competitors = pd.discoveredCompetitors || [];
    const competitorPositioning = competitors.map(c => ({
      name: c.name || c.url,
      url: c.url,
      differentiators: c.differentiators || [],
      valueProps: c.valuePropositions || c.valueProps || [],
      weaknesses: c.weaknesses || []
    }));
    send('detail', { detail: `${competitors.length} competitors mapped` });

    // ── Source 3: PVA data from Competitive Intelligence ──
    send('progress', { detail: 'Reading vulnerability analysis...' });
    const pvaRes = await pool.query(
      'SELECT competitor_name, pva_data, fault_lines_data FROM competitive_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const pvaByCompetitor = pvaRes.rows.map(r => ({
      name: r.competitor_name,
      vulnerabilities: (r.pva_data || []).map(v => ({
        type: v.type,
        claim: v.claim,
        vulnerability: v.vulnerability,
        severity: v.severity
      })),
      faultLines: (r.fault_lines_data || []).map(fl => ({
        language: fl.theirLanguage,
        frequency: fl.frequency,
        angle: fl.differentiationAngle
      }))
    }));
    send('detail', { detail: `${pvaRes.rows.length} competitor analyses loaded` });

    // ── Synthesis: Cross-competitor gap identification ──
    send('progress', { detail: 'Synthesizing cross-competitor gaps...' });

    const brandContext = `Brand: ${profile.brand_name} (${profile.brand_url})
Industry/Category: ${pd.industry || pd.category || 'Unknown'}
Brand Positioning: ${pd.positioningStatement || pd.valueProposition || 'Not specified'}`;

    const synthesisPrompt = `You are a senior brand strategist conducting competitive gap analysis for a board-level intelligence brief. Your job is to find UNDEFENDED MARKET POSITIONS — territory no competitor currently owns that this brand can claim.

${brandContext}

## Source Data

### Topical Authority Gaps (from GEO analysis — where AI platforms don't cite this brand)
${JSON.stringify(gapsByCluster.slice(0, 15), null, 2)}

### Competitor Positioning (from Context Hub scrape)
${JSON.stringify(competitorPositioning, null, 2)}

### Positioning Vulnerabilities & Messaging Fault Lines (from competitive analysis)
${JSON.stringify(pvaByCompetitor, null, 2)}

## Your Task
Synthesize these three data sources to identify 5-8 COMPETITIVE GAPS — positions in the market that:
1. No competitor currently owns or defends well
2. The brand has credible right-to-win based on their actual capabilities
3. Represent real market demand (not theoretical whitespace)

For each gap, cross-reference across all three sources. A gap that shows up in GEO data AND has a corresponding competitor vulnerability AND aligns with messaging fault lines is a high-conviction gap.

## Output Format
Return ONLY a JSON array. No markdown, no preamble, no backticks. Each item:
{
  "position": "The undefended market position stated as a strategic claim the brand could own",
  "opportunityScore": 0-100,
  "currentState": "Who loosely holds this territory and why their hold is weak",
  "evidence": {
    "geo": "What the topical authority data shows (or null if no signal)",
    "pva": "What competitor vulnerabilities create this opening (or null)",
    "faultLines": "What messaging gaps expose this territory (or null)"
  },
  "rightToWin": "Why THIS brand specifically can credibly claim this position",
  "boardImplication": "One sentence a CMO reads to the board explaining why this matters commercially",
  "attackVector": "The specific strategic move to claim this position"
}

Sort by opportunityScore descending. Be ruthlessly specific — no generic strategic advice. Every gap must be traceable to the source data.`;

    const synthesisRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6144,
      messages: [{ role: 'user', content: synthesisPrompt }]
    });

    let gaps = [];
    try {
      gaps = extractJSON(synthesisRes.content[0].text, 'array');
    } catch (pe) {
      console.error('[GAP-MAP] Parse error:', pe.message);
      send('error', { error: 'Failed to parse gap analysis output' });
      return res.end();
    }

    send('detail', { detail: `${gaps.length} competitive gaps identified` });

    // ── Persist ──
    await pool.query(
      `INSERT INTO brand_intelligence (brand_profile_id, deliverable, data, brain_version)
       VALUES ($1, 'gap_map', $2, $3)
       ON CONFLICT (brand_profile_id, deliverable)
       DO UPDATE SET data = $2, brain_version = $3, updated_at = NOW()`,
      [brandProfileId, JSON.stringify({ gaps }), brainVersion]
    );

    console.log('[GAP-MAP] Complete —', gaps.length, 'gaps for', profile.brand_name);
    send('result', { gaps, cached: false });
    res.end();

  } catch (err) {
    console.error('[GAP-MAP] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});


// ── Brand Intelligence: Audience Blind Spots ─────────────────────────────────

// GET cached blind spots
router.get('/blind-spots/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const r = await pool.query(
      'SELECT data, brain_version, updated_at FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
      [brandProfileId, 'blind_spots']
    );
    if (!r.rows.length) return res.json({ success: true, blindSpots: [], cached: false });
    const profile = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const currentVersion = profile.rows[0]?.version || 1;
    const stale = r.rows[0].brain_version < currentVersion;
    res.json({ success: true, blindSpots: asArray(r.rows[0].data?.blindSpots), cached: true, stale, updatedAt: r.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST generate blind spots analysis
router.post('/blind-spots/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { force = false } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    const profileRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profileRes.rows.length) { send('error', { error: 'Brand not found' }); return res.end(); }
    const profile = profileRes.rows[0];
    const pd = profile.profile_data || {};
    const brainVersion = profile.version || 1;

    // Check cache
    if (!force) {
      const cached = await pool.query(
        'SELECT data, brain_version FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
        [brandProfileId, 'blind_spots']
      );
      if (cached.rows.length && cached.rows[0].brain_version >= brainVersion) {
        send('result', { blindSpots: asArray(cached.rows[0].data?.blindSpots), cached: true });
        return res.end();
      }
    }

    // ── Source 1: Brand's own personas ──
    send('progress', { detail: 'Reading brand personas from Context Hub...' });
    const personas = pd.personas || [];
    send('detail', { detail: `${personas.length} personas defined` });

    // ── Source 2: Competitive gaps + strategic recommendations ──
    send('progress', { detail: 'Pulling competitive gaps and strategic recommendations...' });
    const competitiveGaps = pd.competitiveGaps || [];
    const strategicRecs = pd.strategicRecommendations || [];
    send('detail', { detail: `${competitiveGaps.length} gaps, ${strategicRecs.length} recommendations` });

    // ── Source 3: PVA + Fault Lines (who competitors over-serve) ──
    send('progress', { detail: 'Analyzing competitor audience focus from PVA...' });
    const pvaRes = await pool.query(
      'SELECT competitor_name, pva_data, fault_lines_data FROM competitive_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const competitorIntel = pvaRes.rows.map(r => ({
      name: r.competitor_name,
      vulnerabilities: r.pva_data || [],
      faultLines: r.fault_lines_data || []
    }));
    send('detail', { detail: `${pvaRes.rows.length} competitors analyzed` });

    // ── Source 4: GEO topical gaps (audiences implied by unclaimed topics) ──
    send('progress', { detail: 'Pulling topical authority gaps for audience signals...' });
    const geoRes = await pool.query(
      "SELECT brief_data->'topicalMap'->'gapsByCluster' as gaps FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1",
      [brandProfileId]
    );
    const topicalGaps = geoRes.rows[0]?.gaps || [];
    send('detail', { detail: `${topicalGaps.length} topical gaps loaded` });

    // ── Synthesis ──
    send('progress', { detail: 'Identifying audience blind spots across all sources...' });

    const brandContext = `Brand: ${profile.brand_name} (${profile.brand_url})
Industry/Category: ${pd.industry || pd.marketCategory || 'Unknown'}`;

    const prompt = `You are a senior brand strategist conducting audience blind spot analysis for a board-level intelligence brief. Your job is to find AUDIENCE SEGMENTS THE MARKET IS IGNORING — buyer personas that no competitor is actively speaking to, that this brand has a credible right to serve.

${brandContext}

## Source Data

### Brand's Current Personas (who they already target)
${JSON.stringify(personas.map(p => ({ name: p.name, role: p.role, painPoints: p.painPoints, triggers: p.triggers, skepticism: p.skepticism })), null, 2)}

### Competitive Gaps (whitespace often implies underserved buyers)
${JSON.stringify(competitiveGaps.slice(0, 8), null, 2)}

### Strategic Recommendations (may reference untapped audience segments)
${JSON.stringify(strategicRecs.slice(0, 8).map(r => ({ title: r.title, description: r.description, category: r.category })), null, 2)}

### Competitor Vulnerabilities & Messaging (who they over-serve reveals who they neglect)
${JSON.stringify(competitorIntel.map(c => ({
  name: c.name,
  vulnerabilities: (c.vulnerabilities || []).slice(0, 3).map(v => ({ claim: v.claim, vulnerability: v.vulnerability })),
  faultLines: (c.faultLines || []).slice(0, 3).map(fl => ({ language: fl.theirLanguage, angle: fl.differentiationAngle }))
})), null, 2)}

### Topical Authority Gaps (unclaimed topics often map to underserved audiences)
${JSON.stringify(topicalGaps.slice(0, 10).map(g => ({ topic: g.topic, owner: g.owner, rationale: g.rationale })), null, 2)}

## Your Task
Identify 4-6 AUDIENCE BLIND SPOTS — buyer personas or audience segments that:
1. No competitor is actively speaking to or building content for
2. The brand has credible products, capabilities, or authority to serve
3. Represent real purchasing power or strategic influence
4. Are distinct from the brand's existing personas (not just slight variations)

Think beyond the obvious. Look for:
- Adjacent industries that need the same capabilities but aren't being marketed to
- Emerging roles (new job titles, new responsibilities) that didn't exist 2 years ago
- Decision influencers who aren't the buyer but shape the purchase (security teams, compliance officers, end users)
- Segments competitors actively alienate through their positioning choices

## Output Format
Return ONLY a JSON array. No markdown, no preamble, no backticks. Each item:
{
  "persona": "Descriptive name for this audience segment",
  "role": "Typical job title or function",
  "whyBlind": "Why the market is ignoring this segment — what about current competitor positioning excludes them",
  "evidence": {
    "competitorGap": "What competitor behavior or messaging creates this blind spot (or null)",
    "topicalSignal": "What topical/content gap points to this audience being underserved (or null)",
    "marketTrend": "What market shift is creating or expanding this segment (or null)"
  },
  "opportunitySize": "small | medium | large",
  "rightToServe": "Why THIS brand specifically can credibly reach this audience",
  "activationPlay": "The specific first move to capture this audience — not generic advice, a concrete action",
  "experientialPlay": "A specific in-person, event-based, or experiential marketing move to reach this audience — conferences, executive dinners, field activations, immersive demos, co-branded experiences. Must be executable, not theoretical.",
  "boardImplication": "One sentence a CMO reads to the board explaining the revenue opportunity"
}

Sort by opportunitySize (large first). Be ruthlessly specific — name real roles, real market dynamics, real competitive blind spots. No generic 'small business owners' or 'tech-savvy millennials.'`;

    const synthesisRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6144,
      messages: [{ role: 'user', content: prompt }]
    });

    let blindSpots = [];
    try {
      blindSpots = extractJSON(synthesisRes.content[0].text, 'array');
    } catch (pe) {
      console.error('[BLIND-SPOTS] Parse error:', pe.message);
      send('error', { error: 'Failed to parse blind spots output' });
      return res.end();
    }

    send('detail', { detail: `${blindSpots.length} audience blind spots identified` });

    // Persist
    await pool.query(
      `INSERT INTO brand_intelligence (brand_profile_id, deliverable, data, brain_version)
       VALUES ($1, 'blind_spots', $2, $3)
       ON CONFLICT (brand_profile_id, deliverable)
       DO UPDATE SET data = $2, brain_version = $3, updated_at = NOW()`,
      [brandProfileId, JSON.stringify({ blindSpots }), brainVersion]
    );

    console.log('[BLIND-SPOTS] Complete —', blindSpots.length, 'blind spots for', profile.brand_name);
    send('result', { blindSpots, cached: false });
    res.end();

  } catch (err) {
    console.error('[BLIND-SPOTS] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});


// ── Brand Intelligence: Topical Authority Whitespace ─────────────────────────

// GET cached whitespace
router.get('/whitespace/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const r = await pool.query(
      'SELECT data, brain_version, updated_at FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
      [brandProfileId, 'whitespace']
    );
    if (!r.rows.length) return res.json({ success: true, territories: [], cached: false });
    const profile = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const currentVersion = profile.rows[0]?.version || 1;
    const stale = r.rows[0].brain_version < currentVersion;
    res.json({ success: true, territories: asArray(r.rows[0].data?.territories), cached: true, stale, updatedAt: r.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST generate whitespace analysis
router.post('/whitespace/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { force = false } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    const profileRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profileRes.rows.length) { send('error', { error: 'Brand not found' }); return res.end(); }
    const profile = profileRes.rows[0];
    const pd = profile.profile_data || {};
    const brainVersion = profile.version || 1;

    // Check cache
    if (!force) {
      const cached = await pool.query(
        'SELECT data, brain_version FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
        [brandProfileId, 'whitespace']
      );
      if (cached.rows.length && cached.rows[0].brain_version >= brainVersion) {
        send('result', { territories: asArray(cached.rows[0].data?.territories), cached: true });
        return res.end();
      }
    }

    // ── Source 1: GEO Opportunities (platform visibility scores) ──
    send('progress', { detail: 'Pulling platform visibility scores from GEO...' });
    const oppsRes = await pool.query(
      `SELECT topic, avg_score, quick_win, platform_scores, topical_authority_context
       FROM geo_opportunities WHERE brand_profile_id = $1
       ORDER BY avg_score ASC`,
      [brandProfileId]
    );
    const opportunities = oppsRes.rows.map(r => {
      let ctx = r.topical_authority_context || {};
      if (typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = {}; } }
      return {
        topic: r.topic,
        avgScore: parseFloat(r.avg_score) || 0,
        quickWin: r.quick_win,
        platforms: r.platform_scores || {},
        owner: ctx.owner || null,
        rationale: ctx.rationale || '',
        citationScore: ctx.geoCitationScore || 0
      };
    });
    send('detail', { detail: `${opportunities.length} topics with platform visibility data` });

    // ── Source 2: GEO topical authority gaps ──
    send('progress', { detail: 'Reading topical authority map...' });
    const geoRes = await pool.query(
      "SELECT brief_data->'topicalMap'->'gapsByCluster' as gaps FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1",
      [brandProfileId]
    );
    const gapsByCluster = geoRes.rows[0]?.gaps || [];
    send('detail', { detail: `${gapsByCluster.length} authority gaps loaded` });

    // ── Source 3: Competitor messaging data ──
    send('progress', { detail: 'Reading competitor narrative control from PVA...' });
    const pvaRes = await pool.query(
      'SELECT competitor_name, pva_data, fault_lines_data FROM competitive_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const competitorNarratives = pvaRes.rows.map(r => ({
      name: r.competitor_name,
      claimCount: (r.pva_data || []).length,
      topClaims: (r.pva_data || []).slice(0, 3).map(v => v.claim),
      messagingThemes: (r.fault_lines_data || []).slice(0, 3).map(fl => fl.theirLanguage)
    }));
    send('detail', { detail: `${pvaRes.rows.length} competitor narrative profiles` });

    // ── Synthesis ──
    send('progress', { detail: 'Mapping narrative territory and invisibility zones...' });

    const brandContext = `Brand: ${profile.brand_name} (${profile.brand_url})
Industry/Category: ${pd.industry || pd.marketCategory || 'Unknown'}`;

    const prompt = `You are a senior brand strategist conducting topical authority whitespace analysis for a board-level intelligence brief. This is NOT a content calendar exercise. This is a map of CONVERSATIONS YOUR BRAND IS BEING EXCLUDED FROM — narrative territory that competitors control while this brand is invisible.

${brandContext}

## Source Data

### Platform Visibility Scores (0-100, where this brand appears when buyers ask AI about these topics)
${JSON.stringify(opportunities.map(o => ({
  topic: o.topic,
  brandVisibility: o.avgScore,
  controlledBy: o.owner || 'unclaimed',
  platforms: o.platforms,
  quickWin: o.quickWin,
  citationScore: o.citationScore,
  rationale: o.rationale
})), null, 2)}

### Topical Authority Gaps (competitive intelligence on who owns what narrative)
${JSON.stringify(gapsByCluster.slice(0, 12), null, 2)}

### Competitor Narrative Control (what competitors are saying and how often)
${JSON.stringify(competitorNarratives, null, 2)}

## Your Task
Analyze these three data sources and produce a NARRATIVE TERRITORY MAP — not topics to write about, but conversations this brand is losing. For each territory:
- Frame it as a conversation buyers are having RIGHT NOW that this brand has no voice in
- Quantify the invisibility using the platform scores
- Name who controls the narrative and what it costs this brand
- Assess how hard it would be to enter the conversation

## Output Format
Return ONLY a JSON array. No markdown, no preamble, no backticks. Each item:
{
  "narrative": "The conversation happening without this brand — framed as a buyer question or market discussion, not a topic",
  "controlledBy": "Competitor name or 'fragmented' if no single owner",
  "brandVisibility": 0-100,
  "platformBreakdown": { "chatgpt": 0-100, "perplexity": 0-100, "gemini": 0-100, "aiOverviews": 0-100 },
  "invisibilityCost": "What this brand loses commercially by being absent from this conversation",
  "narrativeControl": "How the current owner frames this conversation and why it excludes this brand",
  "reclaimDifficulty": "low | medium | high",
  "quickWin": true/false,
  "ninetyDayPlay": "Specific action to enter this conversation within 90 days — not generic advice",
  "boardImplication": "One sentence a CMO reads to the board about why this absence costs market share"
}

Sort by brandVisibility ascending (most invisible first). Be brutally specific — name real platforms, real competitor language, real commercial consequences.`;

    const synthesisRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    });

    let territories = [];
    try {
      territories = extractJSON(synthesisRes.content[0].text, 'array');
    } catch (pe) {
      console.error('[WHITESPACE] Parse error:', pe.message);
      send('error', { error: 'Failed to parse whitespace analysis output' });
      return res.end();
    }

    send('detail', { detail: `${territories.length} narrative territories mapped` });

    // Persist
    await pool.query(
      `INSERT INTO brand_intelligence (brand_profile_id, deliverable, data, brain_version)
       VALUES ($1, 'whitespace', $2, $3)
       ON CONFLICT (brand_profile_id, deliverable)
       DO UPDATE SET data = $2, brain_version = $3, updated_at = NOW()`,
      [brandProfileId, JSON.stringify({ territories }), brainVersion]
    );

    console.log('[WHITESPACE] Complete —', territories.length, 'territories for', profile.brand_name);
    send('result', { territories, cached: false });
    res.end();

  } catch (err) {
    console.error('[WHITESPACE] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});


// ── Brand Intelligence: Recommended Positioning Pivot ────────────────────────

// GET cached pivot
router.get('/pivot/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const r = await pool.query(
      'SELECT data, brain_version, updated_at FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
      [brandProfileId, 'pivot']
    );
    if (!r.rows.length) return res.json({ success: true, pivot: null, cached: false });
    const profile = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const currentVersion = profile.rows[0]?.version || 1;
    const stale = r.rows[0].brain_version < currentVersion;
    res.json({ success: true, pivot: asObject(r.rows[0].data?.pivot), cached: true, stale, updatedAt: r.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST generate positioning pivot (synthesizes all 5 deliverables)
router.post('/pivot/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { force = false } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    const profileRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profileRes.rows.length) { send('error', { error: 'Brand not found' }); return res.end(); }
    const profile = profileRes.rows[0];
    const pd = profile.profile_data || {};
    const brainVersion = profile.version || 1;

    // Check cache
    if (!force) {
      const cached = await pool.query(
        'SELECT data, brain_version FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
        [brandProfileId, 'pivot']
      );
      if (cached.rows.length && cached.rows[0].brain_version >= brainVersion) {
        send('result', { pivot: asObject(cached.rows[0].data?.pivot), cached: true });
        return res.end();
      }
    }

    // ── Load all 5 deliverables ──
    send('progress', { detail: 'Loading all five intelligence dimensions...' });

    const biRes = await pool.query(
      'SELECT deliverable, data FROM brand_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const deliverables = {};
    biRes.rows.forEach(r => { deliverables[r.deliverable] = r.data; });

    const pvaRes = await pool.query(
      'SELECT competitor_name, pva_data, fault_lines_data FROM competitive_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );

    const gapMap = asArray((deliverables.gap_map || {}).gaps);
    const blindSpots = asArray((deliverables.blind_spots || {}).blindSpots);
    const whitespace = asArray((deliverables.whitespace || {}).territories);
    const pva = pvaRes.rows.map(r => ({
      competitor: r.competitor_name,
      vulnerabilities: (r.pva_data || []).map(v => ({ severity: v.severity, claim: v.claim, vulnerability: v.vulnerability })),
      faultLines: (r.fault_lines_data || []).map(fl => ({ priority: fl.priority, language: fl.theirLanguage, angle: fl.differentiationAngle }))
    }));

    const loaded = [
      gapMap.length ? 'Gap Map' : null,
      pva.length ? 'PVA + Fault Lines' : null,
      blindSpots.length ? 'Blind Spots' : null,
      whitespace.length ? 'Whitespace' : null
    ].filter(Boolean);

    send('detail', { detail: `Loaded: ${loaded.join(', ')}` });

    if (loaded.length < 3) {
      send('error', { error: `Need at least 3 of 5 deliverables to generate a pivot. Currently have: ${loaded.join(', ')}. Run the missing analyses first.` });
      return res.end();
    }

    // ── Synthesis ──
    send('progress', { detail: 'Finding the convergence across all dimensions...' });

    const brandContext = `Brand: ${profile.brand_name} (${profile.brand_url})
Industry/Category: ${pd.industry || pd.marketCategory || 'Unknown'}
Current positioning: ${pd.positioningStatement || pd.valueProposition || 'Not explicitly stated'}`;

    const prompt = `You are a CMO's chief strategist. You've just been handed five dimensions of competitive intelligence for a single brand. Your job is to find the ONE positioning move that appears across all five dimensions — the strategic convergence that, once you see it, you can't unsee.

This is not a brainstorm. This is not a list of options. This is the singular strategic redirect this brand needs to make. One pivot. One rationale. Three moves.

${brandContext}

## Dimension 1: Competitive Gap Map
Undefended market positions, ranked by opportunity:
${JSON.stringify(gapMap.map(g => ({ position: g.position, score: g.opportunityScore, boardImplication: g.boardImplication, attackVector: g.attackVector })), null, 2)}

## Dimension 2: Positioning Vulnerabilities
Competitor claims that are overexposed or weak:
${JSON.stringify(pva.map(c => ({ competitor: c.competitor, vulnerabilities: c.vulnerabilities.slice(0, 3) })), null, 2)}

## Dimension 3: Messaging Fault Lines
Exact competitor language and differentiation angles:
${JSON.stringify(pva.map(c => ({ competitor: c.competitor, faultLines: c.faultLines.slice(0, 3) })), null, 2)}

## Dimension 4: Audience Blind Spots
Buyer personas the market ignores:
${JSON.stringify(blindSpots.map(s => ({ persona: s.persona, role: s.role, opportunitySize: s.opportunitySize, whyBlind: s.whyBlind, boardImplication: s.boardImplication })), null, 2)}

## Dimension 5: Topical Authority Whitespace
Conversations this brand is invisible in:
${JSON.stringify(whitespace.map(t => ({ narrative: t.narrative, brandVisibility: t.brandVisibility, controlledBy: t.controlledBy, invisibilityCost: t.invisibilityCost, boardImplication: t.boardImplication })), null, 2)}

## Your Task
Find the convergence. What is the ONE positioning move that:
1. Exploits the gaps ALL competitors leave open (Dimension 1)
2. Attacks the vulnerabilities competitors can't fix without abandoning their current positioning (Dimension 2)
3. Uses language competitors have ceded (Dimension 3)
4. Speaks to the audiences nobody else is talking to (Dimension 4)
5. Claims the conversations where this brand is currently invisible but has the strongest right-to-win (Dimension 5)

## Output Format
Return ONLY a JSON object. No markdown, no preamble, no backticks.
{
  "pivotStatement": "One sentence. The positioning claim this brand should make. Not a tagline — a strategic position stated plainly. A CMO reads this to the board and says 'this is who we are now.'",
  "fromTo": {
    "from": "What the brand is currently perceived as (be honest, not flattering)",
    "to": "What the brand becomes after the pivot"
  },
  "whyNow": "Why this pivot works RIGHT NOW — what market conditions, competitor missteps, or buyer shifts make this the moment",
  "convergenceEvidence": {
    "gapMap": "Which gaps from Dimension 1 directly support this pivot",
    "pva": "Which competitor vulnerabilities from Dimension 2 this pivot exploits",
    "faultLines": "Which messaging gaps from Dimension 3 this pivot fills",
    "blindSpots": "Which underserved audiences from Dimension 4 this pivot speaks to",
    "whitespace": "Which invisible conversations from Dimension 5 this pivot enters"
  },
  "threeMovesIn90Days": [
    {
      "move": "First move — the most important, do this Monday",
      "rationale": "Why this move first",
      "outcome": "What changes when this is done"
    },
    {
      "move": "Second move",
      "rationale": "Why this move second",
      "outcome": "What changes when this is done"
    },
    {
      "move": "Third move",
      "rationale": "Why this move third",
      "outcome": "What changes when this is done"
    }
  ],
  "whatToStopDoing": "The one thing this brand should STOP saying or doing immediately — the positioning habit that contradicts this pivot",
  "boardSlide": "The closer. 3-5 sentences a CMO puts on the final slide. This is the moment the room goes quiet. Open with what the company is losing by standing still — name the dollar amount or market share at stake. Then state the pivot in one line. Then close with the competitive window — why waiting 6 months means someone else claims this position. Write it like the CMO rehearsed it in the mirror. Conviction, not caution."
}

Be ruthlessly specific. Name competitors. Name products. Name audiences. This is a war room document, not a strategy deck.`;

    send('progress', { detail: 'Generating positioning pivot...' });

    const synthesisRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    let pivot = null;
    try {
      pivot = extractJSON(synthesisRes.content[0].text, 'object');
    } catch (pe) {
      console.error('[PIVOT] Parse error:', pe.message);
      send('error', { error: 'Failed to parse positioning pivot output' });
      return res.end();
    }

    send('detail', { detail: 'Positioning pivot identified' });

    // Persist
    await pool.query(
      `INSERT INTO brand_intelligence (brand_profile_id, deliverable, data, brain_version)
       VALUES ($1, 'pivot', $2, $3)
       ON CONFLICT (brand_profile_id, deliverable)
       DO UPDATE SET data = $2, brain_version = $3, updated_at = NOW()`,
      [brandProfileId, JSON.stringify({ pivot }), brainVersion]
    );

    console.log('[PIVOT] Complete for', profile.brand_name);
    send('result', { pivot, cached: false });
    res.end();

  } catch (err) {
    console.error('[PIVOT] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});


// ── Brand Intelligence: Shareable Brief ──────────────────────────────────────

// POST create share link
router.post('/share/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const profile = await pool.query('SELECT brand_name, brand_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profile.rows.length) return res.status(404).json({ success: false, error: 'Brand not found' });
    const { brand_name, brand_url } = profile.rows[0];
    const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
    await pool.query(
      'INSERT INTO brand_intelligence_shares (brand_profile_id, token, created_by, brand_name, brand_url) VALUES ($1, $2, $3, $4, $5)',
      [brandProfileId, token, req.userId || null, brand_name, brand_url]
    );
    const shareUrl = `https://${req.headers.host}/brand-intelligence/${token}`;
    res.json({ success: true, token, url: shareUrl });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET list shares for a brand
router.get('/shares/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, token, created_at, revoked_at FROM brand_intelligence_shares WHERE brand_profile_id = $1 ORDER BY created_at DESC',
      [req.params.brandProfileId]
    );
    res.json({ success: true, shares: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE revoke a share
router.delete('/share/:token', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE brand_intelligence_shares SET revoked_at = NOW() WHERE token = $1', [req.params.token]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET public brief (no auth — token-gated)
router.get('/brief/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const shareRes = await pool.query(
      'SELECT * FROM brand_intelligence_shares WHERE token = $1',
      [token]
    );
    if (!shareRes.rows.length) return res.status(404).json({ success: false, error: 'Brief not found' });
    const share = shareRes.rows[0];
    if (share.revoked_at) return res.status(410).json({ success: false, error: 'This brief link has been revoked' });

    const brandProfileId = share.brand_profile_id;

    // Load all deliverables
    const biRes = await pool.query(
      'SELECT deliverable, data, updated_at FROM brand_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const deliverables = {};
    biRes.rows.forEach(r => { deliverables[r.deliverable] = { data: r.data, updatedAt: r.updated_at }; });

    const pvaRes = await pool.query(
      'SELECT competitor_name, pva_data, fault_lines_data, updated_at FROM competitive_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const competitors = pvaRes.rows.map(r => ({
      name: r.competitor_name,
      pva: r.pva_data || [],
      faultLines: r.fault_lines_data || [],
      updatedAt: r.updated_at
    }));

    res.json({
      success: true,
      brandName: share.brand_name,
      brandUrl: share.brand_url,
      createdAt: share.created_at,
      pivot: asObject(deliverables.pivot?.data?.pivot),
      gapMap: asArray(deliverables.gap_map?.data?.gaps),
      blindSpots: asArray(deliverables.blind_spots?.data?.blindSpots),
      whitespace: asArray(deliverables.whitespace?.data?.territories),
      competitors,
      updatedAt: biRes.rows.reduce((latest, r) => r.updated_at > latest ? r.updated_at : latest, share.created_at)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Brand Intelligence: Compliance Check ─────────────────────────────────────

// GET cached compliance report
router.get('/compliance/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const r = await pool.query(
      'SELECT data, brain_version, updated_at FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
      [brandProfileId, 'compliance']
    );
    if (!r.rows.length) return res.json({ success: true, report: null, cached: false });
    res.json({ success: true, report: r.rows[0].data, cached: true, updatedAt: r.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST run compliance audit
router.post('/compliance/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    const profileRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profileRes.rows.length) { send('error', { error: 'Brand not found' }); return res.end(); }
    const profile = profileRes.rows[0];
    const pd = profile.profile_data || {};
    const brainVersion = profile.version || 1;

    // ── Load all deliverables ──
    send('progress', { detail: 'Loading all deliverables for audit...' });

    const biRes = await pool.query(
      'SELECT deliverable, data FROM brand_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const deliverables = {};
    biRes.rows.forEach(r => { deliverables[r.deliverable] = r.data; });

    const pvaRes = await pool.query(
      'SELECT competitor_name, competitor_url, pva_data, fault_lines_data, scraped_content_length FROM competitive_intelligence WHERE brand_profile_id = $1',
      [brandProfileId]
    );

    const pivot = asObject(deliverables.pivot?.pivot);
    const gaps = asArray(deliverables.gap_map?.gaps);
    const blindSpots = asArray(deliverables.blind_spots?.blindSpots);
    const whitespace = asArray(deliverables.whitespace?.territories);
    const competitors = pvaRes.rows;

    if (!pivot && gaps.length === 0 && blindSpots.length === 0 && whitespace.length === 0) {
      send('error', { error: 'No deliverables to audit. Run the analyses first.' });
      return res.end();
    }

    // ── Load source data (what the AI actually had access to) ──
    send('progress', { detail: 'Loading source data for cross-reference...' });

    // GEO gaps
    const geoRes = await pool.query(
      "SELECT brief_data->'topicalMap'->'gapsByCluster' as gaps FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1",
      [brandProfileId]
    );
    const sourceGeoGaps = geoRes.rows[0]?.gaps || [];

    // GEO opportunities with platform scores
    const oppsRes = await pool.query(
      'SELECT topic, avg_score, platform_scores, topical_authority_context FROM geo_opportunities WHERE brand_profile_id = $1',
      [brandProfileId]
    );
    const sourceOpportunities = oppsRes.rows;

    // Competitor data from Context Hub
    const sourceCompetitors = pd.discoveredCompetitors || [];
    const sourceCompetitiveGaps = pd.competitiveGaps || [];
    const sourcePersonas = pd.personas || [];

    // Scraped content lengths
    const sourceScrapeLengths = {};
    competitors.forEach(c => { sourceScrapeLengths[c.competitor_name] = c.scraped_content_length; });

    send('detail', { detail: `Sources: ${sourceGeoGaps.length} GEO gaps, ${sourceOpportunities.length} opportunities, ${competitors.length} competitor scrapes, ${sourcePersonas.length} personas` });

    // ── Audit ──
    send('progress', { detail: 'Auditing all claims against source data...' });

    const auditPrompt = `You are a fact-checking editor for a board-level competitive intelligence brief. Your job is to audit every specific, verifiable claim in this brief against the SOURCE DATA that was actually available when the brief was generated.

## CRITICAL RULES
1. If a claim contains a DOLLAR AMOUNT, MARKET SIZE, PERCENTAGE, or STATISTIC — it MUST be traceable to source data or flagged as unverified.
2. If a claim quotes or paraphrases a COMPETITOR'S LANGUAGE — verify it appears in the scraped data or PVA output.
3. If a claim makes a CAUSAL ASSERTION ("this costs X" or "this leads to Y") — flag it as inferred unless the source data directly supports causation.
4. General strategic analysis and recommendations are "inferred" by nature — that's fine. Only flag them as unverified if they contain specific factual claims.
5. Be thorough but not pedantic. "Intel has a broad portfolio" is general knowledge. "$12B edge AI market" is a specific claim that needs a source.
6. DO NOT audit Forge's own internal scores — opportunityScore, brandVisibility, platform scores (chatgpt/perplexity/gemini/aiOverviews), confidenceScore, pass rates, reclaim difficulty ratings, or opportunity size ratings. These are Forge-generated analytical outputs, not factual claims. Skip them entirely.
7. Focus ONLY on claims about the external world — market sizes, dollar figures, competitor quotes, industry statistics, causal business assertions, and named third-party data.

## THE BRIEF TO AUDIT

### Positioning Pivot
${pivot ? JSON.stringify(pivot, null, 2) : 'Not generated'}

### Competitive Gap Map
${JSON.stringify(gaps.slice(0, 8), null, 2)}

### Audience Blind Spots
${JSON.stringify(blindSpots.map(s => ({ persona: s.persona, role: s.role, whyBlind: s.whyBlind, boardImplication: s.boardImplication, activationPlay: s.activationPlay, experientialPlay: s.experientialPlay || null })), null, 2)}

### Topical Authority Whitespace
${JSON.stringify(whitespace.map(t => ({ narrative: t.narrative, brandVisibility: t.brandVisibility, controlledBy: t.controlledBy, invisibilityCost: t.invisibilityCost, boardImplication: t.boardImplication, ninetyDayPlay: t.ninetyDayPlay })), null, 2)}

### Vulnerabilities (from competitor scrapes)
${JSON.stringify(competitors.map(c => ({ name: c.competitor_name, url: c.competitor_url, scrapedChars: c.scraped_content_length, pva: (c.pva_data || []).map(v => ({ claim: v.claim, evidence: v.evidence, severity: v.severity })) })), null, 2)}

### Fault Lines
${JSON.stringify(competitors.map(c => ({ name: c.competitor_name, faultLines: (c.fault_lines_data || []).map(fl => ({ language: fl.theirLanguage, frequency: fl.frequency })) })), null, 2)}

## SOURCE DATA (what was actually available)

### GEO Topical Gaps (from platform analysis)
${JSON.stringify(sourceGeoGaps.slice(0, 12), null, 2)}

### GEO Opportunities (platform visibility scores — REAL measurements)
${JSON.stringify(sourceOpportunities.map(o => ({ topic: o.topic, avgScore: o.avg_score, platforms: o.platform_scores })), null, 2)}

### Competitor URLs Scraped
${JSON.stringify(competitors.map(c => ({ name: c.competitor_name, url: c.competitor_url, scrapedChars: c.scraped_content_length })), null, 2)}

### Competitive Gaps (from Context Hub brand analysis)
${JSON.stringify(sourceCompetitiveGaps.slice(0, 8), null, 2)}

### Brand Personas (from Context Hub)
${JSON.stringify(sourcePersonas.map(p => ({ name: p.name, role: p.role })), null, 2)}

## OUTPUT FORMAT
Return ONLY a JSON object. No markdown, no preamble, no backticks.
{
  "summary": {
    "totalClaims": number,
    "verified": number,
    "inferred": number,
    "unverified": number,
    "passRate": "percentage as string like '84%'"
  },
  "findings": [
    {
      "deliverable": "pivot | gap_map | blind_spots | whitespace | pva | fault_lines",
      "claim": "The exact claim text being audited",
      "status": "verified | inferred | unverified",
      "source": "Where in the source data this claim originates (or null if unverified)",
      "issue": "What's wrong — why it can't be verified (or null if verified/inferred)",
      "recommendation": "How to fix: 'add caveat', 'remove specific figure', 'cite source', 'rephrase as estimate' (or null if clean)",
      "suggestedRewrite": "For unverified claims: the EXACT rewritten text that replaces the original claim. Remove specific figures and replace with directional language ('multi-billion dollar' instead of '$12B'), or add 'estimated' / 'approximately' qualifiers. Must be a drop-in replacement — same meaning, no unverifiable specifics. Null for verified claims."
    }
  ]
}

Focus on the MOST IMPORTANT claims — dollar amounts, market sizes, percentages, competitive quotes, and causal assertions. Don't audit every adjective. A brief with 60+ findings is useless. Target 15-30 of the highest-risk claims.

Sort findings: unverified first, then inferred, then verified. Within each tier, highest-risk first.`;

    const auditRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: auditPrompt }]
    });

    let report = null;
    try {
      report = extractJSON(auditRes.content[0].text, 'object');
    } catch (pe) {
      console.error('[COMPLIANCE] Parse error:', pe.message);
      send('error', { error: 'Failed to parse compliance audit output' });
      return res.end();
    }

    send('detail', { detail: `Audit complete: ${report.summary?.totalClaims || 0} claims checked — ${report.summary?.unverified || 0} unverified` });

    // Persist
    await pool.query(
      `INSERT INTO brand_intelligence (brand_profile_id, deliverable, data, brain_version)
       VALUES ($1, 'compliance', $2, $3)
       ON CONFLICT (brand_profile_id, deliverable)
       DO UPDATE SET data = $2, brain_version = $3, updated_at = NOW()`,
      [brandProfileId, JSON.stringify(report), brainVersion]
    );

    console.log('[COMPLIANCE] Complete —', report.summary?.totalClaims, 'claims,', report.summary?.unverified, 'unverified for', profile.brand_name);
    send('result', { report, cached: false });
    res.end();

  } catch (err) {
    console.error('[COMPLIANCE] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});


// ── Brand Intelligence: Apply compliance fix ─────────────────────────────────
router.post('/compliance-fix/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const { deliverable, claim, rewrite } = req.body;
    if (!deliverable || !claim || !rewrite) return res.status(400).json({ success: false, error: 'deliverable, claim, and rewrite are required' });

    // Map deliverable names to table/column
    const isPva = deliverable === 'pva' || deliverable === 'fault_lines';

    if (isPva) {
      // PVA/fault lines live in competitive_intelligence
      const ciRes = await pool.query(
        'SELECT id, pva_data, fault_lines_data FROM competitive_intelligence WHERE brand_profile_id = $1',
        [brandProfileId]
      );
      for (const row of ciRes.rows) {
        let changed = false;
        const dataStr = JSON.stringify(row.pva_data || []) + JSON.stringify(row.fault_lines_data || []);
        if (dataStr.includes(claim)) {
          let pva = JSON.stringify(row.pva_data || []);
          let fl = JSON.stringify(row.fault_lines_data || []);
          if (pva.includes(claim)) { pva = pva.split(claim).join(rewrite); changed = true; }
          if (fl.includes(claim)) { fl = fl.split(claim).join(rewrite); changed = true; }
          if (changed) {
            await pool.query(
              'UPDATE competitive_intelligence SET pva_data = $1, fault_lines_data = $2, updated_at = NOW() WHERE id = $3',
              [JSON.parse(pva), JSON.parse(fl), row.id]
            );
          }
        }
      }
    } else {
      // All other deliverables live in brand_intelligence
      const biRes = await pool.query(
        'SELECT id, data FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
        [brandProfileId, deliverable]
      );
      if (!biRes.rows.length) return res.status(404).json({ success: false, error: 'Deliverable not found' });
      let dataStr = JSON.stringify(biRes.rows[0].data);
      if (!dataStr.includes(claim)) return res.status(404).json({ success: false, error: 'Claim not found in deliverable data' });
      dataStr = dataStr.split(claim).join(rewrite);
      await pool.query(
        'UPDATE brand_intelligence SET data = $1, updated_at = NOW() WHERE id = $2',
        [JSON.parse(dataStr), biRes.rows[0].id]
      );
    }

    // Update the compliance finding to mark it resolved
    const compRes = await pool.query(
      'SELECT id, data FROM brand_intelligence WHERE brand_profile_id = $1 AND deliverable = $2',
      [brandProfileId, 'compliance']
    );
    if (compRes.rows.length) {
      const report = compRes.rows[0].data;
      const finding = (report.findings || []).find(f => f.claim === claim);
      if (finding) {
        finding.status = 'rewritten';
        finding.rewrittenTo = rewrite;
        // Recalculate summary
        const findings = report.findings || [];
        report.summary.verified = findings.filter(f => f.status === 'verified').length;
        report.summary.inferred = findings.filter(f => f.status === 'inferred').length;
        report.summary.unverified = findings.filter(f => f.status === 'unverified').length;
        const rewritten = findings.filter(f => f.status === 'rewritten').length;
        const total = findings.length;
        const passed = report.summary.verified + report.summary.inferred + rewritten;
        report.summary.passRate = Math.round((passed / total) * 100) + '%';
        await pool.query(
          'UPDATE brand_intelligence SET data = $1, updated_at = NOW() WHERE id = $2',
          [JSON.stringify(report), compRes.rows[0].id]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[COMPLIANCE-FIX]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});


export default router;
