import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';

export interface ActiveBrand {
  id: string;
  brandName: string;
  brandUrl: string;
  isPaid: boolean;
  expiresAt?: string | null;
  updatedAt?: string | null;
}

export interface BrandMini {
  id: string;
  brandName: string;
  brandUrl: string;
  isPaid: boolean;
}

export function useActiveBrand() {
  const [brand, setBrand] = useState<ActiveBrand | null>(null);
  const [allBrands, setAllBrands] = useState<BrandMini[]>([]);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const { isSignedIn, isLoaded, getToken } = useAuth();

  const refetch = useCallback(() => setTick(t => t + 1), []);

  const switchBrand = useCallback((brandId: string) => {
    localStorage.setItem('forge_active_brand_id', brandId);
    localStorage.setItem('forge_pending_brand_id', brandId);
    setTick(t => t + 1);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    async function load() {
      setLoading(true);
      try {
        if (isSignedIn) {
          // Authenticated — server is the source of truth
          const pendingBrandId = localStorage.getItem('forge_pending_brand_id') || '';
          if (pendingBrandId) localStorage.removeItem('forge_pending_brand_id');

          const savedBrandId = localStorage.getItem('forge_active_brand_id') || '';
          const brandIdToUse = pendingBrandId || savedBrandId || '';

          const token = await getToken({ template: 'jwt-template-600' });
          if (token) (window as any).__forgeToken = token;
          const url = brandIdToUse
            ? `/api/auth/me?brand_id=${encodeURIComponent(brandIdToUse)}`
            : '/api/auth/me';

          const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
          const d = await res.json();
          console.log('[Auth] /api/auth/me →', { success: d.success, isSuperAdmin: d.isSuperAdmin, allBrandsCount: d.allBrands?.length, brandId: d.brand?.id });

          setIsSuperAdmin(d.isSuperAdmin || false);
          setAllBrands(d.allBrands || []);

          if (d.success && d.brand) {
            setBrand({
              id: d.brand.id,
              brandName: d.brand.brand_name || d.brand.brandName || d.brand.brand_url,
              brandUrl: d.brand.brand_url || d.brand.brandUrl,
              isPaid: d.isPaid || false,
              updatedAt: d.brand.updated_at || null,
            });
            localStorage.setItem('forge_active_brand_id', d.brand.id);
          } else {
            // Brand not found (deleted or expired) — clear ghost references
            setBrand(null);
            localStorage.removeItem('forge_active_brand');
            localStorage.removeItem('forge_active_brand_id');
          }
        } else {
          // Unauthenticated — domain is the session key
          // Brand is stored in localStorage after scan, with expiry
          setIsSuperAdmin(false);
          setAllBrands([]);
          const stored = localStorage.getItem('forge_active_brand');
          if (stored) {
            try {
              const b = JSON.parse(stored);
              const expired = b.expiresAt && new Date(b.expiresAt) < new Date();
              if (expired) {
                localStorage.removeItem('forge_active_brand');
                localStorage.removeItem('forge_active_brand_id');
                setBrand(null);
              } else {
                // Verify brand still exists in DB
                try {
                  const check = await fetch(`/api/context-hub/brand/${b.id}`);
                  if (!check.ok) {
                    localStorage.removeItem('forge_active_brand');
                    localStorage.removeItem('forge_active_brand_id');
                    setBrand(null);
                    setLoading(false);
                    return;
                  }
                } catch { /* network error — trust localStorage */ }
                setBrand({
                  id: b.id,
                  brandName: b.brandName,
                  brandUrl: b.brandUrl,
                  isPaid: b.isPaid || false,
                  expiresAt: b.expiresAt,
                });
              }
            } catch {
              setBrand(null);
            }
          } else {
            setBrand(null);
          }
        }
      } catch (err) {
        console.error('[Auth] useActiveBrand load failed:', err);
      }
      setLoading(false);
    }

    load();
  }, [isLoaded, isSignedIn, tick]);

  return { brand, loading, refetch, allBrands, isSuperAdmin, switchBrand };
}
