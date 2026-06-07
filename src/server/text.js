// Text / string utilities, extracted from server.js during the decomposition.
// Pure functions, no external dependencies.

// Hard-truncate to a max length (null-safe). No ellipsis.
export function truncateStr(s, max) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

// Truncate to maxChars, preferring a sentence boundary, then a word boundary,
// appending an ellipsis on the soft fallbacks.
export function truncateAtSentence(text, maxChars) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxChars) return text.trim();
  const window = text.slice(0, maxChars);
  // Look for last sentence-ending punctuation followed by space/newline or at end
  const sentenceMatch = window.match(/^.*[.!?](?=\s|$)/s);
  if (sentenceMatch && sentenceMatch[0].length >= maxChars * 0.5) {
    return sentenceMatch[0].trim();
  }
  // Fallback: last complete word
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.5) return window.slice(0, lastSpace).trim() + '…';
  return window.trim() + '…';
}

// Strip markdown that social platforms render literally (headings, bold).
export function stripSocialMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Leading H1-H6 markers on any line: "# Heading" -> "Heading"
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    // **bold** -> bold (non-greedy, single line)
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    // __bold__ -> bold (less common; Claude uses it occasionally)
    .replace(/__([^_\n]+?)__/g, '$1');
}

// Deterministic em/en-dash remover. The em dash is the strongest AI-writing
// tell; the content generator prompt forbids it outright, but models ignore
// punctuation bans, so this is the backstop that GUARANTEES none ship. Null-safe.
//
// Numeric en-dash ranges (2024–2026) become hyphens. Every other em/en dash
// becomes a COMMA — UNLESS the sentence it sits in already has 2+ commas, in
// which case the dash becomes a SEMICOLON instead of piling on a third comma
// (a semicolon reads cleaner and usually fits, since an em dash typically joins
// two independent clauses). Decision is per-dash, scoped to the enclosing
// sentence (text between the surrounding . ! ? boundaries). Comma/space
// artifacts are tidied afterward.
export function stripEmDashes(text) {
  if (typeof text !== 'string') return text;
  // 1. numeric en-dash ranges -> hyphen, before the general pass
  let s = text.replace(/(\d)\s*–\s*(\d)/g, '$1-$2');
  if (!/[—–]/.test(s)) return s;

  // 2. replace each remaining em/en dash, choosing comma vs semicolon by the
  //    comma count of its enclosing sentence.
  const dashRe = /\s*[—–]\s*/g;
  let out = '', last = 0, m;
  while ((m = dashRe.exec(s)) !== null) {
    const idx = m.index;
    const sentStart = Math.max(
      s.lastIndexOf('.', idx - 1), s.lastIndexOf('!', idx - 1), s.lastIndexOf('?', idx - 1)
    ) + 1;
    const after = idx + m[0].length;
    const ends = ['.', '!', '?'].map(p => s.indexOf(p, after)).filter(i => i >= 0);
    const sentEnd = ends.length ? Math.min(...ends) : s.length;
    const commaCount = (s.slice(sentStart, sentEnd).match(/,/g) || []).length;
    out += s.slice(last, idx) + (commaCount >= 2 ? '; ' : ', ');
    last = after;
  }
  out += s.slice(last);

  return out
    .replace(/\s+([,;])/g, '$1')   // "word ," / "word ;" -> "word,"/"word;"
    .replace(/,\s*,/g, ',')        // ", ," -> ","
    .replace(/;\s*,|,\s*;/g, ';')  // mixed ";," / ",;" next to an existing comma -> ";"
    .replace(/^\s*[,;]\s*/, '');   // strip a leading comma/semicolon artifact
}


// Hard-truncate to maxLength, appending an ellipsis when it cuts. Non-string
// input returns ''. (Distinct from truncateStr — that one has no ellipsis —
// and truncateAtSentence, which prefers a boundary.) Used across the Quick
// Start synthesis path.
export function quickStartTruncate(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.length > maxLength ? value.slice(0, maxLength).trim() + '…' : value;
}

// Strip LLM scaffolding artifacts from article section bodies.
// Enrichment briefs give the writer bracketed placeholders like "[SME Hook: ...]",
// "[CTA: ...]", "[Author Quote: ...]" that the model is supposed to expand into
// prose or drop. It sometimes copies them verbatim, and they leak past human
// compliance review. This is the final safety net — called at every article
// write path (content-gen, campaign, compliance approve, content-import).
// Mutates and returns the passed article (sections rebuilt); non-article input
// is returned untouched.
export function stripScaffoldingArtifacts(article) {
  if (!article || typeof article !== 'object' || !Array.isArray(article.sections)) return article;

  // Inline: keyword-gated bracketed instructions (safe — won't nuke legit refs like [1] or [Appendix A])
  const INLINE_RX = /\[(?:SME[\s-]?Hook|Author[\s-]?(?:Quote|Citation|Bio)|Writer[\s-]?Note|(?:Note|Editor[\s-]?Note)[\s-]?to[\s-]?(?:writer|editor|self)?|Insert|TODO|Placeholder|NEEDS[\s-]?CITATION|CITATION|SOURCE|CTA|Pull[\s-]?Quote|Hook|Quote|Link|Image|Tip|Callout|Stat|Fact[\s-]?Check)\s*[:\s][^\]]*\]/gi;
  // Standalone paragraph: entire paragraph is just a bracketed instruction with a colon
  // (e.g. "[Something: details]" alone on its own line — the scaffolding signature)
  const STANDALONE_COLON_BRACKET_RX = /^\s*\[[^\]]*:[^\]]*\]\s*$/;

  const cleanBody = (text) => {
    if (!text || typeof text !== 'string') return text;
    const parts = text.split(/\n\s*\n/);
    const filtered = parts
      .map(p => p.replace(INLINE_RX, '').replace(/[ \t]{2,}/g, ' ').trim())
      .filter(p => p && !STANDALONE_COLON_BRACKET_RX.test(p));
    return filtered.join('\n\n').trim();
  };

  article.sections = article.sections.map(s => {
    const updated = { ...s };
    if (typeof s.body === 'string') updated.body = cleanBody(s.body);
    if (typeof s.content === 'string') updated.content = cleanBody(s.content);
    return updated;
  });
  return article;
}
