// src/server/myeline-ground.js — LIVE factual ground from a Myeline brain (2026-11-10).
//
// The audit lesson: the generator invents integration mechanics when its only
// source is a marketing brief. This module gives the writer VERIFIED facts,
// retrieved at generation time from the brand's own Myeline team brain over
// MCP, each carrying its source. Mechanics the brain does not know get
// flagged as gaps, not invented.
//
// Zero new dependencies: a minimal streamable-HTTP MCP client (initialize +
// tools/call) over fetch. Env: MYELINE_GROUND_URL (the team brain's MCP
// address) + MYELINE_GROUND_TOKEN (the service token). No env, a refused
// call, or a timeout means ground is simply absent — generation NEVER blocks
// or fails on this module. The article's enrichment metadata records what
// ground was used so the audit trail knows.

const GROUND_TIMEOUT_MS = 9_000;
const MAX_QUERIES = 4;
const MAX_FACTS = 14;

let mcpSessionId = null; // carried between initialize and tools/call

async function rpc(method, params) {
  const url = process.env.MYELINE_GROUND_URL;
  const token = process.env.MYELINE_GROUND_TOKEN;
  if (!url || !token) throw new Error('ground not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e9, method, params }),
    signal: AbortSignal.timeout(GROUND_TIMEOUT_MS),
  });
  // streamable HTTP may answer SSE; take the first data line with JSON in it
  const text = await res.text();
  const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
  if (sid) mcpSessionId = sid;
  if (!res.ok) throw new Error(`mcp ${method} answered ${res.status}`);
  let payload = null;
  for (const line of text.split('\n')) {
    const t = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (t.startsWith('{')) { try { payload = JSON.parse(t); } catch { /* next line */ } }
    if (payload?.result !== undefined || payload?.error) break;
  }
  if (!payload) throw new Error(`mcp ${method} returned no JSON payload`);
  if (payload.error) throw new Error(`mcp ${method} error: ${payload.error.message || 'unknown'}`);
  return payload.result;
}

/** One query against the brain's cortex_query tool. Returns facts[] (any shape). */
async function groundQuery(question) {
  const r = await rpc('tools/call', {
    name: 'cortex_query',
    arguments: { q: question, top_k: 6 },
  });
  const content = r?.content;
  if (!Array.isArray(content)) return [];
  const textBlock = content.find((c) => c.type === 'text')?.text || '';
  try {
    const parsed = JSON.parse(textBlock);
    const facts = parsed?.facts || parsed?.results || (Array.isArray(parsed) ? parsed : []);
    return Array.isArray(facts) ? facts : [];
  } catch {
    return [];
  }
}

const factText = (f) => String(f?.body_md || f?.body || f?.fact || f?.text || '').trim();
const factSource = (f) => {
  const s = Array.isArray(f?.sources) ? f.sources[0] : f?.source;
  return s ? String(s.name || s.uri || '') : '';
};

/**
 * Fetch live verified facts for one article angle. Fail-soft by contract.
 * @returns {{ ok: boolean, facts: Array<{text: string, source: string}>, reason?: string }}
 */
export async function fetchLiveGround({ brandName = '', angleTitle = '', keywords = [] }) {
  try {
    if (!process.env.MYELINE_GROUND_URL || !process.env.MYELINE_GROUND_TOKEN) {
      return { ok: false, facts: [], reason: 'not_configured' };
    }
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'forge-intelligence-ground', version: '1.0.0' },
    });
    const brand = brandName || 'the brand';
    const questions = [
      `How does ${brand} work? Mechanics, architecture, integrations, and setup steps.`,
      `What are ${brand}'s plans, pricing, limits, and what is refused at each tier?`,
      `What are ${brand}'s security, permissions, audit, and data-handling rules?`,
      ...(angleTitle ? [`${angleTitle}: specific mechanics, numbers, and documented behavior.`] : []),
      ...(keywords.length ? [`${keywords.join(', ')}: exact documented facts.`] : []),
    ].slice(0, MAX_QUERIES);

    const seen = new Set();
    const facts = [];
    for (const q of questions) {
      let batch = [];
      try { batch = await groundQuery(q); } catch { /* one bad query never sinks the ground */ }
      for (const f of batch) {
        const text = factText(f);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        facts.push({ text: text.slice(0, 500), source: factSource(f) });
        if (facts.length >= MAX_FACTS) break;
      }
      if (facts.length >= MAX_FACTS) break;
    }
    return { ok: true, facts, reason: facts.length ? 'ok' : 'brain_quiet' };
  } catch (e) {
    console.warn('[MYELINE-GROUND] unavailable:', e.message);
    return { ok: false, facts: [], reason: e.message.slice(0, 120) };
  }
}

/** Render the ground as the prompt block the writer sees (or '' when absent). */
export function renderGroundBlock(ground) {
  if (!ground?.ok || !ground.facts.length) return '';
  const lines = ground.facts
    .map((f) => `- ${f.text}${f.source ? ` [source: ${f.source}]` : ''}`)
    .join('\n');
  return `VERIFIED PRODUCT FACTS, retrieved live from the brand's own Myeline memory (each carries its source). Product mechanics, numbers, limits, permission names, and setup steps in your draft MUST trace to one of these facts. If a mechanic you want to describe is NOT supported below, do NOT invent it: write around it and record the gap in that section's confidenceReason.\n${lines}`;
}
