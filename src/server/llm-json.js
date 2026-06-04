// JSON / LLM-output parsing helpers, extracted from server.js during the
// decomposition. safeParseLLM depends on extractJSON; both live here together.
// Pure functions, no external dependencies.

export function extractJSON(text, type = 'object') {
  const open = type === 'array' ? '[' : '{';
  const close = type === 'array' ? ']' : '}';
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // JSON was truncated (hit token limit) — attempt recovery by closing open structures
  if (depth > 0) {
    let partial = text.slice(start).trimEnd();
    // Remove any trailing incomplete string or value
    partial = partial.replace(/,\s*$/, '').replace(/"[^"]*$/, '"truncated"');
    // Close all open braces/brackets
    const stack = [];
    for (const ch of partial) {
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    partial += stack.reverse().join('');
    try { JSON.parse(partial); return partial; } catch(e) { /* unrecoverable */ }
  }
  return null;
}

// Not a library. Not an npm package. Just a dev who got tired of Claude's newlines.
// ── Shared LLM JSON parser — sanitise + recover ──────────────────────────────
export function safeParseLLM(raw, type = 'object', caller = 'unknown') {
  const stripped = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060\u00A0]/g, '')
    .trim();
  const extracted = extractJSON(stripped, type) || stripped;
  // Step 2: fast path
  try { return JSON.parse(extracted); } catch(_) {}
  // Step 3: control chars + trailing commas
  try {
    const sanitized = extracted
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
      .replace(/(?<!\\)\n(?=(?:[^"]*"[^"]*")*[^"]*"[^"]*$)/g, '\\n')
      .replace(/,\s*([\]\}])/g, '$1');
    const result = JSON.parse(sanitized);
    console.warn('[safeParseLLM] Step 3 recovery (' + caller + ') control chars/trailing commas');
    return result;
  } catch(_) {}
  // Step 4: brute-force
  try {
    const brute = extracted
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f]/g, ' ')
      .replace(/,\s*([\]\}])/g, '$1')
      .replace(/("\s*)(\n\s*")/g, '$1,$2')
      .replace(/(\}\s*)(\{)/g, '$1,$2')
      .replace(/("\s*)(\{)/g, '$1,$2')
      .replace(/(\}\s*)(")/g, '$1,$2')
      .replace(/([\]\}])\s*([\[\{])/g, '$1,$2')
      .replace(/(")\s*(")/g, '$1,$2');
    const result = JSON.parse(brute);
    console.warn('[safeParseLLM] Step 4 recovery (' + caller + ') brute-force escape');
    return result;
  } catch(_) {}
  // Step 5: nuclear
  try {
    const open = type === 'array' ? '[' : '{';
    const close = type === 'array' ? ']' : '}';
    const first = stripped.indexOf(open);
    const last = stripped.lastIndexOf(close);
    if (first !== -1 && last > first) {
      const sliced = stripped.slice(first, last + 1)
        .replace(/[\x00-\x1f]/g, ' ')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t')
        .replace(/,\s*([\]\}])/g, '$1');
      const result = JSON.parse(sliced);
      console.warn('[safeParseLLM] NUCLEAR Step 5 recovery (' + caller + ') prompt is broken. First 80: ' + stripped.slice(0, 80).replace(/\n/g, ' '));
      return result;
    }
  } catch(_) {}
  console.error('[safeParseLLM] TOTAL FAILURE (' + caller + ') First 300:', stripped.slice(0, 300));
  throw new Error('LLM JSON parse failed after recovery');
}
