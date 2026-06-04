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
