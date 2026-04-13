import { useState, useEffect, useCallback } from 'react';
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
