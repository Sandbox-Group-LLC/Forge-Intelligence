import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';

export interface ActiveBrand {
  id: string;
  brandName: string;
  brandUrl: string;
  isPaid: boolean;
}

// Returns the authenticated user's brand profile
// Falls back to most recent brand for unauthenticated (landing page flow)
export function useActiveBrand() {
  const [brand, setBrand] = useState<ActiveBrand | null>(null);
  const [loading, setLoading] = useState(true);
  const { isSignedIn, getToken } = useAuth();

  useEffect(() => {
    async function load() {
      try {
        if (isSignedIn) {
          // Authenticated — fetch user's specific brand via /api/auth/me
          // Check localStorage for pending brand_id from post-payment sign-up
          const token = await getToken();
          const pendingBrandId = localStorage.getItem('forge_pending_brand_id') || '';
          if (pendingBrandId) localStorage.removeItem('forge_pending_brand_id');
          const meUrl = pendingBrandId ? `/api/auth/me?brand_id=${encodeURIComponent(pendingBrandId)}` : '/api/auth/me';
          const res = await fetch(meUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const d = await res.json();
          if (d.success && d.brand) {
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
          // Unauthenticated — fall back to most recent brand (landing page flow)
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
          }
        }
      } catch { /* silent */ }
      setLoading(false);
    }
    load();
  }, [isSignedIn]);

  return { brand, loading };
}
