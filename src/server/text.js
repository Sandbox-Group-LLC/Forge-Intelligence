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
