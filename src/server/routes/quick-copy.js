// Quick Copy routes — brand-voiced one-off copy (replies, DMs, posts, notes).
// Mounted at /api/quick-copy with requireAuth at the mount in server.js.
// Copy/paste only in v1 — no publish path. Optional on-demand lite compliance
// returns anchored flags for inline underline + superscript UI.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { anthropic, dateContext } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';
import { verifyBrandAccess } from '../auth.js';
import { activeStreams } from '../streams.js';
import {
  QUICK_COPY_FORMATS,
  QUICK_COPY_PLATFORMS,
  clampVariantCount,
  anchorComplianceFlags,
  formatConstraintBlock,
} from '../quick-copy.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const router = express.Router();

const SONNET = 'claude-sonnet-4-6';

async function ensureQuickCopyTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS quick_copy_drafts (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    brand_profile_id TEXT NOT NULL,
    user_id TEXT,
    format TEXT NOT NULL,
    platform TEXT DEFAULT 'generic',
    prompt TEXT NOT NULL,
    source_text TEXT,
    audience TEXT,
    mandatories TEXT,
    constraints TEXT,
    length_hint TEXT,
    variant_count INTEGER DEFAULT 2,
    variants_json JSONB DEFAULT '[]'::jsonb,
    active_variant_idx INTEGER DEFAULT 0,
    compliance_json JSONB,
    confidence INTEGER,
    confidence_reason TEXT,
    brain_version INTEGER,
    status TEXT DEFAULT 'draft',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_qcd_brand_created ON quick_copy_drafts(brand_profile_id, created_at DESC)`
  ).catch(() => {});
}
ensureQuickCopyTable().catch((e) => console.error('[QUICK-COPY] Table init error:', e.message));

function trimTo(obj, maxChars = 2000) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
}

async function loadBrainContext(brandProfileId) {
  const [profileRes, patternsRes, mistakesRes] = await Promise.all([
    pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]),
    pool.query(
      `SELECT pattern_type, description, confidence_score, tags
         FROM brain_patterns
        WHERE brand_profile_id = $1
        ORDER BY confidence_score DESC
        LIMIT 8`,
      [brandProfileId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT mistake_type, description, severity
         FROM brain_mistakes
        WHERE brand_profile_id = $1
        ORDER BY severity DESC, created_at DESC
        LIMIT 8`,
      [brandProfileId]
    ).catch(() => ({ rows: [] })),
  ]);
  if (!profileRes.rows.length) return null;
  const profile = profileRes.rows[0];
  const profileData = profile.profile_data || {};
  const voiceProfile = profileData.voiceProfile || profileData.voice_profile || {};
  const personas = profileData.personas || [];
  const factualGround = profile.settings?.factualGround || null;
  return {
    profile,
    profileData,
    voiceProfile,
    personas,
    factualGround,
    patterns: patternsRes.rows,
    mistakes: mistakesRes.rows,
    brandName: profile.brand_name || '',
  };
}

function factualGroundBlock(fg) {
  if (!fg || !Object.values(fg).some((v) => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))) {
    return '';
  }
  return `\nFACTUAL GROUND (use verbatim, never contradict):
${fg.whatWeDo ? `- What we do: ${fg.whatWeDo}\n` : ''}${fg.whatWeDontDo ? `- What we DON'T do: ${fg.whatWeDontDo}\n` : ''}${fg.quotablePositions ? `- Quotable positions: ${fg.quotablePositions}\n` : ''}${fg.companyFacts ? `- Company facts: ${String(fg.companyFacts).slice(0, 400)}\n` : ''}${fg.methodology ? `- Methodology: ${String(fg.methodology).slice(0, 300)}\n` : ''}`;
}

function readSystemPrompt() {
  const p = path.join(REPO_ROOT, 'src/agents/stage4_quick_copy/system_prompt.md');
  return fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8')
    : 'You write brand-voiced one-off copy. Return JSON with a variants array.';
}

// POST /api/quick-copy/generate — SSE generation
router.post('/generate', async (req, res) => {
  const {
    brandProfileId,
    format,
    platform = 'generic',
    prompt,
    sourceText = '',
    audience = '',
    mandatories = '',
    constraints = '',
    lengthHint = 'medium',
    variantCount: rawVariantCount,
  } = req.body || {};

  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ success: false, error: 'prompt required' });
  if (!QUICK_COPY_FORMATS.includes(format)) {
    return res.status(400).json({ success: false, error: `format must be one of: ${QUICK_COPY_FORMATS.join(', ')}` });
  }
  const plat = QUICK_COPY_PLATFORMS.includes(platform) ? platform : 'generic';
  const variantCount = clampVariantCount(rawVariantCount);

  if (!(await verifyBrandAccess(brandProfileId, req.userId))) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const streamKey = `${brandProfileId}:quick-copy`;
  if (activeStreams.has(streamKey)) {
    const existing = activeStreams.get(streamKey);
    const elapsed = Math.floor((Date.now() - existing.startedAt) / 1000);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: busy\ndata: ${JSON.stringify({ message: 'Quick Copy already running for this brand', elapsed })}\n\n`);
    return res.end();
  }
  activeStreams.set(streamKey, { startedAt: Date.now(), userId: req.userId });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  };
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  const cleanup = () => {
    clearInterval(keepalive);
    activeStreams.delete(streamKey);
  };
  req.on('close', cleanup);

  try {
    await ensureQuickCopyTable();
    send('status', { message: 'Loading brand brain…' });

    const brain = await loadBrainContext(brandProfileId);
    if (!brain) {
      send('error', { message: 'Brand profile not found.' });
      cleanup();
      return res.end();
    }

    const systemPrompt = readSystemPrompt();
    const constraintBlock = formatConstraintBlock({ format, platform: plat, lengthHint });
    const fgBlock = factualGroundBlock(brain.factualGround);

    const userPrompt = `${dateContext()}

Write exactly ${variantCount} variant(s) of brand-voiced Quick Copy.

${constraintBlock}

BRAND: ${brain.brandName}

USER REQUEST:
"""
${String(prompt).trim()}
"""
${sourceText && String(sourceText).trim() ? `\nSOURCE / INBOUND TO RESPOND TO:\n"""\n${String(sourceText).trim().slice(0, 4000)}\n"""\n` : ''}
${audience ? `AUDIENCE: ${audience}\n` : ''}${mandatories ? `MUST INCLUDE: ${mandatories}\n` : ''}${constraints ? `MUST NOT: ${constraints}\n` : ''}
${fgBlock}

BRAND VOICE PROFILE:
${trimTo(brain.voiceProfile, 1800)}

PERSONAS:
${trimTo((brain.personas || []).slice(0, 3), 1200)}

BRAIN PATTERNS — lean into these:
${brain.patterns.length ? trimTo(brain.patterns, 1400) : 'None yet.'}

BRAIN MISTAKES — avoid unconditionally:
${brain.mistakes.length ? trimTo(brain.mistakes, 1000) : 'None logged yet.'}

Return ONLY valid JSON matching the system prompt schema. Exactly ${variantCount} item(s) in variants.`;

    send('status', { message: `Drafting ${variantCount} variant${variantCount === 1 ? '' : 's'} with Sonnet…` });

    let fullText = '';
    const stream = await anthropic.messages.stream({
      model: SONNET,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        fullText += chunk.delta.text;
        // Lightweight progress crumb — not the full JSON stream (keeps UI calm)
        if (fullText.length % 400 < 20) {
          send('chunk', { chars: fullText.length });
        }
      }
    }

    let parsed;
    try {
      parsed = safeParseLLM(fullText, 'object', 'quick-copy');
    } catch (e) {
      console.error('[QUICK-COPY] Parse failed:', e.message);
      send('error', { message: 'Generation hit a formatting issue — try Generate again.' });
      cleanup();
      return res.end();
    }

    const labels = 'ABCDEFGH';
    const rawVariants = Array.isArray(parsed?.variants) ? parsed.variants : [];
    const variants = rawVariants.slice(0, variantCount).map((v, i) => ({
      id: `v${i}`,
      label: v?.label || labels[i] || String(i + 1),
      subject: v?.subject ?? null,
      preview: v?.preview ?? null,
      body: String(v?.body || '').trim(),
      cta: v?.cta ?? null,
      hook: v?.hook ?? null,
      confidence: typeof v?.confidence === 'number' ? v.confidence : null,
      confidenceReason: v?.confidenceReason || parsed?.overallNotes || null,
    })).filter((v) => v.body);

    if (!variants.length) {
      send('error', { message: 'No copy returned. Try again with a clearer prompt.' });
      cleanup();
      return res.end();
    }

    // Pad if model under-delivered (shouldn't, but don't 500 the UI)
    while (variants.length < variantCount && variants.length > 0) {
      // stop — better fewer good variants than duplicates
      break;
    }

    const overallConfidence = typeof parsed?.overallConfidence === 'number'
      ? parsed.overallConfidence
      : (variants[0].confidence ?? null);
    const notes = parsed?.notes || null;

    const insert = await pool.query(
      `INSERT INTO quick_copy_drafts (
         brand_profile_id, user_id, format, platform, prompt, source_text,
         audience, mandatories, constraints, length_hint, variant_count,
         variants_json, active_variant_idx, confidence, confidence_reason,
         brain_version, status, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15,'draft',$16)
       RETURNING id, created_at`,
      [
        brandProfileId,
        req.userId || null,
        format,
        plat,
        String(prompt).trim(),
        sourceText ? String(sourceText).trim() : null,
        audience || null,
        mandatories || null,
        constraints || null,
        lengthHint || null,
        variantCount,
        JSON.stringify(variants),
        overallConfidence,
        variants[0]?.confidenceReason || null,
        brain.profile.version || 1,
        notes,
      ]
    );

    const draftId = insert.rows[0].id;
    const createdAt = insert.rows[0].created_at;

    send('done', {
      id: draftId,
      format,
      platform: plat,
      variantCount,
      variants,
      confidence: overallConfidence,
      notes,
      createdAt,
    });

    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'stage4_quick_copy',
        brandProfileId,
        'success',
        (stream.usage?.input_tokens || 0) + (stream.usage?.output_tokens || 0),
        0,
      ]
    ).catch(() => {});

    cleanup();
    res.end();
  } catch (err) {
    console.error('[QUICK-COPY] Error:', err?.message || err);
    try { send('error', { message: err.message || 'Generation failed' }); } catch { /* closed */ }
    cleanup();
    res.end();
  }
});

// POST /api/quick-copy/:id/refine — regenerate / refine active variant set
router.post('/:id/refine', async (req, res) => {
  const { direction = '', freeText = '' } = req.body || {};
  try {
    await ensureQuickCopyTable();
    const draftRes = await pool.query(`SELECT * FROM quick_copy_drafts WHERE id = $1`, [req.params.id]);
    if (!draftRes.rows.length) return res.status(404).json({ success: false, error: 'Draft not found' });
    const draft = draftRes.rows[0];
    if (!(await verifyBrandAccess(draft.brand_profile_id, req.userId))) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const brain = await loadBrainContext(draft.brand_profile_id);
    if (!brain) return res.status(404).json({ success: false, error: 'Brand profile not found' });

    const variants = Array.isArray(draft.variants_json) ? draft.variants_json : [];
    const activeIdx = draft.active_variant_idx || 0;
    const base = variants[activeIdx] || variants[0];
    if (!base?.body) return res.status(400).json({ success: false, error: 'No base variant to refine' });

    const directionLabel = freeText?.trim()
      || ({
        shorter: 'Make it shorter and tighter',
        warmer: 'Make it warmer and more human',
        direct: 'Make it more direct and less padded',
        less_salesy: 'Dial back the sales energy',
      }[direction] || 'Improve clarity while keeping the intent');

    const systemPrompt = readSystemPrompt();
    const userPrompt = `${dateContext()}

Refine the following Quick Copy for brand "${brain.brandName}".
DIRECTION: ${directionLabel}

ORIGINAL:
"""
${base.subject ? `Subject: ${base.subject}\n` : ''}${base.body}
"""

FORMAT: ${draft.format}
PLATFORM: ${draft.platform || 'generic'}
ORIGINAL REQUEST: ${draft.prompt}
${factualGroundBlock(brain.factualGround)}

BRAND VOICE:
${trimTo(brain.voiceProfile, 1200)}

Return ONLY valid JSON with exactly 1 item in variants (the refined version). Keep format fields.`;

    const msg = await anthropic.messages.create({
      model: SONNET,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const raw = msg.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = safeParseLLM(raw, 'object', 'quick-copy-refine');
    } catch {
      return res.status(500).json({ success: false, error: 'Refine parse failed — try again' });
    }
    const refined = Array.isArray(parsed?.variants) ? parsed.variants[0] : null;
    if (!refined?.body) return res.status(500).json({ success: false, error: 'No refined body returned' });

    const nextVariant = {
      id: `v${variants.length}`,
      label: String.fromCharCode(65 + Math.min(variants.length, 25)),
      subject: refined.subject ?? base.subject ?? null,
      preview: refined.preview ?? base.preview ?? null,
      body: String(refined.body).trim(),
      cta: refined.cta ?? base.cta ?? null,
      hook: refined.hook ?? base.hook ?? null,
      confidence: typeof refined.confidence === 'number' ? refined.confidence : base.confidence,
      confidenceReason: refined.confidenceReason || `Refined: ${directionLabel}`,
    };
    const nextVariants = [...variants, nextVariant];
    const nextIdx = nextVariants.length - 1;

    await pool.query(
      `UPDATE quick_copy_drafts
          SET variants_json = $1,
              active_variant_idx = $2,
              compliance_json = NULL,
              status = 'edited',
              updated_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(nextVariants), nextIdx, draft.id]
    );

    res.json({ success: true, variants: nextVariants, activeVariantIdx: nextIdx, variant: nextVariant });
  } catch (err) {
    console.error('[QUICK-COPY] Refine error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/quick-copy/:id/check — on-demand lite compliance
router.post('/:id/check', async (req, res) => {
  const { variantIdx, body: bodyOverride } = req.body || {};
  try {
    await ensureQuickCopyTable();
    const draftRes = await pool.query(`SELECT * FROM quick_copy_drafts WHERE id = $1`, [req.params.id]);
    if (!draftRes.rows.length) return res.status(404).json({ success: false, error: 'Draft not found' });
    const draft = draftRes.rows[0];
    if (!(await verifyBrandAccess(draft.brand_profile_id, req.userId))) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const brain = await loadBrainContext(draft.brand_profile_id);
    if (!brain) return res.status(404).json({ success: false, error: 'Brand profile not found' });

    const variants = Array.isArray(draft.variants_json) ? draft.variants_json : [];
    const idx = Number.isInteger(variantIdx) ? variantIdx : (draft.active_variant_idx || 0);
    const variant = variants[idx] || variants[0];
    const body = (typeof bodyOverride === 'string' && bodyOverride.trim())
      ? bodyOverride
      : (variant?.body || '');
    if (!body.trim()) return res.status(400).json({ success: false, error: 'No body to check' });

    const fgBlock = factualGroundBlock(brain.factualGround);
    const system = `You are a lightweight compliance auditor for short brand copy (not long-form articles).
Flag ONLY issues that are explicitly present in the TEXT below.
Every flag MUST include an "excerpt" that is a VERBATIM substring of the text. If you cannot quote it exactly, do not flag it.
Do not invent problems. Prefer fewer, higher-signal flags.

Check for:
- factual_claim: numbers, outcomes, "#1/best/only", unverifiable proof
- legal_risk: guarantees, absolute promises, regulated overreach
- brand_voice: obvious voice drift vs the brand voice profile
- contradiction: conflicts with factual ground

Severity: "red" for factual/legal/contradiction; "yellow" for voice / soft issues.

Return ONLY JSON:
{
  "flags": [
    {
      "severity": "red" | "yellow",
      "type": "factual_claim" | "legal_risk" | "brand_voice" | "contradiction",
      "excerpt": "<exact substring from TEXT>",
      "reason": "<why>",
      "suggestion": "<how to fix>"
    }
  ],
  "summary": "<one sentence>"
}`;

    const user = `BRAND: ${brain.brandName}
${fgBlock}

BRAND VOICE (reference):
${trimTo(brain.voiceProfile, 1000)}

KNOWN MISTAKES (behavioral — do not cite as evidence of claims):
${brain.mistakes.map((m) => `- ${m.mistake_type}: ${m.description}`).join('\n') || 'None'}

TEXT TO AUDIT:
"""
${body}
"""`;

    const msg = await anthropic.messages.create({
      model: SONNET,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = msg.content?.[0]?.text || '{}';
    let parsed;
    try {
      parsed = safeParseLLM(raw, 'object', 'quick-copy-check');
    } catch {
      parsed = { flags: [], summary: 'Check completed but response was unreadable.' };
    }

    const flags = anchorComplianceFlags(body, parsed?.flags || []);
    const compliance = {
      checkedAt: new Date().toISOString(),
      variantIdx: idx,
      bodySnapshot: body,
      summary: parsed?.summary || (flags.length ? `${flags.length} issue(s) found` : 'Clean pass'),
      flags,
      dismissed: [],
    };

    await pool.query(
      `UPDATE quick_copy_drafts SET compliance_json = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(compliance), draft.id]
    );

    res.json({ success: true, compliance });
  } catch (err) {
    console.error('[QUICK-COPY] Check error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/quick-copy/:id — save edits / active variant / dismissals
router.patch('/:id', async (req, res) => {
  const {
    variants,
    activeVariantIdx,
    status,
    compliance,
  } = req.body || {};

  try {
    await ensureQuickCopyTable();
    const draftRes = await pool.query(`SELECT * FROM quick_copy_drafts WHERE id = $1`, [req.params.id]);
    if (!draftRes.rows.length) return res.status(404).json({ success: false, error: 'Draft not found' });
    const draft = draftRes.rows[0];
    if (!(await verifyBrandAccess(draft.brand_profile_id, req.userId))) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (variants !== undefined) {
      sets.push(`variants_json = $${i++}`);
      vals.push(JSON.stringify(variants));
      sets.push(`status = 'edited'`);
    }
    if (activeVariantIdx !== undefined) {
      sets.push(`active_variant_idx = $${i++}`);
      vals.push(activeVariantIdx);
    }
    if (status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(status);
    }
    if (compliance !== undefined) {
      sets.push(`compliance_json = $${i++}`);
      vals.push(JSON.stringify(compliance));
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No fields to update' });
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);

    const upd = await pool.query(
      `UPDATE quick_copy_drafts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    res.json({ success: true, draft: upd.rows[0] });
  } catch (err) {
    console.error('[QUICK-COPY] PATCH error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/quick-copy/history/:brandProfileId
router.get('/history/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }
  try {
    await ensureQuickCopyTable();
    const r = await pool.query(
      `SELECT id, format, platform, prompt, variant_count, variants_json,
              active_variant_idx, confidence, status, notes, created_at, updated_at
         FROM quick_copy_drafts
        WHERE brand_profile_id = $1
        ORDER BY created_at DESC
        LIMIT 30`,
      [brandProfileId]
    );
    const drafts = r.rows.map((row) => {
      const variants = Array.isArray(row.variants_json) ? row.variants_json : [];
      const active = variants[row.active_variant_idx || 0] || variants[0] || null;
      return {
        id: row.id,
        format: row.format,
        platform: row.platform,
        prompt: row.prompt,
        variantCount: row.variant_count,
        preview: active?.body ? String(active.body).slice(0, 140) : '',
        confidence: row.confidence,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    res.json({ success: true, drafts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/quick-copy/:id
router.get('/:id', async (req, res) => {
  try {
    await ensureQuickCopyTable();
    const r = await pool.query(`SELECT * FROM quick_copy_drafts WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Draft not found' });
    const draft = r.rows[0];
    if (!(await verifyBrandAccess(draft.brand_profile_id, req.userId))) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/quick-copy/:id
router.delete('/:id', async (req, res) => {
  try {
    await ensureQuickCopyTable();
    const r = await pool.query(`SELECT brand_profile_id FROM quick_copy_drafts WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Draft not found' });
    if (!(await verifyBrandAccess(r.rows[0].brand_profile_id, req.userId))) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    await pool.query(`DELETE FROM quick_copy_drafts WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
