// Dedicated The Post → Forge Intelligence card-generation endpoint.
// Contract: docs in The Post repo docs/contracts/forge-card-gen.md
// NOT the generic publishing path. Token-gated M2M only.
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { anthropic } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';
import { pool } from '../db.js';
import {
  validateRejectReasons,
  formatRejectBrainFeedback,
  REJECT_REASON_CODES,
  REJECT_REASON_LABELS,
} from '../reject-reasons.js';

const router = express.Router();
const PROMPT_VERSION = 'the-post-card-gen-v2';
// inventory: POST /api/external/the-post/card-gen
const MODEL = process.env.THE_POST_CARD_GEN_MODEL || 'claude-haiku-4-5-20251001';

function serviceTokenOk(req) {
  const expected =
    process.env.THE_POST_SERVICE_TOKEN ||
    process.env.MAILFORGE_SERVICE_TOKEN ||
    '';
  if (!expected) return { ok: false, status: 503, error: 'service token not configured' };
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length !== expected.length) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  try {
    const match = timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!match) return { ok: false, status: 401, error: 'unauthorized' };
  } catch {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function normalizeResponse(raw, session) {
  const title = clip(raw?.title || session?.title || 'Untitled session', 200);
  const summary = clip(raw?.summary || session?.abstract || '', 1200);
  const quotes = Array.isArray(raw?.quotes)
    ? raw.quotes.map((q) => clip(q, 280)).filter(Boolean).slice(0, 5)
    : [];
  const tags = Array.isArray(raw?.tags)
    ? [...new Set(raw.tags.map((t) => clip(t, 40).toLowerCase()).filter(Boolean))].slice(0, 10)
    : [];
  let qna = Array.isArray(raw?.qna) ? raw.qna : [];
  qna = qna
    .map((item) => ({
      question: clip(item?.question || '', 240),
      answer: item?.answer == null || item?.answer === '' ? null : clip(item.answer, 600),
    }))
    .filter((item) => item.question)
    .slice(0, 6);

  let confidence = Number(raw?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  // One decimal-ish stability
  confidence = Math.round(confidence * 100) / 100;

  return { title, summary, quotes, tags, qna, confidence };
}

function heuristicConfidence(session, excerpts, out) {
  let c = 0.45;
  const abstract = String(session?.abstract || '');
  const excerptChars = (excerpts || []).reduce((n, e) => n + String(e?.text || '').length, 0);
  if (abstract.length > 80) c += 0.1;
  if (excerptChars > 400) c += 0.15;
  if (excerptChars > 1500) c += 0.1;
  if ((session?.speakers || []).length) c += 0.05;
  if ((out.quotes || []).length >= 2) c += 0.05;
  if ((out.qna || []).length >= 1 && out.qna[0].answer) c += 0.05;
  if (!out.summary || out.summary.length < 40) c -= 0.15;
  return Math.max(0.15, Math.min(0.95, Math.round(c * 100) / 100));
}


async function loadBrandBrainForCardGen(brandProfileId, { limit = 12 } = {}) {
  if (!brandProfileId || !pool) return { patterns: [], mistakes: [] };
  try {
    const [pRes, mRes] = await Promise.all([
      pool.query(
        `SELECT pattern_type, description, confidence_score, success_rate
           FROM brain_patterns
          WHERE brand_profile_id = $1
          ORDER BY COALESCE(success_rate, 0) DESC, COALESCE(confidence_score, 0) DESC, created_at DESC
          LIMIT $2`,
        [brandProfileId, limit]
      ),
      pool.query(
        `SELECT mistake_type, description, human_feedback, severity
           FROM brain_mistakes
          WHERE brand_profile_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [brandProfileId, limit]
      ),
    ]);
    return { patterns: pRes.rows || [], mistakes: mRes.rows || [] };
  } catch (e) {
    console.warn('[the-post/card-gen] brain load failed', e.message);
    return { patterns: [], mistakes: [] };
  }
}


function formatPreferenceExamples(pref) {
  if (!pref || typeof pref !== 'object') return '';
  const good = Array.isArray(pref.good) ? pref.good : [];
  const bad = Array.isArray(pref.bad) ? pref.bad : [];
  const edits = Array.isArray(pref.edits) ? pref.edits : [];
  const rules = Array.isArray(pref.rules) ? pref.rules : [];
  if (!good.length && !bad.length && !edits.length && !rules.length) return '';

  const lines = [
    'POST ORGANIZER PREFERENCES (org-scoped human judgments — highest priority after session truth):',
    'These are from THIS client\'s approve/reject/edit history. Obey them for this generation.',
  ];
  if (rules.length) {
    lines.push('Active rules:');
    for (const r of rules.slice(0, 6)) {
      lines.push(`- [${r.code || 'rule'}] ${clip(r.guidance || '', 200)}`);
    }
  }
  if (good.length) {
    lines.push('Write MORE like these approved cards:');
    for (const g of good.slice(0, 5)) {
      lines.push(`- TITLE: ${clip(g.title || '', 120)}`);
      if (g.summary) lines.push(`  SUMMARY: ${clip(g.summary, 280)}`);
    }
  }
  if (bad.length) {
    lines.push('Do NOT write like these rejected cards:');
    for (const b of bad.slice(0, 5)) {
      const why = [b.reason_code, b.reason_note].filter(Boolean).join(' — ');
      lines.push(`- TITLE: ${clip(b.title || '', 120)}${why ? ` (${clip(why, 120)})` : ''}`);
      if (b.summary) lines.push(`  SUMMARY: ${clip(b.summary, 220)}`);
    }
  }
  if (edits.length) {
    lines.push('When you see avoid→prefer edits, match the prefer side:');
    for (const e of edits.slice(0, 4)) {
      lines.push(`- AVOID summary: ${clip(e.before_summary || '', 160)}`);
      lines.push(`  PREFER summary: ${clip(e.after_summary || '', 160)}`);
    }
  }
  return lines.join('\n');
}

function formatBrainBlock(brain) {
  const patterns = brain?.patterns || [];
  const mistakes = brain?.mistakes || [];
  if (!patterns.length && !mistakes.length) return '';
  const lines = ['ACTIVE BRAND BRAIN (editorial signals — obey these):'];
  if (patterns.length) {
    lines.push('Patterns / writing rules (prefer):');
    for (const p of patterns.slice(0, 12)) {
      lines.push(`- [${p.pattern_type || 'pattern'}] ${clip(p.description || '', 320)}`);
    }
  }
  if (mistakes.length) {
    lines.push('Mistakes / rejects (avoid):');
    for (const m of mistakes.slice(0, 20)) {
      // human_feedback carries avoid→prefer pairs up to ~830 chars; clipping it
      // short drops the "prefer" correction, so keep the full pair intact here.
      const fb = m.human_feedback ? ` → ${clip(m.human_feedback, 850)}` : '';
      lines.push(`- [${m.mistake_type || 'mistake'}] ${clip(m.description || '', 300)}${fb}`);
    }
  }
  return lines.join('\n');
}

router.post('/card-gen', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const body = req.body || {};
  const session = body.session || {};
  const eventContext = body.event_context || body.eventContext || null;
  const desired = Array.isArray(body.desired) && body.desired.length
    ? body.desired
    : ['title', 'summary', 'quotes', 'tags', 'qna'];
  const excerpts = Array.isArray(body.source_excerpts) ? body.source_excerpts.slice(0, 8) : [];
  const brandProfileId =
    body.brand_profile_id ||
    body.brandProfileId ||
    eventContext?.brand_profile_id ||
    eventContext?.brand_profile?.id ||
    null;
  // Post-owned learnings (preferred). FI brand brain is optional fallback only.
  const preferenceExamples =
    body.preference_examples || body.preferenceExamples || null;
  const prefBlock = formatPreferenceExamples(preferenceExamples);
  const useFiBrain =
    !prefBlock &&
    brandProfileId &&
    String(process.env.THE_POST_USE_FI_BRAIN || '').trim() === '1';
  const brain = useFiBrain
    ? await loadBrandBrainForCardGen(brandProfileId)
    : { patterns: [], mistakes: [] };
  const brainBlock = useFiBrain ? formatBrainBlock(brain) : '';
  const learningBlock = [prefBlock, brainBlock].filter(Boolean).join('\n\n');

  if (!session.title && !session.abstract && excerpts.length === 0) {
    return res.status(400).json({ error: 'session or source_excerpts required' });
  }

  const speakers = (session.speakers || [])
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean);

  const excerptBlock = excerpts
    .map((e, i) => {
      const typ = e?.type || 'note';
      const text = clip(e?.text || '', 3500);
      return text ? `[${i + 1} ${typ}]\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const bp = eventContext?.brand_profile || {};
  const ns = eventContext?.north_star || {};
  const prog = eventContext?.programming || {};
  const pub = eventContext?.publication || {};
  const tracks = Array.isArray(prog.tracks)
    ? prog.tracks.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
    : [];
  const thinContext =
    !ns.thesis ||
    !(bp.name || bp.one_liner || (bp.voice && (bp.voice.tone || bp.voice.do))) ||
    (!(tracks.length) && !prog.agenda_summary);

  const contextBlock = eventContext
    ? `EVENT CORE CONTEXT (higher priority than session fluff):
Brand: ${clip(bp.name || '', 120)} | ${clip(bp.one_liner || '', 240)}
Audience: ${clip(bp.audience || '', 240)}
Voice tone: ${clip(JSON.stringify(bp.voice?.tone || []), 200)}
Voice DO: ${clip(JSON.stringify(bp.voice?.do || []), 400)}
Voice DONT: ${clip(JSON.stringify(bp.voice?.dont || bp.voice?.donts || []), 400)}
Claims OK: ${clip(JSON.stringify(bp.claims_ok || []), 400)}
Claims AVOID: ${clip(JSON.stringify(bp.claims_avoid || []), 400)}
North Star thesis: ${clip(ns.thesis || '', 600)}
Themes: ${clip(JSON.stringify(ns.themes || []), 300)}
Success looks like: ${clip(ns.success_looks_like || '', 300)}
Narrative arc: ${clip(ns.narrative_arc || '', 300)}
Event DO NOT: ${clip(JSON.stringify(ns.do_not || []), 400)}
Programming tracks: ${clip(JSON.stringify(tracks), 300)}
Agenda summary: ${clip(prog.agenda_summary || '', 500)}
Speaker notes: ${clip(prog.speaker_notes || '', 300)}
Publication default visibility: ${clip(pub.default_visibility || '', 40)}
Public bias: ${clip(pub.public_bias || '', 240)}
Context completeness: ${thinContext ? 'THIN — keep confidence conservative (<0.7 unless excerpts are rich)' : 'RICH'}`
    : 'EVENT CORE CONTEXT: (none provided — keep confidence conservative; do not invent event strategy)';

  const system = `You generate approval-queue content cards for post-event hubs (The Post).
Return ONLY valid JSON with keys: title, summary, quotes, tags, qna, confidence.
You are a packager of what happened, not a topic strategist. Do not invent sessions or agenda.
When EVENT CORE CONTEXT is present it outranks generic session wording:
1) Frame every summary through the North Star thesis and themes.
2) Obey brand voice do/dont and claims_avoid absolutely.
3) Prefer programming track taxonomy for tags when it fits.
4) Respect publication public_bias if the card might be public-facing.
Rules:
- title: specific, editorial, max ~120 chars. Prefer session truth over hype.
- summary: 1 tight paragraph (2-4 sentences) of what happened / why it matters for attendees, on-thesis. No fluff openers.
- quotes: 0-5 short pull quotes grounded in provided source text. Invent none if sources are thin.
- tags: 3-8 lowercase topical tags.
- qna: 1-4 structured {question, answer} items. Answers null if not supported by sources.
- confidence: 0-1 reflecting source richness + factual grounding + context completeness. Be honest; thin input or thin event context must stay lower.
- Sentence case. No emoji. No markdown.
- Do NOT invent speakers, stats, or claims absent from the input + event context.
- When POST ORGANIZER PREFERENCES are present: they outrank generic style; match approved examples; never repeat rejected patterns/reasons.
- When ACTIVE BRAND BRAIN is present (legacy): follow Patterns; never repeat Mistakes/rejects.
Desired fields: ${desired.join(', ')}.
Prompt version: ${PROMPT_VERSION}.`;

  const user = `Event id: ${body.event_id || 'n/a'}

${contextBlock}

Session title: ${session.title || ''}
Track: ${session.track || ''}
Speakers: ${speakers.join(', ') || '(none)'}
Abstract/notes: ${clip(session.abstract || session.notes || '', 2500)}

Source excerpts:
${excerptBlock || '(none)'}

${learningBlock ? learningBlock + '\n\n' : ''}Produce the JSON card now.`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1200,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    let parsed = safeParseLLM(text);
    if (!parsed || typeof parsed !== 'object') {
      // last-ditch extract JSON object
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({ error: 'model returned non-JSON', raw: clip(text, 400) });
    }

    const out = normalizeResponse(parsed, session);
    if (!Number.isFinite(Number(parsed.confidence))) {
      out.confidence = heuristicConfidence(session, excerpts, out);
    }
    if (thinContext && out.confidence > 0.7) out.confidence = 0.7;

    return res.json({
      ...out,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      usage: msg.usage || null,
      event_context_thin: thinContext,
      preferences: preferenceExamples
        ? {
            good: (preferenceExamples.good || []).length,
            bad: (preferenceExamples.bad || []).length,
            edits: (preferenceExamples.edits || []).length,
            rules: (preferenceExamples.rules || []).length,
            meta: preferenceExamples.meta || null,
          }
        : null,
      brain: {
        brand_profile_id: brandProfileId || null,
        used: !!useFiBrain,
        patterns: (brain.patterns || []).length,
        mistakes: (brain.mistakes || []).length,
      },
    });
  } catch (err) {
    console.error('[the-post/card-gen]', err.message);
    return res.status(500).json({ error: err.message || 'card-gen failed' });
  }
});


// POST /decision — The Post (or other M2M) writes approve/reject into brand brain.
// Reject requires a typed reason code (same taxonomy as Compliance Gate).
router.post('/decision', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const body = req.body || {};
  const brandProfileId = body.brand_profile_id || body.brandProfileId;
  const decision = String(body.decision || '').toLowerCase();
  if (!brandProfileId) return res.status(400).json({ error: 'brand_profile_id required' });
  if (!['approved', 'rejected', 'approve', 'reject', 'edited', 'dismissed'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved|rejected|edited|dismissed' });
  }
  const isReject = decision === 'rejected' || decision === 'reject';

  // edited — operator rewrote copy in The Post review UI. Same learning write as the
  // Compliance Gate approve-with-edits path: "Avoid old — prefer new" into brain_mistakes.
  if (decision === 'edited') {
    const originalText = clip(body.original_text || body.originalText || '', 400);
    const editedText = clip(body.edited_text || body.editedText || '', 400);
    if (!originalText || !editedText) {
      return res.status(400).json({ error: 'edited decision requires original_text and edited_text' });
    }
    const heading = clip(body.section_heading || body.sectionHeading || body.title || 'untitled', 200);
    const source = clip(body.source_label || body.event_id || body.eventId || 'the-post', 120);
    try {
      await pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
         VALUES ($1, 'human_edit', $2, $3, 'medium')`,
        [
          brandProfileId,
          `The Post longform: section "${heading}" edited by reviewer [${source}]`,
          `Avoid: "${originalText}" — prefer: "${editedText}"`,
        ]
      );
      return res.json({ success: true, wrote: 'brain_mistakes', mistake_type: 'human_edit' });
    } catch (e) {
      console.error('[the-post/decision:edited]', e.message);
      return res.status(500).json({ error: e.message || 'decision write failed' });
    }
  }

  // dismissed — operator says a compliance flag was a false positive. Typed reasons
  // mirror the Stage 5 dismiss-flag taxonomy; each teaches a different suppression.
  if (decision === 'dismissed') {
    const DISMISS_REASONS = ['verified_nameable', 'verified_unnameable', 'intentional_style'];
    const dismissReason = String(body.reason_code || body.reasonCode || body.reason || '').trim();
    if (!DISMISS_REASONS.includes(dismissReason)) {
      return res.status(400).json({
        error: `dismissed decision requires reason_code (${DISMISS_REASONS.join(', ')})`,
        allowedReasons: DISMISS_REASONS,
      });
    }
    const heading = clip(body.section_heading || body.sectionHeading || body.title || 'untitled', 200);
    const flagType = clip(body.flag_type || body.flagType || 'unknown', 60);
    const excerpt = clip(body.flagged_excerpt || body.flaggedExcerpt || body.surface || '', 300);
    const note = clip(body.reason_note || body.reasonNote || body.note || '', 500);
    const where = `The Post longform section "${heading}" flagged as ${flagType}`;
    const signal =
      dismissReason === 'verified_unnameable'
        ? {
            type: 'verified_unnameable',
            description: `Claim in ${where} is VERIFIED but contractually unnameable (NDA/redacted) — promoted to Factual Ground redactedFacts.`,
            feedback: `This claim is TRUE and owner-attested; only the client/proper-noun is redacted by contract. Score it high-confidence-redacted, do NOT flag it as an unverifiable factual_claim, and NEVER suggest naming the underlying party. Surface phrasing: "${excerpt}".`,
          }
        : dismissReason === 'verified_nameable'
          ? {
              type: 'verified_fact',
              description: `Claim in ${where} is a VERIFIED, nameable fact — owner dismissed as false positive.`,
              feedback: `Verified fact for this brand. Do NOT flag similar claims as unverifiable in future critiques. Excerpt: "${excerpt}".${note ? ` Note: ${note}` : ''}`,
            }
          : {
              type: 'intentional_style',
              description: `Flag in ${where} was a voice/style choice, not a factual claim — owner dismissed.`,
              feedback: `This is an intentional voice/style construction, not a factual assertion. Do NOT treat or flag it as a factual_claim in future critiques for this brand.${note ? ` Note: ${note}` : ''}`,
            };
    try {
      await pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
         VALUES ($1, $2, $3, $4, 'low')`,
        [brandProfileId, signal.type, signal.description, signal.feedback]
      );
      // verified_unnameable also promotes to Factual Ground so Stage-4/longform
      // generation stops scoring this claim low on every future piece.
      let redactedFactAdded = false;
      if (dismissReason === 'verified_unnameable' && excerpt) {
        const brandRes = await pool.query('SELECT settings FROM brand_profiles WHERE id = $1', [brandProfileId]);
        if (brandRes.rows.length) {
          const settings = brandRes.rows[0].settings || {};
          const fg = settings.factualGround || {};
          const existing = Array.isArray(fg.redactedFacts) ? fg.redactedFacts : [];
          const dup = existing.some(
            (r) => String(r?.surface || '').trim().toLowerCase() === excerpt.trim().toLowerCase()
          );
          if (!dup) {
            existing.push({ surface: excerpt, source: 'the-post-dismiss', addedAt: new Date().toISOString() });
            fg.redactedFacts = existing;
            settings.factualGround = fg;
            await pool.query('UPDATE brand_profiles SET settings = $1 WHERE id = $2', [settings, brandProfileId]);
            redactedFactAdded = true;
          }
        }
      }
      return res.json({
        success: true,
        wrote: 'brain_mistakes',
        mistake_type: signal.type,
        redacted_fact_added: redactedFactAdded,
      });
    } catch (e) {
      console.error('[the-post/decision:dismissed]', e.message);
      return res.status(500).json({ error: e.message || 'decision write failed' });
    }
  }

  let reasonCode = body.reason_code || body.reasonCode || body.reason || '';
  let reasonNote = body.reason_note || body.reasonNote || body.note || '';
  if (isReject) {
    const check = validateRejectReasons(
      { 0: 'rejected' },
      { 0: { code: reasonCode, note: reasonNote } }
    );
    if (!check.ok) {
      return res.status(400).json({
        error: check.error,
        code: check.code,
        allowedReasons: REJECT_REASON_CODES,
      });
    }
    reasonCode = check.rejected[0].code;
    reasonNote = check.rejected[0].note;
  }

  const title = clip(body.title || body.card?.title || 'card', 200);
  const summary = clip(body.summary || body.card?.summary || '', 400);
  const source = clip(body.source_label || body.event_id || body.eventId || 'the-post', 120);
  const confidence = body.confidence != null ? Number(body.confidence) : null;

  try {
    if (isReject) {
      const label = REJECT_REASON_LABELS[reasonCode] || reasonCode;
      await pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          brandProfileId,
          `post_reject:${reasonCode}`,
          `The Post REJECT "${title}"${summary ? `: "${summary}"` : ''} [${source}]`,
          formatRejectBrainFeedback({
            code: reasonCode,
            label,
            note: reasonNote,
            flagReason: confidence != null ? `model confidence ${confidence}` : '',
            sectionHeading: title,
          }),
          reasonCode === 'legal_risk' || reasonCode === 'nda_risk' ? 'high' : 'medium',
        ]
      );
      return res.json({ success: true, wrote: 'brain_mistakes', reason_code: reasonCode });
    }

    // approve → positive pattern (light signal)
    await pool.query(
      `INSERT INTO brain_patterns (brand_profile_id, pattern_type, description, confidence_score, tags)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        brandProfileId,
        'post_approved_card',
        `Approved card style: "${title}"${summary ? ` — ${summary}` : ''}`,
        Number.isFinite(confidence) ? confidence : 0.7,
        JSON.stringify({ source: 'the-post', event_id: body.event_id || body.eventId || null }),
      ]
    );
    return res.json({ success: true, wrote: 'brain_patterns' });
  } catch (e) {
    console.error('[the-post/decision]', e.message);
    return res.status(500).json({ error: e.message || 'decision write failed' });
  }
});

router.get('/reject-reasons', (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  res.json({
    reasons: REJECT_REASON_CODES.map((code) => ({
      code,
      label: REJECT_REASON_LABELS[code],
    })),
  });
});


// ── Event longform (articles + white papers) ─────────────────────────────────
// Contract: The Post docs/contracts/event-longform.md
// inventory: POST /api/external/the-post/topic-check
// inventory: POST /api/external/the-post/longform-gen
const LONGFORM_PROMPT_VERSION = 'the-post-longform-v3';
const LONGFORM_MODEL = process.env.THE_POST_LONGFORM_MODEL || 'claude-sonnet-4-5-20250929';

function normalizeLongformKind(k) {
  const v = String(k || 'article').toLowerCase().replace(/\s+/g, '_');
  if (v === 'whitepaper' || v === 'white_paper' || v === 'wp') return 'white_paper';
  return 'article';
}

function sectionsToPlain(sections) {
  if (!Array.isArray(sections)) return '';
  return sections
    .map((s) => {
      const h = clip(s?.heading || '', 200);
      const b = String(s?.body || s?.content || '').trim();
      return h ? `## ${h}\n\n${b}` : b;
    })
    .filter(Boolean)
    .join('\n\n');
}

function normalizeLongform(raw, { kind, topic }) {
  const title = clip(raw?.title || topic || 'Untitled', 200);
  const metaDescription = clip(raw?.metaDescription || raw?.meta_description || '', 160);
  const keyTakeaway = clip(raw?.keyTakeaway || raw?.key_takeaway || raw?.summary || '', 900);
  const sections = Array.isArray(raw?.sections)
    ? raw.sections
        .map((s, i) => ({
          id: clip(s?.id || `section-${i + 1}`, 80) || `section-${i + 1}`,
          heading: clip(s?.heading || '', 200),
          body: String(s?.body || s?.content || '').trim(),
          confidence: Number.isFinite(Number(s?.confidence)) ? Number(s.confidence) : null,
          confidenceTier: clip(s?.confidenceTier || s?.confidence_tier || '', 20) || null,
        }))
        .filter((s) => s.body)
        .slice(0, kind === 'white_paper' ? 14 : 10)
    : [];
  const faqs = Array.isArray(raw?.faqs || raw?.qna)
    ? (raw.faqs || raw.qna)
        .map((f) => ({
          question: clip(f?.question || '', 240),
          answer: f?.answer == null || f?.answer === '' ? null : clip(f.answer, 900),
        }))
        .filter((f) => f.question)
        .slice(0, 8)
    : [];
  let overall = Number(raw?.overallConfidence ?? raw?.overall_confidence ?? raw?.confidence);
  if (Number.isFinite(overall) && overall <= 1) overall = Math.round(overall * 100);
  if (!Number.isFinite(overall)) {
    const avg = sections
      .map((s) => s.confidence)
      .filter((n) => Number.isFinite(n));
    overall = avg.length ? Math.round(avg.reduce((a, b) => a + b, 0) / avg.length) : 62;
  }
  overall = Math.max(0, Math.min(100, Math.round(overall)));
  const brainMatch = Number(raw?.brainMatchScore ?? raw?.brain_match_score);
  const estimatedReadTime = clip(raw?.estimatedReadTime || raw?.estimated_read_time || '', 40);
  const authorBlock = raw?.authorBlock && typeof raw.authorBlock === 'object' ? raw.authorBlock : null;
  const bodyMarkdown = sectionsToPlain(sections);
  const wordCount = bodyMarkdown.split(/\s+/).filter(Boolean).length;
  return {
    kind,
    title,
    metaDescription,
    keyTakeaway,
    estimatedReadTime: estimatedReadTime || (wordCount ? `${Math.max(1, Math.round(wordCount / 220))} min read` : null),
    overallConfidence: overall,
    confidence: Math.round((overall / 100) * 100) / 100,
    sections,
    faqs,
    authorBlock,
    citationOpportunities: Array.isArray(raw?.citationOpportunities)
      ? raw.citationOpportunities.map((c) => clip(c, 200)).filter(Boolean).slice(0, 12)
      : [],
    brainMatchScore: Number.isFinite(brainMatch) ? Math.max(0, Math.min(100, Math.round(brainMatch))) : null,
    bodyMarkdown,
    wordCount,
  };
}

router.post('/topic-check', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const body = req.body || {};
  const topic = String(body.topic || body.thesis || '').trim();
  const brandProfileId =
    body.brand_profile_id || body.brandProfileId || body.event_context?.brand_profile_id || null;
  const nsThesis = body.event_context?.north_star?.thesis || body.north_star?.thesis || '';
  if (!topic) return res.status(400).json({ error: 'topic required' });

  try {
    let patterns = [];
    let mistakes = [];
    if (brandProfileId) {
      const brain = await loadBrandBrainForCardGen(brandProfileId, { limit: 8 });
      patterns = brain.patterns || [];
      mistakes = brain.mistakes || [];
    }

    if (!patterns.length && !mistakes.length && !nsThesis) {
      return res.json({
        success: true,
        signal: 'strong',
        confidence: 'No prior data',
        reason:
          'No brand brain patterns yet and no event North Star on hand. Proceed, but expect a thinner voice match until Event Brain is filled.',
        reframe: null,
        reframeRationale: null,
      });
    }

    const prompt = `You are a content strategy advisor for a B2B brand writing event-tied longform for a post-event hub (The Post).
A user wants to write about this topic:
"${topic}"

Event North Star thesis (if any):
${nsThesis || '(none)'}

Brand brain patterns (what works):
${patterns.map((p) => `- [${p.pattern_type}] ${p.description}`).join('\n') || 'None yet'}

Brand brain mistakes (what underperforms):
${mistakes.map((m) => `- [${m.severity || 'med'}] ${m.mistake_type}: ${m.description}`).join('\n') || 'None yet'}

Evaluate the topic for brand + event fit. Return ONLY JSON:
{
  "signal": "strong" | "caution" | "weak",
  "confidence": "one short phrase like '92% alignment' or 'Low confidence'",
  "reason": "2-3 sentences on fit vs brand patterns and North Star",
  "reframe": "If caution/weak: ONLY a better topic phrase. If strong: null",
  "reframeRationale": "If reframe set: 1-2 sentences why. Else null"
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    let parsed = safeParseLLM(text, 'object', 'the-post-topic-check');
    if (!parsed || typeof parsed !== 'object') {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed?.signal) {
      return res.json({
        success: true,
        signal: 'strong',
        confidence: 'Check unavailable',
        reason: 'Could not evaluate topic against brain data right now. Proceed with generation.',
        reframe: null,
        reframeRationale: null,
      });
    }
    return res.json({
      success: true,
      signal: parsed.signal,
      confidence: parsed.confidence || '',
      reason: parsed.reason || '',
      reframe: parsed.reframe || null,
      reframeRationale: parsed.reframeRationale || null,
      model: 'claude-haiku-4-5-20251001',
    });
  } catch (e) {
    console.error('[the-post/topic-check]', e.message);
    return res.json({
      success: true,
      signal: 'strong',
      confidence: 'Check unavailable',
      reason: 'Could not evaluate topic against brain data right now. Proceed with generation.',
      reframe: null,
      reframeRationale: null,
    });
  }
});

router.post('/longform-gen', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const body = req.body || {};
  const kind = normalizeLongformKind(body.kind || body.subtype || 'article');
  const topic = String(body.topic || body.thesis || body.topicPrompt || '').trim();
  if (!topic) return res.status(400).json({ error: 'topic required' });

  const eventContext = body.event_context || body.eventContext || null;
  const brandProfileId =
    body.brand_profile_id ||
    body.brandProfileId ||
    eventContext?.brand_profile_id ||
    eventContext?.brand_profile?.id ||
    eventContext?.brand_profile?.fi_brand_profile_id ||
    null;
  const mandatories = String(body.mandatories || '').trim();
  const constraints = String(body.constraints || '').trim();
  const audience = String(body.audience || body.target_audience || '').trim();
  const ctaTarget = String(body.ctaTarget || body.cta_target || body.cta || '').trim();
  const desiredAction = String(body.desiredAction || body.desired_action || '').trim();
  const wordCountTarget = String(
    body.wordCountTarget ||
      body.word_count_target ||
      (kind === 'white_paper' ? '2200' : '1400')
  ).trim();
  const writingAs = String(body.writingAs || body.writing_as || '').trim() || null;

  const preferenceExamples = body.preference_examples || body.preferenceExamples || null;
  const prefBlock = formatPreferenceExamples(preferenceExamples);

  let profileData = {};
  let brandName = '';
  let factualGround = null;
  if (brandProfileId) {
    try {
      const pr = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (pr.rows[0]) {
        profileData = pr.rows[0].profile_data || {};
        brandName = profileData.brand_name || pr.rows[0].brand_name || '';
        factualGround = pr.rows[0].settings?.factualGround || null;
      }
    } catch (e) {
      console.warn('[the-post/longform-gen] brand load failed', e.message);
    }
  }

  // Same 20-mistake window the critique pass reads — writer/critic parity.
  const brain = brandProfileId
    ? await loadBrandBrainForCardGen(brandProfileId, { limit: 20 })
    : { patterns: [], mistakes: [] };
  const brainBlock = formatBrainBlock(brain);

  const bp = eventContext?.brand_profile || {};
  const ns = eventContext?.north_star || {};
  const prog = eventContext?.programming || {};
  const pub = eventContext?.publication || {};
  if (!brandName) brandName = bp.name || '';

  const lengthGuide =
    kind === 'white_paper'
      ? `WHITE PAPER mode: target ~${wordCountTarget || 2200} words. Structure: executive summary section first, then problem framing, framework/approach, evidence, implementation guidance, risks/limits, close. More formal, denser, fewer rhetorical flourishes than a blog article.`
      : `ARTICLE mode: target ~${wordCountTarget || 1400} words. Hub-native longform: scannable H2s, strong keyTakeaway, practical and observational rather than generic how-to listicles.`;

  const system = `You generate event-tied longform for The Post (post-event knowledge hub).
Return ONLY valid JSON (no markdown fences) with this shape:
{
  "title": string,
  "metaDescription": string (max 155 chars, complete),
  "keyTakeaway": string (40-80 words TL;DR — mandatory),
  "estimatedReadTime": "X min read",
  "overallConfidence": 0-100,
  "sections": [{"id":"slug","heading":"...","body":"...","confidence":0-100,"confidenceTier":"green|yellow|red","confidenceReason":"..."}],
  "faqs": [{"question":"...","answer":"..."}],
  "authorBlock": {"suggestedByline":"..."},
  "citationOpportunities": [string],
  "brainMatchScore": 0-100
}

${lengthGuide}

Hard rules:
- Sentence case. No emoji. ZERO em dashes (U+2014) and no en dashes used as em-dash substitutes.
- Do not invent prices, customer names, stats, credentials, or product claims absent from context.
- ATTRIBUTE, don't genericize: when a capability, technology, or scenario you describe is covered by CLAIMS OK, the brand profile's named products/technologies, or brand voice DO phrases, name the brand's product/technology instead of describing it generically. Vendor-neutral phrasing where the brand has a named offering is a brand-voice failure. Still never introduce names or claims absent from the provided context.
- Concrete figures (performance numbers, latencies, throughput, percentages, prices, dates) ONLY when they appear in the provided context (Factual Ground, CLAIMS OK, brand profile, event context) — and attribute them inline to that source. If no sourced figure exists, describe the capability qualitatively; never invent, approximate, or "illustrate" with a specific number.
- Obey brand voice do/dont and claims_avoid when provided. Voice DO phrases are placement requirements, not suggestions.
- Frame through the event North Star thesis when present — this piece lives under that event. If the North Star or brand voice calls for partnership/engagement signals, work them into section closes and the final section.
- FAQs: 4-6 standalone Q&A drawn from the body.
- keyTakeaway is mandatory and must stand alone.
- If USER MANDATORIES/CONSTRAINTS are present they outrank style preferences.
- Post organizer preferences (if present) outrank generic style.
Prompt version: ${LONGFORM_PROMPT_VERSION}.`;

  const fgBlock =
    factualGround && typeof factualGround === 'object'
      ? `FACTUAL GROUND (verbatim source of truth for company claims):
${JSON.stringify(factualGround).slice(0, 6000)}`
      : '';

  const user = `Event id: ${body.event_id || body.eventId || 'n/a'}
Longform kind: ${kind}
TOPIC / THESIS (non-negotiable subject of the piece):
"${topic}"

EVENT CORE CONTEXT:
Brand: ${clip(bp.name || brandName || '', 120)} | ${clip(bp.one_liner || '', 240)}
Audience: ${clip(bp.audience || audience || '', 240)}
Voice tone: ${clip(JSON.stringify(bp.voice?.tone || []), 300)}
Voice DO: ${clip(JSON.stringify(bp.voice?.do || []), 1200)}
Voice DONT: ${clip(JSON.stringify(bp.voice?.dont || bp.voice?.donts || []), 1200)}
Claims OK: ${clip(JSON.stringify(bp.claims_ok || []), 1200)}
Claims AVOID: ${clip(JSON.stringify(bp.claims_avoid || []), 1200)}
North Star thesis: ${clip(ns.thesis || '', 1000)}
Themes: ${clip(JSON.stringify(ns.themes || []), 400)}
Success looks like: ${clip(ns.success_looks_like || '', 400)}
Event DO NOT: ${clip(JSON.stringify(ns.do_not || []), 800)}
Agenda summary: ${clip(prog.agenda_summary || '', 500)}
Publication default visibility: ${clip(pub.default_visibility || '', 40)}
Public bias: ${clip(pub.public_bias || '', 240)}

USER DIRECTION:
${mandatories ? `MANDATORIES (must include): ${mandatories}\n` : ''}${
    constraints ? `CONSTRAINTS (must NOT): ${constraints}\n` : ''
  }${audience ? `TARGET AUDIENCE: ${audience}\n` : ''}${
    ctaTarget ? `CTA TARGET: ${ctaTarget}\n` : ''
  }${desiredAction ? `DESIRED READER ACTION: ${desiredAction}\n` : ''}${
    writingAs ? `WRITING AS: ${writingAs}\n` : ''
  }TARGET LENGTH: ~${wordCountTarget} words

BRAND PROFILE (compact):
${JSON.stringify(profileData || {}).slice(0, 7000)}

${fgBlock}

${brainBlock || 'ACTIVE BRAND BRAIN: (none)'}

${prefBlock || ''}

Produce the JSON longform now.`;

  try {
    const msg = await anthropic.messages.create({
      model: LONGFORM_MODEL,
      max_tokens: 16000,
      temperature: 0.35,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    let parsed = safeParseLLM(text, 'object', 'the-post-longform-gen');
    if (!parsed || typeof parsed !== 'object') {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({ error: 'model returned non-JSON', raw: clip(text, 400) });
    }
    let out = normalizeLongform(parsed, { kind, topic });
    if (!out.keyTakeaway || out.sections.length < 2) {
      return res.status(502).json({
        error: 'longform incomplete',
        detail: {
          hasTakeaway: !!out.keyTakeaway,
          sectionCount: out.sections.length,
        },
      });
    }

    // Self-critique revision pass (default ON, disable with self_critique:false).
    // Runs the same Stage-5 critique the human reviewer sees, then one revision
    // pass applying the flags — so the writer benefits from the full brain/voice
    // context the critic has, even for a brand-new org with zero edit history.
    const selfCritique = body.self_critique !== false && body.selfCritique !== false;
    const revision = { requested: selfCritique, ran: false, applied: false, flags_found: 0 };
    let critiqueReport = null;
    let revisionUsage = null;
    if (selfCritique) {
      try {
        const cr = await runLongformCritique({ article: out, kind, eventContext, brandProfileId });
        if (cr.ok) {
          revision.ran = true;
          critiqueReport = cr.report;
          revision.flags_found = cr.report.flags.length;
          if (cr.report.flags.length) {
            const flagList = cr.report.flags
              .map(
                (f) =>
                  `- [${f.severity.toUpperCase()} · ${f.type}] section "${f.sectionHeading}"\n  Flagged: "${f.flaggedExcerpt}"\n  Why: ${f.reason}\n  Fix: ${f.suggestion}`
              )
              .join('\n');
            const revMsg = await anthropic.messages.create({
              model: LONGFORM_MODEL,
              max_tokens: 16000,
              temperature: 0.3,
              system,
              messages: [
                { role: 'user', content: user },
                { role: 'assistant', content: text },
                {
                  role: 'user',
                  content: `A brand compliance audit of your draft found these issues:

${flagList}

Revise the draft to resolve EVERY flag, applying each suggested fix (adapt wording to flow naturally — the intent of the fix is mandatory, its exact phrasing is not). Leave unflagged sections unchanged except where a fix requires a transition. All original hard rules still apply. Return the COMPLETE corrected JSON in the exact same shape as before — every section, not just the revised ones. Return ONLY the JSON.`,
                },
              ],
            });
            revisionUsage = revMsg.usage || null;
            const revText = (revMsg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              .trim();
            let revParsed = safeParseLLM(revText, 'object', 'the-post-longform-revise');
            if (!revParsed || typeof revParsed !== 'object') {
              const rm = revText.match(/\{[\s\S]*\}/);
              if (rm) {
                try {
                  revParsed = JSON.parse(rm[0]);
                } catch {
                  revParsed = null;
                }
              }
            }
            if (revParsed && typeof revParsed === 'object') {
              const revised = normalizeLongform(revParsed, { kind, topic });
              // Only accept a structurally sound revision; otherwise keep the draft.
              if (revised.keyTakeaway && revised.sections.length >= 2) {
                out = revised;
                revision.applied = true;
              } else {
                revision.error = 'revision incomplete — kept first draft';
              }
            } else {
              revision.error = 'revision returned non-JSON — kept first draft';
            }
          }
        } else {
          revision.error = cr.error;
        }
      } catch (e) {
        console.warn('[the-post/longform-gen] self-critique failed', e.message);
        revision.error = e.message;
      }
    }

    return res.json({
      success: true,
      kind,
      topic,
      article: out,
      // Card-face convenience fields for The Post queue
      title: out.title,
      summary: out.keyTakeaway,
      quotes: [],
      tags: [
        kind === 'white_paper' ? 'white-paper' : 'article',
        ...((ns.themes || []).slice(0, 4).map((t) => String(t).toLowerCase())),
      ].filter(Boolean),
      qna: out.faqs,
      confidence: out.confidence,
      model: LONGFORM_MODEL,
      prompt_version: LONGFORM_PROMPT_VERSION,
      usage: msg.usage || null,
      revision: {
        ...revision,
        critique: critiqueReport
          ? {
              overallScore: critiqueReport.overallScore,
              brandVoiceScore: critiqueReport.brandVoiceScore,
              factualConfidence: critiqueReport.factualConfidence,
              summary: critiqueReport.summary,
              flags: critiqueReport.flags,
            }
          : null,
        usage: revisionUsage,
        critique_usage: critiqueReport?.usage || null,
      },
      brand_profile_id: brandProfileId || null,
      brain: {
        patterns: (brain.patterns || []).length,
        mistakes: (brain.mistakes || []).length,
      },
    });
  } catch (err) {
    console.error('[the-post/longform-gen]', err.message);
    return res.status(500).json({ error: err.message || 'longform-gen failed' });
  }
});

// ── Longform compliance critique (Stage 5 reuse for The Post) ────────────────
// Contract: The Post docs/contracts/longform-compliance.md
// inventory: POST /api/external/the-post/critique
const CRITIQUE_MODEL = process.env.THE_POST_CRITIQUE_MODEL || 'claude-sonnet-4-6';
const CRITIQUE_VERSION = 'the-post-critique-v2';

// Shared critique core — used by POST /critique and by the longform-gen
// self-critique revision pass, so writer and reviewer see the same standards.
async function runLongformCritique({ article, kind, eventContext, brandProfileId }) {
  const sections = Array.isArray(article?.sections) ? article.sections : [];
  // Brand voice + brain + Factual Ground — same three inputs as /api/compliance/critique.
  // Degrades gracefully with no brand_profile_id: event_context voice only, no brain/FG.
  let brand = null;
  let mistakes = [];
  if (brandProfileId) {
    try {
      const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
      brand = brandRes.rows[0] || null;
      const mRes = await pool.query(
        `SELECT mistake_type, human_feedback FROM brain_mistakes
          WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [brandProfileId]
      );
      mistakes = mRes.rows;
    } catch (e) {
      console.warn('[the-post/critique] brand load failed', e.message);
    }
  }
  const bp = eventContext.brand_profile || {};
  const brandName = brand?.profile_data?.brand_name || brand?.brand_name || bp.name || 'Unknown';
  const voiceProfile = brand?.profile_data?.voice_profile || {
    tone: bp.voice?.tone || [],
    do: bp.voice?.do || [],
    dont: bp.voice?.dont || bp.voice?.donts || [],
  };

  const fg = brand?.settings?.factualGround || null;
  const fgBlock = fg && Object.values(fg).some((v) => v && (typeof v === 'string' ? v.trim() : Array.isArray(v) && v.length))
    ? `\nUSER-VERIFIED FACTS (stated by the brand owner — authoritative ground truth):
${fg.whatWeDo ? `- What this brand does: ${String(fg.whatWeDo).slice(0, 500)}\n` : ''}${fg.whatWeDontDo ? `- What this brand does NOT do: ${String(fg.whatWeDontDo).slice(0, 500)}\n` : ''}${fg.companyFacts ? `- Company facts: ${String(fg.companyFacts).slice(0, 500)}\n` : ''}${fg.methodology ? `- Methodology/frameworks: ${String(fg.methodology).slice(0, 400)}\n` : ''}${Array.isArray(fg.redactedFacts) && fg.redactedFacts.length ? `\nVERIFIED-BUT-REDACTED FACTS (owner-attested TRUE, but the client/proper-noun is withheld by contract — the anonymized surface phrasing is deliberate, not vague):\n${fg.redactedFacts.map((r) => `- "${String(r.surface || '').slice(0, 300)}"`).filter((s) => s !== '- ""').join('\n')}\n` : ''}
How to use these facts:
- A claim that MATCHES or is directly supported by these facts is VERIFIED — do not flag it as an unverifiable factual_claim.
- A claim that CONTRADICTS these facts is a RED factual_claim flag — quote the contradicting excerpt and name the verified fact it violates.
- A claim matching a VERIFIED-BUT-REDACTED fact is VERIFIED: never flag it, never treat the anonymized phrasing as hedging to fix, and NEVER suggest naming the underlying party.`
    : '';

  const nsBlock = eventContext.north_star?.thesis
    ? `\nEvent North Star thesis (the piece should serve this): ${clip(eventContext.north_star.thesis, 500)}
Event DO NOT: ${clip(JSON.stringify(eventContext.north_star.do_not || []), 400)}`
    : '';

  const systemPrompt = `You are a compliance and brand voice auditor for the brand "${brandName}". This is a ${kind === 'white_paper' ? 'white paper' : 'article'} generated for The Post (post-event knowledge hub) that publishes under the event brand. Analyze it and return a JSON compliance report.

CRITICAL RULES:
- ONLY flag claims, phrases, or issues EXPLICITLY present in the article text being audited. No outside sources, no inference.
- Every flag must include a "flaggedExcerpt" containing the EXACT verbatim quote from the article that triggered it. If you cannot quote it verbatim, do not flag it.
- SECTION ISOLATION: each flag references content from ONLY the section identified by its sectionIndex.
- The "Known Mistakes" below are behavioral patterns to watch for, NOT evidence. Never cite one as proof a claim exists elsewhere.
- A Known Mistake is RESOLVED by its correction: if a passage already applies the corrective guidance (the required qualifier, hedge, attribution, or reframe), do NOT flag it merely for touching the same subject. Only flag a passage that repeats the original mistake WITHOUT the correction. Do not escalate an already-corrected passage with a new, stricter rationale.
- Do not flag correct usage of the brand's own name.
- NDA and legal exposure are the highest-priority flag types: unverifiable client names, partner names, embargoed-sounding specifics, pricing, contract terms, or regulated claims are "nda_risk" / "legal_risk" and always severity "red".
- Never fabricate issues. A clean section gets no flags.

Brand Voice Profile:
${JSON.stringify(voiceProfile, null, 2)}
${fgBlock}${nsBlock}

Known Mistakes to Avoid:
${mistakes.map((m) => `- ${m.mistake_type}: ${m.human_feedback}`).join('\n') || 'None recorded yet'}

Return ONLY valid JSON in this exact structure:
{
  "overallScore": <0-100>,
  "brandVoiceScore": <0-100>,
  "factualConfidence": <0-100>,
  "summary": "<2 sentence plain-language brief for the human reviewer>",
  "flags": [
    {
      "sectionIndex": <zero-based index into the sections array>,
      "sectionHeading": "<heading>",
      "severity": "yellow" | "red",
      "type": "brand_voice" | "factual_claim" | "legal_risk" | "nda_risk" | "sme_required",
      "flaggedExcerpt": "<exact quote>",
      "reason": "<why flagged>",
      "suggestion": "<recommended fix>"
    }
  ]
}`;

  const auditText = sections
    .map((s, i) => `[SECTION ${i}] heading: ${s.heading || s.title || 'Untitled'}\n${s.body || s.content || ''}`)
    .join('\n\n---\n\n');

  const msg = await anthropic.messages.create({
    model: CRITIQUE_MODEL,
    max_tokens: 8192,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Article title: ${clip(article.title, 200)}\n\nArticle to audit:\n\n${auditText}` }],
  });
  const text = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  let parsed = safeParseLLM(text, 'object', 'the-post-critique');
  if (!parsed || typeof parsed !== 'object') {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'critique model returned non-JSON', raw: clip(text, 400) };
  }

  const flags = (Array.isArray(parsed.flags) ? parsed.flags : [])
    .map((f, i) => {
      const idx = Number(f?.sectionIndex);
      const type = ['brand_voice', 'factual_claim', 'legal_risk', 'nda_risk', 'sme_required'].includes(f?.type)
        ? f.type
        : 'brand_voice';
      // nda/legal always block — contract rule, not model discretion
      const severity =
        type === 'nda_risk' || type === 'legal_risk'
          ? 'red'
          : f?.severity === 'red'
            ? 'red'
            : 'yellow';
      return {
        id: `f${i}`,
        sectionIndex: Number.isFinite(idx) ? idx : 0,
        sectionHeading: clip(f?.sectionHeading || '', 200),
        severity,
        type,
        flaggedExcerpt: String(f?.flaggedExcerpt || '').slice(0, 600),
        reason: clip(f?.reason || '', 500),
        suggestion: clip(f?.suggestion || '', 500),
        resolution: null,
      };
    })
    .filter((f) => f.flaggedExcerpt);

  return {
    ok: true,
    report: {
      overallScore: Number(parsed.overallScore) || 0,
      brandVoiceScore: Number(parsed.brandVoiceScore) || 0,
      factualConfidence: Number(parsed.factualConfidence) || 0,
      summary: clip(parsed.summary || '', 600),
      flags,
      usage: msg.usage || null,
      mistakesCount: mistakes.length,
      hasFactualGround: !!fg,
    },
  };
}

router.post('/critique', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const body = req.body || {};
  const article = body.article || {};
  const sections = Array.isArray(article.sections) ? article.sections : [];
  if (!article.title || sections.length < 1) {
    return res.status(400).json({ error: 'article with title and sections required' });
  }
  const kind = String(body.kind || 'article');
  const eventContext = body.event_context || body.eventContext || {};
  const brandProfileId = body.brand_profile_id || body.brandProfileId || null;

  try {
    const result = await runLongformCritique({ article, kind, eventContext, brandProfileId });
    if (!result.ok) {
      return res.status(502).json({ error: result.error, raw: result.raw });
    }
    const r = result.report;
    return res.json({
      success: true,
      version: 1,
      prompt_version: CRITIQUE_VERSION,
      model: CRITIQUE_MODEL,
      overallScore: r.overallScore,
      brandVoiceScore: r.brandVoiceScore,
      factualConfidence: r.factualConfidence,
      summary: r.summary,
      flags: r.flags,
      usage: r.usage,
      brain: { brand_profile_id: brandProfileId, mistakes: r.mistakesCount, factual_ground: r.hasFactualGround },
    });
  } catch (err) {
    console.error('[the-post/critique]', err.message);
    return res.status(500).json({ error: err.message || 'critique failed' });
  }
});

// ── Factual Ground (The Post entry point) ────────────────────────────────────
// Contract: The Post docs/contracts/factual-ground.md
// inventory: GET  /api/external/the-post/factual-ground
// inventory: PUT  /api/external/the-post/factual-ground
// The Post organizers read/write the brand's Factual Ground (the verbatim
// source of truth the longform writer AND critic both consume). redactedFacts
// is NOT editable here — it is populated only by the verified_unnameable
// dismiss taxonomy, and trueReferent is write-only and must NEVER leave FI.
const FG_EDITABLE_FIELDS = [
  'whatWeDo',
  'whatWeDontDo',
  'companyFacts',
  'foundingStory',
  'methodology',
  'authors',
];
const FG_FIELD_MAX = 6000;

function fgEditableView(fg) {
  const src = fg && typeof fg === 'object' ? fg : {};
  const out = {};
  for (const k of FG_EDITABLE_FIELDS) {
    if (k === 'authors') {
      out.authors = Array.isArray(src.authors)
        ? src.authors.map((a) => clip(a, 200)).filter(Boolean).slice(0, 12)
        : src.authors
          ? [clip(src.authors, 200)]
          : [];
    } else {
      out[k] = typeof src[k] === 'string' ? src[k] : '';
    }
  }
  return out;
}

router.get('/factual-ground', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const brandProfileId = String(req.query.brand_profile_id || '').trim();
  if (!brandProfileId) return res.status(400).json({ error: 'brand_profile_id required' });
  try {
    const r = await pool.query(
      'SELECT id, brand_name, profile_data, settings FROM brand_profiles WHERE id = $1',
      [brandProfileId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'brand profile not found' });
    const row = r.rows[0];
    const fg = row.settings?.factualGround || {};
    return res.json({
      success: true,
      brand_profile_id: row.id,
      brand_name: row.profile_data?.brand_name || row.brand_name || '',
      factual_ground: fgEditableView(fg),
      // Surfaces only — trueReferent is write-only by contract and never leaves FI.
      redacted_facts: Array.isArray(fg.redactedFacts)
        ? fg.redactedFacts.map((rf) => ({ surface: clip(rf?.surface || '', 300) })).filter((rf) => rf.surface)
        : [],
      updated_at: fg._updatedAt || null,
    });
  } catch (e) {
    console.error('[the-post/factual-ground:get]', e.message);
    return res.status(500).json({ error: e.message || 'factual ground read failed' });
  }
});

router.put('/factual-ground', async (req, res) => {
  const auth = serviceTokenOk(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const body = req.body || {};
  const brandProfileId = String(body.brand_profile_id || body.brandProfileId || '').trim();
  const input = body.factual_ground || body.factualGround;
  if (!brandProfileId) return res.status(400).json({ error: 'brand_profile_id required' });
  if (!input || typeof input !== 'object') {
    return res.status(400).json({ error: 'factual_ground object required' });
  }

  const sanitized = {};
  const ignored = [];
  for (const [k, v] of Object.entries(input)) {
    if (!FG_EDITABLE_FIELDS.includes(k)) {
      ignored.push(k);
      continue;
    }
    if (k === 'authors') {
      sanitized.authors = Array.isArray(v)
        ? v.map((a) => String(a || '').trim().slice(0, 200)).filter(Boolean).slice(0, 12)
        : String(v || '')
            .split(/[,\n]/)
            .map((a) => a.trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 12);
    } else {
      sanitized[k] = String(v || '').trim().slice(0, FG_FIELD_MAX);
    }
  }
  if (!Object.keys(sanitized).length) {
    return res.status(400).json({ error: 'no editable factual_ground fields in payload', ignored });
  }

  try {
    const r = await pool.query('SELECT settings FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!r.rows.length) return res.status(404).json({ error: 'brand profile not found' });
    const settings = r.rows[0].settings || {};
    const existing = settings.factualGround || {};
    // Merge editable fields over existing; redactedFacts is preserved verbatim
    // and can never be set or cleared through this endpoint.
    const nextFg = {
      ...existing,
      ...sanitized,
      redactedFacts: Array.isArray(existing.redactedFacts) ? existing.redactedFacts : [],
      _updatedAt: new Date().toISOString(),
      _updatedBy: 'the-post',
    };
    const nextSettings = { ...settings, factualGround: nextFg };
    await pool.query(
      `UPDATE brand_profiles
          SET settings = $1::jsonb, version = COALESCE(version, 1) + 1, updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(nextSettings), brandProfileId]
    );
    return res.json({
      success: true,
      brand_profile_id: brandProfileId,
      factual_ground: fgEditableView(nextFg),
      redacted_facts: (nextFg.redactedFacts || [])
        .map((rf) => ({ surface: clip(rf?.surface || '', 300) }))
        .filter((rf) => rf.surface),
      updated_at: nextFg._updatedAt,
      ignored_fields: ignored,
    });
  } catch (e) {
    console.error('[the-post/factual-ground:put]', e.message);
    return res.status(500).json({ error: e.message || 'factual ground write failed' });
  }
});

export default router;
