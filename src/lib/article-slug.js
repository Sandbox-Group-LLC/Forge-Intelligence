// Public article-slug helpers shared by the publishing dispatcher and the
// Publishing Queue UI. Keep this file dependency-free so both sides can import it.
//
// Agentcy Core and BrianBMorgan share brianbmorgan.com/thought-leadership.
// Mailforge namespaces Agentcy files with a trailing `-agentcy-core`
// (ForgeOS-mailforge/forge-publish.js applySlugSuffix). FI still sends the
// unsuffixed webhook slug; Mailforge adds the suffix and is idempotent if we
// ever send it pre-suffixed. Social/UTM/canonical URLs are built here, so they
// must apply the same public suffix or they 404.

export const AGENTCY_CORE_BRAND_ID = 'f11df1f0-b1b2-4688-94f9-5e0f85d99977';
export const AGENTCY_CORE_SLUG_SUFFIX = '-agentcy-core';
export const PUBLIC_SLUG_MAX = 120;

export function toArticleSlug(title, fallback = 'article') {
  const slug = String(title || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function isAgentcyCoreBrand(brand) {
  if (brand == null) return false;
  if (typeof brand === 'string') {
    const value = brand.trim().toLowerCase();
    return value === AGENTCY_CORE_BRAND_ID || value.includes('agentcy-core') || value === 'agentcy core';
  }
  const id = String(brand.brandId || brand.brand_profile_id || brand.id || '').trim().toLowerCase();
  if (id === AGENTCY_CORE_BRAND_ID) return true;
  const hay = `${brand.brandUrl || brand.brand_url || ''} ${brand.brandName || brand.brand_name || ''}`.toLowerCase();
  return hay.includes('agentcy-core') || hay.includes('agentcy core');
}

// Mirror Mailforge applySlugSuffix: idempotent, then cap at PUBLIC_SLUG_MAX
// while keeping the suffix intact.
export function applyAgentcyCorePublicSuffix(slug) {
  const clean = String(slug || '').replace(/^-+|-+$/g, '');
  if (!clean) return clean;
  if (clean.endsWith(AGENTCY_CORE_SLUG_SUFFIX)) return clean;
  const next = `${clean}${AGENTCY_CORE_SLUG_SUFFIX}`;
  if (next.length <= PUBLIC_SLUG_MAX) return next;
  const keep = Math.max(1, PUBLIC_SLUG_MAX - AGENTCY_CORE_SLUG_SUFFIX.length);
  return `${clean.slice(0, keep).replace(/-+$/, '')}${AGENTCY_CORE_SLUG_SUFFIX}`;
}

export function withPublicArticleSlug(slug, brand) {
  if (!isAgentcyCoreBrand(brand)) return slug;
  return applyAgentcyCorePublicSuffix(slug);
}
