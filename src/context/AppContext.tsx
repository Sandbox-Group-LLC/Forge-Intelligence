import { useActiveBrand } from '../hooks/useActiveBrand';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { ViewType, BrandProfile, AnalysisInput, ProcessingStage, HistoryEntry } from '../types';
import { initialProcessingStages, sampleAnalysisInput } from '../data/mockData';

interface ActiveBrandMini {
  id: string;
  brandName: string;
  brandUrl: string;
  isPaid: boolean;
}

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
  historyEntries: HistoryEntry[];
  setHistoryEntries: (entries: HistoryEntry[]) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  startAnalysis: () => void;
  loadSampleData: () => void;
  isPaid: boolean;
  // Super admin
  isSuperAdmin: boolean;
  allBrands: ActiveBrandMini[] | null;
  switchBrand: (brandId: string) => void;
  activeBrandId: string | null;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

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

async function fetchBrains(): Promise<HistoryEntry[]> {
  const res = await fetch('/api/context-hub/brains');
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
    saveToBrain: true
  });
  const [processingStages, setProcessingStages] = useState<ProcessingStage[]>(initialProcessingStages);
  const [isProcessing, setIsProcessing] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // God mode — ?god=ForgeCanvas sets localStorage, ?ungod clears it (dev only)
  const godMode = (() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('god') === 'ForgeCanvas') { localStorage.setItem('forge_god_mode', 'true'); return true; }
    if (params.has('ungod')) { localStorage.removeItem('forge_god_mode'); return false; }
    return localStorage.getItem('forge_god_mode') === 'true';
  })();
  const [isPaid, setIsPaid] = useState(godMode);
  const { brand: activeBrand, isSuperAdmin, allBrands, switchBrand } = useActiveBrand();

  // Update isPaid from activeBrand (Clerk-authed) or brandProfile (analysis result)
  useEffect(() => {
    if (godMode) { setIsPaid(true); return; }
    if (isSuperAdmin) { setIsPaid(true); return; }
    if (activeBrand?.isPaid) { setIsPaid(true); return; }
    if (brandProfile && (brandProfile as any).is_paid) { setIsPaid(true); }
  }, [brandProfile, activeBrand, isSuperAdmin]);


  // Load brain history from Neon on mount
  useEffect(() => {
    fetchBrains().then(entries => setHistoryEntries(entries)).catch(() => {});
  }, []);

  const loadSampleData = () => {
    setAnalysisInput(sampleAnalysisInput);
  };

  const startAnalysis = async () => {
    const effectiveUrl = analysisInput.brandUrl;
    setIsProcessing(true);
    setCurrentView('active-run');
    const stages = initialProcessingStages.map(s => ({ ...s, status: 'pending' as const }));
    setProcessingStages(stages);

    // Fire the real API call immediately
    const analyzePromise = fetch('/api/context-hub/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandUrl: effectiveUrl,
        brandName: (() => {
          const domain = effectiveUrl.replace(/https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
          return domain.charAt(0).toUpperCase() + domain.slice(1);
        })(),
        competitorUrls: analysisInput.competitorUrls,
        audienceNotes: analysisInput.audienceNotes,
        strategicNotes: analysisInput.strategicNotes,
        checkBrainFirst: analysisInput.checkBrainFirst,
        saveToBrain: analysisInput.saveToBrain
      })
    });

    // Drive stage UI while Claude works
    const stageTimings = [2000, 3000, 4000, 3000];
    for (let i = 0; i < stageTimings.length; i++) {
      setProcessingStages(prev => prev.map((s, idx) =>
        idx === i ? { ...s, status: 'running' as const, startTime: Date.now() } : s
      ));
      await new Promise(r => setTimeout(r, stageTimings[i]));
      setProcessingStages(prev => prev.map((s, idx) =>
        idx === i ? { ...s, status: 'complete' as const, endTime: Date.now() } : s
      ));
    }

    // Wait for real response
    const analyzeRes = await analyzePromise;
    const analyzeData = await analyzeRes.json();
    if (analyzeData.success && analyzeData.profile) {
      setBrandProfile(analyzeData.profile);
      // Refresh brain history
      fetchBrains().then(entries => setHistoryEntries(entries)).catch(() => {});
    }
    setIsProcessing(false);
    setCurrentView('brand-profile');
  };

  return (
    <AppContext.Provider
      value={{
        currentView,
        setCurrentView,
        brandProfile,
        setBrandProfile,
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
        isPaid,
        isSuperAdmin,
        allBrands,
        switchBrand,
        activeBrandId: activeBrand?.id || null,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
