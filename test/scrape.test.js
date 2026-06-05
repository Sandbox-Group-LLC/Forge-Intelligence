import { describe, it, expect } from 'vitest';
import { looksLikeSpaShell } from '../src/server/scrape.js';

describe('looksLikeSpaShell', () => {
  it('returns false for empty/nullish input', () => {
    expect(looksLikeSpaShell('')).toBe(false);
    expect(looksLikeSpaShell(null)).toBe(false);
  });

  it('detects an empty framework root div (React / Next / Svelte / Nuxt)', () => {
    expect(looksLikeSpaShell('<html><body><div id="root"></div></body></html>')).toBe(true);
    expect(looksLikeSpaShell('<body><div id="__next"></div></body>')).toBe(true);
  });

  it('treats a tiny body (after stripping scripts) as a shell', () => {
    expect(looksLikeSpaShell('<body><p>hi</p><script>var a=1;</script></body>')).toBe(true);
  });

  it('returns false for a body with real content', () => {
    const body = '<p>' + 'Real article content. '.repeat(40) + '</p>'; // >500 chars
    expect(looksLikeSpaShell(`<html><body>${body}</body></html>`)).toBe(false);
  });
});
