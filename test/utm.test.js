import { describe, it, expect } from 'vitest';
import { resolveUtmParams, buildUtmString } from '../src/server/utm.js';

describe('resolveUtmParams', () => {
  it('substitutes all placeholders from context', () => {
    const out = resolveUtmParams(
      { utm_campaign: '{campaign_slug}', utm_content: '{article_slug}', utm_source: '{brand_slug}', utm_medium: '{channel}' },
      { campaignSlug: 'q1', articleSlug: 'how-to', brandSlug: 'acme', channel: 'linkedin' }
    );
    expect(out).toEqual({ utm_campaign: 'q1', utm_content: 'how-to', utm_source: 'acme', utm_medium: 'linkedin' });
  });

  it('falls back to defaults when context fields are missing (channel falls back to the key)', () => {
    const out = resolveUtmParams({ utm_campaign: '{campaign_slug}', utm_medium: '{channel}' }, {});
    expect(out).toEqual({ utm_campaign: 'forge', utm_medium: 'utm_medium' });
  });

  it('passes literals through unchanged', () => {
    expect(resolveUtmParams({ utm_source: 'newsletter' }, {})).toEqual({ utm_source: 'newsletter' });
  });
});

describe('buildUtmString', () => {
  it('serializes params into a url-encoded query string', () => {
    expect(buildUtmString({ utm_source: 'acme', utm_campaign: 'spring sale' }))
      .toBe('utm_source=acme&utm_campaign=spring%20sale');
  });

  it('returns an empty string for empty params', () => {
    expect(buildUtmString({})).toBe('');
  });
});
