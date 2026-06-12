// GEO Strategist (Stage 2) routes, extracted from server.js during the
// route-group phase. Mounted at /api/geo-strategist with NO mount-level auth —
// MIXED group (GET /briefs/:id is public; briefs + analyze are requireAuth), so
// auth stays per-route. Pure move: bodies verbatim, only registration lines
// changed (app.METHOD('/api/geo-strategist/x', …) -> router.METHOD('/x', …)).
import express from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';
import { extractJSON } from '../llm-json.js';
import { requireAuth } from '../auth.js';
import { normalizeGeoData } from '../geo.js';
import { coldScan, extractDomain } from '../geoProbe.js';

const router = express.Router();

router.get('/briefs', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.query;
    const query = brandProfileId
      ? `SELECT id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, brain_version, created_at, updated_at
         FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY updated_at DESC`
      : `SELECT id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, brain_version, created_at, updated_at
         FROM geo_briefs ORDER BY updated_at DESC`;
    const result = brandProfileId
      ? await pool.query(query, [brandProfileId])
      : await pool.query(query);
    // Get current brain version for staleness comparison
    let currentBrainVersion = 1;
    if (brandProfileId) {
      const bpRes = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (bpRes.rows.length) currentBrainVersion = bpRes.rows[0].version || 1;
    }
    const data = result.rows.map(r => ({
      id: r.id, brandProfileId: r.brand_profile_id,
      brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, opportunityScore: r.opportunity_score,
      brainVersion: r.brain_version || 1, currentBrainVersion,
      createdAt: r.created_at, updatedAt: r.updated_at,
      ...r.brief_data
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/briefs/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM geo_briefs WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = result.rows[0];
    res.json({ success: true, data: {
      id: r.id, brandProfileId: r.brand_profile_id,
      brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, opportunityScore: r.opportunity_score,
      createdAt: r.created_at, updatedAt: r.updated_at,
      ...r.brief_data
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyze', requireAuth, async (req, res) => {
  const { brandProfileId, topicFocus = '', additionalContext = '' } = req.body;
  if (!brandProfileId) {
    return res.status(400).json({ success: false, error: 'brandProfileId is required' });
  }

  const startTime = Date.now();

  try {
    // ── Step 0: Brain-First Protocol ─────────────────────────────────────────
    let brainPatterns = [], brainMistakes = [];
    try {
      const [pRes, mRes] = await Promise.all([
        pool.query(`SELECT pattern_type, description, success_rate, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY success_rate DESC LIMIT 10`, [brandProfileId]),
        pool.query(`SELECT mistake_type, description, human_feedback, guardrail_created, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 10`, [brandProfileId]),
      ]);
      brainPatterns = pRes.rows;
      brainMistakes = mRes.rows;
    } catch(e) {
      console.log('[GEO] Brain tables not seeded — proceeding cold:', e.message);
    }

    const brainContext = `BRAIN PATTERNS (what worked for this brand): ${JSON.stringify(brainPatterns)}
BRAIN MISTAKES (DO NOT repeat for this brand): ${JSON.stringify(brainMistakes)}`;

    // ── Step 1: Load Stage 1 brand profile ───────────────────────────────────
    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    if (!profileResult.rows.length) {
      return res.status(404).json({ success: false, error: 'Brand profile not found. Run Stage 1 first.' });
    }
    const profile = profileResult.rows[0];
    const pd = profile.profile_data || {};

    // ── Cache check ──────────────────────────────────────────────────────────
    const forceRefresh = req.body.force === true;
    if (!topicFocus && !additionalContext && !forceRefresh) {
      const existing = await pool.query(
        `SELECT * FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const bd = r.brief_data || {};
        const cachedTopical = bd.topicalAuthorityMap || [];
        const cachedGeo = bd.geoOpportunitiesNorm || [];
        const topicalIsReal = cachedTopical.length > 0 && cachedTopical.some(t => t.topic && t.topic !== 'Unknown' && t.citationProbability > 0);
        const geoIsReal = cachedGeo.length > 0 && cachedGeo.some(g => g.topic && (g.chatgpt > 0 || g.perplexity > 0));
        if (!topicalIsReal || !geoIsReal) {
          console.log('[GEO] Cache stale — topical or geo has bad data, forcing fresh run');
          // fall through to fresh analysis
        } else if ((r.brain_version || 1) < (profile.version || 1)) {
          console.log(`[GEO] Cache stale — built on brain v${r.brain_version || 1}, current is v${profile.version || 1}, forcing fresh run`);
          // fall through to fresh analysis
        } else {
          const normalized = { topicalAuthorityMap: cachedTopical, geoOpportunities: cachedGeo, entitySchemaMap: bd.entitySchemaMap, geoBrief: bd.geoBrief };
          return res.json({ success: true, cached: true, data: {
            id: r.id, brandProfileId: r.brand_profile_id,
            brandUrl: r.brand_url, brandName: r.brand_name,
            version: r.version, opportunityScore: r.opportunity_score,
            brainVersion: r.brain_version || 1, currentBrainVersion: profile.version || 1,
            createdAt: r.created_at, updatedAt: r.updated_at,
            ...normalized
          }});
        }
      }
    }

    const voiceProfile = pd.voiceProfile || {};
    const personas = pd.personas || [];
    const competitiveGaps = pd.competitiveGaps || {};
    const whitespace = typeof competitiveGaps === 'string' ? competitiveGaps : (competitiveGaps.whitespace || '');
    const competitorTopics = Array.isArray(competitiveGaps) ? competitiveGaps : (competitiveGaps.competitorOwnedTopics || []);

    // ── Factual Ground + Strategic Moats injection ───────────────────────────
    // GEO Strategist previously read only Context Hub's profile_data. That meant user-saved
    // corrections (what they actually do, deliberate non-choices, verified competitors) didn't
    // influence topic discovery. Topics that contradicted the brand's own stated positioning
    // could surface as "opportunities" — wasting downstream work. Load both here so Tool 1
    // (Topical Authority Mapper) can respect them.
    const factualGround = profile.settings?.factualGround || null;
    const strategicMoats = Array.isArray(pd.strategicMoats) ? pd.strategicMoats : [];
    const factualGroundBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\nUSER-VERIFIED FACTS (authoritative — topics must not contradict these):
${factualGround.whatWeDo ? `- What this brand does: ${String(factualGround.whatWeDo).slice(0, 400)}\n` : ''}${factualGround.whatWeDontDo ? `- What this brand does NOT do: ${String(factualGround.whatWeDontDo).slice(0, 400)}\n` : ''}${factualGround.competitors?.length ? `- Verified competitors (use these, ignore Context Hub's discoveries if they conflict): ${(Array.isArray(factualGround.competitors) ? factualGround.competitors : [factualGround.competitors]).slice(0, 8).join(', ')}\n` : ''}${factualGround.methodology ? `- Methodology/frameworks: ${String(factualGround.methodology).slice(0, 300)}\n` : ''}`
      : '';
    const strategicMoatsBlock = strategicMoats.length
      ? `\nSTRATEGIC MOATS (things the brand deliberately does NOT do — do NOT suggest topics in these areas, they are intentional exclusions, not gaps):
${strategicMoats.map(m => `- ${m.capability}${m.rationale ? ` (${String(m.rationale).slice(0, 120)})` : ''}`).join('\n')}`
      : '';

    // ── Step 1.5: Measured citation probe (best-effort) ──────────────────────
    // Whitespace used to be pure LLM inference over the cached Stage 1 profile.
    // Probe the REAL engines with brand-free buyer questions before mapping
    // topical gaps, so Tool 1 reasons over observed citations — which questions
    // the brand is invisible on, and who AI cites instead — rather than priors.
    // Best-effort by design: no engine keys, a probe outage, or a question-gen
    // failure all degrade cleanly to the old inference-only path.
    let citationProbe = null;
    try {
      const brandDomain = extractDomain(profile.brand_url || '');
      if (brandDomain) {
        const qRes = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 900,
          messages: [{ role: 'user', content: `Write 8 natural questions a buyer would type into ChatGPT or Perplexity when researching the category this brand sells into — the questions where the brand would WANT to be recommended. Do NOT mention the brand name in any question (we are measuring unprompted visibility). Keep each question under 110 characters.

BRAND: ${profile.brand_name} (${profile.brand_url})
PERSONAS: ${JSON.stringify(personas).slice(0, 1200)}
COMPETITOR-OWNED TOPICS: ${JSON.stringify(competitorTopics).slice(0, 800)}
${topicFocus ? 'FOCUS AREA: ' + topicFocus : ''}

Return ONLY a raw JSON array of strings. No markdown, no explanation.` }]
        });
        const probeQuestions = (JSON.parse(extractJSON(qRes.content[0].text, 'array') || '[]'))
          .filter(q => typeof q === 'string' && q.trim()).slice(0, 8);
        if (probeQuestions.length) {
          citationProbe = await coldScan({ brandName: profile.brand_name, brandDomain, questions: probeQuestions });
          console.log(`[GEO] Probe: visibility ${citationProbe.visibility}% over ${probeQuestions.length} questions (${citationProbe.enginesProbed.join(',')})`);
        }
      }
    } catch (e) {
      console.log('[GEO] Citation probe skipped:', e.message);
    }
    // A question is "invisible" only when at least one engine answered AND none
    // cited or mentioned the brand — engine errors are not evidence of absence.
    const invisibleQuestions = citationProbe
      ? citationProbe.perQuestion.filter(r => {
          const checked = Object.values(r.engines).filter(s => s !== 'error');
          return checked.length > 0 && !checked.some(s => s === 'cited' || s === 'mentioned');
        }).map(r => r.question)
      : [];
    const citationProbeBlock = citationProbe ? `

MEASURED AI VISIBILITY (live probe of the real engines, run minutes ago — treat as ground truth over any modeled assumption):
- Brand appeared in ${citationProbe.visibility}% of ${citationProbe.totalChecks} engine answers (engines: ${citationProbe.enginesProbed.join(', ')})
- Per engine: ${Object.entries(citationProbe.byEngine).map(([id, v]) => `${id} ${v.available ? v.pct + '%' : 'not measured'}`).join(' · ')}
- WHO AI CITES INSTEAD (domains actually answering this category today): ${citationProbe.sources.slice(0, 10).map(s => `${s.domain} (${s.mentions})`).join(', ') || 'none captured'}
- Buyer questions where the brand was INVISIBLE on every engine that answered (strongest whitespace evidence): ${invisibleQuestions.length ? invisibleQuestions.map(q => `"${q}"`).join(' | ') : 'none — the brand surfaced somewhere on every question'}` : '';

    // ── Tool 1: Topical Authority Mapper ─────────────────────────────────────
    console.log('[GEO] Tool 1: Topical Authority Mapper...');
    const topicalRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `You are the Topical Authority Mapper for Forge Intelligence GEO Strategist.

BRAND: ${profile.brand_name} (${profile.brand_url})
PERSONAS: ${JSON.stringify(personas).slice(0, 1500)}
COMPETITOR TOPICS: ${JSON.stringify(competitorTopics).slice(0, 4000)}
WHITESPACE: ${whitespace.slice(0, 2000)}
${topicFocus ? 'FOCUS: ' + topicFocus : ''}${factualGroundBlock}${strategicMoatsBlock}${citationProbeBlock}

Identify 8-12 topical gaps where this brand has low AI citation probability vs competitors. Topics must be consistent with the USER-VERIFIED FACTS above and must NOT fall inside the STRATEGIC MOATS (those are intentional exclusions, not opportunities).

When MEASURED AI VISIBILITY is present, it outranks every inferred signal: the invisible buyer questions are the strongest gap evidence (derive topics directly from them where they fit the brand), and the "who AI cites instead" domains are the real topic owners — use the actual cited domain as the owner when you have no stronger candidate.

Group the gaps into 2-4 clusters. A cluster is the pillar a future content hub builds around (one pillar piece + supporting articles); related gaps share a cluster name. AI engines cite domains with clustered depth at a multiple of the rate of isolated one-off posts, so the clustering IS the strategy, not labeling.

For each gap, also state the information-gain angle: the unique data, first-hand experience, named methodology, or proprietary POV THIS brand can add that an aggregator could not (ground it in the USER-VERIFIED FACTS and methodology when present). Engines increasingly penalize repackaged content — a topical gap the brand cannot say anything original about is a weak opportunity, and its geoCitationScore must reflect that.

YOU MUST return a raw JSON array using EXACTLY these field names: topic, geoCitationScore, owner, rationale, cluster, informationGainAngle.
Example:
[{"topic":"AI PC and Edge Inference","geoCitationScore":85,"owner":"NVIDIA","rationale":"NVIDIA dominates this topic across AI platforms","cluster":"Edge AI Infrastructure","informationGainAngle":"First-party latency benchmarks from the brand's own deployments"},{"topic":"Open Ecosystem Software","geoCitationScore":72,"owner":null,"rationale":"Unclaimed whitespace with high intent","cluster":"Edge AI Infrastructure","informationGainAngle":"The brand's published interop methodology, named verbatim"}]

Return ONLY the raw JSON array. No markdown. No backticks. No explanation. No other keys.` }]
    });
    let topicalMap = { gapsByCluster: [] };
    try {
      // Tool 1 returns a flat array
      const tm = extractJSON(topicalRes.content[0].text, 'array');
      if (!tm) throw new Error('No JSON array found in Tool 1 response');
      const gaps = JSON.parse(tm);
      topicalMap = { gapsByCluster: gaps, brandClusters: [], competitorClusters: [] };
    } catch(e) { console.log('[GEO] Tool 1 parse warn:', e.message, '| raw:', topicalRes.content[0].text.slice(0,200)); }
    console.log(`[GEO] Tool 1 gaps: ${topicalMap.gapsByCluster.length}`);
    if (topicalMap.gapsByCluster.length > 0) console.log("[GEO] Tool 1 sample:", JSON.stringify(topicalMap.gapsByCluster.slice(0,2)));

    // ── Tool 2: GEO Opportunity Scorer ────────────────────────────────────────
    console.log('[GEO] Tool 2: GEO Opportunity Scorer...');
    const scorerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: `You are the GEO Opportunity Scorer for Forge Intelligence.

BRAND: ${profile.brand_name} (${profile.brand_url})
TOPICAL GAPS: ${JSON.stringify(
  (topicalMap.gapsByCluster || [])
    .map(g => ({ ...g, _score: g.geoCitationScore || g.citationProbability || g.score || g.geoScore || g.probability || 0 }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 10)
    .map(({ _score, ...rest }) => rest)
)}
WHITESPACE: ${whitespace.slice(0, 1000)}${citationProbe ? `
MEASURED BASELINE (live probe, ground truth): brand currently appears in ${citationProbe.visibility}% of engine answers — per engine: ${Object.entries(citationProbe.byEngine).map(([id, v]) => `${id} ${v.available ? v.pct + '%' : 'not measured'}`).join(' · ')}. Anchor your scores on this reality: an engine where the brand already surfaces supports higher scores; an engine where it is fully absent today needs stronger justification for a high score.` : ''}

For each topic gap, score citation probability 0-100 across all 4 AI platforms. Score each platform against what that engine actually rewards, not a uniform rubric:
- ChatGPT: favors established authority and entity recognition (Wikipedia-grade sources dominate its citations). Score high when the topic lets the brand make authoritative, fact-dense claims in a space without an entrenched encyclopedic authority; score low where a Wikipedia-tier source already owns the answer.
- Perplexity: favors freshness and community signal (Reddit/forum-heavy citation mix, strong recency bias). Score high for topics with recent developments, dated data, or active practitioner discussion the brand can speak to; evergreen topics dominated by old authoritative pages score low.
- Google AI Overviews: favors E-E-A-T plus structured, schema-marked content surfaced through Google's index. Score high where the brand can demonstrate first-hand expertise on a long-tail question; score low for head terms where established domains already hold the SERP.
- Gemini: favors brand-owned domains (over half its citations resolve to brand sites) and consistent entity presence. Score high when the topic sits squarely in the brand's own naming/products/methodology; score low for generic category topics with no brand-entity tie.
quickWin=true if score >= 70 and low brand presence.

Return ONLY a raw JSON array (no markdown, no explanation):
[{"platform":"ChatGPT","topic":"string","score":80,"quickWin":true},{"platform":"Perplexity","topic":"string","score":70,"quickWin":false},{"platform":"Google AI Overviews","topic":"string","score":65,"quickWin":false},{"platform":"Gemini","topic":"string","score":60,"quickWin":false}]` }]
    });
    let geoOpportunities = [];
    try {
      const go = extractJSON(scorerRes.content[0].text, 'array');
      if (!go) throw new Error('No JSON array found in Tool 2 response');
      geoOpportunities = JSON.parse(go);
    } catch(e) { console.log('[GEO] Tool 2 parse warn:', e.message, '| raw:', scorerRes.content[0].text.slice(0,200)); }
    console.log(`[GEO] Tool 2 opportunities: ${(geoOpportunities||[]).length}`);

    // ── Tool 3: Entity & Schema Mapper ────────────────────────────────────────
    console.log('[GEO] Tool 3: Entity & Schema Mapper...');
    const entityRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: `You are the Entity & Schema Mapper for Forge Intelligence.

BRAND: ${profile.brand_name}
COMPETITIVE GAPS: ${JSON.stringify(competitorTopics).slice(0, 400)}
TOP GEO OPPORTUNITIES: ${JSON.stringify(geoOpportunities.slice(0, 8))}${factualGround?.competitors?.length ? `\nVERIFIED COMPETITORS (use these, do not include entities from different companies with similar names): ${(Array.isArray(factualGround.competitors) ? factualGround.competitors : [factualGround.competitors]).slice(0, 8).join(', ')}` : ''}

Identify entities needing structured markup for AI citation. Flag competitor entities this brand is NOT being cited for.

Return ONLY valid JSON array:
[{"entity":"string","schemaTypes":["Article"],"competitorCiting":false,"priority":"high|medium|low","rationale":"string"}]` }]
    });
    let entitySchema = [];
    try {
      const es = extractJSON(entityRes.content[0].text, 'array');
      if (!es) throw new Error('No JSON array found in Tool 3 response');
      entitySchema = JSON.parse(es);
    } catch(e) { console.log('[GEO] Tool 3 parse warn:', e.message, '| raw:', entityRes.content[0].text.slice(0,200)); }

    // ── NEW ARCHITECTURE: No auto-brief. Persist opportunities for user cherry-picking. ──
    // Tool 4 (Brief Generator) moved to Stage 2.1 — runs ONLY on user-selected topics.
    // Why: burning tokens on 10 briefs when user may only want 2-3 was wasteful.
    // Unpicked opportunities stay in the table as brain food — "user did NOT pick this" is signal.
    console.log('[GEO] Persisting opportunities — no auto-brief (user cherry-picks in UI)...');
    const quickWins = geoOpportunities.filter(o => o.quickWin).slice(0, 3);

    // Generate a session ID that groups all opportunities from this GEO run
    const discoverySessionId = randomUUID();

    // Deduplicate opportunities by topic before persisting (input array often repeats topics per platform)
    const opportunitiesByTopic = new Map();
    for (const opp of geoOpportunities) {
      const key = (opp.topic || '').trim().toLowerCase();
      if (!key) continue;
      if (!opportunitiesByTopic.has(key)) {
        opportunitiesByTopic.set(key, { ...opp, platformScores: {} });
      }
      const existing = opportunitiesByTopic.get(key);
      // Merge platform-specific scores
      if (opp.platform && typeof opp.score === 'number') {
        const _p = opp.platform.toLowerCase().replace(/\s/g, '');
        const _key = _p.includes('overview') || _p.includes('google') ? 'aiOverviews'
          : _p.includes('chatgpt') || _p.includes('openai') ? 'chatgpt'
          : _p.includes('perplexity') ? 'perplexity'
          : _p.includes('gemini') ? 'gemini' : _p;
        existing.platformScores[_key] = opp.score;
      } else if (opp.chatgpt !== undefined || opp.perplexity !== undefined) {
        existing.platformScores = {
          chatgpt: opp.chatgpt, perplexity: opp.perplexity,
          aiOverviews: opp.aiOverviews, gemini: opp.gemini
        };
      }
    }

    // Persist each unique opportunity — link topical authority context for user decision-making
    const persistedOpportunities = [];
    for (const [topic, opp] of opportunitiesByTopic) {
      const platforms = opp.platformScores || {};
      const scores = Object.values(platforms).filter(v => typeof v === 'number');
      const avgScore = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length) : 0;
      // Find the topical authority writeup for this topic if available
      // topicalMap is an OBJECT like { gapsByCluster: [...] }, not an array
      const authorityGaps = (topicalMap && Array.isArray(topicalMap.gapsByCluster))
        ? topicalMap.gapsByCluster
        : (Array.isArray(topicalMap) ? topicalMap : []);
      const authorityWriteup = authorityGaps.find(t => {
        const tt = (t.topic || t.cluster || '').trim().toLowerCase();
        return tt === topic || topic.includes(tt) || tt.includes(topic);
      });
      const authorityContext = authorityWriteup ? JSON.stringify(authorityWriteup) : '';

      // Ignore propagation — if the user has already dismissed a very similar topic,
      // don't resurface it under a near-duplicate name. Checks for:
      //  (1) any previously-ignored topic whose trigram similarity ≥ 0.55 to this one, OR
      //  (2) any previously-ignored topic that contains / is contained in this one (substring).
      // If found, insert with status='ignored' so the user's prior decision propagates.
      let inheritedStatus = 'discovered';
      try {
        const dupRes = await pool.query(
          `SELECT id, topic FROM geo_opportunities
           WHERE brand_profile_id = $1
             AND status = 'ignored'
             AND (LOWER(topic) = LOWER($2)
                  OR LOWER(topic) LIKE '%' || LOWER($2) || '%'
                  OR LOWER($2) LIKE '%' || LOWER(topic) || '%'
                  OR similarity(LOWER(topic), LOWER($2)) >= 0.55)
           LIMIT 1`,
          [brandProfileId, opp.topic]
        );
        if (dupRes.rows.length > 0) {
          inheritedStatus = 'ignored';
          console.log(`[GEO] ignore-propagate: "${opp.topic}" inherits ignored from "${dupRes.rows[0].topic}"`);
        }
      } catch(e) {
        // pg_trgm extension may not be installed — fall back to substring-only check
        if (e.message && e.message.includes('similarity')) {
          try {
            const fbRes = await pool.query(
              `SELECT id, topic FROM geo_opportunities
               WHERE brand_profile_id = $1 AND status = 'ignored'
                 AND (LOWER(topic) = LOWER($2)
                      OR LOWER(topic) LIKE '%' || LOWER($2) || '%'
                      OR LOWER($2) LIKE '%' || LOWER(topic) || '%')
               LIMIT 1`,
              [brandProfileId, opp.topic]
            );
            if (fbRes.rows.length > 0) {
              inheritedStatus = 'ignored';
              console.log(`[GEO] ignore-propagate (fallback): "${opp.topic}" inherits ignored from "${fbRes.rows[0].topic}"`);
            }
          } catch(e2) { /* give up silently — default to 'discovered' */ }
        }
      }

      try {
        const insertRes = await pool.query(
          `INSERT INTO geo_opportunities (
            brand_profile_id, brain_version, topic, platform_scores, avg_score, quick_win,
            topical_authority_context, intent_signals, status, discovery_session_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, $9)
          RETURNING id`,
          [
            brandProfileId, profile.version || 1, opp.topic,
            JSON.stringify(platforms), avgScore.toFixed(2), !!opp.quickWin,
            authorityContext, JSON.stringify({ entities: entitySchema.filter(e => e.priority === 'high').slice(0, 5) }),
            discoverySessionId, inheritedStatus
          ]
        );
        persistedOpportunities.push({ ...opp, id: insertRes.rows[0].id, avgScore, status: inheritedStatus });
      } catch(e) {
        console.log('[GEO] opp persist warn:', e.message, '| topic:', topic);
      }
    }
    console.log(`[GEO] Persisted ${persistedOpportunities.length} opportunities in session ${discoverySessionId}`);

    // Build legacy brief shape for response compatibility — stub values, no real brief yet
    // The actual per-topic brief building happens in Stage 2.1 when user selects topics
    const briefData = {
      targetTopic: null,  // no auto-pick anymore
      executiveSummary: 'Topics surfaced. Select topics in the GEO Opportunities table to build briefs.',
      h1: null,
      h2s: [],
      entities: entitySchema.filter(e => e.priority === 'high').map(e => e.entity).slice(0, 10),
      faqStructure: [],
      geoAnchors: [],
      schemaRequirements: [],
      overallOpportunityScore: persistedOpportunities.length ? Math.round(Math.max(...persistedOpportunities.map(o => o.avgScore || 0))) : 0,
      targetPlatforms: [],
      contentCalendar: { month1: [], month2: [], month3: [] },
      quickWins: quickWins.map(q => ({ topic: q.topic, rationale: '', geoTarget: '' })),
      geoScorecard: {
        currentReadiness: persistedOpportunities.length ? Math.round(Math.max(...persistedOpportunities.map(o => o.avgScore || 0))) : 0,
        primaryGap: 'User selection pending',
        topOpportunity: quickWins[0]?.topic || persistedOpportunities[0]?.topic || ''
      },
      briefRationale: `${persistedOpportunities.length} opportunities discovered. Cherry-pick topics to build briefs.`,
      discoverySessionId,
      pendingUserSelection: true
    };

    // Legacy geo_briefs row kept as stub for backward-compat with older code paths
    // New architecture uses geo_opportunities + geo_topic_briefs instead.
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) as max_v FROM geo_briefs WHERE brand_profile_id = $1`, [brandProfileId]
    );
    const nextVersion = versionResult.rows[0].max_v + 1;
    const id = randomUUID();
    const { topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief } = normalizeGeoData(briefData, topicalMap, geoOpportunities, entitySchema, profile);
    const fullBriefData = { ...briefData, topicalMap, geoOpportunities, entitySchema, topicalAuthorityMap, geoOpportunitiesNorm, entitySchemaMap, geoBrief, citationProbe };
    const opportunityScore = briefData.overallOpportunityScore || 0;

    // Nuke stale GEO briefs — re-run means old data is superseded
    await pool.query('DELETE FROM geo_briefs WHERE brand_profile_id = $1', [brandProfileId]);

    await pool.query(
      `INSERT INTO geo_briefs (id, client_id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, brain_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, null, brandProfileId, profile.brand_url, profile.brand_name, nextVersion, opportunityScore, JSON.stringify(fullBriefData), profile.version || 1]
    );

    const latencyMs = Date.now() - startTime;
    console.log(`[GEO] Complete — Score: ${opportunityScore} | Latency: ${latencyMs}ms | QuickWins: ${quickWins.length}`);

    console.log('[GEO] FINAL topicalAuthorityMap[0]:', JSON.stringify(topicalAuthorityMap[0]));
    console.log('[GEO] FINAL geoOpportunities[0]:', JSON.stringify(geoOpportunitiesNorm[0]));
    console.log('[GEO] FINAL counts — topical:', topicalAuthorityMap.length, 'geo:', geoOpportunitiesNorm.length);
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage2_geo_strategist', brandProfileId, 'success', 0, latencyMs]).catch(e => console.error('[ACTIVITY LOG]', e.message));
            res.json({ success: true, cached: false, data: {
      id, brandProfileId, brandUrl: profile.brand_url, brandName: profile.brand_name,
      version: nextVersion, opportunityScore, latencyMs,
      brainVersion: profile.version || 1, currentBrainVersion: profile.version || 1,
      topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief
    }});

  } catch (err) {
    console.error('[GEO] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
