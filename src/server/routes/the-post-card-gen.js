// Dedicated The Post → Forge Intelligence card-generation endpoint.
// Contract: docs in The Post repo docs/contracts/forge-card-gen.md
// NOT the generic publishing path. Token-gated M2M only.
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { anthropic } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';

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

Produce the JSON card now.`;

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
    });
  } catch (err) {
    console.error('[the-post/card-gen]', err.message);
    return res.status(500).json({ error: err.message || 'card-gen failed' });
  }
});

export default router;
