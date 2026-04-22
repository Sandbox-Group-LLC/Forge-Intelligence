import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
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

export default function StrategyIntelPage() {
  const { setCurrentView, activeBrand, authToken } = useApp();
  const [competitors, setCompetitors] = useState<CompetitorIntel[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'pva' | 'faultlines'>('pva');
  const [expandedComp, setExpandedComp] = useState<string | null>(null);

  const brandProfileId = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';

  useEffect(() => { setCurrentView('strategy-intel'); }, []);

  // Load cached results on mount
  useEffect(() => {
    if (!brandProfileId || !authToken) return;
    fetch(`/api/strategy/competitive-intel/${brandProfileId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success && d.competitors?.length) setCompetitors(d.competitors); })
      .catch(() => {});
  }, [brandProfileId, authToken]);

  const runAnalysis = async (force = false) => {
    if (!brandProfileId) return;
    setIsRunning(true);
    setError('');
    setProgress([]);
    setCompetitors([]);

    try {
      const response = await fetch(`/api/strategy/competitive-intel/${brandProfileId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ force })
      });
      // 401 = token expired/missing. Surface clearly instead of silently draining an empty body.
      if (response.status === 401) {
        throw new Error('Your session expired. Refresh the page and try again.');
      }
      if (!response.ok && response.status !== 200) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Server returned ${response.status}: ${errBody.slice(0, 200) || 'no body'}`);
      }

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
              if (evt.type === 'progress' || evt.type === 'detail') {
                setProgress(prev => [...prev, evt.detail]);
              } else if (evt.type === 'result') {
                setCompetitors(evt.competitors || []);
              } else if (evt.type === 'error') {
                throw new Error(evt.error);
              }
            } catch (pe: any) {
              if (pe.message && !pe.message.includes('JSON')) throw pe;
            }
          }
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsRunning(false);
    }
  };

  const severityColor = (s: string) => s === 'high' ? '#ef4444' : s === 'medium' ? '#f5b942' : '#94a3b8';
  const priorityColor = (p: string) => p === 'high' ? '#3563ff' : p === 'medium' ? '#8b5cf6' : '#94a3b8';

  return (
    <AppShell>
      <div className="si-page">
        <div className="si-header">
          <div>
            <h1 className="si-title">Competitive Intelligence</h1>
            <p className="si-sub">Positioning Vulnerability Analysis + Messaging Fault Lines</p>
          </div>
          <div className="si-header-actions">
            {competitors.length > 0 && !isRunning && (
              <button className="si-btn-secondary" onClick={() => runAnalysis(true)}>
                Re-analyze
              </button>
            )}
            {competitors.length === 0 && !isRunning && (
              <button className="si-btn-primary" onClick={() => runAnalysis(false)}>
                Run Competitive Intelligence
              </button>
            )}
          </div>
        </div>

        {/* Progress feed */}
        {isRunning && (
          <div className="si-progress">
            <div className="si-progress-title">Analyzing competitors...</div>
            {progress.map((msg, i) => (
              <div key={i} className="si-progress-line">{msg}</div>
            ))}
            <div className="si-progress-spinner" />
          </div>
        )}

        {error && <div className="si-error">{error}</div>}

        {/* Results */}
        {competitors.length > 0 && !isRunning && (
          <>
            {/* Tab switcher */}
            <div className="si-tabs">
              <button
                className={`si-tab ${activeTab === 'pva' ? 'active' : ''}`}
                onClick={() => setActiveTab('pva')}
              >
                Vulnerabilities
                <span className="si-tab-count">
                  {competitors.reduce((sum, c) => sum + (c.pva?.length || 0), 0)}
                </span>
              </button>
              <button
                className={`si-tab ${activeTab === 'faultlines' ? 'active' : ''}`}
                onClick={() => setActiveTab('faultlines')}
              >
                Fault Lines
                <span className="si-tab-count">
                  {competitors.reduce((sum, c) => sum + (c.faultLines?.length || 0), 0)}
                </span>
              </button>
            </div>

            {/* Competitor cards */}
            <div className="si-competitors">
              {competitors.map(comp => {
                const items = activeTab === 'pva' ? comp.pva : comp.faultLines;
                const isExpanded = expandedComp === comp.url || competitors.length <= 2;
                return (
                  <div key={comp.url} className="si-comp-card">
                    <button
                      className="si-comp-header"
                      onClick={() => setExpandedComp(expandedComp === comp.url ? null : comp.url)}
                    >
                      <div className="si-comp-name">{comp.name}</div>
                      <div className="si-comp-meta">
                        <span className="si-comp-url">{comp.url.replace(/https?:\/\/(www\.)?/, '')}</span>
                        <span className="si-comp-count">
                          {items?.length || 0} {activeTab === 'pva' ? 'vulnerabilities' : 'fault lines'}
                        </span>
                      </div>
                    </button>

                    {isExpanded && activeTab === 'pva' && (
                      <div className="si-items">
                        {(comp.pva || []).map((v, i) => (
                          <div key={i} className="si-item">
                            <div className="si-item-header">
                              <span className="si-severity" style={{ color: severityColor(v.severity) }}>
                                {v.severity?.toUpperCase()}
                              </span>
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

                    {isExpanded && activeTab === 'faultlines' && (
                      <div className="si-items">
                        {(comp.faultLines || []).map((fl, i) => (
                          <div key={i} className="si-item">
                            <div className="si-item-header">
                              <span className="si-severity" style={{ color: priorityColor(fl.priority) }}>
                                {fl.priority?.toUpperCase()}
                              </span>
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
          </>
        )}

        {/* Empty state */}
        {competitors.length === 0 && !isRunning && !error && (
          <div className="si-empty-state">
            <div className="si-empty-title">No competitive intelligence yet</div>
            <div className="si-empty-body">
              Forge will scrape your competitors' public positioning pages, identify vulnerabilities in their claims,
              and map the exact language they use so you can differentiate against it.
            </div>
            <button className="si-btn-primary" onClick={() => runAnalysis(false)}>
              Run Competitive Intelligence
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
