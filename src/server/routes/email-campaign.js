// Email Campaign Generator routes, extracted from server.js during the
// route-group phase. Mounted at /api/email-campaign with requireAuth at the
// mount in server.js (every route here is authed). Pure move: handler bodies
// are verbatim; only the registration lines changed (app.METHOD(
// '/api/email-campaign/x', requireAuth, …) -> router.METHOD('/x', …)).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';
import { safeParseLLM } from '../llm-json.js';
import { stripScaffoldingArtifacts } from '../text.js';
import { dateContext } from '../llm.js';
import { activeStreams } from '../streams.js';

const router = express.Router();

router.post('/create', async (req, res) => {
  const { brandProfileId, brief } = req.body;
  if (!brandProfileId || !brief) return res.status(400).json({ error: 'brandProfileId and brief required' });

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      brand_profile_id TEXT NOT NULL,
      brief JSONB NOT NULL,
      status VARCHAR(30) DEFAULT 'pending',
      sequence_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});

    await pool.query(`CREATE TABLE IF NOT EXISTS email_campaign_emails (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      campaign_id TEXT NOT NULL,
      email_index INTEGER NOT NULL,
      job TEXT,
      send_day INTEGER DEFAULT 0,
      subject_lines JSONB,
      preview_text TEXT,
      body TEXT,
      cta_text TEXT,
      cta_url_placeholder TEXT,
      ps TEXT,
      confidence_score INTEGER,
      confidence_reason TEXT,
      flags JSONB DEFAULT '[]',
      status VARCHAR(30) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});

    const result = await pool.query(
      `INSERT INTO email_campaigns (brand_profile_id, brief, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [brandProfileId, JSON.stringify(brief)]
    );
    const campaignId = result.rows[0].id;
    res.json({ success: true, campaignId });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/list/:brandProfileId — list saved campaigns
router.get('/list/:brandProfileId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, brief, status, sequence_notes, created_at FROM email_campaigns WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.brandProfileId]
    );
    res.json({ success: true, campaigns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/:id — get campaign + emails
router.get('/:id', async (req, res) => {
  try {
    const [camp, emails] = await Promise.all([
      pool.query(`SELECT * FROM email_campaigns WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT * FROM email_campaign_emails WHERE campaign_id = $1 ORDER BY email_index`, [req.params.id])
    ]);
    if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign: camp.rows[0], emails: emails.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/email-campaign/email/:id
// Update an individual email within a campaign. Brand-scoped via campaign join.
// Allowed fields: body, ps, cta_text, cta_url_placeholder, subject_lines.
router.patch('/email/:id', async (req, res) => {
  const { body, ps, cta_text, cta_url_placeholder, subject_lines } = req.body || {};

  const fieldsProvided = [body, ps, cta_text, cta_url_placeholder, subject_lines].some(v => v !== undefined);
  if (!fieldsProvided) return res.status(400).json({ error: 'No editable fields provided' });

  try {
    const check = await pool.query(
      `SELECT e.id, c.brand_profile_id
         FROM email_campaign_emails e
         JOIN email_campaigns c ON c.id = e.campaign_id
        WHERE e.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Email not found' });

    // Build dynamic UPDATE only for provided fields
    const sets = [];
    const vals = [];
    let i = 1;
    if (body !== undefined)                  { sets.push(`body = $${i++}`);                vals.push(body); }
    if (ps !== undefined)                    { sets.push(`ps = $${i++}`);                  vals.push(ps || null); }
    if (cta_text !== undefined)              { sets.push(`cta_text = $${i++}`);            vals.push(cta_text); }
    if (cta_url_placeholder !== undefined)   { sets.push(`cta_url_placeholder = $${i++}`); vals.push(cta_url_placeholder); }
    if (subject_lines !== undefined)         { sets.push(`subject_lines = $${i++}`);       vals.push(JSON.stringify(subject_lines)); }
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);

    const upd = await pool.query(
      `UPDATE email_campaign_emails SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    res.json({ success: true, email: upd.rows[0] });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] PATCH email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-campaign/email/:id/resolve-flag
// Mark a flag resolved with action: 'edited' | 'cited' | 'dismissed'.
// Resolution stored in flag_resolutions JSONB keyed by flag index. The
// flag itself stays in flags array — UI uses resolution to show
// strikethrough + status badge, preserving audit trail.
router.post('/email/:id/resolve-flag', async (req, res) => {
  const { flagIndex, action, citationUrl, dismissReason } = req.body || {};
  if (typeof flagIndex !== 'number') return res.status(400).json({ error: 'flagIndex (number) required' });
  if (!['edited', 'cited', 'dismissed'].includes(action)) return res.status(400).json({ error: 'action must be edited|cited|dismissed' });
  if (action === 'cited' && !citationUrl) return res.status(400).json({ error: 'citationUrl required for action=cited' });
  if (action === 'dismissed' && !dismissReason) return res.status(400).json({ error: 'dismissReason required for action=dismissed' });

  try {
    const resolution = {
      action,
      resolvedAt: new Date().toISOString(),
      ...(citationUrl && { citationUrl }),
      ...(dismissReason && { dismissReason })
    };

    const result = await pool.query(
      `UPDATE email_campaign_emails
          SET flag_resolutions = COALESCE(flag_resolutions, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb),
              updated_at = NOW()
        WHERE id = $3
        RETURNING flag_resolutions`,
      [String(flagIndex), JSON.stringify(resolution), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Email not found' });
    res.json({ success: true, flag_resolutions: result.rows[0].flag_resolutions });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] resolve-flag error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-campaign/email/:id/dismiss-flag-as-false-positive
// Same as resolve-flag with action='dismissed', but ALSO writes a brain_mistakes
// row so future Compliance Gate runs learn this pattern is a false-positive
// for the brand. Closes the feedback loop on AI-generated flags.
router.post('/email/:id/dismiss-flag-as-false-positive', async (req, res) => {
  const { flagIndex, reason } = req.body || {};
  if (typeof flagIndex !== 'number') return res.status(400).json({ error: 'flagIndex (number) required' });
  if (!reason || reason.length < 10) return res.status(400).json({ error: 'reason (min 10 chars) required' });

  try {
    const check = await pool.query(
      `SELECT e.flags, c.brand_profile_id
         FROM email_campaign_emails e
         JOIN email_campaigns c ON c.id = e.campaign_id
        WHERE e.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Email not found' });

    const flags = check.rows[0].flags || [];
    const flag = flags[flagIndex];
    if (!flag) return res.status(400).json({ error: `flagIndex ${flagIndex} not found in flags` });

    const resolution = {
      action: 'dismissed',
      resolvedAt: new Date().toISOString(),
      dismissReason: reason,
      flagType: flag.type,
      flagDetail: flag.detail,
      writtenToBrainMistakes: true
    };
    await pool.query(
      `UPDATE email_campaign_emails
          SET flag_resolutions = COALESCE(flag_resolutions, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb),
              updated_at = NOW()
        WHERE id = $3`,
      [String(flagIndex), JSON.stringify(resolution), req.params.id]
    );

    await pool.query(
      `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity, created_at)
       VALUES ($1, $2, $3, $4, 'medium', NOW())`,
      [
        check.rows[0].brand_profile_id,
        `compliance_false_positive:${flag.type}`,
        `Compliance Gate flagged: "${flag.detail}". User dismissed as false positive.`,
        `False positive: ${reason.slice(0, 500)}. Do NOT flag similar content in future critiques for this brand.`
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] dismiss-flag-as-false-positive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/generate/:id — SSE — generate all emails sequentially
router.get('/generate/:id', async (req, res) => {
  // Duplicate stream guard
  const streamKey = `${req.params.id}:email-campaign`;
  if (activeStreams.has(streamKey)) {
    const existing = activeStreams.get(streamKey);
    const elapsed = Math.floor((Date.now() - existing.startedAt) / 1000);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: busy\ndata: ${JSON.stringify({ message: 'Email campaign generation already in progress', elapsed })}\n\n`);
    return res.end();
  }
  activeStreams.set(streamKey, { startedAt: Date.now(), userId: req.userId });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(keepalive); activeStreams.delete(streamKey); });

  try {
    const campRes = await pool.query(`SELECT * FROM email_campaigns WHERE id = $1`, [req.params.id]);
    if (!campRes.rows.length) { send('error', { message: 'Campaign not found' }); return res.end(); }
    const campaign = campRes.rows[0];
    const brief = campaign.brief;

    const profileRes = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [campaign.brand_profile_id]);
    if (!profileRes.rows.length) { send('error', { message: 'Brand profile not found' }); return res.end(); }
    const profileData = profileRes.rows[0].profile_data || profileRes.rows[0];

    const [patternsRes, mistakesRes] = await Promise.all([
      pool.query(`SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 6`, [campaign.brand_profile_id]).catch(() => ({ rows: [] })),
      pool.query(`SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 5`, [campaign.brand_profile_id]).catch(() => ({ rows: [] }))
    ]);

    const systemPrompt = fs.readFileSync(
      path.join(__dirname, 'src/agents/stage46_email_campaign/system_prompt.md'), 'utf8'
    );

    const trimTo = (obj, max = 3000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      return s.length > max ? s.substring(0, max) + '...[truncated]' : s;
    };

    const numEmails = brief.num_emails || 5;
    const userPrompt = `Generate a ${numEmails}-email ${brief.campaign_type || 'nurture'} sequence using the following brief and brand brain.

CAMPAIGN BRIEF:
- Business Problem: ${brief.business_problem}
- SMART Goal: ${brief.smart_goal}
- Single-Minded Proposition: ${brief.smp}
- UVP: ${brief.uvp}
- Pain Point Being Solved: ${brief.pain_point}
- Target Persona: ${brief.target_persona}
- Current Mindset: ${brief.current_mindset}
- Desired Mindset After Reading: ${brief.desired_mindset}
- Direct Competitor: ${brief.competitor || 'Not specified'}
- Mandatories: ${brief.mandatories || 'None'}

BRAND VOICE PROFILE:
${trimTo(profileData?.voiceProfile || profileData?.voice_profile || {}, 2000)}

PERSONAS:
${trimTo(profileData?.personas || [], 1500)}

BRAIN PATTERNS (what has worked — lean into these):
${patternsRes.rows.map(p => `- [${p.pattern_type}] ${p.description}`).join('\n') || 'None yet'}

BRAIN MISTAKES (what has failed — avoid unconditionally):
${mistakesRes.rows.map(m => `- [${m.severity}] ${m.mistake_type}: ${m.description}`).join('\n') || 'None yet'}

Generate exactly ${numEmails} emails. Return ONLY valid JSON matching the output format.`;

    await pool.query(`UPDATE email_campaigns SET status = 'generating', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    send('status', { message: 'Brain loaded. Generating sequence...' });

    // ── Mistral Large for email — optimized for lead-gen focused writing ──
    const mistralEmailRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        max_tokens: 8000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (!mistralEmailRes.ok) {
      const errBody = await mistralEmailRes.text();
      throw new Error(`Mistral API ${mistralEmailRes.status}: ${errBody.slice(0, 300)}`);
    }
    const mistralEmailData = await mistralEmailRes.json();
    const raw = mistralEmailData.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = safeParseLLM(jsonMatch ? jsonMatch[0] : raw, 'object', 'email-campaign');
    } catch(e) {
      // Fallback: strip newlines inside strings
      const fixed = (jsonMatch ? jsonMatch[0] : raw).replace(/:\s*"([\s\S]*?)"/g, (m, val) => ': "' + val.replace(/\n/g, ' ').replace(/\r/g, ' ') + '"');
      parsed = JSON.parse(fixed);
    }

    // Save campaign-level metadata
    await pool.query(
      `UPDATE email_campaigns SET status = 'complete', sequence_notes = $1, updated_at = NOW() WHERE id = $2`,
      [parsed.sequence_notes || '', req.params.id]
    );

    // Save each email
    for (const email of parsed.emails || []) {
      await pool.query(
        `INSERT INTO email_campaign_emails (campaign_id, email_index, job, send_day, subject_lines, preview_text, body, cta_text, cta_url_placeholder, ps, confidence_score, confidence_reason, flags, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'complete')
         ON CONFLICT DO NOTHING`,
        [
          req.params.id, email.index, email.job || '', email.send_day || 0,
          JSON.stringify(email.subject_lines || {}), email.preview_text || '',
          email.body || '', email.cta_text || '', email.cta_url_placeholder || '{{cta_url}}',
          email.ps || null, email.confidence_score || 80, email.confidence_reason || '',
          JSON.stringify(email.flags || [])
        ]
      ).catch(() => {});
      send('email', { index: email.index, job: email.job, confidence_score: email.confidence_score, flags: email.flags || [] });
    }

    send('complete', { campaignId: req.params.id, emailCount: parsed.emails?.length || 0, sequenceNotes: parsed.sequence_notes });
    clearInterval(keepalive);
    res.end();
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] Generate error:', err.message);
    send('error', { message: err.message });
    clearInterval(keepalive);
    res.end();
  }
});

// POST /api/email-campaign/save-brief-template — save reusable brief
router.post('/save-brief-template', async (req, res) => {
  const { brandProfileId, name, brief } = req.body;
  if (!brandProfileId || !name || !brief) return res.status(400).json({ error: 'brandProfileId, name, and brief required' });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS email_brief_templates (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      brand_profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brief JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const result = await pool.query(
      `INSERT INTO email_brief_templates (brand_profile_id, name, brief) VALUES ($1, $2, $3) RETURNING id`,
      [brandProfileId, name, JSON.stringify(brief)]
    );
    res.json({ success: true, templateId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/brief-templates/:brandProfileId
router.get('/brief-templates/:brandProfileId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, brief, created_at FROM email_brief_templates WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [req.params.brandProfileId]
    ).catch(() => ({ rows: [] }));
    res.json({ success: true, templates: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
