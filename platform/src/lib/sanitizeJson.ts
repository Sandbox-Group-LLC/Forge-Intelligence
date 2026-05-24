/*
 * Ported from Forge Intelligence. Streamed LLM output sometimes leaves bare
 * control characters (raw newlines/tabs) inside JSON string values, which
 * breaks JSON.parse. This escapes them in-place without touching structure,
 * and strips a leading/trailing ```json code fence if present.
 */
export function sanitizeJson(raw: string): string {
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function parseJsonSafe<T = unknown>(raw: string): T {
  return JSON.parse(sanitizeJson(raw)) as T;
}
