// Campaign Generator routes, extracted from server.js during the route-group
// phase. Mounted at /api/campaign with NO mount-level auth — MIXED group
// (GET /api/campaign/:id is public; the rest are requireAuth), so auth stays
// per-route. enrichAngleForCampaign (campaign-only) moved in; generateArticleImage
// is an inner closure in the generate handler. Pure move: bodies verbatim, only
// registration lines changed (app.METHOD('/api/campaign/x', …) -> router.METHOD('/x', …)).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';

// ESM has no __dirname; resolve the repo root (this file lives at src/server/routes/).
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
import { extractJSON, safeParseLLM } from '../llm-json.js';
import { requireAuth, verifyBrandAccess } from '../auth.js';
import { finalizeArticleForStorage } from '../text.js';
import { buildImagePrompt, generateHeroImage } from '../images.js';
import { ensureGeneratedContentTable } from '../content-table.js';

const router = express.Router();

router.post('/:id/archive', requireAuth, async (req, res) => {
  try {
    const campaignId = req.params.id;

    // Fetch campaign + its queue items
    const campRes = await pool.query('SELECT id, brand_profile_id, name, status FROM campaigns WHERE id = $1', [campaignId]);
    if (!campRes.rows.length) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const camp = campRes.rows[0];

    if (!(await verifyBrandAccess(camp.brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });

    const itemsRes = await pool.query(
      `SELECT id, status, publish_results FROM publishing_queue WHERE campaign_id = $1`,
      [campaignId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) return res.status(400).json({ success: false, error: 'Campaign has no queue items' });

    // "Published enough to archive" = has at least one non-meta key in publish_results.
    // The status field alone is unreliable: 'partial' means some channels failed but the
    // article still went out somewhere, and Brian wants those archive-able. Items already
    // 'archived' are skipped (they're effectively done from the campaign's perspective).
    const hasResults = (pr) => pr && typeof pr === 'object' &&
      Object.keys(pr).filter(k => !k.startsWith('__')).length > 0;
    const blockers = items.filter(i => i.status !== 'archived' && !hasResults(i.publish_results));
    if (blockers.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot archive: ${blockers.length} of ${items.length} articles have no publish results yet`,
        unpublishedCount: blockers.length,
        totalCount: items.length
      });
    }

    // All clear — archive non-archived items + mark campaign archived
    const updRes = await pool.query(
      `UPDATE publishing_queue SET status = 'archived', updated_at = NOW()
       WHERE campaign_id = $1 AND status != 'archived'
       RETURNING id`,
      [campaignId]
    );
    await pool.query(
      `UPDATE campaigns SET status = 'archived', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    res.json({ success: true, archivedCount: updRes.rowCount, campaignName: camp.name });
  } catch(e) {
    console.error('[CAMPAIGN-ARCHIVE]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const campaignId = req.params.id;

    const campRes = await pool.query('SELECT id, brand_profile_id, name FROM campaigns WHERE id = $1', [campaignId]);
    if (!campRes.rows.length) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const camp = campRes.rows[0];

    if (!(await verifyBrandAccess(camp.brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });

    const upd = await pool.query(
      `UPDATE publishing_queue SET status = 'published', updated_at = NOW()
       WHERE campaign_id = $1 AND status = 'archived'
       RETURNING id`,
      [campaignId]
    );
    await pool.query(
      `UPDATE campaigns SET status = 'complete', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    res.json({ success: true, restoredCount: upd.rowCount, campaignName: camp.name });
  } catch(e) {
    console.error('[CAMPAIGN-UNARCHIVE]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

async function enrichAngleForCampaign({ angle, profileData, factualGround, brainPatterns, brainMistakes, brandName }) {
  const fgBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
    ? `FACTUAL GROUND (verbatim, do not contradict):
${factualGround.whatWeDo ? `- What this company does: ${factualGround.whatWeDo}\n` : ''}${factualGround.whatWeDontDo ? `- What this company does NOT do: ${factualGround.whatWeDontDo}\n` : ''}${factualGround.companyFacts ? `- Company facts: ${factualGround.companyFacts}\n` : ''}${factualGround.foundingStory ? `- Founding: ${factualGround.foundingStory}\n` : ''}${factualGround.methodology ? `- Methodology: ${factualGround.methodology}\n` : ''}${(() => {
  const list = factualGround.authors || [];
  return list.length ? `- ${list.length > 1 ? 'Named authors/SMEs' : 'Assigned author'}: ${list.map(a => `${a.name} (${a.title || 'unspecified'})`).join('; ')}\n` : '';
})()}`
    : '';
  const patternsBlock = brainPatterns?.length
    ? `BRAIN PATTERNS (successful approaches — emulate these):\n${brainPatterns.slice(0,10).map(p => `- [${p.pattern_type}] ${p.description}`).join('\n')}`
    : '';
  const mistakesBlock = brainMistakes?.length
    ? `BRAIN MISTAKES (avoid these — hard constraints):\n${brainMistakes.slice(0,10).map(m => `- [${m.mistake_type}] ${m.description}`).join('\n')}`
    : '';
  const voiceBlock = profileData?.voiceProfile
    ? `VOICE PROFILE (tone + style anchors):\n${JSON.stringify(profileData.voiceProfile, null, 2).slice(0, 1500)}`
    : '';
  const personaName = angle.persona?.name || angle.persona || 'the target persona';

  const systemPrompt = `You are a content strategist producing a per-angle enriched brief for a long-form B2B article. Your output directs the article writer on exactly what to cover, what angle to take, what authority signals to inject, and what the brand's user-verified facts are. Every field must be specific to THIS angle and THIS brand — never generic.

Output STRICT JSON matching this schema (no markdown, no commentary):
{
  "enrichedTitle": "SEO-optimized meta title, 55-70 chars, format: 'Primary phrase | Brand' or 'Primary phrase — Brand'",
  "enrichedH1": "on-page headline, declarative, 7-14 words, more punchy than the meta title",
  "topic": "core topic of the article in 3-8 words",
  "enrichedSections": [
    { "heading": "H2 section heading", "body": "2-3 sentences summarizing what the writer should cover in this section — be SPECIFIC to this angle", "confidenceTier": "high|medium|low", "eeatInjections": ["Specific proof point, named source, data point, or expertise signal the writer should weave in"], "smeHooks": ["Quote-worthy position the SME can stand behind"] }
  ],
  "enrichedFAQ": [{ "q": "FAQ question this article should answer", "a": "Concise 1-2 sentence answer" }],
  "powerPhrases": ["Short, declarative phrases the writer should use verbatim — ~5 words each, specific to brand voice"],
  "contentHooks": ["Opening-paragraph hooks that would grab ${personaName}"],
  "authorSchema": { "name": "author name from factual ground authors, or null", "jobTitle": "author job title, or null" }
}

Requirements: 4-6 enrichedSections, 3-5 enrichedFAQ, 4-6 powerPhrases, 2-3 contentHooks.`;

  const userPrompt = `Produce the enriched brief for this specific campaign angle:

ANGLE:
${JSON.stringify(angle, null, 2)}

BRAND: ${brandName}

${voiceBlock}

${fgBlock}

${patternsBlock}

${mistakesBlock}

Return ONLY the JSON object.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const raw = message.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = safeParseLLM(match ? match[0] : raw, 'object', 'campaign-angle-enrichment');

  // Attach a safe narrativeIdentity fallback when the LLM didn't emit one.
  if (!parsed.narrativeIdentity) {
    const assigned = parsed.authorSchema && parsed.authorSchema.name ? parsed.authorSchema : null;
    if (assigned) {
      parsed.narrativeIdentity = {
        subjectType: 'company',
        speakerType: 'person',
        grammaticalPerson: 'first_singular',
        speakerName: parsed.authorSchema.name || null,
        bylineAuthorId: factualGround?.authors?.length ? (factualGround.authors[0].id || null) : null,
        allowedSelfReferences: ['I', 'my', 'me'],
        personalExperienceAllowed: true,
        notes: 'Author-attributed piece: prefer first-person for personal experience; company-level claims use we/our.'
      };
    } else {
      parsed.narrativeIdentity = {
        subjectType: 'company',
        speakerType: 'company',
        grammaticalPerson: 'third_plural',
        speakerName: brandName || null,
        bylineAuthorId: null,
        allowedSelfReferences: ['we', 'our', 'us'],
        personalExperienceAllowed: false,
        notes: 'Default company voice: use third-person references to the company or first-person plural for company actions.'
      };
    }
  }

  // Attach author schema from factualGround if the LLM didn't emit one
  if ((!parsed.authorSchema || !parsed.authorSchema.name) && factualGround?.authors?.length) {
    const fallbackAuthor = factualGround.authors[0];
    parsed.authorSchema = {
      name: fallbackAuthor.name || null,
      jobTitle: fallbackAuthor.title || null
    };
  }

  // Sanitize eeatInjections + smeHooks: unwrap any stringified JSON back to its suggestedContent prose.
  const unwrapLeakedJSON = (item) => {
    if (typeof item !== 'string') {
      if (item && typeof item === 'object' && typeof item.suggestedContent === 'string') return item.suggestedContent;
      return typeof item === 'string' ? item : String(item);
    }
    const trimmed = item.trim();
    if (trimmed.startsWith('{') && /"suggestedContent"\s*:/.test(trimmed)) {
      try {
        const p = JSON.parse(trimmed);
        if (p && typeof p.suggestedContent === 'string') return p.suggestedContent;
      } catch { /* pass */ }
    }
    return item;
  };
  if (Array.isArray(parsed.enrichedSections)) {
    parsed.enrichedSections = parsed.enrichedSections.map(s => ({
      ...s,
      eeatInjections: Array.isArray(s?.eeatInjections) ? s.eeatInjections.map(unwrapLeakedJSON) : [],
      smeHooks: Array.isArray(s?.smeHooks) ? s.smeHooks.map(unwrapLeakedJSON) : []
    }));
  }
  return parsed;
}

// GET /api/campaign/arcs/:brandProfileId — list Context Hub-generated campaign arcs
// Returns the campaignArcs array from Context Hub's output. If none exist (brand scanned before
// campaignArcs were added to the schema), returns []. UI will prompt user to re-scan Context Hub
// or fall back to the custom-prompt flow.

router.get('/arcs/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT profile_data->'campaignArcs' as arcs, brand_name FROM brand_profiles WHERE id = $1`,
      [req.params.brandProfileId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Brand profile not found' });
    const arcs = Array.isArray(r.rows[0].arcs) ? r.rows[0].arcs : [];
    res.json({ success: true, arcs, brandName: r.rows[0].brand_name });
  } catch (err) {
    console.error('[CAMPAIGN-ARCS]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/plan', requireAuth, async (req, res) => {
  const { brandProfileId, topicPrompt, campaignArcId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

  try {
    const profileResult = await pool.query(
      `SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]
    );
    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Brand profile not found. Run Stage 1 first.' });
    }
    const profileData = profileResult.rows[0].profile_data || {};

    // Resolve the campaign arc if an id was provided
    let selectedArc = null;
    if (campaignArcId) {
      const arcs = Array.isArray(profileData.campaignArcs) ? profileData.campaignArcs : [];
      selectedArc = arcs.find(a => a.id === campaignArcId) || null;
      if (!selectedArc) {
        return res.status(404).json({ error: 'Campaign arc not found. It may have been deleted or the brand was rescanned. Pick a different arc or use a custom topic prompt.' });
      }
    }

    const geoRes = await pool.query(
      `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [brandProfileId]
    );
    const enrichedRes = await pool.query(
      `SELECT enriched_data FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [brandProfileId]
    );
    const geoBrief = geoRes.rows[0]?.brief_data || null;
    const enrichedBrief = enrichedRes.rows[0]?.enriched_data || null;

    // Brain + measured context for the planner. The planner previously saw
    // neither: brain tables weren't loaded at all, and citationProbe sat inside
    // the 4000-char geoBrief trimTo where truncation usually ate it. The 8
    // angles should target measured whitespace and reuse proven patterns.
    let planBrainBlock = '';
    try {
      const [pRes, mRes] = await Promise.all([
        pool.query(`SELECT pattern_type, description, success_rate FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY success_rate DESC LIMIT 10`, [brandProfileId]),
        pool.query(`SELECT mistake_type, description FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 10`, [brandProfileId]),
      ]);
      if (pRes.rows.length || mRes.rows.length) {
        planBrainBlock = `\nBRAIN PATTERNS (proven for this brand — angle toward these): ${JSON.stringify(pRes.rows).slice(0, 1500)}\nBRAIN MISTAKES (do NOT repeat): ${JSON.stringify(mRes.rows).slice(0, 1000)}\n`;
      }
    } catch(e) { /* best-effort */ }
    const planProbe = geoBrief?.citationProbe || null;
    const planProbeBlock = planProbe
      ? `\nMEASURED AI VISIBILITY (live engine probe — ground truth): the brand appeared in ${planProbe.visibility}% of ${planProbe.totalChecks} AI answers. WHO AI CITES INSTEAD: ${(planProbe.sources || []).slice(0, 8).map(s => s.domain).join(', ') || 'none captured'}. The strongest campaign angles attack the questions and territories where the brand is measurably invisible.\n`
      : '';

    const trimTo = (obj, maxChars = 6000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
    };

    const systemPrompt = fs.readFileSync(
      path.join(REPO_ROOT, 'src/agents/stage4_campaign_planner/system_prompt.md'), 'utf8'
    );

    // Build the direction block — arc expansion is the strongest signal, custom prompt is medium, nothing is fallback.
    let directionBlock = '';
    if (selectedArc) {
      directionBlock = `\nCAMPAIGN ARC — EXPAND THIS INTO 8 ARTICLES:
The user has selected a Context Hub-generated narrative arc for this campaign. You MUST expand this arc's thesis and acts into exactly 8 distinct but narratively-connected articles, scheduled 2/week across 4 weeks. Think of it as a season of television: the same thesis told across 8 episodes, each building on the last.

ARC TITLE: ${selectedArc.title}
ARC THESIS: ${selectedArc.thesis}
TARGET PERSONA: ${selectedArc.targetPersona || 'infer from brand'}
NATURAL ACT STRUCTURE (${selectedArc.recommendedLength || selectedArc.acts?.length || 3} acts):
${(selectedArc.acts || []).map(a => `  Act ${a.actNumber} — ${a.actTitle}: ${a.actPremise}`).join('\n')}

EXPANSION GUIDANCE:
- If the arc has 3 acts: expand to roughly 3+3+2 or 2+3+3 articles per act, so each act gets multi-article development.
- If 4-5 acts: each act gets ~2 articles, with the opening and closing acts possibly getting 1 or 3 depending on narrative weight.
- If 6-8 acts: roughly 1 article per act, with the 1-2 strongest acts getting a supporting companion piece.
- Each article must be a distinct angle/persona-funnel combination BUT must build on the arc's thesis and the act it sits within.
- Article 1 = opening salvo establishing the problem. Articles 7-8 = payoff/resolution. Middle = progressive proof, case studies, contrarian takes, depth dives.
- Reference which act each article belongs to in its description so the campaign scheduler can maintain narrative coherence.
`;
    } else if (topicPrompt) {
      directionBlock = `\nUSER TOPIC DIRECTION: The user wants this campaign focused on: "${topicPrompt}". Build all 8 article angles around this theme. The brain patterns below should inform HOW you approach this topic, not WHETHER you cover it.\n`;
    }

    const userPrompt = `Generate 8 campaign angle profiles for the following brand brain.
${directionBlock}${planProbeBlock}${planBrainBlock}
BRAND PROFILE:
${trimTo(profileData, 4000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 4000) : 'Not available — infer from brand profile.'}

ENRICHED BRIEF:
${enrichedBrief ? trimTo(enrichedBrief, 4000) : 'Not available — infer from brand profile.'}

Return ONLY valid JSON matching the output format. No markdown, no commentary.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const plan = safeParseLLM(jsonMatch ? jsonMatch[0] : raw, 'object', 'campaign-plan');

    // Annotate the plan with the arc context so the UI can show which arc drove this campaign
    if (selectedArc) plan.sourceArc = { id: selectedArc.id, title: selectedArc.title, thesis: selectedArc.thesis };

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Campaign plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE campaigns SET status = 'pending', updated_at = NOW()
       WHERE id = $1 AND status IN ('generating', 'error')
       RETURNING id, status`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Campaign not found or not in a resettable state' });
    }
    // Also reset any stuck article statuses
    await pool.query(
      `UPDATE campaign_articles SET status = 'pending', updated_at = NOW()
       WHERE campaign_id = $1 AND status = 'generating'`,
      [req.params.id]
    ).catch(() => {});
    res.json({ success: true, campaignId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create', requireAuth, async (req, res) => {
  const { brandProfileId, plan } = req.body;
  if (!brandProfileId || !plan) return res.status(400).json({ error: 'brandProfileId and plan required' });

  try {
    // Ensure tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand_profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        topic_cluster TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        plan JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_articles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        brand_profile_id TEXT NOT NULL,
        article_index INTEGER NOT NULL,
        angle_profile JSONB NOT NULL,
        week_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        generated_content JSONB,
        image_url TEXT,
        image_prompt TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const campRes = await pool.query(
      `INSERT INTO campaigns (brand_profile_id, name, topic_cluster, plan)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [brandProfileId, plan.campaign_name, plan.topic_cluster, JSON.stringify(plan)]
    );
    const campaignId = campRes.rows[0].id;

    for (const article of plan.articles) {
      await pool.query(
        `INSERT INTO campaign_articles (campaign_id, brand_profile_id, article_index, angle_profile, week_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [campaignId, brandProfileId, article.index, JSON.stringify(article), article.week]
      );
    }

    // Migration safety: add image columns if they don't exist yet
    await pool.query(`ALTER TABLE campaign_articles ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await pool.query(`ALTER TABLE campaign_articles ADD COLUMN IF NOT EXISTS image_prompt TEXT`);

    res.json({ success: true, campaignId });
  } catch (err) {
    console.error('Campaign create error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/list/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, topic_cluster, status, created_at,
       (SELECT COUNT(*) FROM campaign_articles WHERE campaign_id = campaigns.id AND status = 'complete') as completed_count
       FROM campaigns WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [req.params.brandProfileId]
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const camp = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    const articles = await pool.query(
      `SELECT * FROM campaign_articles WHERE campaign_id = $1 ORDER BY article_index`,
      [req.params.id]
    );
    res.json({ campaign: camp.rows[0], articles: articles.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/generate/:id', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Keepalive ping every 30s so Render/proxies don't drop the SSE connection
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepalive));

  try {
    const campRes = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    const campaign = campRes.rows[0];
    if (!campaign) { send('error', { message: 'Campaign not found' }); return res.end(); }

    const articlesRes = await pool.query(
      `SELECT * FROM campaign_articles WHERE campaign_id = $1 AND status = 'pending' ORDER BY article_index`,
      [req.params.id]
    );
    const articles = articlesRes.rows;

    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [campaign.brand_profile_id]);
    if (!profileResult.rows.length) { send('error', { message: 'Brand profile not found' }); return res.end(); }
    const profileData = profileResult.rows[0].profile_data || profileResult.rows[0];

    const geoRes = await pool.query(
      `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [campaign.brand_profile_id]
    );
    const patternsRes = await pool.query(
      `SELECT pattern_type, description, success_rate, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY COALESCE(success_rate, confidence_score) DESC LIMIT 10`,
      [campaign.brand_profile_id]
    );
    const mistakesRes = await pool.query(
      `SELECT mistake_type, description FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [campaign.brand_profile_id]
    );

    const geoBrief = geoRes.rows[0]?.brief_data || null;
    // NOTE: we deliberately do NOT load a single "latest enriched brief" here anymore —
    // each of the 8 articles gets its OWN per-angle enriched brief synthesized from the
    // angle profile + factual ground + brain patterns. See enrichAngleForCampaign below.
    // Prior behavior: 7-of-8 articles received a brief that didn't match their angle,
    // which defeated the whole point of the brain injection layer.

    // Load Factual Ground once — it's brand-level, identical for all 8 articles.
    let campaignFactualGround = null;
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [campaign.brand_profile_id]
      );
      if (fgRes.rows[0]?.fg) campaignFactualGround = fgRes.rows[0].fg;
    } catch(e) { /* non-fatal */ }

    const trimTo = (obj, maxChars = 6000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
    };

    const cgSystemPrompt = fs.readFileSync(
      path.join(REPO_ROOT, 'src/agents/stage4_content_generator/system_prompt.md'), 'utf8'
    );

    await pool.query(`UPDATE campaigns SET status = 'generating', updated_at = NOW() WHERE id = $1`, [req.params.id]);

    // ── Flux image generation helper ────────────────────────────────────────────
    const generateArticleImage = async (articleRow, angle, parsed) => {
      try {
        const batchBody = (parsed.sections?.[0]?.body || parsed.sections?.[0]?.content || angle.description || '').slice(0, 250);
        const fluxPrompt = await buildImagePrompt(parsed.title || angle.title, profileData?.voice_profile || {}, batchBody);

        const imageUrl = await generateHeroImage(fluxPrompt);

        const safeId2 = articleRow.brand_profile_id?.replace(/-/g, '_');
        await pool.query(
          `UPDATE generated_content_${safeId2} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
          [imageUrl, fluxPrompt, articleRow.id]
        );
        return imageUrl;
      } catch(e) {
        console.error('[IMG-GEN]', e.message);
        return null;
      }
    };;

    for (const articleRow of articles) {
      const angle = articleRow.angle_profile;
      send('article_start', { index: angle.index, title: angle.title, week: angle.week });

      await pool.query(
        `UPDATE campaign_articles SET status = 'generating', updated_at = NOW() WHERE id = $1`,
        [articleRow.id]
      );

      // ── Per-angle enrichment ────────────────────────────────────────────────
      // Synthesize an enriched brief specific to THIS angle so the writer has proper
      // brain-directing structure (sections, FAQ, power phrases, hooks) rather than
      // inheriting a stale brief from a prior topic.
      send('article_progress', { index: angle.index, stage: 'enriching', label: 'Building per-angle intelligence brief' });
      let enrichedBrief = null;
      try {
        enrichedBrief = await enrichAngleForCampaign({
          angle,
          profileData,
          factualGround: campaignFactualGround,
          brainPatterns: patternsRes.rows,
          brainMistakes: mistakesRes.rows,
          brandName: profileData?.brandName || profileResult.rows[0].brand_name || ''
        });
        console.log(`[CAMPAIGN] Angle ${angle.index} enriched: "${enrichedBrief?.enrichedH1 || enrichedBrief?.enrichedTitle || '(untitled)'}"`);
      } catch(enrichErr) {
        console.error(`[CAMPAIGN] Per-angle enrichment failed for angle ${angle.index}: ${enrichErr.message} — falling back to angle-only generation`);
        enrichedBrief = null;
      }

      // Load Topical Authority Map — strategic context for where this content lives
    let topicalTerritories = [];
    let cpCitationProbe = null;
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [campaign.brand_profile_id]
      );
      cpCitationProbe = gbRes.rows[0]?.brief_data?.citationProbe || null;
      // Prefer the RAW gaps (they carry cluster + informationGainAngle); the
      // normalized topicalAuthorityMap drops both. Mirrors server.js generate.
      const topicalMapRaw = gbRes.rows[0]?.brief_data?.topicalMap?.gapsByCluster || gbRes.rows[0]?.brief_data?.topicalAuthorityMap || [];
      topicalTerritories = topicalMapRaw
        .map(t => ({
          topic: t.topic || t.cluster || t.name,
          coverage: (t.coverage || t.rationale || t.description || '').slice(0, 140),
          cluster: t.cluster || null,
          angle: (t.informationGainAngle || '').slice(0, 160),
          priority: t.priority || (t.geoCitationScore >= 70 || t.citationProbability >= 70 ? 'high' : t.geoCitationScore >= 40 || t.citationProbability >= 40 ? 'medium' : 'low')
        }))
        .filter(t => t.topic)
        .sort((a, b) => (a.priority === 'high' ? -1 : b.priority === 'high' ? 1 : 0))
        .slice(0, 8);
    } catch(e) { /* silent — non-fatal */ }

    const territoriesBlock = topicalTerritories.length
      ? `\nSTRATEGIC TERRITORIES THIS BRAND OPERATES IN (write as an authority in these territories — never drift outside them):\n${topicalTerritories.map(t => `  • [${t.priority}]${t.cluster ? ` (${t.cluster})` : ''} ${t.topic}${t.coverage ? ' — ' + t.coverage : ''}${t.angle ? `\n    Information-gain angle (the unique claim THIS brand makes here — the article must deliver it): ${t.angle}` : ''}`).join('\n')}\n`
      : '';

    const cpMeasuredBlock = cpCitationProbe
      ? `\nMEASURED AI VISIBILITY (live engine probe — this is the gap the campaign exists to close): the brand appeared in ${cpCitationProbe.visibility}% of ${cpCitationProbe.totalChecks} AI answers (${Object.entries(cpCitationProbe.byEngine || {}).map(([id, v]) => `${id} ${v.available ? v.pct + '%' : 'n/a'}`).join(' · ')}). WHO AI CITES INSTEAD: ${(cpCitationProbe.sources || []).slice(0, 8).map(s => s.domain).join(', ') || 'none captured'}. Write the piece those incumbent sources would have to cite — more specific, better evidenced, more extractable than what they publish.\n`
      : '';
    const cpCompetitors = Array.isArray(profileData?.competitorAnalysis) ? profileData.competitorAnalysis : [];
    const cpCompetitorBlock = cpCompetitors.length
      ? `\nCOMPETITOR SITE COVERAGE (measured — crawled from their actual websites): ${cpCompetitors.map(c => `${c.url}: ${c.positioning || ''}${(c.signatureClaims || []).length ? ` — claims: ${c.signatureClaims.join(' | ')}` : ''}`).join('\n')}\nDo not echo their claims; write what they demonstrably cannot say.\n`
      : '';
    const cpMoats = Array.isArray(profileData?.strategicMoats) ? profileData.strategicMoats : [];
    const cpMoatsBlock = cpMoats.length
      ? `\nSTRATEGIC MOATS (deliberate non-actions — reference as trust signals where natural, never as weaknesses): ${cpMoats.map(m => m.capability).join('; ')}\n`
      : '';

    // Load Factual Ground — user-verified facts the writer MUST use verbatim
    let factualGround = null;
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [campaign.brand_profile_id]
      );
      if (fgRes.rows[0]?.fg) factualGround = fgRes.rows[0].fg;
    } catch(e) { console.log('[CONTENT-GEN] No factual ground:', e.message); }

    const factualGroundBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\n═══════════════════════════════════════════════════════════════════════════
FACTUAL GROUND — USER-VERIFIED FACTS YOU MUST USE VERBATIM
═══════════════════════════════════════════════════════════════════════════

These are NOT scraped from the website. These are direct statements from the brand owner.
They OVERRIDE anything else you know or infer about this company.
When referencing company facts, credentials, or methodology — use these exact phrasings.
NEVER invent credentials, titles, dates, methodology steps, or quotes that contradict this section.
NEVER hedge on what is stated here — these are facts, not suggestions.

${factualGround.whatWeDo ? `WHAT THIS COMPANY DOES (use this language):\n${factualGround.whatWeDo}\n` : ''}
${factualGround.whatWeDontDo ? `WHAT THIS COMPANY DOES NOT DO (never claim otherwise):\n${factualGround.whatWeDontDo}\n` : ''}
${factualGround.companyFacts ? `COMPANY FACTS (only reference these):\n${factualGround.companyFacts}\n` : ''}
${factualGround.methodology ? `METHODOLOGY / APPROACH (describe in these terms):\n${factualGround.methodology}\n` : ''}
${factualGround.foundingStory ? `FOUNDING STORY (reference only these details):\n${factualGround.foundingStory}\n` : ''}
${factualGround.teamComposition ? `TEAM (only reference these people/roles):\n${factualGround.teamComposition}\n` : ''}
${factualGround.quotablePositions ? `QUOTABLE POSITIONS (use these phrases verbatim when making bold claims):\n${factualGround.quotablePositions}\n` : ''}
${(() => {
  const assigned = enrichedBrief?.assignedAuthor;
  const authorsToUse = (assigned && assigned.name) ? [assigned] : (factualGround.authors || []);
  return authorsToUse.length ? `NAMED AUTHOR${authorsToUse.length > 1 ? 'S' : ''} (use ${authorsToUse.length > 1 ? 'ONLY these people' : 'this person'} for author attribution, credentials, and bylines):\n${authorsToUse.map(a => `  • ${a.name || '[unnamed]'} — ${a.title || ''}\n    LinkedIn: ${a.linkedinUrl || 'N/A'}\n    Bio: ${a.bio || 'N/A'}\n    Credentials: ${a.credentials || 'N/A'}\n    Expertise: ${a.expertise || 'N/A'}`).join('\n\n')}\n` : '';
})()}
═══════════════════════════════════════════════════════════════════════════
`
      : '';

        const userPrompt = `Generate a long-form article using the following Brand Intelligence context.

CAMPAIGN ANGLE (follow this precisely):
${JSON.stringify(angle, null, 2)}
${factualGroundBlock}${territoriesBlock}${cpMeasuredBlock}${cpCompetitorBlock}${cpMoatsBlock}
BRAND PROFILE:
${trimTo(profileData, 5000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 4000) : 'Not available.'}

ENRICHED BRIEF:
${enrichedBrief ? trimTo(enrichedBrief, 5000) : 'Not available.'}

BRAIN PATTERNS:
${trimTo(patternsRes.rows, 1500)}

BRAIN MISTAKES:
${trimTo(mistakesRes.rows, 1500)}

IMPORTANT: Use the angle profile above to lock the persona, funnel position, content type, and E-E-A-T focus.

GROUNDING (closed-world — applies even if Factual Ground is empty): ground every concrete claim about this company in the Brand Profile, Factual Ground, and briefs above. Do NOT introduce specifics that do not appear there — this includes prices or fees, named competitor products, named methodologies/models/frameworks, statistics or percentages, customer names, case studies, dates, credentials, or product/feature names. If a specific is not provided in the context above, omit it or speak generally — never invent one to sound authoritative. Never state a price as a bare number: always include its terms (what it covers and its conditions). Do not name, rank, compare against, or disparage specific competitor products — and never frame a CRM or martech platform (HubSpot, Salesforce, Marketo, etc.) as passive storage, a "system of record," or a dumb layer; these are sophisticated tools whose output is only as good as the data they receive, so locate any gap upstream at the integration/data-quality layer ("the signal never reaches the CRM"), never in the platform's own capabilities.
Return ONLY valid JSON matching the content generator output format.`;

      let fullText = '';
      const stream = await anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: cgSystemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          fullText += chunk.delta.text;
          send('chunk', chunk.delta.text);
        }
      }

      let parsed;
      try {
        // Use extractJSON which handles token-truncated responses by closing open structures
        const recovered = extractJSON(fullText, 'object');
        if (!recovered) throw new Error('No valid JSON found in response');
        parsed = JSON.parse(recovered);
      } catch (e) {
        await pool.query(
          `UPDATE campaign_articles SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [articleRow.id]
        );
        send('article_error', { index: angle.index, error: e.message });
        continue;
      }

      // Save article + kick off Flux in parallel — don't await Flux here
      await pool.query(
        `UPDATE campaign_articles SET status = 'complete', generated_content = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(parsed), articleRow.id]
      );

      // ── Mirror into generated_content_{uuid} so article flows through publishing pipeline ──
      // This is what connects campaign articles to publishing_queue, UTM tracking, and analytics.
      try {
        const contentTableName = await ensureGeneratedContentTable(campaign.brand_profile_id);
        parsed = finalizeArticleForStorage(parsed);
        const insertedContent = await pool.query(
          `INSERT INTO ${contentTableName}
            (brand_profile_id, title, article_json, overall_confidence, status, campaign_id, campaign_article_index, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6, NOW(), NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            campaign.brand_profile_id,
            parsed.title || angle.title,
            JSON.stringify(parsed),
            parsed.overallConfidence || angle.estimated_confidence || 75,
            campaign.id,
            angle.index
          ]
        );
        const contentId = insertedContent.rows[0]?.id;

        // Stage into publishing_queue with campaign_id so UTM builder can read it
        if (contentId) {
          await pool.query(
            `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, campaign_id, created_at, updated_at)
             VALUES ($1, $2, $3, 'staged', $4, NOW(), NOW())
             ON CONFLICT (content_id) DO NOTHING`,
            [campaign.brand_profile_id, contentId, parsed.title || angle.title, campaign.id]
          );
        }
      } catch (mirrorErr) {
        console.warn('[CAMPAIGN] Mirror to generated_content failed (non-fatal):', mirrorErr.message);
      }

      send('article_done', { index: angle.index, article: parsed });

      // Fire image generation async — emits image_done when ready, never blocks article loop
      generateArticleImage(articleRow, angle, parsed).then(({ imageUrl, fluxPrompt, error }) => {
        if (imageUrl) {
          send('image_done', { index: angle.index, image_url: imageUrl, prompt: fluxPrompt });
        } else {
          send('image_error', { index: angle.index, error: error || 'Image generation failed' });
        }
      });
    }

    await pool.query(`UPDATE campaigns SET status = 'complete', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    send('campaign_done', { campaignId: req.params.id });
    // Stay open 90s for async image_done events, then close gracefully
    setTimeout(() => { clearInterval(keepalive); res.end(); }, 90000);
  } catch (err) {
    console.error('Campaign generate error:', err);
    clearInterval(keepalive);
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
  }
});

export default router;
