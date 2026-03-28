import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import './PerformanceDashboardPage.css';

// ── Types ─────────────────────────────────────────────────────────────────
interface AnalyticsTotals {
  posts: number; impressions: number; clicks: number;
  reactions: number; comments: number; reposts: number;
  avgCtr: string; avgEngagementRate: string; lastSynced: string | null;
}
interface TrendPoint { day: string; impressions: number; clicks: number; reactions: number; }
interface PostRow {
  content_id: string; title: string; impressions: number; clicks: number;
  reactions: number; comments: number; reposts: number; ctr: number;
  engagement_rate: number; published_at: string; hero_image_url?: string; channel: string;
}
interface DashboardData {
  totals: AnalyticsTotals; trend: TrendPoint[]; posts: PostRow[]; topPosts: PostRow[];
}
interface ChannelInfo { channel: string; post_count: number; impressions: number; last_synced: string; }

const CHANNELS = [
  { id: 'linkedin', label: 'LinkedIn', live: true },
  { id: 'wordpress', label: 'WordPress', live: false },
  { id: 'x', label: 'X (Twitter)', live: false },
  { id: 'webflow', label: 'Webflow', live: false },
];

function fmt(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function timeAgo(ts: string | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── SVG Sparkline (pure, no deps) ─────────────────────────────────────────
function Sparkline({ data, key: _k }: { data: number[]; key?: string }) {
  if (!data || data.length < 2) return (
    <svg width="100%" height="40" viewBox="0 0 200 40" className="sparkline-empty">
      <line x1="0" y1="20" x2="200" y2="20" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" opacity="0.2" />
      <text x="100" y="28" textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.3">No data yet</text>
    </svg>
  );
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 200, h = 40, pad = 4;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });
  const area = `M${pts[0]} L${pts.join(' L')} L${w - pad},${h} L${pad},${h} Z`;
  return (
    <svg width="100%" height="40" viewBox={`0 0 ${w} ${h}`} className="sparkline" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.25"/>
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sg)" />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1].split(',')[0]} cy={pts[pts.length - 1].split(',')[1]} r="2.5" fill="var(--color-primary)" />
    </svg>
  );
}

// ── Trend Chart (30-day line, inline SVG) ─────────────────────────────────
function TrendChart({ data }: { data: TrendPoint[] }) {
  if (!data || data.length === 0) return (
    <div className="trend-empty">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
      <p>Sync analytics to see your 30-day trend</p>
    </div>
  );
  const w = 600, h = 140, padX = 40, padY = 16;
  const maxVal = Math.max(...data.map(d => d.impressions), 1);
  const pts = data.map((d, i) => {
    const x = padX + (i / (data.length - 1)) * (w - padX * 2);
    const y = padY + (1 - d.impressions / maxVal) * (h - padY * 2);
    return { x, y, d };
  });
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length-1].x.toFixed(1)},${h} L${pts[0].x.toFixed(1)},${h} Z`;
  const labels = [0, Math.floor(data.length / 2), data.length - 1].map(i => data[i]);
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="trend-chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.18"/>
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(v => {
        const y = padY + v * (h - padY * 2);
        return <line key={v} x1={padX} y1={y} x2={w - padX} y2={y} stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 4" opacity="0.5" />;
      })}
      <path d={areaPath} fill="url(#tg)" />
      <path d={linePath} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2" fill="var(--color-primary)" opacity="0.7" />)}
      {labels.map((label, i) => (
        <text key={i} x={pts[[0, Math.floor(data.length / 2), data.length - 1][i]].x} y={h - 2} textAnchor="middle" fontSize="9" fill="var(--color-text-muted)">
          {new Date(label.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </text>
      ))}
    </svg>
  );
}

// ── Main Component ────────────────────────────────────────────────────────
export default function PerformanceDashboardPage() {
  const [brandProfileId, setBrandProfileId] = useState('');
  const [brands, setBrands] = useState<{id: string; brandName: string; brandUrl: string}[]>([]);
  const [activeChannel, setActiveChannel] = useState('linkedin');
  const [data, setData] = useState<DashboardData | null>(null);
  const [channelInfo, setChannelInfo] = useState<ChannelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [error, setError] = useState('');

  // Load brands
  useEffect(() => {
    fetch('/api/brand-profiles/list')
      .then(r => r.json())
      .then(d => {
        const list = d.profiles || d.data || d.brands || [];
        setBrands(list);
        if (list.length > 0) setBrandProfileId(list[0].id);
      }).catch(() => {});
  }, []);

  // Load dashboard data
  const loadDashboard = useCallback(async () => {
    if (!brandProfileId) return;
    setLoading(true); setError('');
    try {
      const [dashRes, chanRes] = await Promise.all([
        fetch(`/api/analytics/dashboard/${brandProfileId}?channel=${activeChannel}`),
        fetch(`/api/analytics/channels/${brandProfileId}`)
      ]);
      const dashData = await dashRes.json();
      const chanData = await chanRes.json();
      if (dashData.success) setData(dashData);
      if (chanData.success) setChannelInfo(chanData.channels);
    } catch(e) { setError('Failed to load analytics'); }
    setLoading(false);
  }, [brandProfileId, activeChannel]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Sync analytics
  const handleSync = async () => {
    if (!brandProfileId || syncing) return;
    setSyncing(true); setSyncMsg('');
    try {
      const res = await fetch(`/api/analytics/sync/${brandProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: activeChannel })
      });
      const d = await res.json();
      setSyncMsg(d.success
        ? `Synced ${d.synced} post${d.synced !== 1 ? 's' : ''}${d.errors > 0 ? ` (${d.errors} errors)` : ''}`
        : `Error: ${d.error}`);
      if (d.success) await loadDashboard();
    } catch(e) { setSyncMsg('Sync failed'); }
    setSyncing(false);
    setTimeout(() => setSyncMsg(''), 4000);
  };

  const sparkData = data?.trend?.map(t => t.impressions) || [];
  const maxImpressions = data?.posts?.length ? Math.max(...data.posts.map(p => p.impressions), 1) : 1;

  return (
    <AppShell>
      <div className="perf-page">
        {/* ── Header ── */}
        <div className="perf-header">
          <div className="perf-header-left">
            <h1 className="perf-title">Performance</h1>
            <p className="perf-subtitle">Content analytics across all channels</p>
          </div>
          <div className="perf-header-right">
            {brands.length > 1 && (
              <select
                className="perf-brand-select"
                value={brandProfileId}
                onChange={e => setBrandProfileId(e.target.value)}
              >
                {brands.map(b => <option key={b.id} value={b.id}>{b.brandName || b.brandUrl}</option>)}
              </select>
            )}
            <div className="perf-sync-wrap">
              <button className={`perf-sync-btn ${syncing ? 'syncing' : ''}`} onClick={handleSync} disabled={syncing || !brandProfileId}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={syncing ? 'spin' : ''}>
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
                </svg>
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
              {data?.totals?.lastSynced && (
                <span className="perf-last-sync">Last synced {timeAgo(data.totals.lastSynced)}</span>
              )}
              {syncMsg && <span className={`perf-sync-msg ${syncMsg.startsWith('Error') ? 'error' : 'ok'}`}>{syncMsg}</span>}
            </div>
          </div>
        </div>

        {/* ── Channel Tabs ── */}
        <div className="perf-channels">
          {CHANNELS.map(ch => {
            const hasData = channelInfo.find(c => c.channel === ch.id);
            return (
              <button
                key={ch.id}
                className={`perf-channel-tab ${activeChannel === ch.id ? 'active' : ''} ${!ch.live ? 'coming-soon' : ''}`}
                onClick={() => ch.live && setActiveChannel(ch.id)}
                disabled={!ch.live}
              >
                {ch.label}
                {!ch.live && <span className="perf-soon-badge">Soon</span>}
                {ch.live && hasData && <span className="perf-data-dot" />}
              </button>
            );
          })}
        </div>

        {error && <div className="perf-error">{error}</div>}

        {loading && !data ? (
          <div className="perf-skeleton-wrap">
            {[1,2,3,4].map(i => <div key={i} className="perf-skeleton-card" />)}
          </div>
        ) : (
          <>
            {/* ── KPI Cards ── */}
            <div className="perf-kpis">
              {[
                { label: 'Impressions', value: fmt(data?.totals?.impressions || 0), sub: 'Total views', icon: 'eye', spark: true },
                { label: 'Link Clicks', value: fmt(data?.totals?.clicks || 0), sub: `${data?.totals?.avgCtr || '0'}% avg CTR`, icon: 'click', spark: false },
                { label: 'Reactions', value: fmt(data?.totals?.reactions || 0), sub: `${data?.totals?.comments || 0} comments · ${data?.totals?.reposts || 0} reposts`, icon: 'heart', spark: false },
                { label: 'Engagement Rate', value: `${data?.totals?.avgEngagementRate || '0'}%`, sub: `Across ${data?.totals?.posts || 0} posts`, icon: 'trend', spark: false },
              ].map(kpi => (
                <div key={kpi.label} className="perf-kpi-card">
                  <div className="perf-kpi-top">
                    <span className="perf-kpi-label">{kpi.label}</span>
                    <KpiIcon type={kpi.icon} />
                  </div>
                  <div className="perf-kpi-value">{kpi.value}</div>
                  <div className="perf-kpi-sub">{kpi.sub}</div>
                  {kpi.spark && sparkData.length > 1 && (
                    <div className="perf-kpi-spark"><Sparkline data={sparkData} /></div>
                  )}
                </div>
              ))}
            </div>

            {/* ── 30-Day Trend ── */}
            <div className="perf-section">
              <div className="perf-section-header">
                <h2 className="perf-section-title">30-Day Impressions</h2>
                {data?.trend?.length > 0 && (
                  <span className="perf-section-meta">{data.trend.length} data points</span>
                )}
              </div>
              <div className="perf-trend-card">
                <TrendChart data={data?.trend || []} />
              </div>
            </div>

            {/* ── Posts Table ── */}
            <div className="perf-section">
              <div className="perf-section-header">
                <h2 className="perf-section-title">Published Posts</h2>
                <span className="perf-section-meta">{data?.posts?.length || 0} tracked</span>
              </div>
              {!data?.posts?.length ? (
                <div className="perf-empty">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>
                  <p>No analytics data yet for {activeChannel}. Publish articles and hit Sync to start tracking.</p>
                </div>
              ) : (
                <div className="perf-table-wrap">
                  <table className="perf-table">
                    <thead>
                      <tr>
                        <th>Article</th>
                        <th className="num">Impressions</th>
                        <th className="num">Clicks</th>
                        <th className="num">CTR</th>
                        <th className="num">Reactions</th>
                        <th className="num">Engagement</th>
                        <th>Published</th>
                        <th className="bar-col">Relative reach</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.posts.map(post => (
                        <tr key={post.content_id}>
                          <td className="perf-title-cell">
                            {post.hero_image_url && (
                              <img src={post.hero_image_url} alt="" className="perf-thumb" loading="lazy" width="40" height="28" />
                            )}
                            <span className="perf-post-title">{post.title || 'Untitled'}</span>
                          </td>
                          <td className="num">{fmt(post.impressions)}</td>
                          <td className="num">{fmt(post.clicks)}</td>
                          <td className="num">{post.ctr ? `${post.ctr}%` : '—'}</td>
                          <td className="num">{fmt(post.reactions)}</td>
                          <td className="num">{post.engagement_rate ? `${post.engagement_rate}%` : '—'}</td>
                          <td className="perf-date">{post.published_at ? new Date(post.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
                          <td className="bar-col">
                            <div className="perf-bar-bg">
                              <div className="perf-bar-fill" style={{ width: `${Math.round((post.impressions / maxImpressions) * 100)}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Brain Signals ── */}
            {data?.topPosts?.length > 0 && (
              <div className="perf-section">
                <div className="perf-section-header">
                  <h2 className="perf-section-title">Brain Signals</h2>
                  <span className="perf-brain-badge">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    Feeding Stage 8
                  </span>
                </div>
                <div className="perf-brain-grid">
                  <div className="perf-brain-card">
                    <span className="perf-brain-label">Top performing content</span>
                    {data.topPosts.slice(0, 3).map((p, i) => (
                      <div key={i} className="perf-brain-row">
                        <span className="perf-brain-rank">#{i + 1}</span>
                        <span className="perf-brain-post-title">{p.title || 'Untitled'}</span>
                        <span className="perf-brain-stat">{fmt(p.impressions)} impr.</span>
                      </div>
                    ))}
                  </div>
                  <div className="perf-brain-card">
                    <span className="perf-brain-label">Patterns being extracted</span>
                    <div className="perf-brain-pattern">
                      <span className="perf-pattern-dot primary" />
                      <span>High-impression posts will write Brain Patterns</span>
                    </div>
                    <div className="perf-brain-pattern">
                      <span className="perf-pattern-dot amber" />
                      <span>Low-CTR posts will flag for tone review</span>
                    </div>
                    <div className="perf-brain-pattern">
                      <span className="perf-pattern-dot teal" />
                      <span>Stage 8 Pattern Extractor reads this data</span>
                    </div>
                    <div className="perf-brain-note">Stage 8 automation coming — patterns will self-update</div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

function KpiIcon({ type }: { type: string }) {
  const icons: Record<string, JSX.Element> = {
    eye: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    click: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>,
    heart: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>,
    trend: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  };
  return <span className="perf-kpi-icon">{icons[type] || null}</span>;
}
