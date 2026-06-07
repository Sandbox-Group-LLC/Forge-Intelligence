import { describe, it, expect } from 'vitest';
import { MARKETING_META, renderMarketingPage } from '../src/server/marketing.js';

const HTML = '<html><head><title>old</title></head><body><div id="root"></div></body></html>';

describe('MARKETING_META', () => {
  it('covers the three public marketing routes', () => {
    expect(Object.keys(MARKETING_META).sort()).toEqual(['/', '/faq', '/product']);
    for (const k of ['/', '/faq', '/product']) {
      expect(typeof MARKETING_META[k].title).toBe('string');
      expect(typeof MARKETING_META[k].description).toBe('string');
      expect(typeof MARKETING_META[k].bodyContent).toBe('string');
    }
  });
});

describe('renderMarketingPage', () => {
  it('injects title, description, canonical, OG + the Org/WebSite JSON-LD', () => {
    const out = renderMarketingPage(MARKETING_META['/'], HTML, '/');
    expect(out).toContain(`<title>${MARKETING_META['/'].title.replace(/"/g, '&quot;')}</title>`);
    expect(out).toContain('<link rel="canonical" href="https://forgeintelligence.ai/" />');
    expect(out).toContain('"@type":"Organization"');
    expect(out).toContain('"@type":"WebSite"');
    // dropped the original <title>old</title>
    expect(out).not.toContain('<title>old</title>');
  });

  it('only emits FAQPage JSON-LD on the /faq route', () => {
    expect(renderMarketingPage(MARKETING_META['/faq'], HTML, '/faq')).toContain('"@type":"FAQPage"');
    expect(renderMarketingPage(MARKETING_META['/'], HTML, '/')).not.toContain('"@type":"FAQPage"');
  });

  it('injects crawler-visible body content inside #root', () => {
    const out = renderMarketingPage(MARKETING_META['/product'], HTML, '/product');
    expect(out).toContain('<div id="root"><div style="position:absolute;left:-99999px');
    expect(out).toContain('The Forge Product');
  });

  it('uses the per-meta ogImage override when provided, else the default card', () => {
    expect(renderMarketingPage({ ...MARKETING_META['/'], ogImage: 'https://x/y.png' }, HTML, '/'))
      .toContain('content="https://x/y.png"');
    expect(renderMarketingPage(MARKETING_META['/'], HTML, '/'))
      .toContain('https://forgeintelligence.ai/og-card.png');
  });
});
