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


export default function AdminPage() {
  const { getToken } = useAuth();
  const { activeBrand } = useApp();
  const [data, setData] = useState<MissionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

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

            {/* ── 2. Live Log Tail ── */}
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
              <div style={{ maxHeight: 400, overflow: 'auto', background: '#0f172a', borderRadius: 8, padding: '8px 0', fontFamily: 'monospace', fontSize: 11 }}>
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

            {/* ── 3. Error Aggregation ── */}
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

            {/* ── 4. Deploys ── */}
            {['production', 'development'].map(env => {
              const envDeploys = env === 'production' ? deploys.production : deploys.development;
              const failed = envDeploys.filter(d => d.status === 'build_failed' || d.status === 'update_failed');
              return (
                <div key={env} className="mc-panel" style={{ gridColumn: env === 'production' ? '1 / 2' : '2 / -1' }}>
                  <div className="mc-panel-header">
                    <span className="mc-panel-title">{env.toUpperCase()} DEPLOYS</span>
                    <span className="mc-panel-meta">
                      {failed.length > 0 ? `❌ ${failed.length} failed` : envDeploys.length > 0 && envDeploys[0].status === 'live' ? '✅ Live' : '—'}
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

            {/* ── 5. Three-column row: Agent Activity | Brain+Publishing | Provider Costs ── */}
            <div className="mc-grid">
              {/* 5a: Agent Activity */}
              <div className="mc-panel mc-activity-panel" style={{ minHeight: 380 }}>
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

              {/* 5b: Brain Memory + Publishing */}
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

              {/* 5c: Provider Costs — Anthropic, Perplexity, fal.ai */}
              <div className="mc-panel mc-tokens-panel" style={{ minHeight: 380 }}>
                <div className="mc-panel-header">
                  <span className="mc-panel-title">PROVIDER COSTS</span>
                  <span className="mc-panel-meta">30d · {estimateCost(data.activity.totalTokens)}</span>
                </div>
                <div style={{ padding: '12px 0' }}>
                  {(() => {
                    const agents = data.activity.agentBreakdown || [];
                    const anthropicTokens = agents.filter(a => a.agent.startsWith('stage')).reduce((s, a) => s + a.tokens, 0);
                    const perplexityTokens = agents.filter(a => a.agent.includes('perplexity') || a.agent.includes('sonar')).reduce((s, a) => s + a.tokens, 0);
                    const falTokens = agents.filter(a => a.agent.includes('fal')).reduce((s, a) => s + a.tokens, 0);
                    const providers = [
                      { name: 'Anthropic', sub: 'Claude Sonnet 4.6 + Haiku', tokens: anthropicTokens, rate: 6, color: '#D97706', icon: '🧠' },
                      { name: 'Perplexity', sub: 'Sonar Pro', tokens: perplexityTokens, rate: 3, color: '#3B82F6', icon: '🔍' },
                      { name: 'fal.ai', sub: 'FLUX Schnell', tokens: falTokens, rate: 0.003, color: '#8B5CF6', icon: '🎨' },
                    ];
                    return providers.map(p => {
                      const cost = p.name === 'fal.ai' ? (p.tokens * 0.003) : (p.tokens / 1000000) * p.rate;
                      return (
                        <div key={p.name} style={{
                          padding: '14px 16px', marginBottom: 8, borderRadius: 8,
                          background: 'var(--color-bg, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <div>
                              <span style={{ fontSize: 14 }}>{p.icon} </span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text, #1e293b)' }}>{p.name}</span>
                              <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>{p.sub}</span>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: p.color }}>
                              {cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                            <span>{p.name === 'fal.ai' ? `${p.tokens} images` : `${fmt(p.tokens)} tokens`}</span>
                            <span>{p.name === 'fal.ai' ? '$0.003/image' : `$${p.rate}/M tokens`}</span>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
                <div style={{ borderTop: '1px solid var(--color-border, #e2e8f0)', padding: '12px 0 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text, #1e293b)' }}>TOTAL</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-accent, #4F46E5)' }}>
                      {estimateCost(data.activity.totalTokens)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                    {fmt(data.activity.totalTokens)} total tokens · {data.activity.avgLatency}ms avg latency · {data.activity.errors} errors
                  </div>
                </div>
              </div>
            </div>

          </>
        ) : null}
      </div>
    </AppShell>
  );
}
