// Real GEO engine probing. This is the module that makes the GEO scan honest:
// instead of asking Claude to *imagine* how often ChatGPT/Perplexity/Gemini/Google
// AI Overviews cite a brand (the old Tool 2, which produced lockstep, fabricated
// numbers), we actually query each engine with natural buyer questions and MEASURE
// whether the brand is cited.
//
// Each engine is env-gated by its own API key. A missing key disables that engine
// (its column comes back null) rather than throwing — but if NO engine is available
// the caller must treat the run as a failure, never fall back to modeled numbers.
//
// Scoring per (topic, engine): we run a few natural queries and grade each answer
//   100 — brand domain is cited/linked (the real, defensible "you are cited" signal)
//    50 — brand named in the answer text but not linked (mentioned, not sourced)
//     0 — brand absent from the answer
// and average across the queries. So the 0-100 is a measured citation-strength rate,
// not a guess. Three queries gives a 0/17/33/50/.../100 granularity grounded in
// observable engine behavior.

const DEFAULT_QUERIES_PER_TOPIC = 3;
const TOPIC_CONCURRENCY = 3;     // how many topics probed in parallel (rate-limit safety)
const ENGINE_TIMEOUT_MS = 30000;

// ── Engine registry ─────────────────────────────────────────────────────────
// Each engine exposes: key presence flag + a probe(query) -> { text, urls } fn.
// `text` is the engine's answer; `urls` are the cited/grounding source links.

function timeoutFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS) });
}

async function probePerplexity(query) {
  const res = await timeoutFetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: query }], max_tokens: 400 }),
  });
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || '', urls: data.citations || [] };
}

async function probeOpenAI(query) {
  const res = await timeoutFetch('https://api.openai.com/v1/responses', {
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

async function probeGemini(query) {
  // Gemini with Google Search grounding. Grounding URIs come back as redirect
  // links on vertexaisearch.cloud.google.com plus the resolved domain in title.
  const res = await timeoutFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    }
  );
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join(' ');
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  // web.uri is a Google redirect; web.title is the source domain/title — keep both
  // so brand-domain matching can hit either.
  const urls = chunks.flatMap(c => [c.web?.uri, c.web?.title].filter(Boolean));
  return { text, urls };
}

async function probeAIOverviews(query) {
  // Google AI Overviews has no first-party API — SerpAPI surfaces the AI Overview
  // block. Sometimes it's inline; sometimes only a page_token is returned and the
  // block must be fetched with a follow-up engine=google_ai_overview call.
  const base = 'https://serpapi.com/search.json';
  const res = await timeoutFetch(
    `${base}?engine=google&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}`
  );
  let data = await res.json();
  let ov = data.ai_overview;
  if (ov?.page_token && !ov.text_blocks) {
    const res2 = await timeoutFetch(
      `${base}?engine=google_ai_overview&page_token=${encodeURIComponent(ov.page_token)}&api_key=${process.env.SERPAPI_KEY}`
    );
    const data2 = await res2.json();
    ov = data2.ai_overview || ov;
  }
  if (!ov) return { text: '', urls: [], absent: true }; // no AI Overview shown for this query
  const text = (ov.text_blocks || [])
    .map(b => b.snippet || (b.list || []).map(li => li.snippet).join(' ') || '')
    .join(' ');
  const urls = (ov.references || []).map(r => r.link).filter(Boolean);
  return { text, urls };
}

const ENGINES = [
  { id: 'perplexity', label: 'Perplexity', enabled: () => !!process.env.PERPLEXITY_API_KEY, probe: probePerplexity },
  { id: 'chatgpt',    label: 'ChatGPT',    enabled: () => !!process.env.OPENAI_API_KEY,     probe: probeOpenAI },
  { id: 'gemini',     label: 'Gemini',     enabled: () => !!process.env.GEMINI_API_KEY,      probe: probeGemini },
  { id: 'aiOverviews', label: 'Google AI Overviews', enabled: () => !!process.env.SERPAPI_KEY, probe: probeAIOverviews },
];

export function enabledEngines() {
  return ENGINES.filter(e => e.enabled()).map(e => e.id);
}

// ── Scoring helpers (pure, unit-tested) ──────────────────────────────────────

// Normalize a URL or title fragment to a comparable host string.
export function hostOf(value) {
  if (!value || typeof value !== 'string') return '';
  let v = value.trim().toLowerCase();
  try { v = new URL(v.startsWith('http') ? v : `https://${v}`).hostname; } catch { /* keep raw */ }
  return v.replace(/^www\./, '');
}

// Grade one engine answer for brand presence: 100 cited, 50 mentioned, 0 absent.
export function gradeAnswer({ text = '', urls = [], brandDomain = '', brandName = '' }) {
  const dom = (brandDomain || '').toLowerCase().replace(/^www\./, '');
  const t = (text || '').toLowerCase();
  if (dom) {
    const cited = (urls || []).some(u => hostOf(u).includes(dom) || (u || '').toLowerCase().includes(dom)) || t.includes(dom);
    if (cited) return { score: 100, status: 'cited' };
  }
  const name = (brandName || '').toLowerCase().trim();
  if (name && name.length > 2 && t.includes(name)) return { score: 50, status: 'mentioned' };
  return { score: 0, status: 'absent' };
}

// Average a set of per-query grades into a 0-100 engine score for one topic.
export function scoreFromGrades(grades) {
  const valid = grades.filter(g => g && typeof g.score === 'number');
  if (!valid.length) return null; // no observation — distinct from a measured 0
  return Math.round(valid.reduce((a, g) => a + g.score, 0) / valid.length);
}

// Default natural buyer queries for a topic, used when the LLM query-writer is
// unavailable. Deliberately brand-free: we measure UNPROMPTED citation, the honest
// "do engines surface you on their own" signal.
export function defaultQueries(topic) {
  const t = (topic || '').trim();
  return [
    t,
    `What is the best approach to ${t}?`,
    `Who are the leading providers for ${t}?`,
  ];
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Probe a brand across topics on every enabled engine.
// Returns:
//   opportunities: [{ platform, topic, score, quickWin }]  — one row per (engine, topic),
//                   shaped exactly like the old Tool 2 output so downstream is unchanged.
//   evidence:      [{ topic, engine, query, status, urls }] — raw observations for the report.
//   engines:       enabled engine ids actually probed.
export async function probeBrandTopics({ brandName, brandDomain, topics, queryMap = {}, queriesPerTopic = DEFAULT_QUERIES_PER_TOPIC }) {
  const engines = ENGINES.filter(e => e.enabled());
  if (!engines.length) {
    throw new Error('No GEO engines configured — set at least one of PERPLEXITY_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, SERPAPI_KEY. Refusing to emit modeled scores.');
  }
  const cleanTopics = (topics || []).map(t => (typeof t === 'string' ? t : t?.topic)).filter(Boolean);

  const opportunities = [];
  const evidence = [];

  await mapWithConcurrency(cleanTopics, TOPIC_CONCURRENCY, async (topic) => {
    const queries = (queryMap[topic] && queryMap[topic].length ? queryMap[topic] : defaultQueries(topic)).slice(0, queriesPerTopic);

    // For each engine, probe every query, grade, average.
    await Promise.all(engines.map(async (engine) => {
      const grades = await Promise.all(queries.map(async (q) => {
        try {
          const { text, urls } = await engine.probe(q);
          const g = gradeAnswer({ text, urls, brandDomain, brandName });
          evidence.push({ topic, engine: engine.id, query: q, status: g.status, urls: (urls || []).slice(0, 5) });
          return g;
        } catch (e) {
          console.error(`[GEO-PROBE] ${engine.id} failed for "${q}":`, e.message);
          return null; // failed observation — excluded from the average, not scored 0
        }
      }));
      const score = scoreFromGrades(grades);
      if (score === null) return; // engine produced no usable observation for this topic
      opportunities.push({
        platform: engine.label,
        topic,
        score,
        // A quick win is a relevant topic where the brand is measurably weak/absent
        // (real whitespace to capture), not where it already ranks.
        quickWin: score < 40,
      });
    }));
  });

  return { opportunities, evidence, engines: engines.map(e => e.id) };
}
