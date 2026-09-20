export const AGENTCY_CORE_BRAND_ID: string;
export const AGENTCY_CORE_SLUG_SUFFIX: string;
export const PUBLIC_SLUG_MAX: number;
export function toArticleSlug(title: string, fallback?: string): string;
export function isAgentcyCoreBrand(
  brand?: string | {
    brandId?: string;
    brand_profile_id?: string;
    id?: string;
    brandUrl?: string;
    brand_url?: string;
    brandName?: string;
    brand_name?: string;
  } | null
): boolean;
export function applyAgentcyCorePublicSuffix(slug: string): string;
export function withPublicArticleSlug(
  slug: string,
  brand?: string | {
    brandId?: string;
    brand_profile_id?: string;
    id?: string;
    brandUrl?: string;
    brand_url?: string;
    brandName?: string;
    brand_name?: string;
  } | null
): string;
