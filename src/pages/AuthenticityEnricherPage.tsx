import { useState, useEffect } from 'react';
// Inline SVG icon components (no lucide-react dependency)
const ShieldCheck = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>
  </svg>
);
const Zap = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const AlertTriangle = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>
  </svg>
);
const CheckCircle2 = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
  </svg>
);
const ChevronRight = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 18 6-6-6-6"/>
  </svg>
);
const User = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>
  </svg>
);
const Award = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>
  </svg>
);
const FileText = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>
  </svg>
);
const BarChart3 = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>
  </svg>
);
const BookOpen = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
  </svg>
);
const MessageSquare = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);
const Info = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
  </svg>
);
const X = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
  </svg>
);

interface BrainOption { id: string; brandName: string; brandUrl: string; }

interface EEATScore { score: number; rationale: string; evidence: string[]; }
interface Gap {
  dimension: string; gapType: string; severity: string;
  tooltip: string; placeholder: string; whyItMatters: string;
}
interface SMESignal { type: string; value: string; confidence: number; source: string; injectionPoint: string; }
interface InjectionItem {
  section: string; injectionType: string; suggestedContent: string;
  persona: string; eeatDimension: string; confidence: number;
}
interface EnrichedSection {
  heading: string; eeatInjections: string[];
  confidenceFlag: 'green' | 'yellow' | 'red'; flagReason: string | null; smeRequired: boolean;
}

interface EnrichResult {
  brandName: string; confidenceScore: number; needsManualInput: boolean;
  overallEEATScore: number; eeatScores: Record<string, EEATScore>;
  gaps: Gap[]; smeSignals: SMESignal[]; injectionMap: InjectionItem[];
  powerPhrases: string[]; contentHooks: any[]; authorSchema: any; authorSchemaMarkup?: any;
  enrichedTitle: string; enrichedH1: string; enrichedSections: EnrichedSection[];
  enrichedFAQ: any[]; humanReviewItems: string[]; readyForStage4: boolean;
}

const GAP_TYPE_LABELS: Record<string, string> = {
  sme_credentials: 'SME Credentials', awards: 'Awards & Recognition',
  case_studies: 'Case Studies', original_research: 'Original Research / Data',
  customer_proof: 'Customer Proof', author_authority: 'Author Authority',
  founding_story: 'Founding Story', certifications: 'Certifications & Accreditations'
};

const GAP_ICONS: Record<string, any> = {
  sme_credentials: User, awards: Award, case_studies: FileText,
  original_research: BarChart3, customer_proof: MessageSquare,
  author_authority: User, founding_story: BookOpen, certifications: ShieldCheck
};

const CONFIDENCE_COLORS = { green: '#14B8A6', yellow: '#F5B942', red: '#EF4444' };
const EEAT_LABELS = ['experience', 'expertise', 'authoritativeness', 'trustworthiness'];

export default function AuthenticityEnricherPage() {
  const [brains, setBrains] = useState<BrainOption[]>([]);
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<EnrichResult | null>(null);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'eeat' | 'injections' | 'brief' | 'author'>('eeat');
  const [completedStages, setCompletedStages] = useState<number[]>([]);
  const [currentStage, setCurrentStage] = useState(0);
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [showManualForm, setShowManualForm] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/context-hub/brains')
      .then(r => r.json())
      .then(d => { if (d.success) setBrains(d.data); });
  }, []);

  const runAnalysis = async (withManual = false) => {
    if (!selectedBrainId) return;
    setIsRunning(true);
    setResult(null);
    setError('');
    setCompletedStages([]);
    setCurrentStage(1);

    const analyzePromise = fetch('/api/authenticity-enricher/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandProfileId: selectedBrainId,
        manualInputs: withManual ? manualInputs : {},
        force: withManual
      })
    });

    const timings = [2000, 3000, 3500, 3000];
    for (let i = 0; i < timings.length; i++) {
      setCurrentStage(i + 1);
      await new Promise(r => setTimeout(r, timings[i]));
      setCompletedStages(prev => [...prev, i + 1]);
    }
    setCurrentStage(5);

    try {
      const res = await analyzePromise;
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Analysis failed');
      setCompletedStages([1,2,3,4,5]);
      setCurrentStage(0);
      setResult(data.data);
      if (data.data.needsManualInput && !withManual) {
        setShowManualForm(true);
        setActiveTab('eeat');
      } else {
        setActiveTab('eeat');
      }
    } catch(e: any) {
      setError(e.message);
    } finally {
      setIsRunning(false);
    }
  };

  const STAGES = [
    { id: 1, label: 'SME Signal Scraper' },
    { id: 2, label: 'E-E-A-T Confidence Scorer' },
    { id: 3, label: 'Voice & Persona Mapper' },
    { id: 4, label: 'Enriched Brief Assembler' },
  ];

  const flagBg = (flag: string) => flag === 'green' ? '#14B8A614' : flag === 'yellow' ? '#F5B94214' : '#EF444414';
  const flagBorder = (flag: string) => flag === 'green' ? '#14B8A640' : flag === 'yellow' ? '#F5B94240' : '#EF444440';

  return (
    <div className="geo-content">
      <div className="geo-header">
        <div className="geo-header-left">
          <div className="geo-eyebrow">Stage 3</div>
          <h1 className="geo-title">Authenticity Enricher</h1>
          <p className="geo-subtitle">
            Injects E-E-A-T signals, SME credentials, and voice-matched hooks to make content AI-citation ready.
          </p>
        </div>
        <div className="geo-header-right">
          {result && (
            <div className="opportunity-score-badge" style={{ background: result.confidenceScore >= 75 ? '#14B8A614' : result.confidenceScore >= 50 ? '#F5B94214' : '#EF444414', border: `1px solid ${result.confidenceScore >= 75 ? '#14B8A640' : result.confidenceScore >= 50 ? '#F5B94240' : '#EF444440'}` }}>
              <span style={{ fontSize: '11px', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>E-E-A-T Score</span>
              <span style={{ fontSize: '28px', fontWeight: 700, color: result.confidenceScore >= 75 ? '#14B8A6' : result.confidenceScore >= 50 ? '#F5B942' : '#EF4444' }}>{result.confidenceScore}</span>
            </div>
          )}
        </div>
      </div>

      {/* Brain selector */}
      <div className="geo-controls">
        <select className="geo-brain-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
          <option value="">Select a Brain...</option>
          {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
        </select>
        <button className="geo-run-btn" onClick={() => runAnalysis(false)} disabled={!selectedBrainId || isRunning}>
          {isRunning ? 'Enriching...' : result ? 'New Analysis' : 'Run Enrichment'}
        </button>
      </div>

      {/* Stage progress */}
      {isRunning && (
        <div className="geo-stages">
          {STAGES.map(s => (
            <div key={s.id} className={`geo-stage ${completedStages.includes(s.id) ? 'completed' : currentStage === s.id ? 'active' : ''}`}>
              <div className="geo-stage-dot">
                {completedStages.includes(s.id) ? <CheckCircle2 size={14} /> : <span>{s.id}</span>}
              </div>
              <span className="geo-stage-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="geo-error">{error}</div>}

      {/* Manual Input Prompt Card */}
      {showManualForm && result && result.gaps && result.gaps.filter(g => g.severity === 'high').length > 0 && (
        <div style={{ background: '#F5B94208', border: '1px solid #F5B94230', borderRadius: '12px', padding: '20px 24px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <AlertTriangle size={16} color="#F5B942" />
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#F8FAFC' }}>Got 2 minutes? Your brief will be significantly stronger.</span>
              </div>
              <p style={{ fontSize: '13px', color: '#64748B', margin: 0 }}>
                We couldn't find enough E-E-A-T signals online. Drop in what you have — we'll weave it all in automatically.
              </p>
            </div>
            <button onClick={() => setShowManualForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B', padding: '4px' }}>
              <X size={16} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
            {result.gaps.filter(g => g.severity === 'high').map((gap, i) => {
              const Icon = GAP_ICONS[gap.gapType] || FileText;
              return (
                <div key={i} style={{ background: '#1E293B', borderRadius: '8px', padding: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <Icon size={14} color="#3563FF" />
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#F8FAFC' }}>{GAP_TYPE_LABELS[gap.gapType] || gap.gapType}</span>
                    <div style={{ position: 'relative', marginLeft: 'auto' }}>
                      <button
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 0 }}
                        onMouseEnter={() => setActiveTooltip(`gap-${i}`)}
                        onMouseLeave={() => setActiveTooltip(null)}
                      >
                        <Info size={13} />
                      </button>
                      {activeTooltip === `gap-${i}` && (
                        <div style={{ position: 'absolute', right: 0, top: '20px', background: '#0F1720', border: '1px solid #1E293B', borderRadius: '8px', padding: '10px 12px', width: '220px', zIndex: 10 }}>
                          <p style={{ fontSize: '12px', color: '#94A3B8', margin: '0 0 6px' }}>{gap.tooltip}</p>
                          <p style={{ fontSize: '11px', color: '#3563FF', margin: 0 }}>💡 {gap.whyItMatters}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <textarea
                    placeholder={gap.placeholder}
                    value={manualInputs[gap.gapType] || ''}
                    onChange={e => setManualInputs(prev => ({ ...prev, [gap.gapType]: e.target.value }))}
                    style={{
                      width: '100%', background: '#0F1720', border: '1px solid #334155',
                      borderRadius: '6px', padding: '8px 10px', color: '#F8FAFC',
                      fontSize: '12px', resize: 'vertical', minHeight: '60px',
                      fontFamily: 'Inter, system-ui, sans-serif', boxSizing: 'border-box'
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
            <button
              onClick={() => runAnalysis(true)}
              disabled={isRunning || Object.keys(manualInputs).every(k => !manualInputs[k])}
              style={{ background: '#3563FF', border: 'none', borderRadius: '8px', padding: '8px 20px', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >
              Re-run with my inputs
            </button>
            <button
              onClick={() => setShowManualForm(false)}
              style={{ background: 'transparent', border: '1px solid #334155', borderRadius: '8px', padding: '8px 16px', color: '#94A3B8', fontSize: '13px', cursor: 'pointer' }}
            >
              Skip — use what you found
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {result && !isRunning && (
        <>
          <div className="geo-tabs">
            {[
              { id: 'eeat', label: 'E-E-A-T Scores' },
              { id: 'injections', label: 'Injection Map' },
              { id: 'brief', label: 'Enriched Brief' },
              { id: 'author', label: 'Author Schema' },
            ].map(tab => (
              <button key={tab.id} className={`geo-tab ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id as any)}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* E-E-A-T Scores Tab */}
          {activeTab === 'eeat' && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px', marginBottom: '24px' }}>
                {EEAT_LABELS.map(dim => {
                  const s = result.eeatScores?.[dim];
                  if (!s) return null;
                  const color = s.score >= 70 ? '#14B8A6' : s.score >= 45 ? '#F5B942' : '#EF4444';
                  return (
                    <div key={dim} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: '12px', padding: '20px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: '#F8FAFC', textTransform: 'capitalize' }}>{dim}</span>
                        <span style={{ fontSize: '22px', fontWeight: 700, color }}>{s.score}</span>
                      </div>
                      <div style={{ background: '#0F1720', borderRadius: '4px', height: '4px', marginBottom: '12px' }}>
                        <div style={{ background: color, height: '4px', borderRadius: '4px', width: `${s.score}%`, transition: 'width 0.6s ease' }} />
                      </div>
                      <p style={{ fontSize: '12px', color: '#64748B', margin: '0 0 8px' }}>{s.rationale}</p>
                      {s.evidence?.length > 0 && (
                        <ul style={{ margin: 0, padding: '0 0 0 16px' }}>
                          {s.evidence.slice(0, 2).map((e, i) => <li key={i} style={{ fontSize: '11px', color: '#475569', marginBottom: '2px' }}>{e}</li>)}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* SME Signals */}
              {result.smeSignals && result.smeSignals.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                    Discovered Signals — {result.smeSignals.length} found
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
                    {result.smeSignals.map((sig, i) => (
                      <div key={i} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: '8px', padding: '12px 14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                          <span style={{ fontSize: '11px', color: '#3563FF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{sig.type}</span>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            {sig.source === 'manual' && <span style={{ fontSize: '10px', color: '#F5B942', background: '#F5B94215', padding: '2px 6px', borderRadius: '4px' }}>manual</span>}
                            <span style={{ fontSize: '12px', color: sig.confidence >= 70 ? '#14B8A6' : '#F5B942' }}>{sig.confidence}%</span>
                          </div>
                        </div>
                        <p style={{ fontSize: '12px', color: '#94A3B8', margin: '0 0 4px', lineHeight: 1.5 }}>{sig.value}</p>
                        <p style={{ fontSize: '11px', color: '#475569', margin: 0 }}>→ {sig.injectionPoint}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Injection Map Tab */}
          {activeTab === 'injections' && (
            <div>
              {result.contentHooks && result.contentHooks.length > 0 && (
                <div style={{ marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>Opening Hooks</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {result.contentHooks.map((h, i) => (
                      <div key={i} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: '8px', padding: '14px 16px' }}>
                        <div style={{ display: 'flex', gap: '10px', marginBottom: '6px' }}>
                          <span style={{ fontSize: '11px', color: '#3563FF', background: '#3563FF15', padding: '2px 8px', borderRadius: '4px' }}>{h.type}</span>
                          <span style={{ fontSize: '11px', color: '#475569' }}>→ {h.persona}</span>
                        </div>
                        <p style={{ fontSize: '13px', color: '#F8FAFC', margin: 0, lineHeight: 1.6, fontStyle: 'italic' }}>"{h.hook}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.injectionMap && result.injectionMap.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>Section Injections — {result.injectionMap.length} mapped</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {result.injectionMap.map((inj, i) => (
                      <div key={i} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: '8px', padding: '14px 16px' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: '#F8FAFC' }}>{inj.section}</span>
                          <ChevronRight size={12} color="#475569" />
                          <span style={{ fontSize: '11px', color: '#3563FF', background: '#3563FF15', padding: '2px 7px', borderRadius: '4px' }}>{inj.injectionType}</span>
                          <span style={{ fontSize: '11px', color: '#475569' }}>{inj.eeatDimension}</span>
                          <span style={{ marginLeft: 'auto', fontSize: '12px', color: inj.confidence >= 70 ? '#14B8A6' : '#F5B942' }}>{inj.confidence}%</span>
                        </div>
                        <p style={{ fontSize: '12px', color: '#94A3B8', margin: '0 0 4px', lineHeight: 1.6 }}>{inj.suggestedContent}</p>
                        <p style={{ fontSize: '11px', color: '#475569', margin: 0 }}>Resonates with: {inj.persona}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.powerPhrases && result.powerPhrases.length > 0 && (
                <div style={{ marginTop: '24px' }}>
                  <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>Power Phrases</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {result.powerPhrases.map((p, i) => (
                      <span key={i} style={{ background: '#3563FF15', border: '1px solid #3563FF30', borderRadius: '6px', padding: '4px 12px', fontSize: '12px', color: '#94A3B8' }}>{p}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Enriched Brief Tab */}
          {activeTab === 'brief' && (
            <div>
              {result.enrichedTitle && (
                <div style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
                  <div style={{ fontSize: '11px', color: '#3563FF', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Enriched Title</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#F8FAFC', marginBottom: '8px' }}>{result.enrichedTitle}</div>
                  {result.enrichedH1 && <div style={{ fontSize: '14px', color: '#64748B' }}>H1: {result.enrichedH1}</div>}
                </div>
              )}

              {result.enrichedSections && result.enrichedSections.map((sec, i) => (
                <div key={i} style={{ background: flagBg(sec.confidenceFlag), border: `1px solid ${flagBorder(sec.confidenceFlag)}`, borderRadius: '10px', padding: '16px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#F8FAFC' }}>{sec.heading}</span>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {sec.smeRequired && <span style={{ fontSize: '11px', color: '#F5B942', background: '#F5B94215', padding: '2px 8px', borderRadius: '4px' }}>SME needed</span>}
                      <span style={{ fontSize: '11px', color: CONFIDENCE_COLORS[sec.confidenceFlag], background: `${CONFIDENCE_COLORS[sec.confidenceFlag]}15`, padding: '2px 8px', borderRadius: '4px', textTransform: 'capitalize' }}>
                        {sec.confidenceFlag === 'green' ? '✓ auto-approvable' : sec.confidenceFlag === 'yellow' ? '⚠ review suggested' : '✗ human required'}
                      </span>
                    </div>
                  </div>
                  {sec.eeatInjections?.map((inj, j) => (
                    <div key={j} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '4px' }}>
                      <Zap size={12} color="#3563FF" style={{ marginTop: '2px', flexShrink: 0 }} />
                      <span style={{ fontSize: '12px', color: '#94A3B8', lineHeight: 1.5 }}>{inj}</span>
                    </div>
                  ))}
                  {sec.flagReason && <p style={{ fontSize: '11px', color: '#64748B', margin: '8px 0 0' }}>Note: {sec.flagReason}</p>}
                </div>
              ))}

              {result.humanReviewItems && result.humanReviewItems.length > 0 && (
                <div style={{ background: '#EF444408', border: '1px solid #EF444430', borderRadius: '10px', padding: '16px', marginTop: '16px' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                    <AlertTriangle size={14} color="#EF4444" />
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#F8FAFC' }}>Needs Human Review</span>
                  </div>
                  {result.humanReviewItems.map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '6px' }}>
                      <span style={{ color: '#EF4444', fontSize: '12px', flexShrink: 0 }}>•</span>
                      <span style={{ fontSize: '12px', color: '#94A3B8' }}>{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Author Schema Tab */}
          {activeTab === 'author' && result.authorSchema && (
            <div>
              <div style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: '12px', padding: '24px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', marginBottom: '20px' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: '#3563FF20', border: '1px solid #3563FF40', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <User size={20} color="#3563FF" />
                  </div>
                  <div>
                    <div style={{ fontSize: '17px', fontWeight: 700, color: '#F8FAFC', marginBottom: '2px' }}>{result.authorSchema.name || 'Author TBD'}</div>
                    <div style={{ fontSize: '13px', color: '#64748B' }}>{result.authorSchema.title || 'Title not specified'}</div>
                  </div>
                </div>
                {result.authorSchema.expertise?.length > 0 && (
                  <div style={{ marginBottom: '16px' }}>
                    <div style={{ fontSize: '11px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Expertise Areas</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {result.authorSchema.expertise.map((e: string, i: number) => (
                        <span key={i} style={{ background: '#3563FF15', border: '1px solid #3563FF30', borderRadius: '6px', padding: '3px 10px', fontSize: '12px', color: '#94A3B8' }}>{e}</span>
                      ))}
                    </div>
                  </div>
                )}
                {result.authorSchema.credentials?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '11px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Credentials</div>
                    {result.authorSchema.credentials.map((c: string, i: number) => (
                      <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                        <ShieldCheck size={12} color="#14B8A6" />
                        <span style={{ fontSize: '12px', color: '#94A3B8' }}>{c}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ background: '#0F1720', border: '1px solid #1E293B', borderRadius: '10px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>Schema Markup Preview</div>
                <pre style={{ fontSize: '11px', color: '#475569', margin: 0, overflowX: 'auto', lineHeight: 1.7 }}>
                  {JSON.stringify(result.authorSchemaMarkup || { '@context': 'https://schema.org', '@type': 'Person', ...result.authorSchema }, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
