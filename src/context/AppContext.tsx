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
  historyEntries: HistoryEntry[];
  setHistoryEntries: (entries: HistoryEntry[]) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  startAnalysis: () => void;
  loadSampleData: () => void;
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
  const [currentView, setCurrentView] = useState<ViewType>('new-analysis');
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

  // Load brain history from Neon on mount
  useEffect(() => {
    fetchBrains().then(entries => setHistoryEntries(entries)).catch(() => {});
  }, []);

  const loadSampleData = () => {
    setAnalysisInput(sampleAnalysisInput);
  };

  const startAnalysis = async () => {
    setIsProcessing(true);
    setCurrentView('active-run');
    const stages = initialProcessingStages.map(s => ({ ...s, status: 'pending' as const }));
    setProcessingStages(stages);

    // Fire the real API call immediately
    const analyzePromise = fetch('/api/context-hub/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandUrl: analysisInput.brandUrl,
        brandName: (() => {
          const domain = analysisInput.brandUrl.replace(/https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
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

    // Final stage waits for API response
    setProcessingStages(prev => prev.map((s, idx) =>
      idx === stages.length - 1 ? { ...s, status: 'running' as const, startTime: Date.now() } : s
    ));

    try {
      const res = await analyzePromise;
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setProcessingStages(prev => prev.map(s => ({ ...s, status: 'complete' as const, endTime: Date.now() })));
      setBrandProfile(data.data as BrandProfile);

      // Refresh brain history
      fetchBrains().then(entries => setHistoryEntries(entries)).catch(() => {});

      setIsProcessing(false);
      setCurrentView('brand-profile');
    } catch (err) {
      setProcessingStages(prev => prev.map((s, idx) =>
        idx === stages.length - 1
          ? { ...s, status: 'error' as const, message: err instanceof Error ? err.message : 'Analysis failed' }
          : s
      ));
      setIsProcessing(false);
    }
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
        loadSampleData
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
