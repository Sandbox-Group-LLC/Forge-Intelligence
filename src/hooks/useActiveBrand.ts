import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';

export interface ActiveBrand {
  id: string;
  brandName: string;
  brandUrl: string;
  isPaid: boolean;
}

export function useActiveBrand() {
  const [brand, setBrand] = useState<ActiveBrand | null>(null);
  const [allBrands, setAllBrands] = useState<ActiveBrand[] | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const { isSignedIn, isLoaded, getToken } = useAuth();

  const loadBrands = useCallback(async (selectedBrandId?: string) => {
    setLoading(true);
    try {
      if (isSignedIn) {
        // Check localStorage for pending brand from post-payment flow
        const pendingBrandId = localStorage.getItem('forge_pending_brand_id') || '';
        if (pendingBrandId) localStorage.removeItem('forge_pending_brand_id');

        const brandIdToUse = selectedBrandId || pendingBrandId || '';
        const token = await getToken();
        const meUrl = brandIdToUse
          ? `/api/auth/me?brand_id=${encodeURIComponent(brandIdToUse)}`
          : '/api/auth/me';

        const res = await fetch(meUrl, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const d = await res.json();
        
        if (d.success) {
          setIsSuperAdmin(d.isSuperAdmin || false);
          setAllBrands(d.allBrands || null);
          
          if (d.brand) {
            setBrand({
              id: d.brand.id,
              brandName: d.brand.brand_name || d.brand.brandName || d.brand.brand_url,
              brandUrl: d.brand.brand_url || d.brand.brandUrl,
              isPaid: d.isPaid || false,
            });
          } else {
            setBrand(null);
          }
        } else {
          setBrand(null);
          setAllBrands(null);
        }
      } else {
        // Unauthenticated — use most recent brain from API (landing/free flow)
        const res = await fetch('/api/context-hub/brains');
        const d = await res.json();
        if (d.success && d.data?.length) {
          const b = d.data[0];
          setBrand({
            id: b.id,
            brandName: b.brandName || b.brandUrl,
            brandUrl: b.brandUrl,
            isPaid: b.is_paid || false,
          });
        } else {
          setBrand(null);
        }
        setAllBrands(null);
        setIsSuperAdmin(false);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [isSignedIn, getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    loadBrands();
  }, [isSignedIn, isLoaded, loadBrands]);

  // Switch brand (super admin only)
  const switchBrand = useCallback((brandId: string) => {
    if (!isSuperAdmin) return;
    loadBrands(brandId);
  }, [isSuperAdmin, loadBrands]);

  return { brand, loading, isSuperAdmin, allBrands, switchBrand };
}
