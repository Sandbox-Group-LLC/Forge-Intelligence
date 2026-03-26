import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './GeoStrategistPage.css';

interface BrainEntry {
  id: string;
  brandName: string;
  brandUrl: string;
  updatedAt: string;
}

interface GeoResult {
  opportunityScore: number;
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
  const { setCurrentView, historyEntries } = useApp();
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState(0);
  const [completedStages, setCompletedStages] = useState<number[]>([]);
  const [result, setResult] = useState<GeoResult | null>(null);
  const [activeTab, setActiveTab] = useState<'topical' | 'geo' | 'entity' | 'brief'>('topical');
  const [error, setError] = useState('');

  useEffect(() => {
    setCurrentView('geo-strategist');
    const params = new URLSearchParams(window.location.search);
    const profileId = params.get('profileId');
    if (profileId) setSelectedBrainId(profileId);
  }, []);

  // Use historyEntries from AppContext (already loaded) as brain list
  const brains: BrainEntry[] = historyEntries.map(e => ({
    id: e.id,
    brandName: e.brandName,
    brandUrl: e.brandUrl,
    updatedAt: e.timestamp
  }));

  const selectedBrain = brains.find(b => b.id === selectedBrainId);

  const runAnalysis = async () => {
    if (!selectedBrainId) return;
    setIsRunning(true);
    setResult(null);
    setError('');
    setCompletedStages([]);
    setCurrentStage(1);

    const analyzePromise = fetch('/api/geo-strategist/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandProfileId: selectedBrainId })
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
          <div className="geo-score-badge">
            <div className="score-value">{result.opportunityScore}</div>
            <div className="score-label">Opportunity Score</div>
          </div>
        )}
      </div>

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
            <button className="geo-rerun-btn" onClick={() => { setResult(null); setCompletedStages([]); }}>New Analysis</button>
          </div>

          {activeTab === 'topical' && (
            <div className="geo-tab-content">
              <div className="geo-section-header">
                <h3>Topical Authority Map</h3>
                <span className="geo-count">{result.topicalAuthorityMap?.length || 0} topics mapped</span>
              </div>
              <div className="geo-grid">
                {(result.topicalAuthorityMap || []).map((item, i) => (
                  <div key={i} className={`geo-card priority-${item.priority}`}>
                    <div className="geo-card-top">
                      <span className="geo-topic">{item.topic}</span>
                      <span className={`geo-priority-badge ${item.priority}`}>{item.priority}</span>
                    </div>
                    <div className="geo-card-coverage">{item.coverage}</div>
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
                <h3>GEO Opportunity Scores</h3>
                <span className="geo-count">{(result.geoOpportunities || []).filter(o => o.quickWin).length} quick wins</span>
              </div>
              <div className="geo-table-wrap">
                <table className="geo-table">
                  <thead><tr><th>Topic</th><th>ChatGPT</th><th>Perplexity</th><th>AI Overviews</th><th>Gemini</th><th></th></tr></thead>
                  <tbody>
                    {(result.geoOpportunities || []).map((opp, i) => (
                      <tr key={i} className={opp.quickWin ? 'quick-win-row' : ''}>
                        <td className="geo-topic-cell">{opp.topic}</td>
                        <td><ScoreCell score={opp.chatgpt} /></td>
                        <td><ScoreCell score={opp.perplexity} /></td>
                        <td><ScoreCell score={opp.aiOverviews} /></td>
                        <td><ScoreCell score={opp.gemini} /></td>
                        <td>{opp.quickWin && <span className="quick-win-badge">⚡ Quick Win</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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

          {activeTab === 'brief' && result.geoBrief && (
            <div className="geo-tab-content">
              <div className="geo-section-header">
                <h3>GEO Brief</h3>
                <span className="geo-count">Est. citation lift: {result.geoBrief.estimatedCitationLift}</span>
              </div>
              <div className="geo-brief-card">
                <div className="brief-block"><div className="brief-label">Title Tag</div><div className="brief-value">{result.geoBrief.title}</div></div>
                <div className="brief-block"><div className="brief-label">H1</div><div className="brief-value">{result.geoBrief.h1}</div></div>
                <div className="brief-block">
                  <div className="brief-label">H2 Structure</div>
                  {(result.geoBrief.h2s || []).map((h2, i) => <div key={i} className="brief-h2">{h2}</div>)}
                </div>
                <div className="brief-block">
                  <div className="brief-label">GEO Anchors</div>
                  <div className="brief-anchors">{(result.geoBrief.geoAnchors || []).map((a, i) => <span key={i} className="brief-anchor-tag">{a}</span>)}</div>
                </div>
                <div className="brief-block">
                  <div className="brief-label">FAQ Structure</div>
                  {(result.geoBrief.faqItems || []).map((faq, i) => (
                    <div key={i} className="brief-faq-item">
                      <div className="faq-q">Q: {faq.q}</div>
                      <div className="faq-a">A: {faq.a}</div>
                    </div>
                  ))}
                </div>
              </div>
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
  return <AppShell><GeoStrategistContent /></AppShell>;
}
