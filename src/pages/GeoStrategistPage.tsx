import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import { useAuth } from '@clerk/clerk-react';
import './GeoStrategistPage.css';
import GateModal from '../components/GateModal';
import '../components/GateModal.css';

interface BrainEntry {
  id: string;
  brandName: string;
  brandUrl: string;
  updatedAt: string;
}

interface GeoOpportunity {
  id: string;
  topic: string;
  platformScores: { chatgpt?: number; perplexity?: number; aiOverviews?: number; gemini?: number };
  avgScore: number;
  quickWin: boolean;
  status: 'discovered' | 'briefed' | 'backlog' | 'enriched' | 'ignored';
  topicalAuthority?: any;
}

interface TopicBrief {
  id: string;
  opportunityId: string;
  topic: string;
  briefData: {
    h1?: string;
    executiveSummary?: string;
    h2s?: Array<{ heading: string; intent?: string; geoAnchor?: string }>;
    entities?: string[];
    faqStructure?: Array<{ question: string; answerDirection?: string }>;
    geoAnchors?: string[];
    schemaRequirements?: string[];
    targetPlatforms?: string[];
    briefRationale?: string;
  };
  quickWin?: boolean;
  avgScore?: number;
  status: 'briefed' | 'backlog' | 'enriched';
  createdAt: string;
}

interface GeoResult {
  opportunityScore: number;
  brainVersion?: number;
  currentBrainVersion?: number;
  discoverySessionId?: string;
  pendingUserSelection?: boolean;
  topicalAuthorityMap: Array<{ topic: string; coverage: string; citationProbability: number; priority: string }>;
  geoOpportunities: Array<{ topic: string; chatgpt: number; perplexity: number; aiOverviews: number; gemini: number; quickWin: boolean }>;
  entitySchemaMap: Array<{ entity: string; schemaType: string; competitorCited: boolean; recommendation: string }>;
  geoBrief: { title: string; h1: string; h2s: string[]; faqItems: Array<{ q: string; a: string }>; geoAnchors: string[]; estimatedCitationLift: string };
  brandName: string;
  latencyMs: number;
}

const icons = {
  zap: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  map: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" x2="9" y1="3" y2="18"/><line x1="15" x2="15" y1="6" y2="21"/></svg>,
  target: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
  code: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
  fileText: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>,
  loader: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>,
};

const STAGES = [
  { id: 1, label: 'Reading Brain', sub: 'Patterns, mistakes, memories' },
  { id: 2, label: 'Topical Authority Map', sub: 'Mapping content gaps + citation probability' },
  { id: 3, label: 'GEO Opportunity Scoring', sub: 'ChatGPT · Perplexity · AI Overviews · Gemini' },
  { id: 4, label: 'Entity & Schema Map', sub: 'Structured markup + competitor entity gaps' },
  { id: 5, label: 'Generating GEO Brief', sub: 'H1/H2 · FAQ · GEO anchors · opportunity score' },
];

function GeoStrategistContent() {
  const { setCurrentView, historyEntries, activeBrand, authToken } = useApp();
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState(0);
  const [completedStages, setCompletedStages] = useState<number[]>([]);
  const [result, setResult] = useState<GeoResult | null>(null);
  const [opportunities, setOpportunities] = useState<GeoOpportunity[]>([]);
  const brandProfileId = activeBrand?.id;
  const [topicBriefs, setTopicBriefs] = useState<TopicBrief[]>([]);
  const [selectedOppIds, setSelectedOppIds] = useState<Set<string>>(new Set());
  const [buildingBriefs, setBuildingBriefs] = useState(false);
  const [briefBuildError, setBriefBuildError] = useState('');
  const [activeTab, setActiveTab] = useState<'topical' | 'geo' | 'entity' | 'brief'>('topical');
  const [error, setError] = useState('');
  const [isRerun, setIsRerun] = useState(false);

  useEffect(() => {
    setCurrentView('geo-strategist');
    const params = new URLSearchParams(window.location.search);
    const profileId = params.get('profileId');
    if (profileId) {
      setSelectedBrainId(profileId);
    } else {
      const id = activeBrand?.id || (() => { try { return localStorage.getItem('forge_active_brand_id'); } catch(e) { return ''; } })() || new URLSearchParams(window.location.search).get('brand') || '';
      if (id) setSelectedBrainId(id);
    }
  }, []);

  // Re-seed if activeBrand loads after mount
  useEffect(() => {
    if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id);
  }, [activeBrand?.id]);

  // Fetch existing GEO results on mount
  useEffect(() => {
    if (!selectedBrainId || !authToken || result) return;
    const fetchExisting = async () => {
      try {
        const res = await fetch(`/api/geo-strategist/briefs?brandProfileId=${selectedBrainId}`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const d = await res.json();
        if (d.success && d.data?.length > 0) {
          const b = d.data.find((x: any) => x.brandProfileId === selectedBrainId) || d.data[0];
          setResult({
            opportunityScore: b.opportunityScore || 0,
            topicalAuthorityMap: b.topicalAuthorityMap || [],
            geoOpportunities: b.geoOpportunitiesNorm || b.geoOpportunities || [],
            entitySchemaMap: b.entitySchemaMap || [],
            geoBrief: b.geoBrief || null,
            brandName: b.brandName || '',
            brainVersion: b.brainVersion || b.brain_version,
            currentBrainVersion: b.currentBrainVersion || b.current_brain_version,
            latencyMs: 0
          });
        }
      } catch { /* silent */ }
    };
    fetchExisting();
  }, [selectedBrainId, authToken]);

  // Use historyEntries from AppContext (already loaded) as brain list
  let brains: BrainEntry[] = historyEntries.map(e => ({
    id: e.id,
    brandName: e.brandName,
    brandUrl: e.brandUrl,
    updatedAt: e.timestamp
  }));

  // Ensure current brand appears in dropdown even if historyEntries hasn't loaded yet (auth redirect race)
  if (brains.length === 0 && activeBrand) {
    brains.push({ id: activeBrand.id, brandName: activeBrand.brandName || activeBrand.brandUrl, brandUrl: activeBrand.brandUrl , updatedAt: ''});
  }

  const selectedBrain = brains.find(b => b.id === selectedBrainId);

  const runAnalysis = async () => {
    if (!selectedBrainId) return;
    const shouldForce = isRerun;
    setIsRunning(true);
    setResult(null);
    setError('');
    setCompletedStages([]);
    setCurrentStage(1);
    setIsRerun(false);

    const analyzePromise = fetch('/api/geo-strategist/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandProfileId: selectedBrainId, force: shouldForce })
    });

    const timings = [1500, 3000, 3500, 2500];
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
      console.log('[GEO DEBUG] topicalAuthorityMap[0]:', JSON.stringify(data.data?.topicalAuthorityMap?.[0]));
      console.log('[GEO DEBUG] geoOpportunities[0]:', JSON.stringify(data.data?.geoOpportunities?.[0]));
      setResult(data.data);
      setActiveTab('topical');
    } catch(e: any) {
      setError(e.message);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="geo-content">
      {/* ── Header ── */}
      <div className="geo-header">
        <div className="geo-header-left">
          <div className="geo-eyebrow">Stage 2</div>
          <h2 className="geo-title">GEO Strategist</h2>
          <p className="geo-description">
            Maps topical authority gaps, scores GEO citation opportunities across AI platforms, and generates a structured brief ready for Stage 3.
          </p>
        </div>
        {result && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="geo-score-badge">
              <div className="score-value">{result.opportunityScore}</div>
              <div className="score-label">Opportunity Score</div>
            </div>
            <button onClick={() => { setResult(null); setIsRerun(true); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              Re-run Analysis
            </button>
            <button onClick={() => { window.location.href = '/app/authenticity-enricher'; }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#4F46E5', color: '#fff', border: '1px solid #4F46E5', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              Continue to Authenticity Enricher →
            </button>
          </div>
        )}
      </div>


      {result && result.brainVersion && result.currentBrainVersion && result.brainVersion < result.currentBrainVersion && (
        <div style={{ background: '#FEF3C7', border: '1px solid #F59E0B', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span style={{ fontSize: 13, color: '#92400E' }}>
            These results were built on <strong>Brain v{result.brainVersion}</strong> — your brand is now on <strong>v{result.currentBrainVersion}</strong>. Re-run GEO Strategy for updated results.
          </span>
        </div>
      )}
      {/* ── Input bar ── */}
      {!isRunning && !result && (
        <div className="geo-input-bar">
          <div className="geo-select-wrap">
            <select
              className="geo-select"
              value={selectedBrainId}
              onChange={e => setSelectedBrainId(e.target.value)}
            >
              <option value="">Select a Brand Profile...</option>
              {brains.map(b => (
                <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>
              ))}
            </select>
          </div>
          <button className="geo-run-btn" onClick={runAnalysis} disabled={!selectedBrainId}>
            {icons.zap} Run GEO Analysis
          </button>
        </div>
      )}

      {/* ── Active run ── */}
      {isRunning && (
        <div className="geo-running">
          <div className="geo-running-brand">{selectedBrain?.brandName}</div>
          <div className="geo-stages">
            {STAGES.map(s => {
              const done = completedStages.includes(s.id);
              const active = currentStage === s.id && !done;
              return (
                <div key={s.id} className={`geo-stage ${done ? 'done' : active ? 'active' : 'pending'}`}>
                  <div className="geo-stage-indicator">
                    {done ? '✓' : active ? icons.loader : s.id}
                  </div>
                  <div className="geo-stage-info">
                    <div className="geo-stage-label">{s.label}</div>
                    <div className="geo-stage-sub">{s.sub}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && <div className="geo-error">{error}</div>}

      {/* ── Results ── */}
      {result && !isRunning && (
        <div className="geo-results">
          <div className="geo-tabs">
            {[
              { id: 'topical', label: 'Topical Authority', icon: icons.map },
              { id: 'geo', label: 'GEO Opportunities', icon: icons.target },
              { id: 'entity', label: 'Entity & Schema', icon: icons.code },
              { id: 'brief', label: 'GEO Brief', icon: icons.fileText },
            ].map(t => (
              <button key={t.id} className={`geo-tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id as any)}>
                {t.icon}{t.label}
              </button>
            ))}
            <button className="geo-rerun-btn" onClick={() => { setResult(null); setCompletedStages([]); setIsRerun(true); }}>New Analysis</button>
          </div>

          {activeTab === 'topical' && (
            <div className="geo-tab-content">
              <div className="geo-section-header">
                <h3>Topical Authority Map</h3>
                <span className="geo-count">{result.topicalAuthorityMap?.length || 0} topics mapped</span>
              </div>
              <div className="geo-grid">
                {(result.topicalAuthorityMap || []).map((item, i) => (
                  <div key={i} className={`geo-card priority-${item.priority || 'low'}`}>
                    <div className="geo-card-top">
                      <span className="geo-topic">{item.topic || (item as any).cluster || (item as any).name || 'Unknown'}</span>
                      <span className={`geo-priority-badge ${item.priority || 'low'}`}>{item.priority || 'low'}</span>
                    </div>
                    <div className="geo-card-coverage">{item.coverage || (item as any).rationale || (item as any).description || ''}</div>
                    <div className="geo-citation-bar">
                      <div className="geo-citation-label">Citation Probability</div>
                      <div className="geo-bar-track"><div className="geo-bar-fill" style={{ width: `${item.citationProbability}%` }} /></div>
                      <div className="geo-citation-pct">{item.citationProbability}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'geo' && (
            <div className="geo-tab-content">
              <div className="geo-section-header">
                <div>
                  <h3>GEO Opportunity Scores</h3>
                  <p className="geo-section-sub">Cherry-pick topics to build briefs. Unselected topics stay in the repository as brain signal.</p>
                </div>
                <span className="geo-count">
                  {opportunities.filter(o => o.status === 'discovered' && o.quickWin).length} quick wins
                  {' · '}
                  {opportunities.filter(o => o.status === 'discovered').length} available
                </span>
              </div>

              {opportunities.filter(o => o.status === 'discovered').length > 0 && (
                <div className="geo-cherry-bar">
                  <div className="geo-cherry-selected">
                    {selectedOppIds.size} selected
                  </div>
                  <div className="geo-cherry-actions">
                    <button
                      className="geo-cherry-btn-secondary"
                      onClick={() => setSelectedOppIds(new Set())}
                      disabled={selectedOppIds.size === 0}
                    >
                      Clear
                    </button>
                    <button
                      className="geo-cherry-btn-primary"
                      onClick={buildBriefsForSelected}
                      disabled={selectedOppIds.size === 0 || buildingBriefs}
                    >
                      {buildingBriefs ? 'Building briefs...' : `Build Briefs (${selectedOppIds.size})`}
                    </button>
                  </div>
                </div>
              )}

              {briefBuildError && <div className="geo-error">{briefBuildError}</div>}

              <div className="geo-table-wrap">
                <table className="geo-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={opportunities.filter(o => o.status === 'discovered').length > 0 && opportunities.filter(o => o.status === 'discovered').every(o => selectedOppIds.has(o.id))}
                          onChange={e => {
                            if (e.target.checked) {
                              setSelectedOppIds(new Set(opportunities.filter(o => o.status === 'discovered').map(o => o.id)));
                            } else {
                              setSelectedOppIds(new Set());
                            }
                          }}
                        />
                      </th>
                      <th>Topic</th>
                      <th>ChatGPT</th>
                      <th>Perplexity</th>
                      <th>AI Overviews</th>
                      <th>Gemini</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {opportunities.filter(o => o.status === 'discovered').map(opp => (
                      <tr key={opp.id} className={opp.quickWin ? 'quick-win-row' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedOppIds.has(opp.id)}
                            onChange={e => {
                              const next = new Set(selectedOppIds);
                              if (e.target.checked) next.add(opp.id); else next.delete(opp.id);
                              setSelectedOppIds(next);
                            }}
                          />
                        </td>
                        <td className="geo-topic-cell">{opp.topic}</td>
                        <td><ScoreCell score={opp.platformScores?.chatgpt || 0} /></td>
                        <td><ScoreCell score={opp.platformScores?.perplexity || 0} /></td>
                        <td><ScoreCell score={opp.platformScores?.aiOverviews || 0} /></td>
                        <td><ScoreCell score={opp.platformScores?.gemini || 0} /></td>
                        <td>{opp.quickWin && <span className="quick-win-badge">⚡ Quick Win</span>}</td>
                      </tr>
                    ))}
                    {opportunities.filter(o => o.status === 'discovered').length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-secondary, #64748b)' }}>
                          No opportunities available — all have been briefed or moved to backlog.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {opportunities.filter(o => o.status === 'briefed' || o.status === 'enriched').length > 0 && (
                <div className="geo-already-briefed">
                  <div className="geo-section-sub" style={{ marginTop: 24, marginBottom: 8 }}>
                    Briefed topics ({opportunities.filter(o => o.status === 'briefed').length} pending · {opportunities.filter(o => o.status === 'enriched').length} enriched)
                  </div>
                  <div className="geo-briefed-chips">
                    {opportunities.filter(o => o.status !== 'discovered' && o.status !== 'ignored').map(o => (
                      <span key={o.id} className={`geo-briefed-chip status-${o.status}`}>
                        {o.topic}
                        <span className="geo-chip-status">· {o.status}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'entity' && (
            <div className="geo-tab-content">
              <div className="geo-section-header">
                <h3>Entity & Schema Map</h3>
                <span className="geo-count">{(result.entitySchemaMap || []).filter(e => e.competitorCited).length} competitor gaps</span>
              </div>
              <div className="geo-grid">
                {(result.entitySchemaMap || []).map((item, i) => (
                  <div key={i} className={`geo-card ${item.competitorCited ? 'competitor-gap' : ''}`}>
                    <div className="geo-card-top">
                      <span className="geo-topic">{item.entity}</span>
                      <span className="geo-schema-badge">{item.schemaType}</span>
                    </div>
                    <p className="geo-card-coverage">{item.recommendation}</p>
                    {item.competitorCited && <div className="geo-competitor-flag">⚠ Competitor cited, you are not</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'brief' && (
            <div className="geo-tab-content">
              <div className="geo-section-header">
                <div>
                  <h3>Content Briefs</h3>
                  <p className="geo-section-sub">Briefs built from topics you cherry-picked. Send to Enricher or park in Backlog.</p>
                </div>
                <span className="geo-count">
                  {topicBriefs.filter(b => b.status === 'briefed').length} ready
                  {' · '}
                  {topicBriefs.filter(b => b.status === 'backlog').length} in backlog
                </span>
              </div>

              {topicBriefs.length === 0 && (
                <div className="geo-brief-empty">
                  <div className="geo-brief-empty-title">No briefs built yet</div>
                  <div className="geo-brief-empty-body">
                    Head to <strong>GEO Opportunities</strong>, cherry-pick the topics you want to write about, and click <strong>Build Briefs</strong>.
                    Forge will generate a per-topic brief (H1, H2s, entities, FAQs) for each selected topic.
                  </div>
                  <button className="geo-cherry-btn-primary" onClick={() => setActiveTab('geo')}>Go to Opportunities →</button>
                </div>
              )}

              {topicBriefs.filter(b => b.status === 'briefed').length > 0 && (
                <div className="geo-briefs-list">
                  {topicBriefs.filter(b => b.status === 'briefed').map(b => (
                    <div key={b.id} className="geo-brief-card-v2">
                      <div className="brief-card-header">
                        <div>
                          <div className="brief-card-topic">{b.topic}</div>
                          {b.quickWin && <span className="quick-win-badge small">⚡ Quick Win</span>}
                        </div>
                        <div className="brief-card-actions">
                          <button className="brief-card-btn-backlog" onClick={() => backlogBrief(b.id)}>→ Backlog</button>
                          <button className="brief-card-btn-enrich" onClick={() => enrichBrief(b.id)}>Enrich Now →</button>
                        </div>
                      </div>
                      {b.briefData?.h1 && (
                        <div className="brief-block"><div className="brief-label">H1</div><div className="brief-value">{b.briefData.h1}</div></div>
                      )}
                      {b.briefData?.executiveSummary && (
                        <div className="brief-block"><div className="brief-label">Summary</div><div className="brief-value">{b.briefData.executiveSummary}</div></div>
                      )}
                      {b.briefData?.h2s && b.briefData.h2s.length > 0 && (
                        <div className="brief-block">
                          <div className="brief-label">H2 Structure ({b.briefData.h2s.length})</div>
                          {b.briefData.h2s.map((h2, i) => (
                            <div key={i} className="brief-h2">
                              <div className="brief-h2-heading">{h2.heading}</div>
                              {h2.intent && <div className="brief-h2-intent">{h2.intent}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                      {b.briefData?.geoAnchors && b.briefData.geoAnchors.length > 0 && (
                        <div className="brief-block">
                          <div className="brief-label">GEO Anchors</div>
                          <div className="brief-anchors">{b.briefData.geoAnchors.map((a, i) => <span key={i} className="brief-anchor-tag">{a}</span>)}</div>
                        </div>
                      )}
                      {b.briefData?.faqStructure && b.briefData.faqStructure.length > 0 && (
                        <div className="brief-block">
                          <div className="brief-label">FAQ ({b.briefData.faqStructure.length})</div>
                          {b.briefData.faqStructure.slice(0, 3).map((faq, i) => (
                            <div key={i} className="brief-faq-item"><div className="faq-q">Q: {faq.question}</div></div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {topicBriefs.filter(b => b.status === 'backlog').length > 0 && (
                <>
                  <div className="geo-section-sub" style={{ marginTop: 32, marginBottom: 12 }}>
                    Backlog — topics parked for later ({topicBriefs.filter(b => b.status === 'backlog').length})
                  </div>
                  <div className="geo-backlog-list">
                    {topicBriefs.filter(b => b.status === 'backlog').map(b => (
                      <div key={b.id} className="geo-backlog-item">
                        <span>{b.topic}</span>
                        <button className="brief-card-btn-resurface" onClick={() => resurfaceBrief(b.id)}>Resurface →</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}


    </div>
  );
}

function ScoreCell({ score }: { score: number }) {
  const color = score >= 70 ? 'var(--color-success)' : score >= 40 ? 'var(--color-warning)' : 'var(--color-text-muted)';
  return <span style={{ color, fontWeight: 600 }}>{score}</span>;
}

export default function GeoStrategistPage() {
  const { isPaid, brandLoading, activeBrand } = useApp();
  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell>
        <div className="geo-gate-wrapper">
          <GateModal
            featureName="GEO Strategist"
            brandProfileId={activeBrand?.id}
            onClose={() => window.location.href = '/app/context-hub'}
            onUnlocked={() => {}}
          />
        </div>
      </AppShell>
    );
  }

  return <AppShell><GeoStrategistContent /></AppShell>;
}
