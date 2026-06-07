// Engine-probing primitives for the GEO Citation Tracker (Performance Dashboard →
// "Run Citation Check"). Each probe queries ONE real AI engine and returns
// { text, urls } — the engine's answer plus the source links it cited. The
// /api/geo/track loop in server.js uses these to record measured citation results
// into geo_citations across every configured engine.
//
// Perplexity Sonar and OpenAI web search were already wired inline in server.js;
// this module unifies them with two new engines — Google Gemini (Search grounding)
// and Google AI Overviews (via SerpAPI) — so all four are measured identically.
// Each engine is gated by its own API key; a missing key disables that engine.

const PROBE_TIMEOUT_MS = 30000;

// Default fetch with an abort timeout. The dashboard route passes its own
// fetchWithTimeout(url, opts, ms); both share this signature.
function defaultFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

// ── Per-engine probes — each returns { text, urls } ──────────────────────────

export async function probePerplexity(query, doFetch = defaultFetch) {
  const res = await doFetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: query }], max_tokens: 400 }),
  });
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || '', urls: data.citations || [] };
}

export async function probeOpenAI(query, doFetch = defaultFetch) {
  const res = await doFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', tools: [{ type: 'web_search_preview' }], input: query }),
  });
  const data = await res.json();
  const msgItem = data.output?.find(o => o.type === 'message');
  const textContent = msgItem?.content?.find(c => c.type === 'output_text');
  const text = textContent?.text || data.output_text || '';
  const urls = (textContent?.annotations || [])
    .filter(a => a.type === 'url_citation')
    .map(a => a.url || a.url_citation?.url || '')
    .filter(Boolean);
  return { text, urls };
}

export async function probeGemini(query, doFetch = defaultFetch) {
  // Gemini 2.0 Flash with Google Search grounding. Grounding chunks carry a Google
  // redirect URI plus the resolved source title — keep both so domain matching can
  // hit either.
  const res = await doFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: query }] }], tools: [{ google_search: {} }] }),
    }
  );
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join(' ');
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  const urls = chunks.flatMap(c => [c.web?.uri, c.web?.title].filter(Boolean));
  return { text, urls };
}

export async function probeAIOverviews(query, doFetch = defaultFetch) {
  // Google AI Overviews has no first-party API — SerpAPI surfaces the AI Overview
  // block. Sometimes it's inline; sometimes only a page_token comes back and the
  // block must be fetched with a follow-up engine=google_ai_overview call.
  const base = 'https://serpapi.com/search.json';
  const res = await doFetch(`${base}?engine=google&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}`);
  let data = await res.json();
  let ov = data.ai_overview;
  if (ov?.page_token && !ov.text_blocks) {
    const res2 = await doFetch(`${base}?engine=google_ai_overview&page_token=${encodeURIComponent(ov.page_token)}&api_key=${process.env.SERPAPI_KEY}`);
    ov = (await res2.json()).ai_overview || ov;
  }
  if (!ov) return { text: '', urls: [] }; // no AI Overview shown for this query
  const text = (ov.text_blocks || [])
    .map(b => b.snippet || (b.list || []).map(li => li.snippet).join(' ') || '')
    .join(' ');
  const urls = (ov.references || []).map(r => r.link).filter(Boolean);
  return { text, urls };
}

// Engine registry. `id` is the value stored in geo_citations.engine and rendered
// as the engine badge in the dashboard. Order is the display order.
export const CITATION_ENGINES = [
  { id: 'perplexity',  enabled: () => !!process.env.PERPLEXITY_API_KEY, probe: probePerplexity },
  { id: 'chatgpt',     enabled: () => !!process.env.OPENAI_API_KEY,     probe: probeOpenAI },
  { id: 'gemini',      enabled: () => !!process.env.GEMINI_API_KEY,     probe: probeGemini },
  { id: 'aiOverviews', enabled: () => !!process.env.SERPAPI_KEY,        probe: probeAIOverviews },
];

// ── Cold-prospect scan ───────────────────────────────────────────────────────
// Runs an AI Visibility scan for a brand we have NO content for (a sales lead).
// Given the brand's domain + a set of natural buyer questions (brand-free), probe
// every enabled engine and measure: how often the brand is cited, on which engines,
// and which domains AI cites instead. This is what powers the shareable report.

const COLD_SCAN_CONCURRENCY = 3;

// Source domains that are scan plumbing, not real citations (Google grounding
// redirects, asset hosts). Excluded from the "who AI cites instead" tally.
const NOISE_DOMAINS = ['vertexaisearch.cloud.google.com', 'google.com', 'gstatic.com', 'googleusercontent.com'];

export function extractDomain(value) {
  if (!value || typeof value !== 'string') return '';
  let v = value.trim().toLowerCase();
  try { v = new URL(v.startsWith('http') ? v : `https://${v}`).hostname; } catch { return ''; }
  return v.replace(/^www\./, '');
}

// Tally cited source domains, excluding the brand's own domain and scan noise.
export function aggregateSources(urls, brandDomain, limit = 20) {
  const bd = (brandDomain || '').toLowerCase().replace(/^www\./, '');
  const counts = new Map();
  for (const u of urls || []) {
    const d = extractDomain(u);
    if (!d) continue;
    if (bd && d.includes(bd)) continue;
    if (NOISE_DOMAINS.some(n => d.includes(n))) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, mentions]) => ({ domain, mentions }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);
}

async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; await fn(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
}

// Probe a cold brand across buyer questions on every enabled engine.
export async function coldScan({ brandName, brandDomain, questions }) {
  const engines = CITATION_ENGINES.filter(e => e.enabled());
  if (!engines.length) {
    throw new Error('No GEO engines configured — set at least one of PERPLEXITY_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, SERPAPI_KEY. Refusing to emit modeled scores.');
  }
  const qs = (questions || []).filter(q => typeof q === 'string' && q.trim());
  // per engine: checks, cited(=visible: linked or mentioned), linked(=domain cited)
  const byEngine = Object.fromEntries(engines.map(e => [e.id, { checks: 0, cited: 0, linked: 0 }]));
  let totalChecks = 0, totalCited = 0, totalLinked = 0;
  const allUrls = [];
  const citedQueries = [];
  const perQuestion = [];

  await mapWithConcurrency(qs, COLD_SCAN_CONCURRENCY, async (q) => {
    const row = { question: q, engines: {} };
    await Promise.all(engines.map(async (engine) => {
      try {
        const { text, urls } = await engine.probe(q);
        const v = scanVisibility({ text, urls, brandName, brandDomain });
        byEngine[engine.id].checks++; totalChecks++;
        if (v.visible) {
          byEngine[engine.id].cited++; totalCited++;
          if (v.status === 'cited') { byEngine[engine.id].linked++; totalLinked++; }
          if (!citedQueries.includes(q)) citedQueries.push(q);
        }
        allUrls.push(...(urls || []));
        row.engines[engine.id] = v.status;
      } catch (e) {
        console.error(`[COLD-SCAN] ${engine.id} "${q}":`, e.message);
        row.engines[engine.id] = 'error';
      }
    }));
    perQuestion.push(row);
  });

  const pct = (c, n) => (n ? Math.round((c / n) * 100) : 0);
  return {
    brandName, brandDomain,
    // visibility = share of answers where the brand shows up at all (named or linked)
    visibility: pct(totalCited, totalChecks),
    totalChecks, totalCited, totalLinked,
    byEngine: Object.fromEntries(engines.map(e => [e.id, { ...byEngine[e.id], pct: pct(byEngine[e.id].cited, byEngine[e.id].checks) }])),
    sources: aggregateSources(allUrls, brandDomain),
    citedQueries,
    perQuestion,
    enginesProbed: engines.map(e => e.id),
  };
}

// ── Citation-attribution helpers (pure, unit-tested) ─────────────────────────

export function urlHasDomain(url, brandDomain) {
  if (!url || typeof url !== 'string' || !brandDomain) return false;
  return url.toLowerCase().includes(brandDomain.toLowerCase());
}

// Was the brand cited? A linked source on the brand domain, or the domain spelled
// out in the answer text.
export function isCited({ text = '', urls = [], brandDomain = '' }) {
  if (!brandDomain) return false;
  return (urls || []).some(u => urlHasDomain(u, brandDomain)) || (text || '').toLowerCase().includes(brandDomain.toLowerCase());
}

// Name tokens used to detect a brand MENTION (vs a domain citation): the brand
// name and the domain's second-level label, length-guarded so short/common
// fragments don't match. e.g. nike.com -> ["nike"]; novaintelligenceai.com +
// "Nova Intelligence" -> ["nova intelligence", "novaintelligenceai"].
export function brandTokens(brandName, brandDomain) {
  const toks = new Set();
  const n = (brandName || '').toLowerCase().trim();
  if (n.length > 2) toks.add(n);
  const sld = (brandDomain || '').toLowerCase().replace(/^www\./, '').split('.')[0];
  if (sld && sld.length > 3) toks.add(sld);
  return [...toks];
}

// Visibility for the cold scan: the brand is "visible" in an answer if its domain
// is cited/linked (strong) OR its name appears in the answer text (a mention).
// Domain-only badly undercounts well-known brands that engines name without
// linking (e.g. an answer that recommends "Nike" but links a review site).
// Returns { visible, status: 'cited' | 'mentioned' | 'absent' }.
export function scanVisibility({ text = '', urls = [], brandName = '', brandDomain = '' }) {
  if (isCited({ text, urls, brandDomain })) return { visible: true, status: 'cited' };
  const t = (text || '').toLowerCase();
  for (const tok of brandTokens(brandName, brandDomain)) {
    const re = new RegExp(`(^|[^a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(t)) return { visible: true, status: 'mentioned' };
  }
  return { visible: false, status: 'absent' };
}

// Which part of the article got cited: section bodies first, then FAQs, then a
// URL-cited-vs-brand-mention fallback. Mirrors the original inline logic exactly.
export function findCitedSection({ text = '', urls = [], brandDomain = '', sections = [], faqs = [] }) {
  const respWords = (text || '').toLowerCase().split(' ');
  const overlaps = (body) => respWords.filter(w => w.length > 6 && body.includes(w)).length > 3;
  for (const s of sections) {
    const body = (s.body || s.content || '').toLowerCase();
    if (overlaps(body)) return s.heading;
  }
  for (const f of faqs) {
    const body = `${f?.question || ''} ${f?.answer || ''}`.toLowerCase();
    if (overlaps(body)) {
      const q = (f?.question || '').trim();
      return q.length > 60 ? `FAQ: ${q.slice(0, 60)}…` : `FAQ: ${q}`;
    }
  }
  return (urls || []).some(u => urlHasDomain(u, brandDomain)) ? 'Article URL cited' : 'Brand mention';
}
