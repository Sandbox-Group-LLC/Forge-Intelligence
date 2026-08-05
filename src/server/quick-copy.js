// Pure helpers for Quick Copy — kept out of the Express route so unit tests
// can cover annotation / excerpt anchoring without standing up the server.

export const QUICK_COPY_FORMATS = [
  'email_reply',
  'cold_email',
  'dm',
  'social_post',
  'comment',
  'custom',
];

export const QUICK_COPY_PLATFORMS = [
  'email',
  'linkedin',
  'x',
  'instagram',
  'generic',
];

/**
 * Clamp variant count to the product range (1–4). Invalid / missing → default 2.
 * @param {unknown} n
 * @returns {number}
 */
export function clampVariantCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 2;
  return Math.min(4, Math.max(1, Math.round(num)));
}

/**
 * Find the first occurrence of `excerpt` in `text` (case-sensitive exact match).
 * Returns { start, end } or null if not found / empty.
 * @param {string} text
 * @param {string} excerpt
 * @returns {{ start: number, end: number } | null}
 */
export function findExcerptRange(text, excerpt) {
  if (typeof text !== 'string' || typeof excerpt !== 'string') return null;
  if (!excerpt.trim()) return null;
  const start = text.indexOf(excerpt);
  if (start < 0) return null;
  return { start, end: start + excerpt.length };
}

/**
 * Normalize model flags into anchored, numbered flags ready for the UI.
 * Drops flags whose excerpt cannot be found in the body (no fake underlines).
 * Overlapping ranges: keep the earlier/longer one; skip later overlaps.
 *
 * @param {string} body
 * @param {Array<Record<string, unknown>>} rawFlags
 * @returns {Array<{
 *   n: number,
 *   severity: 'red' | 'yellow',
 *   type: string,
 *   excerpt: string,
 *   start: number,
 *   end: number,
 *   reason: string,
 *   suggestion: string
 * }>}
 */
export function anchorComplianceFlags(body, rawFlags) {
  if (typeof body !== 'string' || !body) return [];
  const list = Array.isArray(rawFlags) ? rawFlags : [];
  /** @type {Array<{n:number,severity:'red'|'yellow',type:string,excerpt:string,start:number,end:number,reason:string,suggestion:string}>} */
  const anchored = [];

  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const excerpt = String(f.excerpt || f.flaggedExcerpt || '').trim();
    if (!excerpt) continue;
    const range = findExcerptRange(body, excerpt);
    if (!range) continue;

    const severity = f.severity === 'red' ? 'red' : 'yellow';
    const type = String(f.type || 'factual_claim');
    const reason = String(f.reason || '').trim() || 'Flagged during claim check.';
    const suggestion = String(f.suggestion || '').trim();

    // Skip if this range overlaps an already-accepted flag
    const overlaps = anchored.some(
      (a) => range.start < a.end && range.end > a.start
    );
    if (overlaps) continue;

    anchored.push({
      n: 0, // filled after sort
      severity,
      type,
      excerpt,
      start: range.start,
      end: range.end,
      reason,
      suggestion,
    });
  }

  anchored.sort((a, b) => a.start - b.start || b.end - a.start - (a.end - a.start));
  return anchored.map((f, i) => ({ ...f, n: i + 1 }));
}

/**
 * Split body into annotated segments for rendering red underlines + superscripts.
 * Segments are either plain text or a flag span.
 *
 * @param {string} body
 * @param {ReturnType<typeof anchorComplianceFlags>} flags
 * @param {Set<number> | number[]} [dismissedNs]
 * @returns {Array<
 *   | { kind: 'text', text: string }
 *   | { kind: 'flag', text: string, n: number, severity: 'red' | 'yellow' }
 * >}
 */
export function buildAnnotatedSegments(body, flags, dismissedNs = []) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return [];
  const dismissed = dismissedNs instanceof Set
    ? dismissedNs
    : new Set(Array.isArray(dismissedNs) ? dismissedNs : []);

  const active = (Array.isArray(flags) ? flags : [])
    .filter((f) => f && !dismissed.has(f.n) && Number.isFinite(f.start) && Number.isFinite(f.end) && f.start < f.end)
    .slice()
    .sort((a, b) => a.start - b.start);

  /** @type {Array<{kind:'text',text:string}|{kind:'flag',text:string,n:number,severity:'red'|'yellow'}>} */
  const segments = [];
  let cursor = 0;
  for (const f of active) {
    const start = Math.max(0, Math.min(text.length, f.start));
    const end = Math.max(start, Math.min(text.length, f.end));
    if (start < cursor) continue; // overlap after sort — skip
    if (start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, start) });
    }
    segments.push({
      kind: 'flag',
      text: text.slice(start, end),
      n: f.n,
      severity: f.severity === 'red' ? 'red' : 'yellow',
    });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Clean clipboard text — always the raw body, never annotation chrome.
 * @param {string} body
 * @returns {string}
 */
export function cleanCopyText(body) {
  return typeof body === 'string' ? body : '';
}

/**
 * Replace the first occurrence of `excerpt` in `body` with `replacement`.
 * Returns null if excerpt is missing / empty (caller should 400).
 * @param {string} body
 * @param {string} excerpt
 * @param {string} replacement
 * @returns {string | null}
 */
export function applyExcerptRewrite(body, excerpt, replacement) {
  if (typeof body !== 'string' || typeof excerpt !== 'string') return null;
  if (!excerpt) return null;
  const range = findExcerptRange(body, excerpt);
  if (!range) return null;
  const rep = typeof replacement === 'string' ? replacement : '';
  return body.slice(0, range.start) + rep + body.slice(range.end);
}

/**
 * Deduplicate recent prompts for the "reuse last prompt" strip.
 * Newest-first input; returns unique non-empty prompts (trimmed), capped.
 * @param {Array<{ prompt?: string, format?: string, platform?: string, id?: string, createdAt?: string }>} rows
 * @param {number} [limit=8]
 */
export function uniqueRecentPrompts(rows, limit = 8) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const prompt = typeof row?.prompt === 'string' ? row.prompt.trim() : '';
    if (!prompt) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: row.id || null,
      prompt,
      format: row.format || null,
      platform: row.platform || null,
      createdAt: row.createdAt || row.created_at || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build length / platform constraint block for the writer prompt.
 * @param {{ format: string, platform?: string, lengthHint?: string }} opts
 */
export function formatConstraintBlock({ format, platform = 'generic', lengthHint = '' }) {
  const lines = [`FORMAT: ${format}`, `PLATFORM: ${platform || 'generic'}`];
  if (lengthHint === 'short') lines.push('LENGTH: short — tight, scannable, no padding.');
  else if (lengthHint === 'long') lines.push('LENGTH: long — complete but still one-shot copy, not an article.');
  else if (lengthHint === 'medium' || !lengthHint) lines.push('LENGTH: medium — enough to do the job, nothing extra.');
  else lines.push(`LENGTH HINT: ${lengthHint}`);

  if (format === 'dm' && platform === 'x') {
    lines.push('Hard preference: keep under ~280 characters when possible.');
  }
  if (format === 'social_post' && platform === 'x') {
    lines.push('HARD CONSTRAINT: body at or below 280 characters.');
  }
  if (format === 'social_post' && platform === 'instagram') {
    lines.push('HARD CONSTRAINT: body at or below 300 characters; prefer under 150.');
  }
  if (format === 'social_post' && (platform === 'linkedin' || platform === 'generic')) {
    lines.push('Prefer under ~1,300 characters. Plain text, no markdown.');
  }
  return lines.join('\n');
}
