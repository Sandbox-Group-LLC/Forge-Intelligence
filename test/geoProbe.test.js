import { describe, it, expect } from 'vitest';
import { urlHasDomain, isCited, findCitedSection, CITATION_ENGINES } from '../src/server/geoProbe.js';

describe('urlHasDomain', () => {
  it('matches a domain inside a URL (case-insensitive)', () => {
    expect(urlHasDomain('https://Forge.Example.com/post', 'forge.example.com')).toBe(true);
  });
  it('does not match a different domain', () => {
    expect(urlHasDomain('https://competitor.com', 'forge.example.com')).toBe(false);
  });
  it('is null-safe', () => {
    expect(urlHasDomain(null, 'forge.example.com')).toBe(false);
    expect(urlHasDomain('https://forge.example.com', '')).toBe(false);
  });
});

describe('isCited', () => {
  const dom = 'forge.example.com';
  it('true when a cited URL is on the brand domain', () => {
    expect(isCited({ text: 'answer', urls: ['https://forge.example.com/x'], brandDomain: dom })).toBe(true);
  });
  it('true when the domain appears in the answer text', () => {
    expect(isCited({ text: 'see forge.example.com for more', urls: [], brandDomain: dom })).toBe(true);
  });
  it('false when neither URL nor text mentions the domain', () => {
    expect(isCited({ text: 'competitors win', urls: ['https://competitor.com'], brandDomain: dom })).toBe(false);
  });
  it('false with no brand domain', () => {
    expect(isCited({ text: 'anything', urls: ['https://x.com'], brandDomain: '' })).toBe(false);
  });
});

describe('findCitedSection', () => {
  const brandDomain = 'forge.example.com';
  const sections = [{ heading: 'Pipeline Attribution', body: 'measuring pipeline attribution across multiple marketing events accurately' }];
  const faqs = [{ question: 'What is cross-event portfolio benchmarking?', answer: 'benchmarking compares portfolio performance across recurring events' }];

  it('attributes to a section body on strong word overlap', () => {
    const text = 'measuring pipeline attribution across multiple marketing events accurately matters';
    expect(findCitedSection({ text, urls: [], brandDomain, sections, faqs })).toBe('Pipeline Attribution');
  });
  it('falls through to an FAQ when no section matches', () => {
    const text = 'benchmarking compares portfolio performance across recurring events for teams';
    expect(findCitedSection({ text, urls: [], brandDomain, sections: [], faqs })).toBe('FAQ: What is cross-event portfolio benchmarking?');
  });
  it('truncates long FAQ questions to 60 chars', () => {
    const longQ = 'How do enterprise marketing teams measure and attribute multi-event pipeline influence over time?';
    const text = 'enterprise marketing teams measure attribute multi-event pipeline influence';
    const out = findCitedSection({ text, urls: [], brandDomain, sections: [], faqs: [{ question: longQ, answer: text }] });
    expect(out.startsWith('FAQ: ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
  it('falls back to "Article URL cited" when cited by link but no content overlap', () => {
    expect(findCitedSection({ text: 'unrelated text', urls: ['https://forge.example.com/p'], brandDomain, sections, faqs }))
      .toBe('Article URL cited');
  });
  it('falls back to "Brand mention" when cited by text only', () => {
    expect(findCitedSection({ text: 'unrelated text', urls: ['https://competitor.com'], brandDomain, sections, faqs }))
      .toBe('Brand mention');
  });
});

describe('CITATION_ENGINES', () => {
  it('registers all four engines in display order', () => {
    expect(CITATION_ENGINES.map(e => e.id)).toEqual(['perplexity', 'chatgpt', 'gemini', 'aiOverviews']);
  });
  it('each engine has an enabled() gate and a probe() fn', () => {
    for (const e of CITATION_ENGINES) {
      expect(typeof e.enabled).toBe('function');
      expect(typeof e.probe).toBe('function');
    }
  });
});
