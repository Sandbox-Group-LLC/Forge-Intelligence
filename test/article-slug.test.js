import { describe, it, expect } from 'vitest';
import {
  AGENTCY_CORE_BRAND_ID,
  AGENTCY_CORE_SLUG_SUFFIX,
  applyAgentcyCorePublicSuffix,
  isAgentcyCoreBrand,
  toArticleSlug,
  withPublicArticleSlug,
} from '../src/lib/article-slug.js';

describe('toArticleSlug', () => {
  it('slugifies a title the same way publishing does', () => {
    expect(toArticleSlug("The Audit Gap Hidden Inside Every Agency's Client Knowledge Problem"))
      .toBe('the-audit-gap-hidden-inside-every-agency-s-client-knowledge-problem');
  });
});

describe('isAgentcyCoreBrand', () => {
  it('matches the Agentcy Core brand UUID', () => {
    expect(isAgentcyCoreBrand(AGENTCY_CORE_BRAND_ID)).toBe(true);
    expect(isAgentcyCoreBrand({ brandId: AGENTCY_CORE_BRAND_ID })).toBe(true);
  });

  it('matches Agentcy Core by name/url without colliding with brianbmorgan', () => {
    expect(isAgentcyCoreBrand({ brandName: 'Agentcy Core' })).toBe(true);
    expect(isAgentcyCoreBrand({ brand_url: 'https://agentcy-core.com' })).toBe(true);
    expect(isAgentcyCoreBrand({ brandId: 'e6f79032-51ed-4d0c-83ee-d39a648cea0b', brandName: 'Brian B. Morgan' })).toBe(false);
  });
});

describe('applyAgentcyCorePublicSuffix', () => {
  it('appends the Mailforge namespace once', () => {
    expect(applyAgentcyCorePublicSuffix('the-audit-gap-hidden-inside-every-agency-s-client-knowledge-problem'))
      .toBe('the-audit-gap-hidden-inside-every-agency-s-client-knowledge-problem-agentcy-core');
  });

  it('is idempotent if Mailforge already namespaced the slug', () => {
    const slugged = `how-agencies-keep-client-knowledge-agentcy-core`;
    expect(applyAgentcyCorePublicSuffix(slugged)).toBe(slugged);
  });

  it('keeps the suffix when truncating to 120 chars', () => {
    const long = 'a'.repeat(130);
    const out = applyAgentcyCorePublicSuffix(long);
    expect(out.endsWith(AGENTCY_CORE_SLUG_SUFFIX)).toBe(true);
    expect(out.length).toBe(120);
  });
});

describe('withPublicArticleSlug', () => {
  it('only suffixes Agentcy Core public URLs', () => {
    const slug = 'the-audit-gap-hidden-inside-every-agency-s-client-knowledge-problem';
    expect(withPublicArticleSlug(slug, AGENTCY_CORE_BRAND_ID)).toBe(`${slug}${AGENTCY_CORE_SLUG_SUFFIX}`);
    expect(withPublicArticleSlug(slug, 'e6f79032-51ed-4d0c-83ee-d39a648cea0b')).toBe(slug);
  });
});
