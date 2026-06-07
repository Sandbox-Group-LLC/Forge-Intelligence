import { describe, it, expect } from 'vitest';
import { urlHasDomain, isCited, findCitedSection, CITATION_ENGINES, extractDomain, aggregateSources, brandTokens, scanVisibility, probeGemini, probePerplexity, probeAIOverviews } from '../src/server/geoProbe.js';

describe('probeAIOverviews — ValueSERP branch', () => {
  const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body });
  it('deep-collects AI-overview text + source links regardless of exact schema', async () => {
    process.env.VALUESERP_API_KEY = 'test-key';
    try {
      const body = { ai_overview: { contents: [{ snippet: 'Nike and Adidas lead running.' }], sources: [{ link: 'https://nike.com/run' }, { url: 'https://adidas.com' }] } };
      const out = await probeAIOverviews('best running shoes', async () => fakeRes(200, body));
      expect(out.text).toContain('Nike');
      expect(out.urls).toEqual(expect.arrayContaining(['https://nike.com/run', 'https://adidas.com']));
    } finally { delete process.env.VALUESERP_API_KEY; }
  });
  it('throws on a ValueSERP failure response', async () => {
    process.env.VALUESERP_API_KEY = 'test-key';
    try {
      await expect(probeAIOverviews('q', async () => fakeRes(401, { request_info: { success: false, message: 'invalid api key' } })))
        .rejects.toThrow(/valueserp/);
    } finally { delete process.env.VALUESERP_API_KEY; }
  });
  it('returns empty when no AI overview is shown', async () => {
    process.env.VALUESERP_API_KEY = 'test-key';
    try {
      const out = await probeAIOverviews('q', async () => fakeRes(200, { request_info: { success: true } }));
      expect(out).toEqual({ text: '', urls: [] });
    } finally { delete process.env.VALUESERP_API_KEY; }
  });
});

const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body });

describe('engine probes throw on API errors (so a dead engine is excluded, not scored a false 0%)', () => {
  it('probeGemini throws on an expired-key 400', async () => {
    await expect(probeGemini('q', async () => fakeRes(400, { error: { message: 'API key expired. Please renew the API key.' } })))
      .rejects.toThrow(/gemini 400/);
  });
  it('probePerplexity throws on a non-OK response', async () => {
    await expect(probePerplexity('q', async () => fakeRes(401, { error: { message: 'unauthorized' } })))
      .rejects.toThrow(/perplexity 401/);
  });
  it('probeGemini returns text + grounding urls on success', async () => {
    const body = { candidates: [{ content: { parts: [{ text: 'Nike leads.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://nike.com' } }] } }] };
    const out = await probeGemini('q', async () => fakeRes(200, body));
    expect(out.text).toContain('Nike');
    expect(out.urls).toContain('https://nike.com');
  });
});

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

describe('extractDomain', () => {
  it('pulls the host and strips www', () => {
    expect(extractDomain('https://www.Cvent.com/products/x?y=1')).toBe('cvent.com');
  });
  it('handles a bare domain', () => {
    expect(extractDomain('jasper.ai')).toBe('jasper.ai');
  });
  it('is null-safe / returns empty for junk', () => {
    expect(extractDomain(null)).toBe('');
    expect(extractDomain('')).toBe('');
  });
});

describe('aggregateSources', () => {
  it('counts domains, excludes the brand and scan noise, sorts desc', () => {
    const urls = [
      'https://cvent.com/a', 'https://www.cvent.com/b',
      'https://swoogo.com/x',
      'https://brand.com/own',                      // brand — excluded
      'https://vertexaisearch.cloud.google.com/r',  // noise — excluded
      'https://google.com/search',                  // noise — excluded
    ];
    expect(aggregateSources(urls, 'brand.com')).toEqual([
      { domain: 'cvent.com', mentions: 2 },
      { domain: 'swoogo.com', mentions: 1 },
    ]);
  });
  it('respects the limit', () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    expect(aggregateSources(urls, 'brand.com', 2)).toHaveLength(2);
  });
  it('is empty-safe', () => {
    expect(aggregateSources([], 'brand.com')).toEqual([]);
    expect(aggregateSources(null, 'brand.com')).toEqual([]);
  });
});

describe('brandTokens', () => {
  it('includes the brand name and the domain SLD', () => {
    expect(brandTokens('Nova Intelligence', 'novaintelligenceai.com')).toEqual(['nova intelligence', 'novaintelligenceai']);
  });
  it('drops too-short tokens', () => {
    // name "Hi" (<=2) dropped; SLD "ab" (<=3) dropped
    expect(brandTokens('Hi', 'ab.com')).toEqual([]);
  });
  it('dedupes when name equals SLD', () => {
    expect(brandTokens('nike', 'nike.com')).toEqual(['nike']);
  });
});

describe('scanVisibility', () => {
  it('cited when the brand domain is linked', () => {
    expect(scanVisibility({ text: 'great shoes', urls: ['https://nike.com/x'], brandName: 'Nike', brandDomain: 'nike.com' }))
      .toEqual({ visible: true, status: 'cited' });
  });
  it('mentioned when the brand NAME appears in text but no link (the Nike bug)', () => {
    const r = scanVisibility({ text: 'Nike and Adidas dominate running.', urls: ['https://runrepeat.com'], brandName: 'Nike', brandDomain: 'nike.com' });
    expect(r).toEqual({ visible: true, status: 'mentioned' });
  });
  it('matches a possessive ("Nike’s") via word boundary', () => {
    expect(scanVisibility({ text: "Nike's Vaporfly is popular", urls: [], brandName: 'Nike', brandDomain: 'nike.com' }).visible).toBe(true);
  });
  it('absent when neither name nor domain appears', () => {
    expect(scanVisibility({ text: 'Adidas and Puma lead here', urls: ['https://x.com'], brandName: 'Nike', brandDomain: 'nike.com' }))
      .toEqual({ visible: false, status: 'absent' });
  });
  it('does not match the token as a substring of another word', () => {
    // "nova" should not match "innovation"
    expect(scanVisibility({ text: 'this drives innovation forward', urls: [], brandName: 'Nova', brandDomain: 'nova.io' }).visible).toBe(false);
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
