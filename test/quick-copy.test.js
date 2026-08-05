import { describe, it, expect } from 'vitest';
import {
  clampVariantCount,
  findExcerptRange,
  anchorComplianceFlags,
  buildAnnotatedSegments,
  cleanCopyText,
  formatConstraintBlock,
  applyExcerptRewrite,
  uniqueRecentPrompts,
  QUICK_COPY_FORMATS,
} from '../src/server/quick-copy.js';

describe('clampVariantCount', () => {
  it('defaults invalid input to 2', () => {
    expect(clampVariantCount(undefined)).toBe(2);
    expect(clampVariantCount('nope')).toBe(2);
    expect(clampVariantCount(NaN)).toBe(2);
  });
  it('clamps to 1–4 and rounds', () => {
    expect(clampVariantCount(0)).toBe(1);
    expect(clampVariantCount(1)).toBe(1);
    expect(clampVariantCount(3.6)).toBe(4);
    expect(clampVariantCount(99)).toBe(4);
  });
});

describe('findExcerptRange', () => {
  it('returns first exact match', () => {
    expect(findExcerptRange('We grew 3x pipeline last quarter.', '3x pipeline'))
      .toEqual({ start: 8, end: 19 });
  });
  it('returns null when missing or empty', () => {
    expect(findExcerptRange('hello', 'goodbye')).toBeNull();
    expect(findExcerptRange('hello', '   ')).toBeNull();
    expect(findExcerptRange(null, 'x')).toBeNull();
  });
});

describe('anchorComplianceFlags', () => {
  const body = 'We deliver 3x pipeline in 90 days with synergy-driven solutions.';

  it('numbers flags in document order and drops unmatched excerpts', () => {
    const flags = anchorComplianceFlags(body, [
      { severity: 'yellow', type: 'brand_voice', excerpt: 'synergy-driven solutions', reason: 'voice drift' },
      { severity: 'red', type: 'factual_claim', excerpt: '3x pipeline in 90 days', reason: 'unverified' },
      { severity: 'red', type: 'factual_claim', excerpt: 'not in the body', reason: 'hallucinated' },
    ]);
    expect(flags.map((f) => f.n)).toEqual([1, 2]);
    expect(flags[0].excerpt).toBe('3x pipeline in 90 days');
    expect(flags[0].severity).toBe('red');
    expect(flags[1].excerpt).toBe('synergy-driven solutions');
    expect(flags[1].start).toBeLessThan(flags[1].end);
  });

  it('skips overlapping ranges', () => {
    const flags = anchorComplianceFlags(body, [
      { excerpt: '3x pipeline in 90 days', severity: 'red', type: 'factual_claim', reason: 'a' },
      { excerpt: 'pipeline in 90', severity: 'yellow', type: 'factual_claim', reason: 'b' },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0].excerpt).toBe('3x pipeline in 90 days');
  });
});

describe('buildAnnotatedSegments', () => {
  it('splits body into text + flag segments with superscript numbers', () => {
    const body = 'Hello 3x world today.';
    const flags = anchorComplianceFlags(body, [
      { excerpt: '3x', severity: 'red', type: 'factual_claim', reason: 'metric' },
    ]);
    const segs = buildAnnotatedSegments(body, flags, []);
    expect(segs).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'flag', text: '3x', n: 1, severity: 'red' },
      { kind: 'text', text: ' world today.' },
    ]);
  });

  it('omits dismissed flags from annotation', () => {
    const body = 'Hello 3x world.';
    const flags = anchorComplianceFlags(body, [
      { excerpt: '3x', severity: 'red', type: 'factual_claim', reason: 'metric' },
    ]);
    const segs = buildAnnotatedSegments(body, flags, [1]);
    expect(segs).toEqual([{ kind: 'text', text: 'Hello 3x world.' }]);
  });
});

describe('cleanCopyText', () => {
  it('returns raw body only', () => {
    expect(cleanCopyText('Subject line stays separate.\nBody here.')).toBe(
      'Subject line stays separate.\nBody here.'
    );
    expect(cleanCopyText(null)).toBe('');
  });
});

describe('formatConstraintBlock', () => {
  it('includes format, platform, and social hard limits', () => {
    const block = formatConstraintBlock({ format: 'social_post', platform: 'x', lengthHint: 'short' });
    expect(block).toContain('FORMAT: social_post');
    expect(block).toContain('PLATFORM: x');
    expect(block).toContain('280');
    expect(block).toContain('LENGTH: short');
  });
});

describe('QUICK_COPY_FORMATS', () => {
  it('includes the v1 preset set', () => {
    expect(QUICK_COPY_FORMATS).toEqual(expect.arrayContaining([
      'email_reply', 'cold_email', 'dm', 'social_post', 'comment', 'custom',
    ]));
  });
});

describe('applyExcerptRewrite', () => {
  it('replaces the first exact excerpt', () => {
    expect(applyExcerptRewrite('We grew 3x pipeline fast.', '3x pipeline', 'strong pipeline growth'))
      .toBe('We grew strong pipeline growth fast.');
  });
  it('returns null when excerpt missing', () => {
    expect(applyExcerptRewrite('hello', 'goodbye', 'x')).toBeNull();
    expect(applyExcerptRewrite(null, 'a', 'b')).toBeNull();
  });
});

describe('uniqueRecentPrompts', () => {
  it('dedupes case-insensitively and keeps newest-first order', () => {
    const out = uniqueRecentPrompts([
      { id: '1', prompt: 'Reply to pricing', format: 'email_reply' },
      { id: '2', prompt: 'reply to pricing', format: 'email_reply' },
      { id: '3', prompt: 'LinkedIn DM after like', format: 'dm' },
      { id: '4', prompt: '   ' },
    ], 8);
    expect(out).toHaveLength(2);
    expect(out[0].prompt).toBe('Reply to pricing');
    expect(out[1].prompt).toBe('LinkedIn DM after like');
  });
  it('respects limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ prompt: `Prompt ${i}` }));
    expect(uniqueRecentPrompts(rows, 3)).toHaveLength(3);
  });
});
