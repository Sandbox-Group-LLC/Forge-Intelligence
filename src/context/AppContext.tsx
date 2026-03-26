import { createContext, useContext, useState, ReactNode } from 'react';
import { ViewType, BrandProfile, AnalysisInput, ProcessingStage, HistoryEntry } from '../types';
import { mockBrandProfile, mockHistoryEntries, initialProcessingStages, sampleAnalysisInput } from '../data/mockData';

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
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>(mockHistoryEntries);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const loadSampleData = () => {
    setAnalysisInput(sampleAnalysisInput);
  };

  const startAnalysis = () => {
    setIsProcessing(true);
    setCurrentView('active-run');
    setProcessingStages(initialProcessingStages.map(s => ({ ...s, status: 'pending' })));

    const stageTimings = [1500, 1000, 3000, 2500, 1000];
    let currentStage = 0;

    const runStage = () => {
      if (currentStage >= stageTimings.length) {
        setIsProcessing(false);
        setBrandProfile(mockBrandProfile);
        setCurrentView('brand-profile');
        return;
      }

      setProcessingStages(prev => prev.map((stage, idx) => {
        if (idx === currentStage) {
          return { ...stage, status: 'running', startTime: Date.now() };
        }
        if (idx < currentStage) {
          return { ...stage, status: 'complete' };
        }
        return stage;
      }));

      setTimeout(() => {
        setProcessingStages(prev => prev.map((stage, idx) => {
          if (idx === currentStage) {
            return { ...stage, status: 'complete', endTime: Date.now() };
          }
          return stage;
        }));
        currentStage++;
        runStage();
      }, stageTimings[currentStage]);
    };

    runStage();
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
