import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import { Target, Map, Eye, MessageSquare, Compass, ArrowRight, Share2 } from 'lucide-react';
import './StrategyIntelPage.css';

interface Vulnerability {
  type: string;
  claim: string;
  evidence: string;
  vulnerability: string;
  severity: string;
}

interface FaultLine {
  theirLanguage: string;
  frequency: string;
  context: string;
  differentiationAngle: string;
  priority: string;
}

interface CompetitorIntel {
  url: string;
  name: string;
  scrapedLength: number;
  pva: Vulnerability[];
  faultLines: FaultLine[];
  createdAt?: string;
}

interface GapItem {
  position: string;
  opportunityScore: number;
  currentState: string;
  evidence: { geo: string | null; pva: string | null; faultLines: string | null };
  rightToWin: string;
  boardImplication: string;
  attackVector: string;
}

interface BlindSpot {
  persona: string;
  role: string;
  whyBlind: string;
  evidence: { competitorGap: string | null; topicalSignal: string | null; marketTrend: string | null };
  opportunitySize: string;
  rightToServe: string;
  activationPlay: string;
  experientialPlay?: string;
  boardImplication: string;
}

interface Territory {
  narrative: string;
  controlledBy: string;
  brandVisibility: number;
  platformBreakdown: { chatgpt: number; perplexity: number; gemini: number; aiOverviews: number };
  invisibilityCost: string;
  narrativeControl: string;
  reclaimDifficulty: string;
  quickWin: boolean;
  ninetyDayPlay: string;
  boardImplication: string;
}

interface PivotMove {
  move: string;
  rationale: string;
  outcome: string;
}

interface Pivot {
  pivotStatement: string;
  fromTo: { from: string; to: string };
  whyNow: string;
  convergenceEvidence: {
    gapMap: string;
    pva: string;
    faultLines: string;
    blindSpots: string;
    whitespace: string;
  };
  threeMovesIn90Days: PivotMove[];
  whatToStopDoing: string;
  boardSlide: string;
}

type TabId = 'gap_map' | 'pva' | 'blind_spots' | 'faultlines' | 'whitespace' | 'pivot';

const TABS: { id: TabId; label: string; icon: any; ready: boolean }[] = [
  { id: 'gap_map', label: 'Gap Map', icon: Map, ready: true },
  { id: 'pva', label: 'Vulnerabilities', icon: Target, ready: true },
  { id: 'faultlines', label: 'Fault Lines', icon: MessageSquare, ready: true },
  { id: 'blind_spots', label: 'Blind Spots', icon: Eye, ready: true },
  { id: 'whitespace', label: 'Whitespace', icon: Compass, ready: true },
  { id: 'pivot', label: 'Positioning Pivot', icon: ArrowRight, ready: true },
];

export default function StrategyIntelPage() {
  const { setCurrentView, activeBrand, authToken } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>('gap_map');

  // PVA + Fault Lines state
  const [competitors, setCompetitors] = useState<CompetitorIntel[]>([]);
  const [expandedComp, setExpandedComp] = useState<string | null>(null);

  // Gap Map state
  const [gaps, setGaps] = useState<GapItem[]>([]);
  const [expandedGap, setExpandedGap] = useState<number | null>(null);

  // Blind Spots state
  const [blindSpots, setBlindSpots] = useState<BlindSpot[]>([]);
  const [expandedSpot, setExpandedSpot] = useState<number | null>(null);

  // Whitespace state
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [expandedTerritory, setExpandedTerritory] = useState<number | null>(null);

  // Pivot state
  const [pivot, setPivot] = useState<Pivot | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [complianceReport, setComplianceReport] = useState<any>(null);
  const [complianceRunning, setComplianceRunning] = useState(false);
  const [complianceExpanded, setComplianceExpanded] = useState(false);

  // Shared
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');

  const brandProfileId = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';

  useEffect(() => { setCurrentView('strategy-intel'); }, []);

  // Load cached PVA/Fault Lines
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/competitive-intel/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.competitors?.length) setCompetitors(d.competitors); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  // Load cached Gap Map
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/gap-map/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.gaps?.length) setGaps(d.gaps); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  // Load cached Blind Spots
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/blind-spots/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.blindSpots?.length) setBlindSpots(d.blindSpots); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  // Load cached Whitespace
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/whitespace/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.territories?.length) setTerritories(d.territories); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  // Load cached Compliance
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/compliance/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.report) setComplianceReport(d.report); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  // Load cached Pivot
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/pivot/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.pivot) setPivot(d.pivot); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  // Run PVA + Fault Lines
  const runCompetitiveIntel = async (force = false) => {
    if (!brandProfileId) return;
    setIsRunning(true); setError(''); setProgress([]); setCompetitors([]);
    try {
      const response = await fetch(`/api/strategy/competitive-intel/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.type === 'progress' || evt.type === 'detail') setProgress(prev => [...prev, evt.detail]);
              else if (evt.type === 'result') setCompetitors(evt.competitors || []);
              else if (evt.type === 'error') throw new Error(evt.error);
            } catch (pe: any) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
          }
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setIsRunning(false); }
  };

  // Run Gap Map
  const runGapMap = async (force = false) => {
    if (!brandProfileId) return;
    setIsRunning(true); setError(''); setProgress([]); setGaps([]);
    try {
      const response = await fetch(`/api/strategy/gap-map/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.type === 'progress' || evt.type === 'detail') setProgress(prev => [...prev, evt.detail]);
              else if (evt.type === 'result') setGaps(evt.gaps || []);
              else if (evt.type === 'error') throw new Error(evt.error);
            } catch (pe: any) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
          }
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setIsRunning(false); }
  };

  // Run Blind Spots
  const runBlindSpots = async (force = false) => {
    if (!brandProfileId) return;
    setIsRunning(true); setError(''); setProgress([]); setBlindSpots([]);
    try {
      const response = await fetch(`/api/strategy/blind-spots/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.type === 'progress' || evt.type === 'detail') setProgress(prev => [...prev, evt.detail]);
              else if (evt.type === 'result') setBlindSpots(evt.blindSpots || []);
              else if (evt.type === 'error') throw new Error(evt.error);
            } catch (pe: any) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
          }
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setIsRunning(false); }
  };

  // Run Whitespace
  const runWhitespace = async (force = false) => {
    if (!brandProfileId) return;
    setIsRunning(true); setError(''); setProgress([]); setTerritories([]);
    try {
      const response = await fetch(`/api/strategy/whitespace/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.type === 'progress' || evt.type === 'detail') setProgress(prev => [...prev, evt.detail]);
              else if (evt.type === 'result') setTerritories(evt.territories || []);
              else if (evt.type === 'error') throw new Error(evt.error);
            } catch (pe: any) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
          }
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setIsRunning(false); }
  };

  // Run Pivot
  const runPivot = async (force = false) => {
    if (!brandProfileId) return;
    setIsRunning(true); setError(''); setProgress([]); setPivot(null);
    try {
      const response = await fetch(`/api/strategy/pivot/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.type === 'progress' || evt.type === 'detail') setProgress(prev => [...prev, evt.detail]);
              else if (evt.type === 'result') setPivot(evt.pivot || null);
              else if (evt.type === 'error') throw new Error(evt.error);
            } catch (pe: any) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
          }
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setIsRunning(false); }
  };

  const runCompliance = async () => {
    if (!brandProfileId || complianceRunning) return;
    setComplianceRunning(true); setError(''); setProgress([]);
    try {
      const response = await fetch(`/api/strategy/compliance/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.type === 'progress' || evt.type === 'detail') setProgress(prev => [...prev, evt.detail]);
              else if (evt.type === 'result') { setComplianceReport(evt.report); setComplianceExpanded(true); }
              else if (evt.type === 'error') throw new Error(evt.error);
            } catch (pe: any) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
          }
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setComplianceRunning(false); }
  };

  const createShareLink = async () => {
    if (!brandProfileId || sharing) return;
    setSharing(true);
    try {
      const res = await fetch(`/api/strategy/share/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const d = await res.json();
      if (d.success && d.url) {
        setShareUrl(d.url);
        navigator.clipboard.writeText(d.url).catch(() => {});
        window.open(d.url, '_blank');
      } else {
        setError(d.error || 'Failed to create share link');
      }
    } catch (e: any) { setError(e.message || 'Failed to create share link'); }
    finally { setSharing(false); }
  };

  const severityColor = (s: string) => s === 'high' ? '#ef4444' : s === 'medium' ? '#f5b942' : '#94a3b8';
  const priorityColor = (p: string) => p === 'high' ? '#3563ff' : p === 'medium' ? '#8b5cf6' : '#94a3b8';
  const scoreColor = (s: number) => s >= 75 ? '#14b8a6' : s >= 50 ? '#f5b942' : '#ef4444';

  const runAction = activeTab === 'gap_map' ? runGapMap
    : activeTab === 'blind_spots' ? runBlindSpots
    : activeTab === 'whitespace' ? runWhitespace
    : activeTab === 'pivot' ? runPivot
    : (activeTab === 'pva' || activeTab === 'faultlines') ? runCompetitiveIntel
    : null;

  const hasData = activeTab === 'gap_map' ? gaps.length > 0
    : activeTab === 'blind_spots' ? blindSpots.length > 0
    : activeTab === 'whitespace' ? territories.length > 0
    : activeTab === 'pivot' ? !!pivot
    : (activeTab === 'pva' || activeTab === 'faultlines') ? competitors.length > 0
    : false;

  const tabMeta = TABS.find(t => t.id === activeTab);

  return (
    <AppShell>
      <div className="si-page">
        <div className="si-header">
          <div>
            <h1 className="si-title">Brand Intelligence</h1>
            <p className="si-sub">Board-ready competitive intelligence across six dimensions</p>
          </div>
          <div className="si-header-actions">
            {hasData && !isRunning && runAction && (
              <button className="si-btn-secondary" onClick={() => runAction(true)}>
                Re-analyze
              </button>
            )}
            {!hasData && !isRunning && runAction && (
              <button className="si-btn-primary" onClick={() => runAction(false)}>
                Run {tabMeta?.label || 'Analysis'}
              </button>
            )}
            {(gaps.length > 0 || competitors.length > 0 || blindSpots.length > 0) && !isRunning && !complianceRunning && (
              <>
                {!complianceReport && (
                  <button className="si-btn-compliance" onClick={runCompliance}>
                    Run Compliance Check
                  </button>
                )}
                {complianceReport && (
                  <>
                    <button className="si-btn-compliance-status" onClick={() => setComplianceExpanded(!complianceExpanded)}>
                      {complianceReport.summary?.unverified > 0
                        ? `⚠ ${complianceReport.summary.unverified} Unverified`
                        : `✓ ${complianceReport.summary?.passRate || 'Passed'}`
                      }
                    </button>
                    <button className="si-btn-compliance" onClick={runCompliance}>
                      Re-check
                    </button>
                  </>
                )}
                <button className="si-btn-share" onClick={createShareLink} disabled={sharing || !complianceReport}>
                  <Share2 size={13} /> {sharing ? 'Creating...' : 'Share Brief'}
                </button>
              </>
            )}
          </div>
        </div>
        {shareUrl && (
          <div className="si-share-banner">
            <span>Link copied to clipboard:</span>
            <a href={shareUrl} target="_blank" rel="noopener">{shareUrl}</a>
            <button className="si-share-dismiss" onClick={() => setShareUrl(null)}>×</button>
          </div>
        )}

        {/* Compliance report */}
        {complianceExpanded && complianceReport && (
          <div className="si-compliance-panel">
            <div className="si-compliance-header">
              <div className="si-compliance-title">Compliance Audit</div>
              <div className="si-compliance-summary">
                <span className="si-compliance-stat si-compliance-verified">{complianceReport.summary?.verified || 0} Verified</span>
                <span className="si-compliance-stat si-compliance-inferred">{complianceReport.summary?.inferred || 0} Inferred</span>
                <span className="si-compliance-stat si-compliance-unverified">{complianceReport.summary?.unverified || 0} Unverified</span>
                <span className="si-compliance-pass">Pass rate: {complianceReport.summary?.passRate || '—'}</span>
              </div>
              <button className="si-compliance-close" onClick={() => setComplianceExpanded(false)}>×</button>
            </div>
            <div className="si-compliance-findings">
              {(complianceReport.findings || []).map((f: any, i: number) => (
                <div key={i} className={`si-compliance-finding si-compliance-${f.status}`}>
                  <div className="si-compliance-finding-header">
                    <span className={`si-compliance-badge si-badge-${f.status}`}>
                      {f.status === 'verified' ? '✓' : f.status === 'inferred' ? '~' : '✕'} {f.status}
                    </span>
                    <span className="si-compliance-deliverable">{f.deliverable?.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="si-compliance-claim">"{f.claim}"</div>
                  {f.source && <div className="si-compliance-source">Source: {f.source}</div>}
                  {f.issue && <div className="si-compliance-issue">{f.issue}</div>}
                  {f.recommendation && <div className="si-compliance-rec">Fix: {f.recommendation}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="si-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`si-tab ${activeTab === tab.id ? 'active' : ''} ${!tab.ready ? 'si-tab-disabled' : ''}`}
              onClick={() => tab.ready && setActiveTab(tab.id)}
              title={!tab.ready ? 'Coming soon' : undefined}
            >
              <tab.icon size={13} />
              {tab.label}
              {!tab.ready && <span className="si-tab-soon">soon</span>}
              {tab.id === 'gap_map' && gaps.length > 0 && (
                <span className="si-tab-count">{gaps.length}</span>
              )}
              {tab.id === 'blind_spots' && blindSpots.length > 0 && (
                <span className="si-tab-count">{blindSpots.length}</span>
              )}
              {tab.id === 'whitespace' && territories.length > 0 && (
                <span className="si-tab-count">{territories.length}</span>
              )}
              {tab.id === 'pva' && competitors.length > 0 && (
                <span className="si-tab-count">{competitors.reduce((s, c) => s + (c.pva?.length || 0), 0)}</span>
              )}
              {tab.id === 'faultlines' && competitors.length > 0 && (
                <span className="si-tab-count">{competitors.reduce((s, c) => s + (c.faultLines?.length || 0), 0)}</span>
              )}
            </button>
          ))}
        </div>

        {/* Progress feed */}
        {isRunning && (
          <div className="si-progress">
            <div className="si-progress-title">Analyzing...</div>
            {progress.map((msg, i) => (
              <div key={i} className="si-progress-line">{msg}</div>
            ))}
            <div className="si-progress-spinner" />
          </div>
        )}

        {error && <div className="si-error">{error}</div>}

        {/* ═══ GAP MAP TAB ═══ */}
        {activeTab === 'gap_map' && !isRunning && gaps.length > 0 && (
          <div className="si-competitors">
            {gaps.map((gap, i) => {
              const isExpanded = expandedGap === i;
              return (
                <div key={i} className="si-comp-card">
                  <button className="si-comp-header" onClick={() => setExpandedGap(isExpanded ? null : i)}>
                    <div className="si-gap-position">{gap.position}</div>
                    <div className="si-comp-meta">
                      <span className="si-gap-score" style={{ color: scoreColor(gap.opportunityScore) }}>
                        {gap.opportunityScore}/100
                      </span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="si-items">
                      <div className="si-item">
                        <div className="si-gap-section">
                          <div className="si-gap-label">Current State</div>
                          <div className="si-gap-text">{gap.currentState}</div>
                        </div>
                        {gap.evidence.geo && (
                          <div className="si-gap-section">
                            <div className="si-gap-label">GEO Signal</div>
                            <div className="si-gap-text">{gap.evidence.geo}</div>
                          </div>
                        )}
                        {gap.evidence.pva && (
                          <div className="si-gap-section">
                            <div className="si-gap-label">Vulnerability Signal</div>
                            <div className="si-gap-text">{gap.evidence.pva}</div>
                          </div>
                        )}
                        {gap.evidence.faultLines && (
                          <div className="si-gap-section">
                            <div className="si-gap-label">Messaging Signal</div>
                            <div className="si-gap-text">{gap.evidence.faultLines}</div>
                          </div>
                        )}
                        <div className="si-gap-section">
                          <div className="si-gap-label">Right to Win</div>
                          <div className="si-gap-text">{gap.rightToWin}</div>
                        </div>
                        <div className="si-gap-section si-gap-board">
                          <div className="si-gap-label">Board Implication</div>
                          <div className="si-gap-text">{gap.boardImplication}</div>
                        </div>
                        <div className="si-gap-section">
                          <div className="si-gap-label">Attack Vector</div>
                          <div className="si-gap-text">{gap.attackVector}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ═══ PVA TAB ═══ */}
        {activeTab === 'pva' && !isRunning && competitors.length > 0 && (
          <div className="si-competitors">
            {competitors.map(comp => {
              const isExpanded = expandedComp === comp.url || competitors.length <= 2;
              return (
                <div key={comp.url} className="si-comp-card">
                  <button className="si-comp-header" onClick={() => setExpandedComp(expandedComp === comp.url ? null : comp.url)}>
                    <div className="si-comp-name">{comp.name}</div>
                    <div className="si-comp-meta">
                      <span className="si-comp-url">{comp.url.replace(/https?:\/\/(www\.)?/, '')}</span>
                      <span className="si-comp-count">{comp.pva?.length || 0} vulnerabilities</span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="si-items">
                      {(comp.pva || []).map((v, i) => (
                        <div key={i} className="si-item">
                          <div className="si-item-header">
                            <span className="si-severity" style={{ color: severityColor(v.severity) }}>{v.severity?.toUpperCase()}</span>
                            <span className="si-type">{v.type?.replace(/_/g, ' ')}</span>
                          </div>
                          <div className="si-claim">"{v.claim}"</div>
                          <div className="si-evidence">{v.evidence}</div>
                          <div className="si-vuln-label">Strategic Opening:</div>
                          <div className="si-vulnerability">{v.vulnerability}</div>
                        </div>
                      ))}
                      {(!comp.pva || comp.pva.length === 0) && (
                        <div className="si-empty">No vulnerabilities identified for this competitor.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ═══ FAULT LINES TAB ═══ */}
        {activeTab === 'faultlines' && !isRunning && competitors.length > 0 && (
          <div className="si-competitors">
            {competitors.map(comp => {
              const isExpanded = expandedComp === comp.url || competitors.length <= 2;
              return (
                <div key={comp.url} className="si-comp-card">
                  <button className="si-comp-header" onClick={() => setExpandedComp(expandedComp === comp.url ? null : comp.url)}>
                    <div className="si-comp-name">{comp.name}</div>
                    <div className="si-comp-meta">
                      <span className="si-comp-url">{comp.url.replace(/https?:\/\/(www\.)?/, '')}</span>
                      <span className="si-comp-count">{comp.faultLines?.length || 0} fault lines</span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="si-items">
                      {(comp.faultLines || []).map((fl, i) => (
                        <div key={i} className="si-item">
                          <div className="si-item-header">
                            <span className="si-severity" style={{ color: priorityColor(fl.priority) }}>{fl.priority?.toUpperCase()}</span>
                          </div>
                          <div className="si-their-lang">"{fl.theirLanguage}"</div>
                          <div className="si-frequency">{fl.frequency}</div>
                          {fl.context && <div className="si-context">{fl.context}</div>}
                          <div className="si-diff-label">Differentiation Angle:</div>
                          <div className="si-diff-angle">{fl.differentiationAngle}</div>
                        </div>
                      ))}
                      {(!comp.faultLines || comp.faultLines.length === 0) && (
                        <div className="si-empty">No fault lines mapped for this competitor.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ═══ BLIND SPOTS TAB ═══ */}
        {activeTab === 'blind_spots' && !isRunning && blindSpots.length > 0 && (
          <div className="si-competitors">
            {blindSpots.map((spot, i) => {
              const isExpanded = expandedSpot === i;
              const sizeColor = spot.opportunitySize === 'large' ? '#14b8a6' : spot.opportunitySize === 'medium' ? '#f5b942' : '#94a3b8';
              return (
                <div key={i} className="si-comp-card">
                  <button className="si-comp-header" onClick={() => setExpandedSpot(isExpanded ? null : i)}>
                    <div className="si-gap-position">{spot.persona}</div>
                    <div className="si-comp-meta">
                      <span className="si-blind-role">{spot.role}</span>
                      <span className="si-gap-score" style={{ color: sizeColor }}>
                        {spot.opportunitySize?.toUpperCase()}
                      </span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="si-items">
                      <div className="si-item">
                        <div className="si-gap-section">
                          <div className="si-gap-label">Why the Market Is Blind</div>
                          <div className="si-gap-text">{spot.whyBlind}</div>
                        </div>
                        {spot.evidence.competitorGap && (
                          <div className="si-gap-section">
                            <div className="si-gap-label">Competitor Gap</div>
                            <div className="si-gap-text">{spot.evidence.competitorGap}</div>
                          </div>
                        )}
                        {spot.evidence.topicalSignal && (
                          <div className="si-gap-section">
                            <div className="si-gap-label">Topical Signal</div>
                            <div className="si-gap-text">{spot.evidence.topicalSignal}</div>
                          </div>
                        )}
                        {spot.evidence.marketTrend && (
                          <div className="si-gap-section">
                            <div className="si-gap-label">Market Trend</div>
                            <div className="si-gap-text">{spot.evidence.marketTrend}</div>
                          </div>
                        )}
                        <div className="si-gap-section">
                          <div className="si-gap-label">Right to Serve</div>
                          <div className="si-gap-text">{spot.rightToServe}</div>
                        </div>
                        <div className="si-gap-section si-gap-board">
                          <div className="si-gap-label">Board Implication</div>
                          <div className="si-gap-text">{spot.boardImplication}</div>
                        </div>
                        <div className="si-gap-section">
                          <div className="si-gap-label">Activation Play</div>
                          <div className="si-gap-text">{spot.activationPlay}</div>
                        </div>
                        {spot.experientialPlay && (
                          <div className="si-gap-section si-gap-experiential">
                            <div className="si-gap-label">Experiential Play</div>
                            <div className="si-gap-text">{spot.experientialPlay}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ═══ WHITESPACE TAB ═══ */}
        {activeTab === 'whitespace' && !isRunning && territories.length > 0 && (
          <div className="si-competitors">
            {territories.map((t, i) => {
              const isExpanded = expandedTerritory === i;
              const visColor = t.brandVisibility <= 30 ? '#ef4444' : t.brandVisibility <= 55 ? '#f5b942' : '#94a3b8';
              const diffColor = t.reclaimDifficulty === 'low' ? '#14b8a6' : t.reclaimDifficulty === 'medium' ? '#f5b942' : '#ef4444';
              return (
                <div key={i} className="si-comp-card">
                  <button className="si-comp-header" onClick={() => setExpandedTerritory(isExpanded ? null : i)}>
                    <div className="si-gap-position">{t.narrative}</div>
                    <div className="si-comp-meta">
                      <span className="si-ws-controller">Controlled by: {t.controlledBy}</span>
                      <span className="si-gap-score" style={{ color: visColor }}>
                        Visibility: {t.brandVisibility}/100
                      </span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="si-items">
                      <div className="si-item">
                        <div className="si-ws-platforms">
                          <div className="si-ws-platform">
                            <span className="si-ws-plat-name">ChatGPT</span>
                            <div className="si-ws-bar"><div className="si-ws-bar-fill" style={{ width: `${t.platformBreakdown?.chatgpt || 0}%`, background: '#14b8a6' }} /></div>
                            <span className="si-ws-plat-score">{t.platformBreakdown?.chatgpt || 0}</span>
                          </div>
                          <div className="si-ws-platform">
                            <span className="si-ws-plat-name">Perplexity</span>
                            <div className="si-ws-bar"><div className="si-ws-bar-fill" style={{ width: `${t.platformBreakdown?.perplexity || 0}%`, background: '#8b5cf6' }} /></div>
                            <span className="si-ws-plat-score">{t.platformBreakdown?.perplexity || 0}</span>
                          </div>
                          <div className="si-ws-platform">
                            <span className="si-ws-plat-name">Gemini</span>
                            <div className="si-ws-bar"><div className="si-ws-bar-fill" style={{ width: `${t.platformBreakdown?.gemini || 0}%`, background: '#3563ff' }} /></div>
                            <span className="si-ws-plat-score">{t.platformBreakdown?.gemini || 0}</span>
                          </div>
                          <div className="si-ws-platform">
                            <span className="si-ws-plat-name">AI Overviews</span>
                            <div className="si-ws-bar"><div className="si-ws-bar-fill" style={{ width: `${t.platformBreakdown?.aiOverviews || 0}%`, background: '#f5b942' }} /></div>
                            <span className="si-ws-plat-score">{t.platformBreakdown?.aiOverviews || 0}</span>
                          </div>
                        </div>
                        <div className="si-gap-section">
                          <div className="si-gap-label">Cost of Invisibility</div>
                          <div className="si-gap-text">{t.invisibilityCost}</div>
                        </div>
                        <div className="si-gap-section">
                          <div className="si-gap-label">Narrative Control</div>
                          <div className="si-gap-text">{t.narrativeControl}</div>
                        </div>
                        <div className="si-gap-section">
                          <div className="si-gap-label">Reclaim Difficulty</div>
                          <span className="si-gap-score" style={{ color: diffColor, fontSize: '0.85rem' }}>{t.reclaimDifficulty?.toUpperCase()}</span>
                          {t.quickWin && <span className="si-ws-qw"> ⚡ Quick Win</span>}
                        </div>
                        <div className="si-gap-section si-gap-board">
                          <div className="si-gap-label">Board Implication</div>
                          <div className="si-gap-text">{t.boardImplication}</div>
                        </div>
                        <div className="si-gap-section">
                          <div className="si-gap-label">90-Day Play</div>
                          <div className="si-gap-text">{t.ninetyDayPlay}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}



        {/* ═══ POSITIONING PIVOT TAB ═══ */}
        {activeTab === 'pivot' && !isRunning && pivot && (
          <div className="si-pivot">
            <div className="si-pivot-statement">{pivot.pivotStatement}</div>

            <div className="si-pivot-fromto">
              <div className="si-pivot-from">
                <div className="si-pivot-fromto-label">FROM</div>
                <div className="si-pivot-fromto-text">{pivot.fromTo.from}</div>
              </div>
              <div className="si-pivot-arrow">→</div>
              <div className="si-pivot-to">
                <div className="si-pivot-fromto-label">TO</div>
                <div className="si-pivot-fromto-text">{pivot.fromTo.to}</div>
              </div>
            </div>

            <div className="si-pivot-section">
              <div className="si-gap-label">Why Now</div>
              <div className="si-gap-text">{pivot.whyNow}</div>
            </div>

            <div className="si-pivot-evidence">
              <div className="si-gap-label">Convergence Evidence</div>
              <div className="si-pivot-evidence-grid">
                {pivot.convergenceEvidence.gapMap && (
                  <div className="si-pivot-ev-card">
                    <div className="si-pivot-ev-dim">Gap Map</div>
                    <div className="si-pivot-ev-text">{pivot.convergenceEvidence.gapMap}</div>
                  </div>
                )}
                {pivot.convergenceEvidence.pva && (
                  <div className="si-pivot-ev-card">
                    <div className="si-pivot-ev-dim">Vulnerabilities</div>
                    <div className="si-pivot-ev-text">{pivot.convergenceEvidence.pva}</div>
                  </div>
                )}
                {pivot.convergenceEvidence.faultLines && (
                  <div className="si-pivot-ev-card">
                    <div className="si-pivot-ev-dim">Fault Lines</div>
                    <div className="si-pivot-ev-text">{pivot.convergenceEvidence.faultLines}</div>
                  </div>
                )}
                {pivot.convergenceEvidence.blindSpots && (
                  <div className="si-pivot-ev-card">
                    <div className="si-pivot-ev-dim">Blind Spots</div>
                    <div className="si-pivot-ev-text">{pivot.convergenceEvidence.blindSpots}</div>
                  </div>
                )}
                {pivot.convergenceEvidence.whitespace && (
                  <div className="si-pivot-ev-card">
                    <div className="si-pivot-ev-dim">Whitespace</div>
                    <div className="si-pivot-ev-text">{pivot.convergenceEvidence.whitespace}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="si-pivot-moves">
              <div className="si-gap-label">Three Moves in 90 Days</div>
              {(pivot.threeMovesIn90Days || []).map((m, i) => (
                <div key={i} className="si-pivot-move">
                  <div className="si-pivot-move-num">{i + 1}</div>
                  <div className="si-pivot-move-body">
                    <div className="si-pivot-move-title">{m.move}</div>
                    <div className="si-pivot-move-rationale">{m.rationale}</div>
                    <div className="si-pivot-move-outcome">{m.outcome}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="si-pivot-stop">
              <div className="si-gap-label">Stop Doing</div>
              <div className="si-gap-text">{pivot.whatToStopDoing}</div>
            </div>

            <div className="si-pivot-board">
              <div className="si-gap-label">The Board Slide</div>
              <div className="si-pivot-board-text">{pivot.boardSlide}</div>
            </div>
          </div>
        )}

        {/* ═══ EMPTY STATE ═══ */}
        {!hasData && !isRunning && !error && (activeTab === 'gap_map' || activeTab === 'pva' || activeTab === 'faultlines' || activeTab === 'blind_spots' || activeTab === 'whitespace' || activeTab === 'pivot') && (
          <div className="si-empty-state">
            <div className="si-empty-title">No {tabMeta?.label?.toLowerCase()} data yet</div>
            <div className="si-empty-body">
              {activeTab === 'gap_map' && 'Forge will aggregate your GEO topical authority gaps, competitor positioning, and vulnerability data to identify undefended market positions no competitor currently owns.'}
              {activeTab === 'pivot' && 'Forge synthesizes all five intelligence dimensions to find the ONE positioning move that exploits every gap, vulnerability, blind spot, and invisible conversation simultaneously. Run the other analyses first.'}
              {activeTab === 'whitespace' && 'Forge will map every conversation happening on ChatGPT, Perplexity, Gemini, and AI Overviews where your brand is invisible — who controls the narrative, what it costs you, and how to reclaim territory.'}
              {activeTab === 'blind_spots' && 'Forge will analyze your personas, competitor positioning, and topical gaps to identify audience segments the entire market is ignoring — buyers nobody is speaking to that your brand can own.'}
              {(activeTab === 'pva' || activeTab === 'faultlines') && 'Forge will scrape your competitors\' public positioning pages, identify vulnerabilities in their claims, and map the exact language they use so you can differentiate against it.'}
            </div>
            <button className="si-btn-primary" onClick={() => runAction && runAction(false)}>
              Run {tabMeta?.label || 'Analysis'}
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
