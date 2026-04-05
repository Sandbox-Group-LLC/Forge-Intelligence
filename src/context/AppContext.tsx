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
  activeBrandId: string | null;
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
  const [currentView, setCurrentView] = useState<ViewType>('active-run');
  const [analysisInput, setAnalysisInput] = useState<AnalysisInput>(sampleAnalysisInput);
  const [processingStages, setProcessingStages] = useState<ProcessingStage[]>(initialProcessingStages);
  const [isProcessing, setIsProcessing] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem('forge_sidebar_collapsed');
    return stored === 'true';
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLE AUTH LOAD - THE ONLY PLACE WE CALL /api/auth/me
  // ─────────────────────────────────────────────────────────────────────────
  
  const loadAuth = useCallback(async (selectedBrandId?: string) => {
    setIsAuthLoading(true);
    
    try {
      if (!isSignedIn) {
        // Not signed in - reset to defaults
        setIsSuperAdmin(false);
        setActiveBrand(null);
        setAllBrands(null);
        
        // Still fetch brains for session-based trial users
        const brains = await fetchBrains();
        setHistoryEntries(brains);
        setIsAuthLoading(false);
        return;
      }
      
      // Signed in - get auth state from server
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
        
        // Set brands
        if (data.allBrands) {
          setAllBrands(data.allBrands);
        }
        
        // Set active brand
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
        
        // Fetch brains
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
  const hasAccess = isSuperAdmin || (activeBrand?.isPaid ?? false);
  
  // Legacy compatibility
  const isPaid = hasAccess;
  const activeBrandId = activeBrand?.id ?? null;

  // Sidebar collapse persistence
  useEffect(() => {
    localStorage.setItem('forge_sidebar_collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // ─────────────────────────────────────────────────────────────────────────
  // LEGACY FUNCTIONS
  // ─────────────────────────────────────────────────────────────────────────
  
  const startAnalysis = () => {
    setProcessingStages(initialProcessingStages);
    setCurrentView('active-run');
    setIsProcessing(true);
  };

  const loadSampleData = () => {
    setAnalysisInput(sampleAnalysisInput);
  };

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
    activeBrandId,
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
