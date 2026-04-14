import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import './AdminPage.css';

function fmt(n: number) {
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n/1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function estimateCost(tokens: number): string {
  // Rough Sonnet 4.6 blended rate ~$6/M tokens
  const cost = (tokens / 1000000) * 6;
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

interface MissionData {
  platform: { totalBrands: number; totalContent: number; totalReach: number };
  brain: { writingRules: number; contentSignals: number; totalMistakes: number; humanEdits: number; falsePositives: number; totalPatterns: number };
  activity: { totalCalls: number; totalTokens: number; avgLatency: number; errors: number; activeBrands: number; agentBreakdown: { agent: string; calls: number; tokens: number; avgMs: number }[] };
  publishing: { channel: string; total: number; published: number; errors: number }[];
  integrations: { channel: string; total: number; active: number }[];
  tableSizes: { table: string; sizeBytes: number; sizePretty: string; overThreshold: boolean }[];
  recentActivity: { agent: string; brand: string; status: string; tokens: number; latency: number; createdAt: string; metadata: any }[];
}

interface Reviewer { id: string; name: string; email: string; title: string; }

export default function AdminPage() {
  const { getToken } = useAuth();
  const { activeBrand } = useApp();
  const [data, setData] = useState<MissionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedBrand = activeBrand?.id || '';

  // Live logs
  interface LogEntry { ts: string; level: string; msg: string; isError: boolean; isWarn: boolean; }
  interface ErrorAgg { key: string; count: number; firstSeen: string; lastSeen: string; lastMsg: string; level: string; }
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [errorAggs, setErrorAggs] = useState<ErrorAgg[]>([]);
  const [logPaused, setLogPaused] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warn'>('all');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Deploys
  interface Deploy { id: string; status: string; commitMessage: string; commitId: string; createdAt: string; finishedAt: string; env: string; }
  const [deploys, setDeploys] = useState<{ production: Deploy[]; development: Deploy[] }>({ production: [], development: [] });

  const loadData = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await fetch('/api/admin/mission-control', { headers: { 'Authorization': `Bearer ${token}` } });
      const d = await r.json();
      if (d.success) { setData(d); setLastRefresh(new Date()); }
    } catch(e) { console.error('Mission control fetch error:', e); }
    setLoading(false);
  }, [getToken]);

  useEffect(() => { loadData(); }, [loadData]);

  // SSE live log stream
  useEffect(() => {
    let es: EventSource | null = null;
    const connect = async () => {
      const token = await getToken();
      if (!token) return;
      es = new EventSource(`/api/admin/logs/stream?token=${token}`);
      es.onmessage = (e) => {
        if (logPaused) return;
        try {
          const entry = JSON.parse(e.data);
          setLogEntries(prev => [...prev.slice(-499), entry]);
        } catch {}
      };
      es.onerror = () => { es?.close(); setTimeout(connect, 5000); };
    };
    connect();
    return () => es?.close();
  }, [getToken, logPaused]);

  // Auto-scroll log tail
  useEffect(() => {
    if (!logPaused) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEntries, logPaused]);

  // Fetch error aggregates every 30s
  useEffect(() => {
    const fetchErrors = async () => {
      const token = await getToken();
      if (!token) return;
      const r = await fetch('/api/admin/logs/errors', { headers: { 'Authorization': `Bearer ${token}` } });
      const d = await r.json();
      if (d.success) setErrorAggs(d.errors);
    };
    fetchErrors();
    const interval = setInterval(fetchErrors, 30000);
    return () => clearInterval(interval);
  }, [getToken]);

  // Fetch deploy status
  useEffect(() => {
    const fetchDeploys = async () => {
      const token = await getToken();
      if (!token) return;
      const r = await fetch('/api/admin/deploys', { headers: { 'Authorization': `Bearer ${token}` } });
      const d = await r.json();
      if (d.success) setDeploys({ production: d.production || [], development: d.development || [] });
    };
    fetchDeploys();
    const interval = setInterval(fetchDeploys, 60000);
    return () => clearInterval(interval);
  }, [getToken]);

  useEffect(() => {
    if (!selectedBrand) return;
    fetch(`/api/reviewers/${selectedBrand}`).then(r => r.json()).then(d => {
      if (d.success) setReviewers(d.reviewers);
    });
  }, [selectedBrand]);

  const addReviewer = async () => {
    if (!name.trim() || !email.trim()) { setError('Name and email required'); return; }
    setSaving(true); setError('');
    const r = await fetch('/api/reviewers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandProfileId: selectedBrand, name: name.trim(), email: email.trim(), title: title.trim() })
    });
    const d = await r.json();
    if (d.success) { setReviewers(prev => [...prev, d.reviewer]); setName(''); setEmail(''); setTitle(''); }
    else { setError(d.error || 'Failed'); }
    setSaving(false);
  };

  const removeReviewer = async (id: string) => {
    await fetch(`/api/reviewers/${id}`, { method: 'DELETE' });
    setReviewers(prev => prev.filter(r => r.id !== id));
  };

  const totalPublished = data?.publishing.reduce((s, p) => s + p.published, 0) || 0;
  const totalIntegrations = data?.integrations.reduce((s, i) => s + i.active, 0) || 0;
  const totalChannels = data?.integrations.length || 0;
  const brainTotal = (data?.brain.writingRules || 0) + (data?.brain.totalMistakes || 0) + (data?.brain.totalPatterns || 0);

  return (
    <AppShell pageTitle="Mission Control">
      <div className="mc-page">
        {/* Header */}
        <div className="mc-header">
          <div>
            <div className="mc-eyebrow">ADMIN</div>
            <h1 className="mc-title">Mission Control</h1>
            <p className="mc-updated">Updated {lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
          <button className="mc-refresh-btn" onClick={() => { setLoading(true); loadData(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'spin' : ''}>
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
            </svg>
            Refresh
          </button>
        </div>

        {loading && !data ? (
          <div className="mc-loading">Loading platform data...</div>
        ) : data ? (
          <>
            {/* Status Cards */}
            <div className="mc-status-grid">
              <div className="mc-status-card">
                <div className="mc-status-label">PRODUCTION</div>
                <div className="mc-status-badge mc-live">LIVE</div>
                <div className="mc-status-sub">{fmt(data.platform.totalReach)} total reach</div>
              </div>
              <div className="mc-status-card">
                <div className="mc-status-label">CONTENT</div>
                <div className="mc-status-value">{fmt(data.platform.totalContent)}</div>
                <div className="mc-status-sub">{totalPublished} published across {data.publishing.length} channels</div>
              </div>
              <div className="mc-status-card">
                <div className="mc-status-label">INTEGRATIONS</div>
                <div className="mc-status-value">{totalIntegrations}<span className="mc-status-dim">/{totalChannels * data.platform.totalBrands}</span></div>
                <div className="mc-status-sub">{totalChannels} channels · {data.platform.totalBrands} brands</div>
              </div>
              <div className="mc-status-card">
                <div className="mc-status-label">BRAIN</div>
                <div className="mc-status-badge mc-online">ONLINE</div>
                <div className="mc-status-sub">{brainTotal} records</div>
              </div>
            </div>

            {/* Main Grid */}
            <div className="mc-grid">
              {/* Left: Agent Activity Feed */}
              <div className="mc-panel mc-activity-panel">
                <div className="mc-panel-header">
                  <span className="mc-panel-title">AGENT ACTIVITY</span>
                  <span className="mc-panel-meta">{data.activity.totalCalls} calls · 30d</span>
                </div>
                <div className="mc-activity-list">
                  {data.recentActivity.length === 0 ? (
                    <div className="mc-empty">No recent agent activity</div>
                  ) : data.recentActivity.map((a, i) => (
                    <div key={i} className={`mc-activity-row mc-status-${a.status}`}>
                      <div className="mc-activity-agent">{a.agent}</div>
                      <div className="mc-activity-detail">
                        <span className={`mc-activity-status ${a.status}`}>{a.status}</span>
                        <span className="mc-activity-tokens">{a.tokens ? fmt(a.tokens) + ' tok' : ''}</span>
                        <span className="mc-activity-time">{timeAgo(a.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Center: Brain Memory + Publishing */}
              <div className="mc-center-stack">
                <div className="mc-panel mc-brain-panel">
                  <div className="mc-panel-header">
                    <span className="mc-panel-title">BRAIN MEMORY</span>
                    <span className="mc-panel-meta">{brainTotal} total</span>
                  </div>
                  <div className="mc-brain-breakdown">
                    {[
                      { label: 'Writing Rules', value: data.brain.writingRules, max: 20, color: 'var(--color-accent)' },
                      { label: 'Human Edits', value: data.brain.humanEdits, max: 100, color: '#F5B942' },
                      { label: 'Mistakes', value: data.brain.totalMistakes, max: 100, color: '#14B8A6' },
                      { label: 'False Positives', value: data.brain.falsePositives, max: 10, color: '#EF4444' },
                    ].map(item => (
                      <div key={item.label} className="mc-brain-row">
                        <span className="mc-brain-label">{item.label}</span>
                        <div className="mc-brain-bar-wrap">
                          <div className="mc-brain-bar" style={{ width: `${Math.min(100, (item.value / item.max) * 100)}%`, background: item.color }} />
                        </div>
                        <span className="mc-brain-count">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mc-panel mc-publish-panel">
                  <div className="mc-panel-header">
                    <span className="mc-panel-title">PUBLISHING</span>
                    <span className="mc-panel-meta">{totalPublished} published</span>
                  </div>
                  <div className="mc-publish-grid">
                    {data.publishing.map(p => (
                      <div key={p.channel} className="mc-publish-row">
                        <span className="mc-publish-channel">{p.channel}</span>
                        <span className="mc-publish-count">{p.published}</span>
                        {p.errors > 0 && <span className="mc-publish-errors">{p.errors} err</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right: Token Usage */}
              <div className="mc-panel mc-tokens-panel">
                <div className="mc-panel-header">
                  <span className="mc-panel-title">TOKEN USAGE</span>
                  <span className="mc-panel-meta">{estimateCost(data.activity.totalTokens)}</span>
                </div>
                <div className="mc-token-summary">
                  <div className="mc-token-big">
                    <span className="mc-token-number">{fmt(data.activity.totalTokens)}</span>
                    <span className="mc-token-label">TOTAL TOKENS</span>
                  </div>
                  <div className="mc-token-stats">
                    <div className="mc-token-stat">
                      <span className="mc-token-stat-val">{data.activity.avgLatency}ms</span>
                      <span className="mc-token-stat-label">AVG LATENCY</span>
                    </div>
                    <div className="mc-token-stat">
                      <span className="mc-token-stat-val">{data.activity.errors}</span>
                      <span className="mc-token-stat-label">ERRORS</span>
                    </div>
                  </div>
                </div>
                <div className="mc-agent-list">
                  {data.activity.agentBreakdown.map(a => (
                    <div key={a.agent} className="mc-agent-row">
                      <span className="mc-agent-name">{a.agent}</span>
                      <span className="mc-agent-calls">{a.calls} calls</span>
                      <span className="mc-agent-tokens">{fmt(a.tokens)} tok</span>
                      <span className="mc-agent-cost">{estimateCost(a.tokens)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Deploy Status */}
            {['production', 'development'].map(env => {
              const envDeploys = env === 'production' ? deploys.production : deploys.development;
              const failed = envDeploys.filter(d => d.status === 'build_failed' || d.status === 'update_failed');
              return (
                <div key={env} className="mc-panel" style={{ gridColumn: env === 'production' ? '1 / 2' : '2 / -1' }}>
                  <div className="mc-panel-header">
                    <span className="mc-panel-title">{env.toUpperCase()} DEPLOYS</span>
                    <span className="mc-panel-meta">
                      {failed.length > 0 ? `❌ ${failed.length} failed` : envDeploys.length > 0 && envDeploys[0].status === 'live' ? '✅ Live' : '...'}
                    </span>
                  </div>
                  <div style={{ maxHeight: 260, overflow: 'auto' }}>
                    {envDeploys.slice(0, 8).map((d, i) => {
                      const isFailed = d.status === 'build_failed' || d.status === 'update_failed';
                      const isLive = d.status === 'live';
                      const isBuilding = d.status === 'build_in_progress' || d.status === 'queued';
                      return (
                        <div key={d.id || i} style={{
                          padding: '8px 12px', borderBottom: '1px solid #f1f5f9',
                          background: isFailed ? '#FEF2F2' : isBuilding ? '#FFFBEB' : 'transparent'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                            <span style={{
                              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                              background: isFailed ? '#FEE2E2' : isLive ? '#D1FAE5' : isBuilding ? '#FEF3C7' : '#F1F5F9',
                              color: isFailed ? '#B91C1C' : isLive ? '#065F46' : isBuilding ? '#92400E' : '#64748b'
                            }}>{d.status.replace(/_/g, ' ')}</span>
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>
                              {d.commitId && <code style={{ marginRight: 6 }}>{d.commitId}</code>}
                              {d.createdAt ? new Date(d.createdAt).toLocaleString() : ''}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: isFailed ? '#B91C1C' : '#475569', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                            {d.commitMessage.slice(0, 120) || 'No commit message'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Table Size Monitor */}
            {data?.tableSizes && data.tableSizes.length > 0 && (
              <div className="mc-panel" style={{ gridColumn: '1 / -1' }}>
                <div className="mc-panel-header">
                  <span className="mc-panel-title">CONTENT TABLE SIZES</span>
                  <span className="mc-panel-meta">
                    {data.tableSizes.filter(t => t.overThreshold).length > 0
                      ? `⚠️ ${data.tableSizes.filter(t => t.overThreshold).length} over 500KB`
                      : '✅ All under 500KB'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 0' }}>
                  {data.tableSizes.map((t, i) => (
                    <div key={i} style={{
                      padding: '8px 14px', borderRadius: 8, fontSize: 12, fontFamily: 'monospace',
                      background: t.overThreshold ? '#FEF2F2' : 'var(--color-bg, #f8fafc)',
                      border: `1px solid ${t.overThreshold ? '#FECACA' : 'var(--color-border, #e2e8f0)'}`,
                      color: t.overThreshold ? '#B91C1C' : 'var(--color-text-secondary, #64748b)'
                    }}>
                      <span style={{ fontWeight: 600 }}>{t.table.replace('generated_content_', '').slice(0, 8)}...</span>
                      {' '}{t.sizePretty}
                      {t.overThreshold && ' ⚠️'}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error Aggregation Card */}
            <div className="mc-panel" style={{ gridColumn: '1 / -1' }}>
              <div className="mc-panel-header">
                <span className="mc-panel-title">ERROR AGGREGATION</span>
                <span className="mc-panel-meta">{errorAggs.length} unique errors</span>
              </div>
              {errorAggs.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', color: '#10b981', fontSize: 13 }}>No errors captured since last deploy</div>
              ) : (
                <div style={{ maxHeight: 240, overflow: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #e2e8f0', color: '#64748b', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>Error</th>
                        <th style={{ padding: '6px 8px', width: 60 }}>Count</th>
                        <th style={{ padding: '6px 8px', width: 140 }}>Last Seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {errorAggs.slice(0, 20).map((e, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '6px 8px', color: '#ef4444', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>{e.lastMsg.slice(0, 150)}</td>
                          <td style={{ padding: '6px 8px', fontWeight: 600, color: e.count > 5 ? '#ef4444' : '#f59e0b' }}>{e.count}</td>
                          <td style={{ padding: '6px 8px', color: '#64748b', fontSize: 11 }}>{new Date(e.lastSeen).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Live Log Tail */}
            <div className="mc-panel" style={{ gridColumn: '1 / -1' }}>
              <div className="mc-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span className="mc-panel-title">LIVE LOG TAIL</span>
                  <span className="mc-panel-meta" style={{ marginLeft: 8 }}>{logEntries.length} entries</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['all', 'error', 'warn'] as const).map(f => (
                    <button key={f} onClick={() => setLogFilter(f)} style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: logFilter === f ? 600 : 400,
                      border: '1px solid ' + (logFilter === f ? '#4F46E5' : '#e2e8f0'),
                      borderRadius: 6, background: logFilter === f ? '#4F46E5' : '#fff',
                      color: logFilter === f ? '#fff' : '#64748b', cursor: 'pointer'
                    }}>{f === 'all' ? 'All' : f === 'error' ? 'Errors' : 'Warnings'}</button>
                  ))}
                  <button onClick={() => setLogPaused(!logPaused)} style={{
                    padding: '4px 10px', fontSize: 11, border: '1px solid ' + (logPaused ? '#f59e0b' : '#e2e8f0'),
                    borderRadius: 6, background: logPaused ? '#fef3c7' : '#fff', color: logPaused ? '#92400e' : '#64748b', cursor: 'pointer'
                  }}>{logPaused ? '▶ Resume' : '⏸ Pause'}</button>
                  <button onClick={() => setLogEntries([])} style={{
                    padding: '4px 10px', fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', color: '#64748b', cursor: 'pointer'
                  }}>Clear</button>
                </div>
              </div>
              <div style={{ maxHeight: 400, overflow: 'auto', background: '#0f172a', borderRadius: 8, padding: '8px 0', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
                {logEntries
                  .filter(e => logFilter === 'all' || (logFilter === 'error' && e.isError) || (logFilter === 'warn' && e.isWarn))
                  .map((e, i) => (
                  <div key={i} style={{
                    padding: '1px 12px',
                    color: e.isError ? '#fca5a5' : e.isWarn ? '#fcd34d' : '#94a3b8',
                    background: e.isError ? 'rgba(239,68,68,0.08)' : 'transparent',
                    borderLeft: e.isError ? '3px solid #ef4444' : e.isWarn ? '3px solid #f59e0b' : '3px solid transparent'
                  }}>
                    <span style={{ color: '#475569' }}>{new Date(e.ts).toLocaleTimeString()}</span>
                    {' '}
                    <span>{e.msg.slice(0, 300)}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>

            {/* Reviewers Section */}
            <div className="mc-panel mc-reviewers-panel">
              <div className="mc-panel-header">
                <span className="mc-panel-title">REVIEWERS</span>
                <span className="mc-panel-meta">Compliance Gate approval workflow</span>
              </div>
              <p className="mc-reviewer-desc">Reviewers receive an email with a unique link to approve or request changes on articles before they publish.</p>
              <div className="mc-reviewer-form">
                <input className="mc-input" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
                <input className="mc-input" placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
                <input className="mc-input" placeholder="Title (optional)" value={title} onChange={e => setTitle(e.target.value)} />
                <button className="mc-add-btn" onClick={addReviewer} disabled={saving}>
                  {saving ? 'Adding...' : '+ Add'}
                </button>
              </div>
              {error && <div className="mc-error">{error}</div>}
              {reviewers.length > 0 && (
                <div className="mc-reviewer-list">
                  {reviewers.map(r => (
                    <div key={r.id} className="mc-reviewer-row">
                      <div className="mc-reviewer-avatar">{r.name[0].toUpperCase()}</div>
                      <div className="mc-reviewer-info">
                        <div className="mc-reviewer-name">{r.name}</div>
                        <div className="mc-reviewer-meta">{r.email}{r.title ? ` · ${r.title}` : ''}</div>
                      </div>
                      <button className="mc-remove-btn" onClick={() => removeReviewer(r.id)} title="Remove">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
