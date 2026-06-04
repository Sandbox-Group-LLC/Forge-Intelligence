// UTM helpers, extracted from server.js during the decomposition.
// Pure functions, no external dependencies.

// Resolve {campaign_slug}/{article_slug}/{brand_slug}/{channel} placeholders in
// a UTM template against a context object.
export function resolveUtmParams(template, ctx) {
  const resolved = {};
  for (const [k, v] of Object.entries(template)) {
    resolved[k] = v
      .replace('{campaign_slug}', ctx.campaignSlug || 'forge')
      .replace('{article_slug}', ctx.articleSlug || 'article')
      .replace('{brand_slug}', ctx.brandSlug || 'brand')
      .replace('{channel}', ctx.channel || k);
  }
  return resolved;
}

// Serialize a params object into a URL-encoded query string.
export function buildUtmString(params) {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
