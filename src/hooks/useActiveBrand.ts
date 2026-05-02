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
  // 7-day full-access trial state surfaced by /api/auth/me. Null when user is
  // unauth, super admin, or not eligible (existing free-tier signups predating
  // TRIAL_LAUNCH_MARKER on the server).
  const [trial, setTrial] = useState<{ active: boolean; eligible: boolean; daysRemaining: number; endsAt: string | null } | null>(null);
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
          // Priority order for brand ID:
          //   1. ?brand=<uuid> in URL — explicit request (e.g., preview CTA) always wins
          //   2. forge_pending_brand_id — set by switchBrand() for in-app brand switching
          //   3. forge_active_brand_id — last-used brand cached from prior session
          const urlParams = new URLSearchParams(window.location.search);
          const urlBrandId = urlParams.get('brand') || '';
          const pendingBrandId = localStorage.getItem('forge_pending_brand_id') || '';
          if (pendingBrandId) localStorage.removeItem('forge_pending_brand_id');

          const savedBrandId = localStorage.getItem('forge_active_brand_id') || '';
          const brandIdToUse = urlBrandId || pendingBrandId || savedBrandId || '';

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
          setTrial(d.trial || null);

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
          setTrial(null);

          // URL-first for unauthenticated users too — preview CTA sends prospects here
          // with ?brand=<uuid>. Without this, they land empty and see 'no active brand.'
          const urlParams = new URLSearchParams(window.location.search);
          const urlBrandId = urlParams.get('brand') || '';
          if (urlBrandId) {
            try {
              const check = await fetch(`/api/context-hub/brand/${urlBrandId}`);
              if (check.ok) {
                const dbBrand = await check.json();
                const dbData = dbBrand.data || dbBrand;
                const dbExpiry = dbData.expires_at || dbData.expiresAt;
                const dbPaid = dbData.is_paid || dbData.isPaid;
                const actuallyExpired = !dbPaid && dbExpiry && new Date(dbExpiry) < new Date();
                if (!actuallyExpired) {
                  const active = {
                    id: dbData.id || urlBrandId,
                    brandName: dbData.brand_name || dbData.brandName,
                    brandUrl: dbData.brand_url || dbData.brandUrl,
                    isPaid: dbPaid || false,
                    expiresAt: dbExpiry || null,
                  };
                  try {
                    localStorage.setItem('forge_active_brand', JSON.stringify(active));
                    localStorage.setItem('forge_active_brand_id', active.id);
                  } catch {}
                  setBrand(active);
                  setLoading(false);
                  return;
                }
              }
            } catch { /* fall through to localStorage */ }
          }

          const stored = localStorage.getItem('forge_active_brand');
          if (stored) {
            try {
              const b = JSON.parse(stored);
              // Always verify with DB — promo codes may have cleared expires_at
              try {
                const check = await fetch(`/api/context-hub/brand/${b.id}`);
                if (!check.ok) {
                  localStorage.removeItem('forge_active_brand');
                  localStorage.removeItem('forge_active_brand_id');
                  setBrand(null);
                  setLoading(false);
                  return;
                }
                const dbBrand = await check.json();
                const dbData = dbBrand.data || dbBrand;
                const dbExpiry = dbData.expires_at || dbData.expiresAt;
                const dbPaid = dbData.is_paid || dbData.isPaid;
                const actuallyExpired = !dbPaid && dbExpiry && new Date(dbExpiry) < new Date();
                if (actuallyExpired) {
                  localStorage.removeItem('forge_active_brand');
                  localStorage.removeItem('forge_active_brand_id');
                  setBrand(null);
                  setLoading(false);
                  return;
                }
                // Update localStorage with fresh DB values
                const updated = { ...b, isPaid: dbPaid || false, expiresAt: dbExpiry || null };
                try { localStorage.setItem('forge_active_brand', JSON.stringify(updated)); } catch {}
                setBrand({
                  id: b.id,
                  brandName: dbData.brand_name || b.brandName,
                  brandUrl: dbData.brand_url || b.brandUrl,
                  isPaid: dbPaid || false,
                  expiresAt: dbExpiry || null,
                });
              } catch {
                // Network error — fall back to localStorage expiry check
                const expired = b.expiresAt && new Date(b.expiresAt) < new Date();
                if (expired) {
                  localStorage.removeItem('forge_active_brand');
                  localStorage.removeItem('forge_active_brand_id');
                  setBrand(null);
                } else {
                  setBrand({
                    id: b.id,
                    brandName: b.brandName,
                    brandUrl: b.brandUrl,
                    isPaid: b.isPaid || false,
                    expiresAt: b.expiresAt,
                  });
                }
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

  return { brand, loading, refetch, allBrands, isSuperAdmin, switchBrand, trial };
}
