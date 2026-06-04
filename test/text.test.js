import { describe, it, expect } from 'vitest';
import { truncateStr, truncateAtSentence, stripSocialMarkdown } from '../src/server/text.js';

describe('truncateStr', () => {
  it('returns null for null/undefined', () => {
    expect(truncateStr(null, 5)).toBeNull();
    expect(truncateStr(undefined, 5)).toBeNull();
  });
  it('leaves short strings unchanged', () => {
    expect(truncateStr('hi', 5)).toBe('hi');
  });
  it('hard-truncates longer strings with no ellipsis', () => {
    expect(truncateStr('hello world', 5)).toBe('hello');
  });
  it('coerces non-strings', () => {
    expect(truncateStr(12345, 3)).toBe('123');
  });
});

describe('truncateAtSentence', () => {
  it('returns empty string for non-string input', () => {
    expect(truncateAtSentence(null, 10)).toBe('');
  });
  it('returns trimmed text when under the limit', () => {
    expect(truncateAtSentence('  short.  ', 100)).toBe('short.');
  });
  it('prefers a sentence boundary', () => {
    expect(truncateAtSentence('First sentence. Second sentence that overflows the window.', 20)).toBe('First sentence.');
  });
  it('falls back to a word boundary with an ellipsis', () => {
    const out = truncateAtSentence('one two three four five six seven', 18);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('one two')).toBe(true);
  });
});

describe('stripSocialMarkdown', () => {
  it('removes heading markers', () => {
    expect(stripSocialMarkdown('# Title\n## Sub')).toBe('Title\nSub');
  });
  it('unwraps **bold** and __bold__', () => {
    expect(stripSocialMarkdown('a **bold** and __also__ here')).toBe('a bold and also here');
  });
  it('passes non-strings through unchanged', () => {
    expect(stripSocialMarkdown(null)).toBeNull();
  });
});
