import { useActiveBrand, ActiveBrand, BrandMini } from '../hooks/useActiveBrand';
import { useAuth } from '@clerk/clerk-react';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { ViewType, BrandProfile, AnalysisInput, ProcessingStage, HistoryEntry } from '../types';
import { initialProcessingStages, sampleAnalysisInput } from '../data/mockData';

interface AppContextType {
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;
  brandProfile: BrandProfile | null;
  setBrandProfile: (profile: BrandProfile | null) => void;
  analysisInput: AnalysisInput;
  setAnalysisInput: (input: AnalysisInput) => void;
  processingStages: ProcessingStage[];
  setProcessingStages: (stages: ProcessingStage[]) => void;
  isProcessing: boolean;
  setIsProcessing: (processing: boolean) => void;
  historyEntries: HistoryEntry[]
  setHistoryEntries: (entries: HistoryEntry[]) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  startAnalysis: () => void;
  loadSampleData: () => void;
  // Auth & access
  isPaid: boolean;
  brandLoading: boolean;
  activeBrand: ActiveBrand | null;
  refetchBrand: () => void;
  authToken: string;
  allBrands: BrandMini[];
  isSuperAdmin: boolean;
  switchBrand: (brandId: string) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

function getSessionId(): string {
  let id = localStorage.getItem('forge_session_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('forge_session_id', id); }
  return id;
}

function mapBrainToHistoryEntry(b: any): HistoryEntry {
  return {
    id: b.id,
    brandUrl: b.brandUrl,
    brandName: b.brandName,
    timestamp: b.updatedAt,
    version: b.version,
    isActive: b.isActive,
    isCached: b.cacheStatus === 'cached',
    hasFactualGround: b.hasFactualGround ?? false,
    factualGroundUpdatedAt: b.factualGroundUpdatedAt ?? null,
  };
}

async function fetchBrains(token?: string | null): Promise<HistoryEntry[]> {
  const headers: Record<string, string> = { 'x-session-id': getSessionId() };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/api/context-hub/brains', { headers });
  const data = await res.json();
  if (data.success && Array.isArray(data.data)) {
    return data.data.map(mapBrainToHistoryEntry);
  }
  return [];
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewType>(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    const valid: ViewType[] = ['new-analysis', 'active-run', 'brand-profile', 'strategy', 'brain-history', 'content-generator', 'campaign-generator'];
    return (valid.includes(viewParam as ViewType) ? viewParam : 'new-analysis') as ViewType;
  });
  const [brandProfile, setBrandProfile] = useState<BrandProfile | null>(null);
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
  // Initialize collapsed=true on mobile so off-canvas drawer starts hidden.
  // On desktop, default to expanded.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768;
  });

  // God mode — ?god=ForgeCanvas persists in localStorage; ?ungod clears it
  const godMode = (() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('god') === 'ForgeCanvas') { localStorage.setItem('forge_god_mode', 'true'); return true; }
    if (params.has('ungod')) { localStorage.removeItem('forge_god_mode'); return false; }
    return localStorage.getItem('forge_god_mode') === 'true';
  })();

  const { brand: activeBrand, loading: brandLoading, refetch: refetchBrand, allBrands, isSuperAdmin, switchBrand } = useActiveBrand();
  const { isSignedIn, getToken } = useAuth();

  // DB is now the truth — /api/auth/me marks brand as paid on every auth.
  // brandLoading guard on pages prevents gate flash during Clerk hydration.
  const isPaid = godMode || (activeBrand?.isPaid ?? false);

  // Load brain history on mount — pass auth token so signed-in users get their tethered brain
  useEffect(() => {
    (async () => {
      try {
        const token = isSignedIn ? await getToken({ template: 'jwt-template-600' }) : null;
        const entries = await fetchBrains(token);
        setHistoryEntries(entries);
      } catch { /* silent */ }
    })();
  }, [isSignedIn]);

  const [authToken, setAuthToken] = useState<string>('');

  // Keep token fresh — refresh every 55s, store in state and window for interceptor
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

  const startAnalysis = async () => {
    const effectiveUrl = analysisInput.brandUrl;
    sessionStorage.removeItem('forge_run_start'); // Reset timer for new analysis
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
        try { localStorage.setItem('forge_active_brand_id', scannedId); } catch(e) {}
        try { localStorage.setItem('forge_active_brand', JSON.stringify({
          id: data.data.id, brandUrl: data.data.brandUrl, brandName: data.data.brandName,
          expiresAt: data.data.expiresAt || null, isPaid: data.data.isPaid || false,
        })); } catch(e) {}
        window.history.replaceState({}, '', `/app/context-hub?brand=${scannedId}`);
      }
      getToken().then(t => fetchBrains(t)).then(setHistoryEntries).catch(() => {});
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

  return (
    <AppContext.Provider value={{
      currentView, setCurrentView,
      brandProfile, setBrandProfile,
      analysisInput, setAnalysisInput,
      processingStages, setProcessingStages,
      isProcessing, setIsProcessing,
      historyEntries, setHistoryEntries,
      sidebarCollapsed, setSidebarCollapsed,
      startAnalysis, loadSampleData,
      isPaid, brandLoading, activeBrand, refetchBrand, authToken,
      allBrands, isSuperAdmin, switchBrand,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) throw new Error('useApp must be used within an AppProvider');
  return context;
}
