import { describe, it, expect } from 'vitest';
import { normalizeGeoData } from '../src/server/geo.js';

describe('normalizeGeoData', () => {
  it('buckets topical-authority priority by score and reads many score aliases', () => {
    const out = normalizeGeoData(
      {},
      { gapsByCluster: [
        { topic: 'A', geoCitationScore: 80 },
        { cluster: 'B', score: 50 },
        { name: 'C', probability: 10 },
      ] },
      [], [], null,
    );
    expect(out.topicalAuthorityMap.map(t => [t.topic, t.priority])).toEqual([
      ['A', 'high'], ['B', 'medium'], ['C', 'low'],
    ]);
  });

  it('maps GEO opportunities onto per-platform columns', () => {
    const out = normalizeGeoData({}, {}, [
      { topic: 'T', platform: 'ChatGPT', score: 7 },
      { topic: 'T', platform: 'Perplexity', score: 9, quickWin: true },
      { topic: 'T', platform: 'Google AI Overviews', score: 5 },
    ], [], null);
    expect(out.geoOpportunities).toEqual([
      { topic: 'T', chatgpt: 7, perplexity: 9, aiOverviews: 5, gemini: 0, quickWin: true },
    ]);
  });

  it('builds geoBrief with title fallback to brand_name and the default lift', () => {
    const out = normalizeGeoData({ h2s: ['One', { heading: 'Two' }] }, {}, [], [], { brand_name: 'Acme' });
    expect(out.geoBrief.title).toBe('Acme');
    expect(out.geoBrief.h2s).toEqual(['One', 'Two']);
    expect(out.geoBrief.estimatedCitationLift).toContain('90 days');
  });
});
