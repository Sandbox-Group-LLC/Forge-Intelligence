import React, { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import GateModal from '../components/GateModal';
import { useApp } from '../context/AppContext';
import './PerformanceDashboardPage.css';

// ── Types ──────────────────────────────────────────────────────────────────────────────────
interface AnalyticsTotals {
  posts: number; impressions: number; clicks: number;
  reactions: number; comments: number; reposts: number;
  avgCtr: string; avgEngagementRate: string; lastSynced: string | null;
  positiveFeedback?: number; negativeFeedback?: number; avgReadingTime?: number;
}
interface TrendPoint { day: string; impressions: number; clicks: number; reactions: number; }
interface PostRow {
  content_id: string; title: string; impressions: number; clicks: number;
  reactions: number; comments: number; reposts: number; ctr: number;
  engagement_rate: number; published_at: string; hero_image_url?: string; channel: string;
  reading_time?: number; positive_feedback?: number; negative_feedback?: number;
}
interface DashboardData {
  totals: AnalyticsTotals; trend: TrendPoint[]; posts: PostRow[]; topPosts: PostRow[];
}
interface ChannelInfo { channel: string; post_count: number; impressions: number; last_synced: string; }
interface CampaignChannelBreakdown {
  channel: string; impressions: number; clicks: number; reactions: number; reposts: number; article_count: number;
}
interface CampaignTopArticle {
  content_id: string; title: string; impressions: number; clicks: number; reactions: number; channel: string; published_url?: string;
}
interface CampaignRow {
  campaign_id: string; campaign_name: string; topic_cluster: string; campaign_created_at: string;
  article_count: number; channel_count: number;
  total_impressions: number; total_clicks: number; total_reactions: number;
  total_comments: number; total_reposts: number;
  avg_ctr: number; avg_engagement_rate: number; last_synced: string | null;
  channels: CampaignChannelBreakdown[];
  top_articles: CampaignTopArticle[];
}

const CHANNELS = [
  { id: 'patterns', label: 'Patterns', live: true },
  { id: 'predictions', label: 'Predictions', live: true },
  { id: 'linkedin', label: 'LinkedIn', live: true },
  { id: 'x', label: 'X (Twitter)', live: true },
  { id: 'ghost', label: 'Ghost', live: true },
  { id: 'gsc',   label: 'GSC',   live: true },
  { id: 'geo',   label: 'GEO',   live: true },
  { id: 'wordpress', label: 'WordPress', live: false },
  { id: 'webflow', label: 'Webflow', live: false },
  { id: 'campaigns', label: 'Campaigns', live: true },
];

const CHANNEL_COLORS: Record<string, string> = {
  linkedin: '#0A66C2', x: '#000000', ghost: '#FF1A75', facebook: '#1877F2', gsc: '#4285F4',
  reddit: '#FF4500', wordpress: '#3858E9', webflow: '#4353FF',
};

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

// ── SVG Sparkline (pure, no deps) ───────────────────────────────────────────────────────────
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

// ── Trend Chart (30-day line, inline SVG) ──────────────────────────────────────────────────



export default function PerformanceDashboardPage() {
  const { isPaid, brandLoading, activeBrand } = useApp();
  
  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell>
        <GateModal 
          featureName="Performance Dashboard" 
          onClose={() => window.location.href = '/app/context-hub'} 
          onUnlocked={() => {}} 
        />
      </AppShell>
    );
  }

  const brandProfileId = activeBrand?.id ?? '';

  const handleBatchScore = async () => {
    if (!brandProfileId || batchScoring) return;
    setBatchScoring(true);
    const timeout = setTimeout(() => setBatchScoring(false), 30_000);
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };
    try {
      const r = await fetch('/api/precog/batch', { method: 'POST', headers, body: JSON.stringify({ brandProfileId }) });
      const d = await r.json();
      if (d.success) {
        const r2 = await fetch(`/api/precog/all/${brandProfileId}`, { headers });
        const d2 = await r2.json();
        if (d2.success) setPredictions(d2.items || []);
      }
    } catch { /* non-fatal */ } finally { clearTimeout(timeout); setBatchScoring(false); }
  };  const [activeChannel, setActiveChannel] = useState('linkedin');
  const [data, setData] = useState<DashboardData | null>(null);
  const [channelInfo, setChannelInfo] = useState<ChannelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<any[]>([]);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [predictionsLoading, setPredictionsLoading] = useState(false);
  const [batchScoring, setBatchScoring] = useState(false);
  const [accuracy, setAccuracy] = useState<{
    measuredCount: number; pendingCount: number; totalPredictions: number;
    directionAccuracy: number | null; rangeAccuracy: number | null;
  } | null>(null);
  const [mistakes, setMistakes] = useState<any[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [decayAlerts, setDecayAlerts] = useState<any[]>([]);
  const [decayLoaded, setDecayLoaded] = useState(false);
  const [gscSyncing, setGscSyncing] = useState(false);
  const [geoCitations, setGeoCitations] = useState<any[]>([]);
  const [geoTracking, setGeoTracking] = useState(false);
  const [geoLoaded, setGeoLoaded] = useState(false);
  const [gscStatus, setGscStatus] = useState<{ connected: boolean; verifiedSites?: string[] } | null>(null);
  const [extractResult, setExtractResult] = useState<string>('');
  const [extractMeta, setExtractMeta] = useState<{
    articlesAnalyzed: number; precogOutcomesUsed: number;
    predictionAccuracy: number | null; trendDirection: string;
    channelsAnalyzed: string[];
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [error, setError] = useState('');


  const loadCampaigns = useCallback(async () => {
    if (!brandProfileId) return;
    setCampaignsLoading(true);
    try {
      const res = await fetch(`/api/analytics/campaigns/${brandProfileId}`);
      const d = await res.json();
      if (d.success) setCampaigns(d.campaigns || []);
    } catch { /* non-fatal */ }
    setCampaignsLoading(false);
  }, [brandProfileId]);

  useEffect(() => {
    if (activeChannel === 'campaigns') loadCampaigns();
    if (activeChannel === 'predictions' && brandProfileId) {
      setPredictionsLoading(true);
      Promise.all([
        fetch(`/api/precog/all/${brandProfileId}`).then(r => r.json()).then(d => { if (d.success) setPredictions(d.items || []); }).catch(() => {}),
        fetch(`/api/precog/accuracy/${brandProfileId}`).then(r => r.json()).then(d => { if (d.success) setAccuracy(d); }).catch(() => {}),
      ]).finally(() => setPredictionsLoading(false));
    }
    if (activeChannel === 'geo' && brandProfileId) {
      fetch(`/api/geo/citations/${brandProfileId}`)
        .then(r => r.json())
        .then(d => { if (d.success) { setGeoCitations(d.citations || []); setGeoLoaded(true); } })
        .catch(() => setGeoLoaded(true));
    }
    if (activeChannel === 'gsc' && brandProfileId) {
      fetch(`/api/gsc/status/${brandProfileId}`).then(r => r.json()).then(d => setGscStatus(d)).catch(() => {});
    }
    if (brandProfileId) {
      fetch(`/api/analytics/decay/${brandProfileId}`)
        .then(r => r.json())
        .then(d => { if (d.success) { setDecayAlerts(d.alerts || []); setDecayLoaded(true); } })
        .catch(() => {});
      fetch(`/api/analytics/patterns/${brandProfileId}`)
        .then(r => r.json())
        .then(d => { if (d.success) { setPatterns(d.patterns || []); setMistakes(d.mistakes || []); } })
        .catch(() => {});
    }
  }, [activeChannel, brandProfileId, loadCampaigns]);

  const loadDashboard = useCallback(async () => {
    if (!brandProfileId || activeChannel === 'campaigns') return;
    setLoading(true); setError('');
    try {
      const [dashRes, chanRes] = await Promise.all([
        fetch(`/api/analytics/dashboard/${brandProfileId}?channel=${activeChannel === 'predictions' ? 'all' : activeChannel}`),
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

  // Auto-spin sync on mount to cover token injection delay
  useEffect(() => {
    setSyncing(true);
    const t = setTimeout(() => setSyncing(false), 15000);
    return () => clearTimeout(t);
  }, []);

  // Re-fire dashboard load when token becomes available (handles race on initial page load)
  useEffect(() => {
    const onTokenReady = () => { loadDashboard(); };
    window.addEventListener('forge:token-ready', onTokenReady);
    return () => window.removeEventListener('forge:token-ready', onTokenReady);
  }, [loadDashboard]);

  const handleGeoTrack = async () => {
    if (!brandProfileId) return;
    setGeoTracking(true);
    try {
      // Fire and forget — server responds immediately, processes in background
      await fetch(`/api/geo/track/${brandProfileId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });

      // Poll for up to 60s — stop when checked_at timestamps are fresher than start time
      const startTime = new Date();
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const c = await fetch(`/api/geo/citations/${brandProfileId}`).then(r => r.json());
          if (c.success) setGeoCitations(c.citations || []);
          // Stop when we see data newer than our start time, or after 20 attempts (~60s)
          const hasNewData = (c.citations || []).some(
            (cit: any) => cit.lastChecked && new Date(cit.lastChecked) > startTime
          );
          if (hasNewData || attempts >= 20) {
            clearInterval(poll);
            setGeoTracking(false);
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch(e) {
      setGeoTracking(false);
    }
  };

  const handleGscSync = async () => {
    if (!brandProfileId) return;
    setGscSyncing(true);
    try {
      const r = await fetch(`/api/analytics/sync-gsc/${brandProfileId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 28 }) });
      const d = await r.json();
      if (d.success) {
        await loadDashboard();
        setGscStatus(prev => ({ ...prev, connected: true }));
      }
    } finally { setGscSyncing(false); }
  };

  const handleGscConnect = async () => {
    if (!brandProfileId) return;
    const r = await fetch(`/api/gsc/auth?brandProfileId=${brandProfileId}`);
    const d = await r.json();
    if (d.authUrl) window.location.href = d.authUrl;
  };

  const resolveDecay = async (contentId: string) => {
    if (!brandProfileId) return;
    await fetch(`/api/analytics/decay/${brandProfileId}/resolve/${contentId}`, { method: 'POST' });
    setDecayAlerts(prev => prev.filter(a => a.content_id !== contentId));
  };

  const handleExtract = async () => {
    if (!brandProfileId) return;
    setExtracting(true);
    setExtractResult('');
    try {
      const r = await fetch(`/api/analytics/extract-patterns/${brandProfileId}`, { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        setPatterns(d.patterns || []);
        setMistakes(d.mistakes || []);
        if (d.meta) setExtractMeta(d.meta);
        const metaStr = d.meta ? ` · ${d.meta.articlesAnalyzed} articles · ${d.meta.precogOutcomesUsed > 0 ? `${d.meta.precogOutcomesUsed} pre-cog outcomes` : 'no pre-cog data yet'}` : '';
        const newThings = (d.patternsWritten || 0) + (d.mistakesWritten || 0);
        setExtractResult(newThings > 0
          ? `✓ ${d.patternsWritten || 0} new patterns · ${d.mistakesWritten || 0} new mistakes${metaStr}`
          : d.message || `Brain up to date — ${(d.patterns || []).length} patterns · ${(d.mistakes || []).length} mistakes in Brain${metaStr}`);
        setTimeout(() => setExtractResult(''), 7000);
      } else {
        setExtractResult(`Error: ${d.error}`);
      }
    } catch(e) {
      setExtractResult('Network error');
    } finally {
      setExtracting(false);
    }
  };

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
  const maxReach = data?.posts?.length
    ? activeChannel === 'ghost'
      ? Math.max(...data.posts.map(p => p.clicks || 0), 1)
      : Math.max(...data.posts.map(p => p.impressions || 0), 1)
    : 1;

  return (
    <AppShell>
      <div className="perf-page">
        {/* ── Header ── */}
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Stage 7</div>
            <h1 className="geo-title">Performance Dashboard</h1>
            <p className="geo-description">Content analytics across all channels and campaigns.</p>
          </div>
          <div className="perf-header-right">
            {!['geo', 'gsc', 'predictions'].includes(activeChannel) && <div className="perf-sync-wrap">
              <div className="perf-btn-group">
              <button className={`perf-sync-btn ${syncing ? 'syncing' : ''}`} onClick={handleSync} disabled={syncing || !brandProfileId}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={syncing ? 'spin' : ''}>
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
                </svg>
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
              <span className="perf-btn-hint">Pull latest post analytics from {activeChannel}</span>
              </div>
              {data?.totals?.lastSynced && (
                <span className="perf-last-sync">Last synced {timeAgo(data.totals.lastSynced)}</span>
              )}
              {syncMsg && <span className={`perf-sync-msg ${syncMsg.startsWith('Error') ? 'error' : 'ok'}`}>{syncMsg}</span>}
            </div>}
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
                {ch.live && (hasData || (ch.id === 'gsc' && gscStatus?.connected) || (ch.id === 'geo' && geoCitations.some(c => c.citations > 0))) && <span className="perf-data-dot" />}
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
            {activeChannel !== 'campaigns' && activeChannel !== 'gsc' && activeChannel !== 'geo' && activeChannel !== 'predictions' && activeChannel !== 'predictions' && <div className="perf-kpis">
              {(activeChannel === 'ghost' ? [
                { label: 'Link Clicks', value: fmt(data?.totals?.clicks || 0), sub: 'Total tracked clicks', icon: 'click', spark: false },
                { label: 'Avg Read Time', value: data?.totals?.avgReadingTime ? `${data.totals.avgReadingTime} min` : '—', sub: 'Minutes per article', icon: 'eye', spark: false },
                { label: 'Positive Feedback', value: fmt(data?.totals?.positiveFeedback || 0), sub: 'Reader thumbs up', icon: 'heart', spark: false },
                { label: 'Negative Feedback', value: fmt(data?.totals?.negativeFeedback || 0), sub: 'Reader thumbs down', icon: 'trend', spark: false },
              ] : [
                { label: 'Impressions', value: fmt(data?.totals?.impressions || 0), sub: 'Total views', icon: 'eye', spark: true },
                { label: 'Link Clicks', value: fmt(data?.totals?.clicks || 0), sub: `${data?.totals?.avgCtr || '0'}% avg CTR`, icon: 'click', spark: false },
                { label: 'Reactions', value: fmt(data?.totals?.reactions || 0), sub: `${data?.totals?.comments || 0} comments · ${data?.totals?.reposts || 0} reposts`, icon: 'heart', spark: false },
                { label: 'Engagement Rate', value: `${data?.totals?.avgEngagementRate || '0'}%`, sub: `Across ${data?.totals?.posts || 0} posts`, icon: 'trend', spark: false },
              ]).map(kpi => (
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
            </div>}

            {/* ── 30-Day Trend ── */}
            {activeChannel !== 'campaigns' && activeChannel !== 'gsc' && activeChannel !== 'geo' && activeChannel !== 'predictions' && <div className="perf-section">
              <div className="perf-section-header">
                <h2 className="perf-section-title">30-Day Impressions</h2>
                {(data?.trend?.length ?? 0) > 0 && (
                  <span className="perf-section-meta">{data?.trend?.length} data points</span>
                )}
              </div>
              <div className="perf-trend-card">
                <TrendChart data={data?.trend || []} onSync={handleSync} />
              </div>
            </div>}

            {/* ── Posts Table ── */}
            {activeChannel !== 'campaigns' && activeChannel !== 'gsc' && activeChannel !== 'geo' && activeChannel !== 'predictions' && <div className="perf-section">
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
                        {activeChannel === 'ghost' ? (<>
                          <th className="num">Clicks</th>
                          <th className="num">Read Time</th>
                          <th className="num">👍 Feedback</th>
                          <th className="num">👎 Feedback</th>
                        </>) : (<>
                          <th className="num">Impressions</th>
                          <th className="num">Clicks</th>
                          <th className="num">CTR</th>
                          <th className="num">Reactions</th>
                          <th className="num">Engagement</th>
                        </>)}
                        <th>Published</th>
                        <th className="bar-col">{activeChannel === 'ghost' ? 'Relative clicks' : 'Relative reach'}</th>
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
                          {activeChannel === 'ghost' ? (<>
                            <td className="num">{fmt(post.clicks)}</td>
                            <td className="num">{post.reading_time ? `${post.reading_time} min` : '—'}</td>
                            <td className="num">{fmt(post.positive_feedback ?? 0)}</td>
                            <td className="num">{fmt(post.negative_feedback ?? 0)}</td>
                          </>) : (<>
                            <td className="num">{fmt(post.impressions)}</td>
                            <td className="num">{fmt(post.clicks)}</td>
                            <td className="num">{post.ctr ? `${post.ctr}%` : '—'}</td>
                            <td className="num">{fmt(post.reactions)}</td>
                            <td className="num">{post.engagement_rate ? `${post.engagement_rate}%` : '—'}</td>
                          </>)}
                          <td className="perf-date">{post.published_at ? new Date(post.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
                          <td className="bar-col">
                            <div className="perf-bar-bg">
                              <div className="perf-bar-fill" style={{ width: `${Math.round(((activeChannel === 'ghost' ? post.clicks : post.impressions) / maxReach) * 100)}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>}

            {/* ── Campaigns Tab ── */}
            {activeChannel === 'geo' && (
              <div className="perf-geo-panel">
                <div className="perf-geo-header">
                  <div>
                    <h2 className="perf-section-title">GEO Citation Tracker</h2>
                    <p className="perf-section-sub">Track when your content is cited by ChatGPT, Perplexity, and other AI engines. Results write to Brain patterns.</p>
                  </div>
                  <div className="perf-btn-group">
                  <button className="perf-sync-btn perf-geo-track-btn" onClick={handleGeoTrack} disabled={geoTracking || !brandProfileId}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={geoTracking ? 'spin' : ''}>
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
                    </svg>
                    {geoTracking ? 'Tracking...' : 'Run Citation Check'}
                  </button>
                  <span className="perf-btn-hint">Checks if ChatGPT & Perplexity cite your articles — runs in background, takes ~30s</span>
                  </div>
                </div>

                {geoTracking && (
                  <div className="perf-geo-scanning">
                    <div className="perf-geo-scan-dot" />
                    <span>Querying AI engines — Perplexity, ChatGPT... this takes ~30 seconds</span>
                  </div>
                )}

                {geoLoaded && geoCitations.length === 0 && !geoTracking && (
                  <div className="perf-geo-empty">
                    <div className="perf-geo-empty-icon">◈</div>
                    <p className="perf-geo-empty-title">No citation data yet</p>
                    <p className="perf-geo-empty-sub">Hit Run Citation Check above — Forge will query Perplexity and ChatGPT with your article topics and tell you if your content is being cited by AI engines.</p>
                  </div>
                )}

                {geoCitations.length > 0 && (() => {
                  const totalCited = geoCitations.reduce((a,c) => a + c.citations, 0);
                  const totalChecks = geoCitations.reduce((a,c) => a + c.totalChecks, 0);
                  const visibilityScore = Math.round(totalCited / Math.max(1, totalChecks) * 100);
                  const enginesWithCitations = [...new Set(geoCitations.filter(c => c.citations > 0).flatMap(c => c.engines || []))];
                  const articlesCited = [...new Set(geoCitations.filter(c => c.citations > 0).map(c => c.content_id))].length;
                  const allSections = geoCitations.flatMap(c => c.citedSections || []);
                  const topSection = allSections.length > 0
                    ? Object.entries(allSections.reduce((a: Record<string,number>, s) => { a[s] = (a[s]||0)+1; return a; }, {})).sort((a,b) => b[1]-a[1])[0][0]
                    : null;
                  return (
                  <div className="perf-geo-results">
                    <div className="perf-kpis" style={{ marginTop: '16px' }}>
                      <div className="perf-kpi-card">
                        <div className="perf-kpi-top"><span className="perf-kpi-label">AI Visibility</span></div>
                        <div className="perf-kpi-value" style={{ color: visibilityScore > 20 ? '#10B981' : visibilityScore > 5 ? '#F59E0B' : 'inherit' }}>{visibilityScore}%</div>
                        <div className="perf-kpi-sub">Of topic queries where you appeared</div>
                      </div>
                      <div className="perf-kpi-card">
                        <div className="perf-kpi-top"><span className="perf-kpi-label">Engines Citing You</span></div>
                        <div className="perf-kpi-value">{enginesWithCitations.length > 0 ? enginesWithCitations.join(', ') : '—'}</div>
                        <div className="perf-kpi-sub">{enginesWithCitations.length === 0 ? 'Not yet cited' : 'Active citation sources'}</div>
                      </div>
                      <div className="perf-kpi-card">
                        <div className="perf-kpi-top"><span className="perf-kpi-label">Articles Referenced</span></div>
                        <div className="perf-kpi-value">{articlesCited} <span style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)' }}>/ {[...new Set(geoCitations.map(c => c.content_id))].length}</span></div>
                        <div className="perf-kpi-sub">Of your published articles</div>
                      </div>
                      <div className="perf-kpi-card">
                        <div className="perf-kpi-top"><span className="perf-kpi-label">Top Cited Section</span></div>
                        <div className="perf-kpi-value" style={{ fontSize: topSection && topSection.length > 12 ? '0.9rem' : '1.5rem' }}>{topSection || '—'}</div>
                        <div className="perf-kpi-sub">{topSection ? 'Most quoted section' : 'Run check to discover'}</div>
                      </div>
                    </div>

                    {/* Citation table */}
                    <div className="perf-section" style={{ marginTop: '24px' }}>
                      <div className="perf-table-wrap">
                        <table className="perf-table">
                          <thead><tr>
                            <th>Article</th>
                            <th>Engine</th>
                            <th className="num">Checks</th>
                            <th className="num">Citations</th>
                            <th>Cited Section</th>
                          </tr></thead>
                          <tbody>
                            {geoCitations.map((c, i) => (
                              <tr key={i} className={c.citations > 0 ? 'perf-geo-cited-row' : ''}>
                                <td className="perf-title-cell"><span className="perf-post-title">{c.title}</span></td>
                                <td>{(c.engines || []).map((e: string) => <span key={e} className={`perf-geo-engine perf-geo-engine-${e}`}>{e}</span>)}</td>
                                <td className="num">{c.totalChecks}</td>
                                <td className="num">
                                  {c.citations > 0
                                    ? <span className="perf-geo-cited">✓ {c.citations}</span>
                                    : <span className="perf-geo-notcited">—</span>}
                                </td>
                                <td className="perf-geo-section">{c.citedSections?.[0] || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                  );
                })()}
              </div>
            )}

            {activeChannel === 'gsc' && (
              <div className="perf-gsc-panel">
                {!gscStatus?.connected ? (
                  <div className="perf-gsc-connect">
                    <div className="perf-gsc-icon">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                    </div>
                    <h3 className="perf-gsc-title">Connect Google Search Console</h3>
                    <p className="perf-gsc-desc">Pull organic search performance — clicks, impressions, CTR, and position — for every article on your domain. Works with BYO published articles too.</p>
                    <button className="perf-gsc-btn" onClick={handleGscConnect} disabled={!brandProfileId}>
                      Connect GSC
                    </button>
                  </div>
                ) : (
                  <div className="perf-gsc-connected">
                    <div className="perf-gsc-connected-header">
                      <span className="perf-gsc-connected-label">✓ Connected</span>
                      {gscStatus.verifiedSites && gscStatus.verifiedSites.length > 0 && (
                        <span className="perf-gsc-sites">{gscStatus.verifiedSites.slice(0,3).join(', ')}{gscStatus.verifiedSites.length > 3 ? ` +${gscStatus.verifiedSites.length - 3} more` : ''}</span>
                      )}
                      <div className="perf-btn-group">
                      <button className="perf-sync-btn" onClick={handleGscSync} disabled={gscSyncing || !brandProfileId}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={gscSyncing ? 'spin' : ''}>
                          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
                          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
                        </svg>
                        {gscSyncing ? 'Syncing...' : 'Sync GSC'}
                      </button>
                      <span className="perf-btn-hint">Pulls 28 days of search impressions & clicks from Google Search Console</span>
                      </div>
                    </div>

                    {/* GSC KPI cards */}
                    <div className="perf-kpis" style={{ marginTop: '16px' }}>
                      {[
                        { label: 'Total Clicks', value: fmt(data?.totals?.clicks || 0), sub: 'Organic search clicks', icon: 'click' },
                        { label: 'Impressions', value: fmt(data?.totals?.impressions || 0), sub: 'Search result appearances', icon: 'eye' },
                        { label: 'Avg CTR', value: `${data?.totals?.avgCtr || '0'}%`, sub: 'Click-through rate', icon: 'trend' },
                        { label: 'Avg Position', value: data?.totals?.avgEngagementRate || '—', sub: 'Search ranking position', icon: 'trend' },
                      ].map(kpi => (
                        <div key={kpi.label} className="perf-kpi-card">
                          <div className="perf-kpi-top"><span className="perf-kpi-label">{kpi.label}</span><KpiIcon type={kpi.icon} /></div>
                          <div className="perf-kpi-value">{kpi.value}</div>
                          <div className="perf-kpi-sub">{kpi.sub}</div>
                        </div>
                      ))}
                    </div>

                    {/* GSC pages table */}
                    {(data?.posts?.length ?? 0) > 0 && (
                      <div className="perf-section" style={{ marginTop: '24px' }}>
                        <div className="perf-section-header"><h2 className="perf-section-title">Pages</h2></div>
                        <div className="perf-table-wrap">
                          <table className="perf-table">
                            <thead><tr>
                              <th>Page</th>
                              <th className="num">Clicks</th>
                              <th className="num">Impressions</th>
                              <th className="num">CTR</th>
                              <th className="num">Position</th>
                            </tr></thead>
                            <tbody>
                              {(data?.posts || []).map((post, i) => (
                                <tr key={i}>
                                  <td className="perf-title-cell"><span className="perf-post-title">{post.title || (post as any).raw_data?.pageUrl || 'Unknown'}</span></td>
                                  <td className="num">{fmt(post.clicks)}</td>
                                  <td className="num">{fmt(post.impressions)}</td>
                                  <td className="num">{post.ctr ? `${post.ctr}%` : '—'}</td>
                                  <td className="num">{post.engagement_rate ? `#${post.engagement_rate}` : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {(data?.posts?.length ?? 0) === 0 && (
                      <div className="perf-empty" style={{ marginTop: '24px' }}>
                        <p>No GSC data yet. Hit Sync GSC to pull organic search performance for your domain.</p>
                        <button className="perf-sync-btn" style={{ marginTop: '12px' }} onClick={handleGscSync} disabled={gscSyncing}>
                          {gscSyncing ? 'Syncing...' : '↺ Sync now'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeChannel === 'campaigns' && (
              <CampaignsView
                campaigns={campaigns}
                loading={campaignsLoading}
                expanded={expandedCampaign}
                setExpanded={setExpandedCampaign}
              />
            )}

          {/* ── Decay Monitoring ── */}
            {decayLoaded && decayAlerts.length > 0 && (
              <div className="perf-section perf-decay-section">
                <div className="perf-section-header">
                  <div>
                    <h2 className="perf-section-title">
                      <span className="perf-decay-indicator" />
                      Decay Alerts
                      <span className="perf-decay-count">{decayAlerts.length}</span>
                    </h2>
                    <p className="perf-section-sub">Content with 50%+ engagement drop from peak — agent runs every 6 hours.</p>
                  </div>
                </div>
                <div className="perf-decay-list">
                  {decayAlerts.map(alert => (
                    <div key={alert.id} className={`perf-decay-card perf-decay-${alert.decay_score >= 0.8 ? 'high' : 'medium'}`}>
                      <div className="perf-decay-header">
                        <div className="perf-decay-title">{alert.title}</div>
                        <div className="perf-decay-meta">
                          <span className="perf-decay-channel">{alert.channel}</span>
                          <span className="perf-decay-pct">↓{Math.round(alert.decay_score * 100)}% from peak</span>
                        </div>
                      </div>
                      <div className="perf-decay-stats">
                        <span>Peak: {alert.peak_impressions} impr / {alert.peak_clicks} clicks</span>
                        <span>Now: {alert.current_impressions} impr / {alert.current_clicks} clicks</span>
                      </div>
                      <div className="perf-decay-action">
                        <span className="perf-decay-recommend">⚡ {alert.recommended_action}</span>
                        <button className="perf-decay-resolve" onClick={() => resolveDecay(alert.content_id)}>
                          Mark resolved
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* ── Predictions Tab ── */}
            {activeChannel === 'predictions' && (
              <div className="perf-predictions-wrap">
                <div className="perf-section-header" style={{ marginBottom: 24 }}>
                  <div>
                    <h2 className="perf-section-title">Pre-cog Scores</h2>
                    <p className="perf-section-sub">Predicted performance for each article relative to your brand's historical average. Powered by your Brain patterns and analytics data.</p>
                    {accuracy && accuracy.totalPredictions > 0 && (
                      <div className="perf-accuracy-banner">
                        {accuracy.directionAccuracy !== null ? (
                          <>
                            <span className="perf-accuracy-stat">
                              <span className="perf-accuracy-val" style={{ color: accuracy.directionAccuracy >= 70 ? '#22C55E' : accuracy.directionAccuracy >= 50 ? '#EAB308' : '#F97316' }}>
                                {accuracy.directionAccuracy}%
                              </span>
                              directional accuracy
                            </span>
                            <span className="perf-accuracy-sep">·</span>
                            {accuracy.rangeAccuracy !== null && (
                              <>
                                <span className="perf-accuracy-stat">
                                  <span className="perf-accuracy-val">{accuracy.rangeAccuracy}%</span>
                                  in predicted range
                                </span>
                                <span className="perf-accuracy-sep">·</span>
                              </>
                            )}
                            <span className="perf-accuracy-stat">{accuracy.measuredCount} article{accuracy.measuredCount !== 1 ? 's' : ''} measured</span>
                          </>
                        ) : (
                          <span className="perf-accuracy-stat perf-accuracy-building">
                            Accuracy data building — {accuracy.measuredCount} of {accuracy.totalPredictions} article{accuracy.totalPredictions !== 1 ? 's' : ''} measured so far
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="perf-btn-group">
                  <button
                    className={`perf-extract-btn ${batchScoring ? 'extracting' : ''}`}
                    onClick={handleBatchScore}
                    disabled={batchScoring}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={batchScoring ? 'spin' : ''}>
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M16 8h5V3"/>
                    </svg>
                    {batchScoring ? 'Scoring...' : 'Score All'}
                  </button>
                  <span className="perf-btn-hint">Runs Pre-cog predictions on all published articles — needs 3+ articles with analytics</span>
                  </div>
                </div>

                {predictionsLoading ? (
                  <div className="perf-skeleton-wrap">
                    {[1,2,3].map(i => <div key={i} className="perf-skeleton-card" />)}
                  </div>
                ) : predictions.length === 0 ? (
                  <div className="perf-predictions-empty">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 12 }}>
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                    </svg>
                    <p>No scored articles yet.</p>
                    <p className="perf-predictions-empty-sub">Hit "Score All" to run pre-cog scoring across your content library. Requires 3+ articles with synced analytics.</p>
                  </div>
                ) : (
                  <div className="perf-predictions-list">
                    {predictions.map((item: any) => {
                      const bd = item.breakdown || {};
                      const tier = bd.tier || item.tier;
                      const score = bd.score ?? item.precog_score;
                      const color = bd.color || '#64748B';
                      const signals = bd.signals || [];
                      const actions = bd.recommendedActions || [];
                      const hist = bd.historicalContext || {};
                      const insufficient = tier === 'insufficient_data';
                      return (
                        <div key={item.id} className={`perf-pred-card perf-pred-${tier}`}>
                          <div className="perf-pred-top">
                            <div className="perf-pred-left">
                              <div className="perf-pred-title">{item.title || 'Untitled'}</div>
                              <div className="perf-pred-meta">
                                {item.precog_scored_at && (
                                  <span>Scored {new Date(item.precog_scored_at).toLocaleDateString()}</span>
                                )}
                                {hist.totalArticles > 0 && (
                                  <span>· Based on {hist.totalArticles} articles</span>
                                )}
                              </div>
                            </div>
                            <div className="perf-pred-score-block" style={{ '--pred-color': color } as React.CSSProperties}>
                              {insufficient ? (
                                <div className="perf-pred-insufficient">Not enough data</div>
                              ) : (
                                <>
                                  <div className="perf-pred-score">{score}</div>
                                  <div className="perf-pred-tier">{tier}</div>
                                  {item.measured_at && item.direction_correct !== null && (
                                    <div className={`perf-pred-direction ${item.direction_correct ? 'correct' : 'incorrect'}`}>
                                      {item.direction_correct ? '✓ Correct' : '✗ Off'}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>

                          {!insufficient && (
                            <>
                              {bd.prediction && (
                                <div className="perf-pred-prediction">{bd.prediction}</div>
                              )}
                              {bd.predictedImpressions && (
                                <div className="perf-pred-range">
                                  <span className="perf-pred-range-label">Predicted impressions</span>
                                  <span className="perf-pred-range-val" style={{ color }}>{bd.predictedImpressions.low.toLocaleString()} – {bd.predictedImpressions.high.toLocaleString()}</span>
                                  <span className="perf-pred-range-avg">(avg: {hist.avgImpressions?.toLocaleString()})</span>
                                  {item.measured_at ? (
                                    <span className="perf-pred-actual">
                                      Actual: <strong>{(item.actual_impressions || 0).toLocaleString()}</strong>
                                      {item.in_range === true && <span className="perf-pred-outcome perf-pred-outcome-hit">✓ in range</span>}
                                      {item.in_range === false && <span className="perf-pred-outcome perf-pred-outcome-miss">✗ out of range</span>}
                                    </span>
                                  ) : item.actual_impressions === null ? (
                                    <span className="perf-pred-pending">Awaiting analytics sync</span>
                                  ) : null}
                                </div>
                              )}
                              {signals.length > 0 && (
                                <div className="perf-pred-signals">
                                  {signals.slice(0, 4).map((s: any, i: number) => (
                                    <div key={i} className={`perf-pred-signal perf-pred-signal-${s.impact}`}>
                                      <span className="perf-pred-signal-dot" />
                                      <span>{s.label}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {actions.length > 0 && (
                                <div className="perf-pred-actions">
                                  <span className="perf-pred-actions-label">Suggested:</span>
                                  {actions.slice(0, 2).map((a: string, i: number) => (
                                    <span key={i} className="perf-pred-action">{a}</span>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          {/* ── Pattern Dashboard ── */}
            {activeChannel === 'patterns' && <div className="perf-section perf-pattern-section">
              <div className="perf-section-header">
                <div>
                  <h2 className="perf-section-title">Pattern Dashboard</h2>
                  <p className="perf-section-sub">Deep pattern analysis — content structure, pre-cog feedback loop, channel breakdown, topic momentum.</p>
                  {extractMeta && (
                    <div className="perf-extract-meta">
                      <span>{extractMeta.articlesAnalyzed} articles analyzed</span>
                      {extractMeta.precogOutcomesUsed > 0 && <><span className="perf-accuracy-sep">·</span><span>{extractMeta.precogOutcomesUsed} pre-cog outcomes used</span></>}
                      {extractMeta.predictionAccuracy !== null && <><span className="perf-accuracy-sep">·</span><span>{extractMeta.predictionAccuracy}% prediction accuracy</span></>}
                      {extractMeta.trendDirection !== 'insufficient_data' && <><span className="perf-accuracy-sep">·</span><span className={`perf-trend-dir ${extractMeta.trendDirection}`}>{extractMeta.trendDirection === 'improving' ? '↑ Trending up' : '↓ Trending down'}</span></>}
                    </div>
                  )}
                </div>
                <div className="perf-pattern-actions">
                  {extractResult && <span className="perf-extract-result">{extractResult}</span>}
                  <div className="perf-btn-group">
                  <button
                    className={`perf-extract-btn ${extracting ? 'extracting' : ''}`}
                    onClick={handleExtract}
                    disabled={extracting || !brandProfileId}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={extracting ? 'spin' : ''}>
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M16 8h5V3"/>
                    </svg>
                    {extracting ? 'Extracting...' : 'Run Extraction'}
                  </button>
                  <span className="perf-btn-hint">Sends all analytics to AI for deep pattern analysis — writes results to Brain. Runs weekly via cron.</span>
                  </div>
                </div>
              </div>

              <div className="perf-pattern-grid">
                {/* Patterns */}
                <div className="perf-pattern-col">
                  <div className="perf-pattern-col-header">
                    <span className="perf-pattern-dot primary" />
                    <span>What's Working</span>
                    <span className="perf-pattern-count">{patterns.length}</span>
                  </div>
                  {patterns.length === 0 ? (
                    <div className="perf-pattern-empty">No patterns yet — run extraction after syncing analytics.</div>
                  ) : patterns.map((p, i) => (
                    <div key={i} className={`perf-pattern-item ${p.pattern_type === 'prediction_correction' ? 'perf-pattern-correction' : ''}`}>
                      <div className="perf-pattern-type-row">
                        <span className="perf-pattern-type">{p.pattern_type?.replace(/_/g, ' ')}</span>
                        {p.source_channel && <span className="perf-pattern-channel">{p.source_channel}</span>}
                        {p.last_validated_at && <span className="perf-pattern-fresh">validated {new Date(p.last_validated_at).toLocaleDateString()}</span>}
                      </div>
                      <div className="perf-pattern-desc">{p.description}</div>
                      {Array.isArray(p.example_titles) && p.example_titles.length > 0 && (
                        <div className="perf-pattern-examples">
                          {p.example_titles.slice(0, 2).map((t: string, j: number) => (
                            <span key={j} className="perf-pattern-example-title">"{t}"</span>
                          ))}
                        </div>
                      )}
                      {p.confidence_score > 0 && (
                        <div className="perf-pattern-meta">
                          <span className="perf-confidence-bar">
                            <span className="perf-confidence-fill" style={{ width: `${Math.min(p.confidence_score * 100, 100)}%` }} />
                          </span>
                          <span className="perf-confidence-label">{Math.round(p.confidence_score * 100)}% confidence</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Mistakes */}
                <div className="perf-pattern-col">
                  <div className="perf-pattern-col-header">
                    <span className="perf-pattern-dot amber" />
                    <span>What to Avoid</span>
                    <span className="perf-pattern-count">{mistakes.length}</span>
                  </div>
                  {mistakes.length === 0 ? (
                    <div className="perf-pattern-empty">No mistakes logged yet — run extraction or flag content in Compliance Gate.</div>
                  ) : mistakes.slice(0, 10).map((m, i) => (
                    <div key={i} className={`perf-pattern-item perf-mistake-item perf-severity-${m.severity || 'low'}`}>
                      <div className="perf-pattern-type">{m.mistake_type}</div>
                      <div className="perf-pattern-desc">{m.description}</div>
                      {m.human_feedback && <div className="perf-mistake-feedback">"{m.human_feedback}"</div>}
                      <div className="perf-severity-tag">{m.severity || 'low'}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>}
          </>
        )}
      </div>
    </AppShell>
  );
}

// ── Campaigns View ─────────────────────────────────────────────────────────────
function CampaignsView({
  campaigns, loading, expanded, setExpanded
}: {
  campaigns: CampaignRow[];
  loading: boolean;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
}) {
  if (loading) return (
    <div className="perf-skeleton-wrap">
      {[1,2,3].map(i => <div key={i} className="perf-skeleton-card" style={{ height: 160 }} />)}
    </div>
  );

  if (!campaigns.length) return (
    <div className="perf-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 3h18v4H3z"/><path d="M3 10h18v4H3z"/><path d="M3 17h18v4H3z"/>
      </svg>
      <p>No campaign analytics yet. Generate a campaign, publish all 8 articles, then sync.</p>
    </div>
  );

  // Summary KPIs across all campaigns
  const totalImpressions = campaigns.reduce((s, c) => s + Number(c.total_impressions), 0);
  const totalClicks      = campaigns.reduce((s, c) => s + Number(c.total_clicks), 0);
  const totalReactions   = campaigns.reduce((s, c) => s + Number(c.total_reactions), 0);
  const bestCampaign     = [...campaigns].sort((a, b) => Number(b.total_impressions) - Number(a.total_impressions))[0];
  const avgCtr           = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '0';
  const avgEng           = campaigns.length
    ? (campaigns.reduce((s, c) => s + Number(c.avg_engagement_rate), 0) / campaigns.length).toFixed(2)
    : '0';

  return (
    <div className="camp-analytics-wrap">
      {/* Cross-campaign summary KPIs */}
      <div className="perf-kpis">
        {[
          {
            label: 'Total Campaign Reach',
            value: fmt(totalImpressions),
            sub: `Across ${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}`,
            icon: 'eye',
          },
          {
            label: 'Total Link Clicks',
            value: fmt(totalClicks),
            sub: `${avgCtr}% blended CTR`,
            icon: 'click',
          },
          {
            label: 'Total Reactions',
            value: fmt(totalReactions),
            sub: `${avgEng}% avg engagement`,
            icon: 'heart',
          },
          {
            label: 'Top Campaign',
            value: bestCampaign ? fmt(Number(bestCampaign.total_impressions)) : '—',
            sub: bestCampaign ? bestCampaign.campaign_name : 'No data yet',
            icon: 'trend',
          },
        ].map(kpi => (
          <div key={kpi.label} className="perf-kpi-card">
            <div className="perf-kpi-top">
              <span className="perf-kpi-label">{kpi.label}</span>
              <KpiIcon type={kpi.icon} />
            </div>
            <div className="perf-kpi-value">{kpi.value}</div>
            <div className="perf-kpi-sub">{kpi.sub}</div>
          </div>
        ))}
      </div>

      {/* Per-campaign cards */}
      <div className="camp-cards">
        {campaigns.map(c => {
          const isOpen = expanded === c.campaign_id;
          const bestChannel = [...(c.channels || [])].sort((a, b) => Number(b.impressions) - Number(a.impressions))[0];
          const publishProgress = c.article_count; // articles with analytics data = published + synced
          const ctr = Number(c.avg_ctr);
          const eng = Number(c.avg_engagement_rate);

          return (
            <div key={c.campaign_id} className={`camp-analytics-card ${isOpen ? 'open' : ''}`}>
              {/* Card header — always visible */}
              <button
                className="camp-analytics-header"
                onClick={() => setExpanded(isOpen ? null : c.campaign_id)}
              >
                <div className="camp-analytics-header-left">
                  <div className="camp-analytics-name">{c.campaign_name}</div>
                  <div className="camp-analytics-cluster">{c.topic_cluster}</div>
                </div>
                <div className="camp-analytics-header-right">
                  <div className="camp-analytics-pills">
                    <span className="camp-analytics-pill impressions">
                      {fmt(Number(c.total_impressions))} reach
                    </span>
                    <span className="camp-analytics-pill clicks">
                      {fmt(Number(c.total_clicks))} clicks
                    </span>
                    <span className="camp-analytics-pill articles">
                      {publishProgress} article{publishProgress !== 1 ? 's' : ''} tracked
                    </span>
                  </div>
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    className={`camp-analytics-chevron ${isOpen ? 'open' : ''}`}
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div className="camp-analytics-body">
                  {/* 4 meaningful KPIs for this campaign */}
                  <div className="camp-analytics-kpi-row">
                    <div className="camp-analytics-kpi">
                      <span className="camp-analytics-kpi-label">Total Impressions</span>
                      <span className="camp-analytics-kpi-value">{fmt(Number(c.total_impressions))}</span>
                      <span className="camp-analytics-kpi-sub">across {c.channel_count} channel{c.channel_count !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="camp-analytics-kpi">
                      <span className="camp-analytics-kpi-label">Avg CTR</span>
                      <span className="camp-analytics-kpi-value">{ctr > 0 ? `${ctr}%` : '—'}</span>
                      <span className="camp-analytics-kpi-sub">{fmt(Number(c.total_clicks))} total clicks</span>
                    </div>
                    <div className="camp-analytics-kpi">
                      <span className="camp-analytics-kpi-label">Engagement Rate</span>
                      <span className="camp-analytics-kpi-value">{eng > 0 ? `${eng}%` : '—'}</span>
                      <span className="camp-analytics-kpi-sub">{fmt(Number(c.total_reactions))} reactions</span>
                    </div>
                    <div className="camp-analytics-kpi">
                      <span className="camp-analytics-kpi-label">Best Channel</span>
                      <span className="camp-analytics-kpi-value" style={{ color: CHANNEL_COLORS[bestChannel?.channel] || 'var(--color-accent)', fontSize: '1rem' }}>
                        {bestChannel ? bestChannel.channel.charAt(0).toUpperCase() + bestChannel.channel.slice(1) : '—'}
                      </span>
                      <span className="camp-analytics-kpi-sub">
                        {bestChannel ? `${fmt(Number(bestChannel.impressions))} impressions` : 'No data'}
                      </span>
                    </div>
                  </div>

                  {/* Channel breakdown bar chart */}
                  {c.channels.length > 0 && (
                    <div className="camp-channel-breakdown">
                      <div className="camp-breakdown-label">Channel breakdown</div>
                      {[...c.channels]
                        .sort((a, b) => Number(b.impressions) - Number(a.impressions))
                        .map(ch => {
                          const maxImpr = Math.max(...c.channels.map(x => Number(x.impressions)), 1);
                          const pct = Math.round((Number(ch.impressions) / maxImpr) * 100);
                          const color = CHANNEL_COLORS[ch.channel] || 'var(--color-accent)';
                          return (
                            <div key={ch.channel} className="camp-breakdown-row">
                              <span className="camp-breakdown-ch">{ch.channel}</span>
                              <div className="camp-breakdown-bar-wrap">
                                <div className="camp-breakdown-bar" style={{ width: `${pct}%`, background: color }} />
                              </div>
                              <span className="camp-breakdown-val">{fmt(Number(ch.impressions))}</span>
                              <span className="camp-breakdown-clicks">{fmt(Number(ch.clicks))} clicks</span>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* Top articles leaderboard */}
                  {c.top_articles.length > 0 && (
                    <div className="camp-top-articles">
                      <div className="camp-breakdown-label">Top articles in this campaign</div>
                      {c.top_articles.map((a, i) => (
                        <div key={a.content_id} className="camp-top-article-row">
                          <span className="camp-top-rank">#{i + 1}</span>
                          <span className="camp-top-title">
                            {a.published_url
                              ? <a href={a.published_url} target="_blank" rel="noopener noreferrer" className="camp-top-link">{a.title || 'Untitled'}</a>
                              : (a.title || 'Untitled')
                            }
                          </span>
                          <span className="camp-top-ch" style={{ color: CHANNEL_COLORS[a.channel] || 'var(--color-text-muted)' }}>
                            {a.channel}
                          </span>
                          <span className="camp-top-impr">{fmt(Number(a.impressions))} impr.</span>
                          <span className="camp-top-clicks">{fmt(Number(a.clicks))} clicks</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="camp-analytics-footer">
                    Campaign started {new Date(c.campaign_created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {c.last_synced && <> · Last synced {timeAgo(c.last_synced)}</>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
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
}function TrendChart({ data, onSync: _onSync }: { data: TrendPoint[]; onSync?: () => void }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(900);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(Math.floor(w));
    });
    obs.observe(el);
    setContainerWidth(el.clientWidth || 900);
    return () => obs.disconnect();
  }, []);

  if (!data || data.length === 0) return (
    <div ref={containerRef} style={{ width: '100%', height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>No data yet</span>
    </div>
  );

  const w = containerWidth, h = 260, padX = 8, padY = 20, padBottom = 32;
  const chartH = h - padY - padBottom;
  const maxVal = Math.max(...data.map(d => d.impressions), 1);
  const pts = data.map((d, i) => {
    const x = data.length === 1 ? w / 2 : padX + (i / (data.length - 1)) * (w - padX * 2);
    const y = padY + (1 - d.impressions / maxVal) * chartH;
    return { x, y, d };
  });
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length-1].x.toFixed(1)},${(padY + chartH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padY + chartH).toFixed(1)} Z`;
  const labels = [0, Math.floor(data.length / 2), data.length - 1].map(i => data[i]);

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="trend-chart" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3563FF" stopOpacity="0.3"/>
            <stop offset="100%" stopColor="#3563FF" stopOpacity="0.02"/>
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map(v => {
          const y = padY + v * chartH;
          return <line key={v} x1={0} y1={y} x2={w} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />;
        })}
        <path d={areaPath} fill="url(#tg)" />
        <path d={linePath} fill="none" stroke="#3563FF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3.5" fill="#3563FF" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        ))}
        {labels.map((label, i) => (
          <text key={i} x={Math.max(30, Math.min(w - 30, pts[[0, Math.floor(data.length / 2), data.length - 1][i]].x))} y={h - 8} textAnchor="middle" fontSize="11" fill="rgba(255,255,255,0.35)">
            {new Date(label.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────────────────────────