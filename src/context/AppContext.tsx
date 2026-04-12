import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ViewType, BrandProfile, AnalysisInput, ProcessingStage, HistoryEntry } from '../types';
import { initialProcessingStages, sampleAnalysisInput } from '../data/mockData';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface BrandMini {
  id: string;
  brandName: string;
  brandUrl: string;
  isPaid: boolean;
  updatedAt?: string;
}

interface AppContextType {
  // Auth state - SINGLE SOURCE OF TRUTH
  isAuthLoading: boolean;
  isSuperAdmin: boolean;
  hasAccess: boolean; // true if super admin OR brand is paid
  activeBrand: BrandMini | null;
  allBrands: BrandMini[] | null;
  switchBrand: (brandId: string) => void;

  // Legacy compatibility (maps to new state)
  isPaid: boolean;
  brandLoading: boolean; // alias for isAuthLoading — keeps Sidebar/GateModal compat
  activeBrandId: string | null;
  refetchBrand: () => void; // alias for loadAuth() — keeps Sidebar/GateModal compat
  brandProfile: BrandProfile | null;
  setBrandProfile: (profile: BrandProfile | null) => void;

  // App state
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;
  analysisInput: AnalysisInput;
  setAnalysisInput: (input: AnalysisInput) => void;
  processingStages: ProcessingStage[];
  setProcessingStages: (stages: ProcessingStage[]) => void;
  isProcessing: boolean;
  setIsProcessing: (processing: boolean) => void;
  historyEntries: HistoryEntry[];
  setHistoryEntries: (entries: HistoryEntry[]) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  startAnalysis: () => void;
  loadSampleData: () => void;
  authToken: string;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_BRAND_KEY = 'forge_active_brand_id';

function getSessionId(): string {
  let sessionId = localStorage.getItem('forge_session_id');
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem('forge_session_id', sessionId);
  }
  return sessionId;
}

function mapBrainToHistoryEntry(b: any): HistoryEntry {
  return {
    id: b.id,
    brandUrl: b.brandUrl,
    brandName: b.brandName,
    timestamp: b.updatedAt,
    version: b.version,
    isActive: b.isActive,
    isCached: b.cacheStatus === 'cached'
  };
}

async function fetchBrains(token?: string | null): Promise<HistoryEntry[]> {
  const headers: Record<string, string> = {
    'X-Session-ID': getSessionId()
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/api/context-hub/brains', { headers });
  const data = await res.json();
  return (data.data || []).map(mapBrainToHistoryEntry);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Auth state
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [activeBrand, setActiveBrand] = useState<BrandMini | null>(null);
  const [allBrands, setAllBrands] = useState<BrandMini[] | null>(null);

  // App state
  const [brandProfile, setBrandProfile] = useState<BrandProfile | null>(null);
  const [currentView, setCurrentView] = useState<ViewType>(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    const valid: ViewType[] = ['new-analysis', 'active-run', 'brand-profile', 'strategy', 'brain-history', 'content-generator', 'campaign-generator'];
    return (valid.includes(viewParam as ViewType) ? viewParam : 'new-analysis') as ViewType;
  });
  const [analysisInput, setAnalysisInput] = useState<AnalysisInput>({
    brandUrl: '',
    competitorUrls: [],
    audienceNotes: '',
    strategicNotes: '',
    checkBrainFirst: true,
    saveToBrain: true,
  });
  const [processingStages, setProcessingStages] = useState<ProcessingStage[]>(initialProcessingStages);
  const [isProcessing, setIsProcessing] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem('forge_sidebar_collapsed');
    return stored === 'true';
  });

  // God mode — ?god=ForgeCanvas persists in localStorage; ?ungod clears it
  const godMode = (() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('god') === 'ForgeCanvas') { localStorage.setItem('forge_god_mode', 'true'); return true; }
    if (params.has('ungod')) { localStorage.removeItem('forge_god_mode'); return false; }
    return localStorage.getItem('forge_god_mode') === 'true';
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLE AUTH LOAD - THE ONLY PLACE WE CALL /api/auth/me
  // ─────────────────────────────────────────────────────────────────────────

  const loadAuth = useCallback(async (selectedBrandId?: string) => {
    setIsAuthLoading(true);
    try {
      if (!isSignedIn) {
        setIsSuperAdmin(false);
        setActiveBrand(null);
        setAllBrands(null);
        const brains = await fetchBrains();
        setHistoryEntries(brains);
        setIsAuthLoading(false);
        return;
      }

      const token = await getToken();
      const savedBrandId = localStorage.getItem(ACTIVE_BRAND_KEY) || '';
      const brandIdToUse = selectedBrandId || savedBrandId || '';

      const url = brandIdToUse
        ? `/api/auth/me?brand_id=${encodeURIComponent(brandIdToUse)}`
        : '/api/auth/me';

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();

      if (data.success) {
        setIsSuperAdmin(data.isSuperAdmin || false);

        if (data.allBrands) {
          setAllBrands(data.allBrands);
        }

        if (data.brand) {
          const brand: BrandMini = {
            id: data.brand.id,
            brandName: data.brand.brand_name || data.brand.brandName || data.brand.brand_url,
            brandUrl: data.brand.brand_url || data.brand.brandUrl,
            isPaid: data.brand.is_paid || data.brand.isPaid || false
          };
          setActiveBrand(brand);
          localStorage.setItem(ACTIVE_BRAND_KEY, brand.id);
        }

        const brains = await fetchBrains(token);
        setHistoryEntries(brains);
      }
    } catch (err) {
      console.error('[AppContext] Auth load failed:', err);
    } finally {
      setIsAuthLoading(false);
    }
  }, [isSignedIn, getToken]);

  // Load auth when Clerk is ready
  useEffect(() => {
    if (isLoaded) {
      loadAuth();
    }
  }, [isLoaded, loadAuth]);

  // Keep window.__forgeToken fresh — Clerk tokens expire ~60s, refresh every 55s
  useEffect(() => {
    if (!isSignedIn) return;
    const refresh = async () => {
      const t = await getToken();
      if (t) (window as any).__forgeToken = t;
    };
    refresh();
    const interval = setInterval(refresh, 55_000);
    return () => clearInterval(interval);
  }, [isSignedIn, getToken]);

  // Sidebar collapse persistence
  useEffect(() => {
    localStorage.setItem('forge_sidebar_collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // ─────────────────────────────────────────────────────────────────────────
  // SWITCH BRAND - calls loadAuth with new brand ID
  // ─────────────────────────────────────────────────────────────────────────

  const switchBrand = useCallback((brandId: string) => {
    localStorage.setItem(ACTIVE_BRAND_KEY, brandId);
    loadAuth(brandId);
  }, [loadAuth]);

  // ─────────────────────────────────────────────────────────────────────────
  // DERIVED STATE
  // ─────────────────────────────────────────────────────────────────────────

  // Super admins ALWAYS have access. Regular users need isPaid on their brand.
  const hasAccess = godMode || isSuperAdmin || (activeBrand?.isPaid ?? false);

  // Legacy compatibility
  const isPaid = hasAccess;
  const activeBrandId = activeBrand?.id ?? null;
  const brandLoading = isAuthLoading;
  const refetchBrand = useCallback(() => loadAuth(), [loadAuth]);

  // ─────────────────────────────────────────────────────────────────────────
  // START ANALYSIS — full pipeline (mirrors production)
  // ─────────────────────────────────────────────────────────────────────────

  const startAnalysis = async () => {
    const effectiveUrl = analysisInput.brandUrl;
    setIsProcessing(true);
    setCurrentView('active-run');
    const stages = initialProcessingStages.map(s => ({ ...s, status: 'pending' as const }));
    setProcessingStages(stages);

    // Fire API call immediately — runs concurrently with the stage animation
    const analyzePromise = fetch('/api/context-hub/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandUrl: effectiveUrl,
        sessionId: getSessionId(),
        brandName: (() => {
          const domain = effectiveUrl.replace(/https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
          return domain.charAt(0).toUpperCase() + domain.slice(1);
        })(),
        competitorUrls: analysisInput.competitorUrls,
        audienceNotes: analysisInput.audienceNotes,
        strategicNotes: analysisInput.strategicNotes,
        checkBrainFirst: analysisInput.checkBrainFirst,
        saveToBrain: analysisInput.saveToBrain,
      }),
    }).then(async r => {
      if (r.status === 409) {
        const errData = await r.json();
        window.dispatchEvent(new CustomEvent('forge:scan-blocked', { detail: { message: errData.message } }));
        throw new Error('domain-claimed');
      }
      return r.json();
    });

    // Drive all 5 stages with 75s total timing — matches landing page onboard flow
    // The last stage stays in 'running' until the API resolves — eliminates the dead zone
    // where animation is done but results haven't rendered yet.
    const stageTimings = [12500, 15500, 19000, 15500, 12500];
    let cancelled = false;
    const lastIdx = stageTimings.length - 1;
    const driveStages = async () => {
      for (let i = 0; i < stageTimings.length; i++) {
        if (cancelled) break;
        setProcessingStages(prev => prev.map((s, idx) =>
          idx === i ? { ...s,
            status: 'running' as const,
            startTime: Date.now(),
            // Last stage label updates to signal we're waiting on the API
            name: i === lastIdx ? 'Finalizing Brain...' : s.name
          } : s
        ));
        await new Promise(r => setTimeout(r, stageTimings[i]));
        if (cancelled) break;
        // Don't mark last stage complete here — API resolution does that
        if (i < lastIdx) {
          setProcessingStages(prev => prev.map((s, idx) =>
            idx === i ? { ...s, status: 'complete' as const, endTime: Date.now() } : s
          ));
        }
      }
    };
    driveStages();

    try {
      const data = await analyzePromise;
      cancelled = true;
      if (!data.success) throw new Error(data.error);

      setProcessingStages(initialProcessingStages.map(s => ({ ...s, status: 'complete' as const, endTime: Date.now() })));
      setBrandProfile(data.data as BrandProfile);

      // Persist brand ID in localStorage AND URL param — URL survives mobile Safari localStorage wipes
      const scannedId = (data.data as any)?.id || (data.data as any)?.brandProfileId;
      if (scannedId) {
        try { localStorage.setItem(ACTIVE_BRAND_KEY, scannedId); } catch(e) {}
        try { localStorage.setItem('forge_active_brand', JSON.stringify({
          id: data.data.id, brandUrl: data.data.brandUrl, brandName: data.data.brandName,
          expiresAt: data.data.expiresAt || null, isPaid: data.data.isPaid || false,
        })); } catch(e) {}
        window.history.replaceState({}, '', `/app/context-hub?brand=${scannedId}`);
      }

      const token = isSignedIn ? await getToken() : null;
      fetchBrains(token).then(setHistoryEntries).catch(() => {});

      setIsProcessing(false);
      setCurrentView('brand-profile');
    } catch (err) {
      cancelled = true;
      if (err instanceof Error && err.message === 'domain-claimed') {
        setProcessingStages(prev => prev.map((s, idx) =>
          idx === 0 ? { ...s, status: 'error' as const, endTime: Date.now() } : s
        ));
        setIsProcessing(false);
        setCurrentView('new-analysis');
        return;
      }
      setProcessingStages(prev => prev.map((s, idx) =>
        idx === stages.length - 1
          ? { ...s, status: 'error' as const, message: err instanceof Error ? err.message : 'Analysis failed' }
          : s
      ));
      setIsProcessing(false);
    }
  };

  const [authToken, setAuthToken] = useState<string>('');

  // Keep token fresh — refresh every 55s
  useEffect(() => {
    if (!isSignedIn) { setAuthToken(''); return; }
    const refresh = async () => {
      const t = await getToken({ template: 'jwt-template-600' });
      if (t) { setAuthToken(t); (window as any).__forgeToken = t; }
    };
    refresh();
    const interval = setInterval(refresh, 55_000);
    return () => clearInterval(interval);
  }, [isSignedIn, getToken]);

  const loadSampleData = () => setAnalysisInput(sampleAnalysisInput);

  // ─────────────────────────────────────────────────────────────────────────
  // CONTEXT VALUE
  // ─────────────────────────────────────────────────────────────────────────

  const value: AppContextType = {
    // Auth state
    isAuthLoading,
    isSuperAdmin,
    hasAccess,
    activeBrand,
    allBrands,
    switchBrand,

    // Legacy compatibility
    isPaid,
    brandLoading,
    activeBrandId,
    refetchBrand,
    authToken,
    brandProfile,
    setBrandProfile,

    // App state
    currentView,
    setCurrentView,
    analysisInput,
    setAnalysisInput,
    processingStages,
    setProcessingStages,
    isProcessing,
    setIsProcessing,
    historyEntries,
    setHistoryEntries,
    sidebarCollapsed,
    setSidebarCollapsed,
    startAnalysis,
    loadSampleData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
