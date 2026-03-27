export interface VoiceProfile {
  summary: string;
  toneAttributes: {
    attribute: string;
    score: number;
    description: string;
  }[];
  writingStyle: string;
  keyPhrases: string[];
}

export interface Persona {
  id: string;
  name: string;
  role: string;
  painPoints: string[];
  triggers: string[];
  skepticism: string;
  motivations: string[];
}

export interface ThirdPartySignal {
  source: string;
  signalType: string;
  value: string | null;
  confidence: number;
  lastChecked: string;
}

export interface CompetitiveGap {
  topic: string;
  ownedBy: string | null;
  whitespaceOpportunity: string;
  priority: 'high' | 'medium' | 'low';
}

export interface StrategicRecommendation {
  id: string;
  category: string;
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'high' | 'medium' | 'low';
}

export interface BrandProfile {
  id: string;
  brandUrl: string;
  brandName: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  isActive: boolean;
  cacheStatus: 'fresh' | 'cached' | 'stale';
  voiceProfile: VoiceProfile;
  personas: Persona[];
  thirdPartySignals: ThirdPartySignal[];
  competitiveGaps: CompetitiveGap[];
  strategicRecommendations: StrategicRecommendation[];
}

export interface AnalysisInput {
  brandUrl: string;
  competitorUrls: string[];
  audienceNotes: string;
  strategicNotes: string;
  checkBrainFirst: boolean;
  saveToBrain: boolean;
}

export interface ProcessingStage {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  message?: string;
  startTime?: number;
  endTime?: number;
}

export interface HistoryEntry {
  id: string;
  brandUrl: string;
  brandName: string;
  timestamp: string;
  version: number;
  isActive: boolean;
  isCached: boolean;
}

export type ViewType = 'new-analysis' | 'active-run' | 'brand-profile' | 'strategy' | 'brain-history' | 'geo-strategist' | 'authenticity-enricher' | 'content-generator' | 'campaign-generator' | 'compliance-gate' | 'integrations' | 'publishing-queue';
