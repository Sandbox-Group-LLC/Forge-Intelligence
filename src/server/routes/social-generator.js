// Social Generator routes, extracted from server.js during the route-group
// phase. Mounted at /api/social-generator with requireAuth at the mount in
// server.js (every route here is authed). The generated_social_posts table
// init (ensureSocialPostsTable) + its boot-time call moved here too — it fires
// when server.js imports this router. Pure move: handler bodies verbatim, only
// registration lines changed (app.METHOD('/api/social-generator/x', requireAuth,
// …) -> router.METHOD('/x', …)).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { anthropic, dateContext } from '../llm.js';

// ESM has no __dirname; resolve the repo root (this file lives at src/server/routes/).
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
import { safeParseLLM } from '../llm-json.js';
import { verifyBrandAccess } from '../auth.js';
import { activeStreams } from '../streams.js';
import { buildSocialImagePrompt, generateSocialImage } from '../images.js';
import { buildXOAuthHeader, uploadXMedia, refreshXOAuth2Token } from '../x.js';

async function ensureSocialPostsTable() {
  // Idempotent — schema also defined in init-schema.sql but this guarantees the table
  // exists on dev branches that haven't run init-schema.sql since shipping social gen.
  await pool.query(`CREATE TABLE IF NOT EXISTS generated_social_posts (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    brand_profile_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    angle TEXT,
    hook TEXT,
    body TEXT NOT NULL,
    hashtags JSONB DEFAULT '[]'::jsonb,
    cta TEXT,
    char_count INTEGER,
    confidence INTEGER,
    confidence_tier TEXT,
    confidence_reason TEXT,
    brain_match_score INTEGER,
    image_url TEXT,
    image_prompt TEXT,
    status TEXT DEFAULT 'draft',
    user_edited_body TEXT,
    source_brief_id TEXT,
    source_topic TEXT,
    brain_version INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gsp_brand_created ON generated_social_posts(brand_profile_id, created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gsp_batch ON generated_social_posts(batch_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gsp_platform ON generated_social_posts(brand_profile_id, platform)`).catch(() => {});
  // Capture which campaignArc was used for the batch so the Recent Batches drawer
  // can show it. Idempotent ALTERs — safe on existing tables.
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS arc_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS arc_title TEXT`).catch(() => {});
  // Direct-publish (May 5, 2026) — X first, IG to follow with its own flow.
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS published_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
}
ensureSocialPostsTable().catch(e => console.error('[SOCIAL-GEN] Table init error:', e.message));

const router = express.Router();

router.get('/generate', async (req, res) => {
  const { brandProfileId, platform, topicPrompt, briefId, mandatories, constraints, audience, ctaTarget, desiredAction, arcId } = req.query;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!platform || (platform !== 'x' && platform !== 'instagram')) {
    return res.status(400).json({ success: false, error: 'platform must be x or instagram' });
  }
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  // Duplicate stream guard — keyed by brand+platform so user can run X and IG concurrently
  const streamKey = `${brandProfileId}:social-${platform}`;
  if (activeStreams.has(streamKey)) {
    const existing = activeStreams.get(streamKey);
    const elapsed = Math.floor((Date.now() - existing.startedAt) / 1000);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: busy\ndata: ${JSON.stringify({ message: `Social generation already running for ${platform}`, elapsed })}\n\n`);
    return res.end();
  }
  activeStreams.set(streamKey, { startedAt: Date.now(), userId: req.userId });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(keepalive); activeStreams.delete(streamKey); });

  try {
    await ensureSocialPostsTable();

    // ── Brain-First: load all context (mirrors content-generator) ──
    const [profileRes, patternsRes, mistakesRes] = await Promise.all([
      pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]),
      pool.query('SELECT pattern_type, description, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8', [brandProfileId]).catch(() => ({ rows: [] })),
      pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC LIMIT 8', [brandProfileId]).catch(() => ({ rows: [] }))
    ]);

    if (!profileRes.rows.length) {
      send('error', 'Brand profile not found.');
      clearInterval(keepalive); activeStreams.delete(streamKey);
      return res.end();
    }
    const profile = profileRes.rows[0];
    const profileData = profile.profile_data || {};
    const voiceProfile = profileData.voiceProfile || profileData.voice_profile || {};
    const personas = profileData.personas || [];
    const brandName = profile.brand_name || '';

    // Optional enriched brief (secondary path — most social posts come from typed angle)
    let enrichedBrief = null;
    if (briefId) {
      try {
        const ebRes = await pool.query('SELECT enriched_data, brand_name FROM enriched_briefs WHERE id = $1 AND brand_profile_id = $2', [briefId, brandProfileId]);
        if (ebRes.rows.length) enrichedBrief = ebRes.rows[0].enriched_data;
      } catch(e) { console.log('[SOCIAL-GEN] brief load skipped:', e.message); }
    }

    // Strategic territories — same source as content generator. Prefer the RAW
    // gaps (they carry cluster + informationGainAngle; the normalized map drops
    // both), and pull the measured layer off the same row: citationProbe is the
    // live-engine ground truth and competitorAnalysis the crawled coverage —
    // short-form posts are exactly where "attack the question the brand is
    // invisible on" and "say what competitors can't" earn their keep.
    let topicalTerritories = [];
    let sgCitationProbe = null;
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [brandProfileId]
      );
      sgCitationProbe = gbRes.rows[0]?.brief_data?.citationProbe || null;
      const topicalMapRaw = gbRes.rows[0]?.brief_data?.topicalMap?.gapsByCluster || gbRes.rows[0]?.brief_data?.topicalAuthorityMap || [];
      topicalTerritories = topicalMapRaw
        .map(t => ({
          topic: t.topic || t.cluster || t.name,
          cluster: t.cluster || null,
          angle: (t.informationGainAngle || '').slice(0, 120),
          priority: t.priority || (t.geoCitationScore >= 70 || t.citationProbability >= 70 ? 'high' : 'medium')
        }))
        .filter(t => t.topic).slice(0, 6);
    } catch(e) { /* silent */ }

    const sgMeasuredBlock = sgCitationProbe
      ? `\nMEASURED AI VISIBILITY (live engine probe): the brand appears in ${sgCitationProbe.visibility}% of AI answers today. WHO AI CITES INSTEAD: ${(sgCitationProbe.sources || []).slice(0, 6).map(s => s.domain).join(', ') || 'none captured'}. The sharpest posts stake claims on the questions and territories where the brand is measurably invisible.\n`
      : '';
    const sgCompetitors = Array.isArray(profileData.competitorAnalysis) ? profileData.competitorAnalysis : [];
    const sgCompetitorBlock = sgCompetitors.length
      ? `\nCOMPETITOR SITE COVERAGE (measured — crawled from their actual websites): ${sgCompetitors.map(c => `${c.url}: ${c.positioning || ''}${(c.signatureClaims || []).length ? ` — claims: ${c.signatureClaims.slice(0, 2).join(' | ')}` : ''}`).join('\n')}\nDo not echo their claims; post what they demonstrably cannot say.\n`
      : '';

    // Factual ground — same source as content generator
    const factualGround = profile.settings?.factualGround || null;
    const fgBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\nFACTUAL GROUND (use verbatim, never contradict):\n${factualGround.whatWeDo ? `- What we do: ${factualGround.whatWeDo}\n` : ''}${factualGround.whatWeDontDo ? `- What we DON'T do: ${factualGround.whatWeDontDo}\n` : ''}${factualGround.quotablePositions ? `- Quotable positions: ${factualGround.quotablePositions}\n` : ''}${factualGround.companyFacts ? `- Company facts: ${String(factualGround.companyFacts).slice(0, 400)}\n` : ''}`
      : '';

    // Load system prompt
    const systemPromptPath = path.join(REPO_ROOT, 'src/agents/stage4_social_generator/system_prompt.md');
    const systemPrompt = fs.existsSync(systemPromptPath)
      ? fs.readFileSync(systemPromptPath, 'utf8')
      : 'You are a short-form social writer. Produce 4 platform-native posts.';

    const trimTo = (obj, maxChars = 2000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
    };

    // Optional arc context — inject thesis + acts if user selected an arc.
    // Also captures arc title so it can be persisted on each post for the Recent Batches drawer.
    let arcBlock = '';
    let selectedArcTitle = null;
    if (arcId) {
      try {
        const allArcs = (profileData.campaignArcs || []);
        const arc = allArcs.find(a => a.id === arcId);
        if (arc) {
          selectedArcTitle = arc.title || null;
          const actsText = Array.isArray(arc.acts)
            ? arc.acts.map(a => `  Act ${a.actNumber}: ${a.actTitle} — ${a.actPremise}`).join('\n')
            : '';
          arcBlock = `\nBRAND NARRATIVE ARC (the brand arc this post series should advance):\nArc: "${arc.title}"\nThesis: ${arc.thesis}${actsText ? `\nActs:\n${actsText}` : ''}\nTarget persona: ${arc.targetPersona || 'primary'}\nThe posts must feel like they belong inside this arc — advancing the thesis, not contradicting it.\n`;
        }
      } catch(e) { console.log('[SOCIAL-GEN] arc inject skipped:', e.message); }
    }

    const userPrompt = `${dateContext()}\n\nGenerate exactly 4 ${platform.toUpperCase()} posts using the following brand intelligence.\n\nPLATFORM: ${platform}\n${platform === 'x' ? 'HARD CONSTRAINT: every X post body must be at or below 280 characters INCLUDING any inline characters. Count before you emit. If you find yourself at 270+ chars, cut it down. The X API rejects over-limit posts outright.\n' : 'HARD CONSTRAINT: every Instagram caption must be at or below 300 characters total. Stay below 150 when possible — audience disengages past that.\n'}BRAND: ${brandName}\n${topicPrompt ? `\nTOPIC / ANGLE THE USER WANTS COVERED:\n"${topicPrompt}"\n` : ''}${arcBlock}${(mandatories || constraints || audience || ctaTarget || desiredAction) ? `\nUSER MANDATORIES & CONSTRAINTS:\n${mandatories ? `- MUST INCLUDE: ${mandatories}\n` : ''}${constraints ? `- MUST NOT: ${constraints}\n` : ''}${audience ? `- AUDIENCE: ${audience}\n` : ''}${ctaTarget ? `- CTA TARGET: ${ctaTarget}\n` : ''}${desiredAction ? `- DESIRED ACTION: ${desiredAction}\n` : ''}` : ''}${fgBlock}${sgMeasuredBlock}${sgCompetitorBlock}\n\nBRAND VOICE PROFILE:\n${trimTo(voiceProfile, 1500)}\n\nPERSONAS:\n${trimTo(personas.slice(0, 2), 1000)}\n${topicalTerritories.length ? `\nSTRATEGIC TERRITORIES (stay inside these):\n${topicalTerritories.map(t => `- [${t.priority}]${t.cluster ? ` (${t.cluster})` : ''} ${t.topic}${t.angle ? ` — unique angle: ${t.angle}` : ''}`).join('\n')}\n` : ''}\nBRAIN PATTERNS — what works for this brand:\n${patternsRes.rows.length ? trimTo(patternsRes.rows, 1500) : 'No patterns yet.'}\n\nBRAIN MISTAKES — what to avoid:\n${mistakesRes.rows.length ? trimTo(mistakesRes.rows, 1000) : 'No mistakes logged yet.'}\n${enrichedBrief ? `\nENRICHED BRIEF CONTEXT:\n${trimTo({ title: enrichedBrief.enrichedTitle, hooks: enrichedBrief.contentHooks, powerPhrases: enrichedBrief.powerPhrases }, 1500)}\n` : ''}\nReturn ONLY valid JSON matching the {posts: [...]} schema in the system prompt. No markdown, no commentary.`;

    send('chunk', 'Brain loaded. Drafting 4 posts...');
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1, $2, $3, $4, $5)', ['stage4_5_social_generator_start', brandProfileId, 'started', 0, 0]).catch(() => {});

    // Stream from Claude
    let fullText = '';
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        fullText += chunk.delta.text;
        send('chunk', chunk.delta.text.replace(/\n/g, '⏎'));
      }
    }

    let parsed;
    try {
      parsed = safeParseLLM(fullText, 'object', 'social-generator');
    } catch(e) {
      console.error('[SOCIAL-GEN] Parse failed:', e.message);
      send('error', 'Generation hit a formatting issue — click Generate again.');
      clearInterval(keepalive); activeStreams.delete(streamKey);
      return res.end();
    }

    const posts = Array.isArray(parsed?.posts) ? parsed.posts.slice(0, 4) : [];
    if (!posts.length) {
      send('error', 'No posts returned. Click Generate to retry.');
      clearInterval(keepalive); activeStreams.delete(streamKey);
      return res.end();
    }

    // Persist all 4 with shared batch_id
    const batchId = randomUUID();
    const persisted = [];
    for (const post of posts) {
      const charCount = (post.body || '').length;
      const insertRes = await pool.query(
        `INSERT INTO generated_social_posts
          (brand_profile_id, batch_id, platform, angle, hook, body, hashtags, cta, char_count,
           confidence, confidence_tier, confidence_reason, brain_match_score,
           source_brief_id, source_topic, brain_version, arc_id, arc_title, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft')
         RETURNING id`,
        [
          brandProfileId, batchId, platform,
          post.angle || null, post.hook || null, post.body || '',
          JSON.stringify(post.hashtags || []), post.cta || null, charCount,
          post.confidence || null, post.confidenceTier || null, post.confidenceReason || null,
          post.brainMatchScore || null,
          briefId || null, topicPrompt || null, profile.version || 1,
          (arcId || null), (typeof selectedArcTitle === 'string' ? selectedArcTitle : null)
        ]
      );
      persisted.push({
        id: insertRes.rows[0].id,
        ...post,
        charCount,
        batchId,
        platform
      });
    }

    send('done', JSON.stringify({ batchId, platform, posts: persisted }));

    // Fire 4 image generations in parallel — non-blocking, emit image_done per post
    (async () => {
      try {
        await Promise.all(persisted.map(async (p) => {
          try {
            const imgPrompt = await buildSocialImagePrompt(p, voiceProfile, brandName);
            const imageUrl = await generateSocialImage(imgPrompt);
            await pool.query(
              `UPDATE generated_social_posts SET image_url = $1, image_prompt = $2, updated_at = NOW() WHERE id = $3`,
              [imageUrl, imgPrompt, p.id]
            ).catch(() => {});
            send('image_done', JSON.stringify({ post_id: p.id, image_url: imageUrl, prompt: imgPrompt }));
          } catch(imgErr) {
            console.error(`[SOCIAL-IMG] post ${p.id}:`, imgErr.message);
            send('image_error', JSON.stringify({ post_id: p.id, error: imgErr.message }));
          }
        }));
      } finally {
        clearInterval(keepalive);
        activeStreams.delete(streamKey);
        res.end();
      }
    })();

    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1, $2, $3, $4, $5)',
      ['stage4_5_social_generator', brandProfileId, 'success',
       (stream.usage?.input_tokens || 0) + (stream.usage?.output_tokens || 0), 0]
    ).catch(() => {});

  } catch (err) {
    console.error('[SOCIAL-GEN] Error:', err?.message || err);
    send('error', err.message || 'Generation failed');
    clearInterval(keepalive);
    activeStreams.delete(streamKey);
    res.end();
  }
});

// GET /api/social-generator/arcs/:brandProfileId — return campaign arcs from brand profile
router.get('/arcs/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const r = await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Brand not found' });
    const arcs = (r.rows[0].profile_data || {}).campaignArcs || [];
    res.json({ success: true, arcs });
  } catch(e) {
    console.error('[SOCIAL-ARCS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/social-generator/regenerate-arcs/:brandProfileId
// Generates a fresh set of campaignArcs[] for the brand's profile_data
// WITHOUT a full Context Hub rescan. The Social Generator UI calls this
// when the user wants alternate narrative angles to choose from.
//
// Body (all optional):
//   leanIntoMoats:    string[]  — strategicMoat capabilities to emphasize
//   leanIntoPersonas: string[]  — persona IDs to emphasize
//   leanIntoGaps:     string[]  — competitiveGap topics to emphasize
//   guidance:         string    — free-text nudge (max 500 chars)
//
// Returns: { success: true, arcs: CampaignArc[] }
//
// Persistence: REPLACES profile_data.campaignArcs with the new set.
// Old arcs are not preserved (no brain_history table yet — add audit
// when that table exists).
router.post('/regenerate-arcs/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });

  const {
    leanIntoMoats = [],
    leanIntoPersonas = [],
    leanIntoGaps = [],
    guidance = ''
  } = req.body || {};

  // Validate guidance length defensively
  const cleanGuidance = String(guidance || '').slice(0, 500).trim();

  try {
    // Load brand profile (+ settings: factualGround gates what arcs may claim)
    const pr = await pool.query('SELECT brand_name, profile_data, settings FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Brand not found' });
    const profile = pr.rows[0];
    const pd = profile.profile_data || {};

    const personas = pd.personas || [];
    const moats = pd.strategicMoats || [];
    const gaps = pd.competitiveGaps || [];
    const voiceProfile = pd.voiceProfile || pd.voice_profile || {};
    const existingArcs = pd.campaignArcs || [];

    // Arc regen previously saw no Factual Ground (arcs could stake theses the
    // brand contradicts), no brain, and no measured visibility. All best-effort.
    const arcFg = profile.settings?.factualGround || null;
    const arcFgBlock = arcFg && (arcFg.whatWeDo || arcFg.whatWeDontDo || arcFg.quotablePositions)
      ? `\nFACTUAL GROUND (arcs must never stake a thesis that contradicts these):\n${arcFg.whatWeDo ? `- What we do: ${String(arcFg.whatWeDo).slice(0, 400)}\n` : ''}${arcFg.whatWeDontDo ? `- What we DON'T do: ${String(arcFg.whatWeDontDo).slice(0, 400)}\n` : ''}${arcFg.quotablePositions ? `- Quotable positions (theses the brand already stands behind): ${String(arcFg.quotablePositions).slice(0, 400)}\n` : ''}`
      : '';
    let arcBrainBlock = '';
    let arcProbeBlock = '';
    try {
      const [apRes, amRes, agRes] = await Promise.all([
        pool.query(`SELECT pattern_type, description FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY success_rate DESC NULLS LAST LIMIT 8`, [brandProfileId]),
        pool.query(`SELECT mistake_type, description FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 8`, [brandProfileId]),
        pool.query(`SELECT brief_data->'citationProbe' as probe FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]),
      ]);
      if (apRes.rows.length || amRes.rows.length) {
        arcBrainBlock = `\nBRAIN PATTERNS (proven for this brand — arcs should ride these): ${JSON.stringify(apRes.rows).slice(0, 1200)}\nBRAIN MISTAKES (do NOT repeat): ${JSON.stringify(amRes.rows).slice(0, 800)}\n`;
      }
      const arcProbe = agRes.rows[0]?.probe || null;
      if (arcProbe && typeof arcProbe.visibility === 'number') {
        arcProbeBlock = `\nMEASURED AI VISIBILITY (live engine probe): the brand appears in ${arcProbe.visibility}% of AI answers today; AI cites ${(arcProbe.sources || []).slice(0, 6).map(s => s.domain).join(', ') || 'other sources'} instead. The strongest arcs argue theses on territory where the brand is measurably invisible.\n`;
      }
    } catch(e) { /* best-effort */ }

    // Build emphasis blocks. If user selected specific moats/personas/gaps,
    // surface them first and most prominently. Otherwise pass the whole list
    // (model picks angles itself, equivalent to current Context Hub flow).
    const moatsForPrompt = leanIntoMoats.length
      ? moats.filter(m => leanIntoMoats.includes(m.capability))
      : moats;
    const personasForPrompt = leanIntoPersonas.length
      ? personas.filter(p => leanIntoPersonas.includes(p.id))
      : personas;
    const gapsForPrompt = leanIntoGaps.length
      ? gaps.filter(g => leanIntoGaps.includes(g.topic))
      : gaps;

    const emphasisBlock = (leanIntoMoats.length || leanIntoPersonas.length || leanIntoGaps.length)
      ? `\nUSER-SPECIFIED EMPHASIS (lean into these, not the others):\n` +
        (leanIntoMoats.length ? `\nMoats: ${leanIntoMoats.join(', ')}\n` : '') +
        (leanIntoPersonas.length ? `Personas: ${leanIntoPersonas.join(', ')}\n` : '') +
        (leanIntoGaps.length ? `Gaps: ${leanIntoGaps.join(', ')}\n` : '')
      : '';

    const guidanceBlock = cleanGuidance ? `\nUSER GUIDANCE: ${cleanGuidance}\n` : '';

    const existingTitles = existingArcs.map(a => a.title).filter(Boolean);
    const avoidBlock = existingTitles.length
      ? `\nAVOID REPRODUCING EXISTING ARC TITLES OR THESES. The user already has these and wants ALTERNATE angles:\n${existingTitles.map(t => `  - "${t}"`).join('\n')}\n`
      : '';

    const prompt = `You are generating fresh CAMPAIGN ARCS for a brand's content strategy. These arcs will be picked by the brand's social-post generator as the spine of multi-post sequences — each arc is a sustained narrative the brand argues across many short-form posts.

BRAND: ${profile.brand_name}

VOICE PROFILE:
${JSON.stringify(voiceProfile, null, 2).slice(0, 1500)}

PERSONAS (these are who the brand speaks to):
${JSON.stringify(personasForPrompt, null, 2).slice(0, 2000)}

STRATEGIC MOATS (what the brand deliberately does NOT do — leverage as positioning):
${JSON.stringify(moatsForPrompt, null, 2).slice(0, 1500)}

COMPETITIVE GAPS (topics where peers own the conversation and the brand could plausibly win):
${JSON.stringify(gapsForPrompt, null, 2).slice(0, 2000)}
${arcFgBlock}${arcBrainBlock}${arcProbeBlock}${emphasisBlock}${guidanceBlock}${avoidBlock}
TASK: Write 3-5 fresh campaign arcs. Each arc must be:
- A narrative spine the brand can argue for weeks/months
- Ownable — something the brand specifically can claim, not generic
- Provocative — a real point of view, not a topic survey
- Tied to one persona primarily

OUTPUT ONLY valid JSON matching this schema exactly. No prose before or after.

{
  "campaignArcs": [
    {
      "id": "kebab-case-slug",
      "title": "Evocative name of the campaign series (not generic)",
      "thesis": "1-2 sentence core claim of the whole series. Provocative, ownable, tied to the brand's POV. NOT a summary of what will be covered — the argument itself.",
      "acts": [
        { "actNumber": 1, "actTitle": "string", "actPremise": "what this act establishes, proves, or resolves" }
      ],
      "recommendedLength": 4,
      "targetPersona": "persona id from the input"
    }
  ]
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = msg.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = safeParseLLM(raw, 'object', 'regen-arcs');
    } catch (parseErr) {
      console.error('[REGEN-ARCS] JSON parse failed:', parseErr.message, 'raw start:', raw.slice(0, 300));
      return res.status(500).json({ success: false, error: 'Model returned invalid JSON. Please try again.' });
    }

    const newArcs = parsed.campaignArcs || [];
    if (!Array.isArray(newArcs) || newArcs.length === 0) {
      return res.status(500).json({ success: false, error: 'Model returned no arcs. Please try again.' });
    }

    // Persist: jsonb_set replaces only the campaignArcs key, preserves everything else
    await pool.query(
      `UPDATE brand_profiles
          SET profile_data = jsonb_set(COALESCE(profile_data, '{}'::jsonb), '{campaignArcs}', $1::jsonb),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(newArcs), brandProfileId]
    );

    console.log(`[REGEN-ARCS] Brand ${brandProfileId.slice(0,8)}… generated ${newArcs.length} fresh arcs`);
    res.json({ success: true, arcs: newArcs });
  } catch (e) {
    console.error('[REGEN-ARCS] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/social-generator/recent/:brandProfileId — list recent batches
router.get('/recent/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    await ensureSocialPostsTable();
    const r = await pool.query(
      `SELECT id, batch_id, platform, angle, hook, body, hashtags, cta, char_count,
              confidence, confidence_tier, confidence_reason, brain_match_score,
              image_url, image_prompt, status, user_edited_body, source_topic,
              arc_id, arc_title, published_url, published_at,
              created_at, updated_at
       FROM generated_social_posts
       WHERE brand_profile_id = $1
       ORDER BY created_at DESC LIMIT 80`,
      [brandProfileId]
    );
    // Group by batch_id
    const batches = {};
    for (const row of r.rows) {
      const bid = row.batch_id;
      if (!batches[bid]) batches[bid] = {
        // FE expects snake_case here — mirror Postgres column names exactly so
        // the type definition in SocialGeneratorPage.tsx works without remapping.
        batch_id: bid,
        platform: row.platform,
        created_at: row.created_at,
        source_topic: row.source_topic || null,
        arc_id: row.arc_id || null,
        arc_title: row.arc_title || null,
        posts: []
      };
      batches[bid].posts.push(row);
    }
    res.json({ success: true, batches: Object.values(batches) });
  } catch(e) {
    console.error('[SOCIAL-LIST]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/social-generator/edit/:postId — inline edit, captures delta as brain_mistake.
// Accepts both 'user_edited_body' (current FE field name) and 'body' (legacy/scripts) for the
// new text. Stores edits in user_edited_body without overwriting the original generator output
// in post.body, so brain delta-mistake calculations stay anchored to the true original.
// Returns the full updated post via RETURNING * so FE.onUpdate(d.post) re-renders cleanly.
router.post('/edit/:postId', async (req, res) => {
  const { postId } = req.params;
  const { body, user_edited_body, hashtags, cta } = req.body;
  // FE sends user_edited_body; older clients/scripts may send body — accept either.
  const newBodyInput = typeof user_edited_body === 'string' ? user_edited_body
                     : typeof body === 'string' ? body : null;
  try {
    // Look up post + verify access
    const r = await pool.query('SELECT * FROM generated_social_posts WHERE id = $1', [postId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Post not found' });
    const post = r.rows[0];
    if (!(await verifyBrandAccess(post.brand_profile_id, req.userId))) return res.status(403).json({ success: false, error: 'Access denied' });

    const newBody = newBodyInput !== null ? newBodyInput : (post.user_edited_body || post.body);
    const newHashtags = Array.isArray(hashtags) ? hashtags : (post.hashtags || []);
    const newCta = typeof cta === 'string' ? cta : post.cta;
    const newCharCount = newBody.length;

    // Hard char limit on X. Reject early so users get a useful error at edit time.
    if (post.platform === 'x' && newCharCount > 280) {
      return res.status(400).json({ success: false, error: `X posts must be 280 characters or fewer. This edit is ${newCharCount}.`, charCount: newCharCount });
    }

    // Brain feedback: if body changed vs the original generator output, log as a mistake.
    if (newBody !== post.body && post.body) {
      pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
         VALUES ($1, 'social_human_edit', $2, $3, 'medium')`,
        [
          post.brand_profile_id,
          `${post.platform} ${post.angle || 'post'}: human reviewer edited body`,
          `Avoid: "${(post.body || '').substring(0, 200)}" — prefer: "${newBody.substring(0, 200)}"`
        ]
      ).catch(e => console.error('[SOCIAL-EDIT] mistake write:', e.message));
    }

    // Persist edit. user_edited_body always carries the latest text; original post.body untouched.
    const upd = await pool.query(
      `UPDATE generated_social_posts
       SET user_edited_body = $1, hashtags = $2, cta = $3, char_count = $4,
           status = CASE WHEN status = 'published' THEN 'published' ELSE 'edited' END,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [newBody, JSON.stringify(newHashtags), newCta, newCharCount, postId]
    );

    res.json({ success: true, post: upd.rows[0], body: newBody, hashtags: newHashtags, cta: newCta, charCount: newCharCount });
  } catch(e) {
    console.error('[SOCIAL-EDIT]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/social-generator/publish-x/:postId — direct-publish a single social
// post to X (Twitter) using the brand's stored OAuth credentials in publishing_channels.
//
// Why this exists separate from the article publish flow at /api/publishing/publish/:itemId:
// - Social posts have no URL append, no UTM injection, no title fallback — the body IS the tweet.
// - No queue staging, no campaign machinery, no per-channel selection (X-only here).
// - One post = one network call, ship-or-fail. Status flip + URL store on success.
//
// Auth path mirrors the article flow's X handler (L10049 region in this file):
// OAuth 2.0 token from publishing_channels.credentials, refresh on 401, OAuth 1.0a fallback.
router.post('/publish-x/:postId', async (req, res) => {
  const { postId } = req.params;
  try {
    // Load the post + verify brand access
    const r = await pool.query('SELECT * FROM generated_social_posts WHERE id = $1', [postId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Post not found' });
    const post = r.rows[0];
    if (post.platform !== 'x') return res.status(400).json({ success: false, error: 'This endpoint publishes X posts only.' });
    if (!(await verifyBrandAccess(post.brand_profile_id, req.userId))) return res.status(403).json({ success: false, error: 'Access denied' });
    if (post.status === 'published' && post.published_url) {
      return res.json({ success: true, alreadyPublished: true, url: post.published_url, post });
    }

    // Use the latest user-edited body if present, else the original body
    const tweetText = (post.user_edited_body || post.body || '').trim();
    if (!tweetText) return res.status(400).json({ success: false, error: 'Post has no body to publish.' });
    if (tweetText.length > 280) return res.status(400).json({ success: false, error: `Post is ${tweetText.length} chars; X requires ≤280. Edit the post and try again.` });

    // Pull X creds for this brand
    const channelRes = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'x'`,
      [post.brand_profile_id]
    );
    if (!channelRes.rows.length) {
      return res.status(400).json({ success: false, error: 'X is not connected for this brand. Connect it in Integrations first.', code: 'X_NOT_CONNECTED' });
    }
    const creds = channelRes.rows[0].credentials || {};

    const tweetEndpoint = 'https://api.twitter.com/2/tweets';
    let tweetId, twitterHandle = creds.username || 'i';

    // ── Media upload: prefer brand's OAuth 2.0 user-context token (same user uploads + posts) ──
    // X enforces user-level ownership of media on tweet POST — the user that uploads must be
    // the same user that attaches. So we upload using the brand's own token. Requires
    // media.write scope on the OAuth 2.0 token (added 2026-05-05 to the OAuth scope list).
    //
    // Fallback: if the brand reconnected before media.write was added (no media.write in
    // scope), try the system OAuth 1.0a creds. Only succeeds if brand's OAuth 2.0 user is
    // the same person as the system OAuth 1.0a user (@makemysandbox). Otherwise X rejects
    // the attach with 'One or more parameters to your request was invalid'.
    let mediaIds = [];
    if (post.image_url) {
      const oauth2Token = creds.oauth2AccessToken;
      const oauth2HasMediaWrite = (creds.oauth2Scope || '').includes('media.write');

      if (oauth2Token && oauth2HasMediaWrite) {
        // Preferred path: brand's own OAuth 2.0 token with media.write scope
        try {
          const mediaId = await uploadXMedia({ imageUrl: post.image_url, oauth2Token });
          mediaIds = [mediaId];
        } catch(e) {
          console.error('[X-SOCIAL] OAuth2 media upload failed:', e.message);
          return res.status(500).json({ success: false, error: `Image upload to X failed: ${e.message}`, code: 'X_MEDIA_UPLOAD_FAILED' });
        }
      } else {
        // Fallback: system OAuth 1.0a creds. Only succeeds if brand's user == system user.
        const k1 = process.env.X_OAUTH1CONSUMER_KEY;
        const s1 = process.env.X_OAUTH1CONSUMER_SECRET;
        const t1 = process.env.X_OAUTH1ACCESS_TOKEN;
        const ts1 = process.env.X_OAUTH1ACCESS_SECRET;
        if (!k1 || !s1 || !t1 || !ts1) {
          return res.status(400).json({
            success: false,
            error: 'Reconnect X to enable image uploads. Open Integrations and reconnect your X account to grant the new media permission.',
            code: 'X_MEDIA_RECONNECT_REQUIRED'
          });
        }
        try {
          // v1.1 media upload endpoint (despite v2 working elsewhere, v2 /2/media/upload doesn't
          // accept multipart-friendly additional_owners). The OAuth 1.0a signature is computed
          // against the v1.1 URL.
          const mediaUploadEndpoint = 'https://upload.twitter.com/1.1/media/upload.json';
          const mediaAuthHeader = buildXOAuthHeader('POST', mediaUploadEndpoint, k1, s1, t1, ts1);

          // Look up the brand's X user ID so we can grant them attach permission via
          // additional_owners. Without this, X rejects the cross-user tweet POST. Cache the
          // result back into credentials so future publishes skip this lookup.
          let brandUserId = creds.userId || null;
          if (!brandUserId && creds.username) {
            try {
              const lookupUrl = `https://api.x.com/2/users/by/username/${encodeURIComponent(creds.username)}`;
              const lookupAuth = buildXOAuthHeader('GET', lookupUrl, k1, s1, t1, ts1);
              const lr = await fetch(lookupUrl, { headers: { Authorization: lookupAuth } });
              if (lr.ok) {
                const ld = await lr.json();
                brandUserId = ld?.data?.id || null;
                if (brandUserId) {
                  // Cache for next time
                  await pool.query(
                    `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
                    [JSON.stringify({ userId: brandUserId }), post.brand_profile_id]
                  );
                }
              }
            } catch (lookupErr) {
              console.error('[X-SOCIAL] User ID lookup failed (non-fatal):', lookupErr.message);
            }
          }

          const mediaId = await uploadXMedia({
            imageUrl: post.image_url,
            oauth1Header: mediaAuthHeader,
            additionalOwners: brandUserId || undefined,
          });
          mediaIds = [mediaId];
        } catch(e) {
          console.error('[X-SOCIAL] OAuth1 fallback media upload failed:', e.message);
          return res.status(400).json({
            success: false,
            error: 'Reconnect X to enable image uploads. Your X connection was authorized before image support was added — open Integrations to reconnect.',
            code: 'X_MEDIA_RECONNECT_REQUIRED'
          });
        }
      }
    }

    if (creds.oauth2AccessToken) {
      // OAuth 2.0 path — preferred for the tweet POST. Try posting; if 401, refresh and retry.
      let token = creds.oauth2AccessToken;
      const tweetBody = mediaIds.length
        ? { text: tweetText, media: { media_ids: mediaIds } }
        : { text: tweetText };
      let xRes = await fetch(tweetEndpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(tweetBody)
      });
      if (xRes.status === 401 && creds.oauth2RefreshToken) {
        try {
          const refreshed = await refreshXOAuth2Token(creds.oauth2RefreshToken);
          token = refreshed.access_token;
          await pool.query(
            `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
            [JSON.stringify({ oauth2AccessToken: refreshed.access_token, oauth2RefreshToken: refreshed.refresh_token || creds.oauth2RefreshToken }), post.brand_profile_id]
          );
          // Media was uploaded via OAuth 1.0a system creds before the OAuth 2.0 refresh —
          // media_ids tied to app, not user token, so they survive the user's token refresh.
          // Just retry the tweet POST with the same body shape.
          const tweetBodyRetry = mediaIds.length
            ? { text: tweetText, media: { media_ids: mediaIds } }
            : { text: tweetText };
          xRes = await fetch(tweetEndpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(tweetBodyRetry)
          });
        } catch(e) {
          console.error('[X-SOCIAL] Token refresh failed:', e.message);
          if (e.message && (e.message.includes('invalid') || e.message.includes('revoked') || e.message.includes('expired'))) {
            await pool.query(
              `UPDATE publishing_channels SET credentials = credentials - 'oauth2AccessToken' - 'oauth2RefreshToken' WHERE brand_profile_id = $1 AND channel = 'x'`,
              [post.brand_profile_id]
            ).catch(() => {});
            return res.status(401).json({ success: false, error: 'X authentication expired. Please reconnect X in Integrations.', code: 'X_AUTH_EXPIRED' });
          }
          throw e;
        }
      }
      const xData = await xRes.json();
      if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
      tweetId = xData.data?.id;
    } else {
      // OAuth 1.0a fallback — legacy manual tokens
      const xApiKey       = creds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
      const xApiSecret    = creds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
      const xAccessToken  = creds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
      const xAccessSecret = creds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
      if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessSecret) {
        return res.status(400).json({ success: false, error: 'X is not connected for this brand. Connect it in Integrations first.', code: 'X_NOT_CONNECTED' });
      }
      // OAuth 1.0a tweet POST (legacy fallback when no OAuth 2.0 creds for the brand).
      // Media was already uploaded upstream via the system OAuth 1.0a creds; mediaIds is populated.
      const authHeader = buildXOAuthHeader('POST', tweetEndpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
      const tweetBody1 = mediaIds.length
        ? { text: tweetText, media: { media_ids: mediaIds } }
        : { text: tweetText };
      const xRes = await fetch(tweetEndpoint, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(tweetBody1)
      });
      const xData = await xRes.json();
      if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
      tweetId = xData.data?.id;
      try {
        const meRes = await fetch('https://api.twitter.com/2/users/me', { headers: { 'Authorization': authHeader } });
        if (meRes.ok) twitterHandle = (await meRes.json()).data?.username || 'i';
      } catch(e) {}
    }

    const publishedUrl = `https://x.com/${twitterHandle}/status/${tweetId}`;

    // Persist
    const upd = await pool.query(
      `UPDATE generated_social_posts SET status = 'published', published_url = $1, published_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [publishedUrl, postId]
    );
    res.json({ success: true, url: publishedUrl, tweetId, post: upd.rows[0] });
  } catch(e) {
    console.error('[X-SOCIAL]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
