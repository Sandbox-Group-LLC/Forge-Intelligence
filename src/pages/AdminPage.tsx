import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './AdminPage.css';

interface ActivityRow {
  id: string;
  agent_name: string;
  brand_name?: string;
  brand_profile_id: string;
  status: string;
  tokens_used: number;
  latency_ms: number;
  metadata: Record<string, any>;
  created_at: string;
}

interface Stats {
  totalBrands: number;
  totalReach: number;
  totalContent: number;
  totalQueued: number;
  totalPublished: number;
  last30Days: {
    totalCalls: number;
    totalTokens: number;
    avgLatency: number;
    errorCount: number;
    activeBrands: number;
  };
  agentBreakdown: { agent_name: string; calls: number; tokens: number; avg_latency: number }[];
}

const AGENT_LABELS: Record<string, string> = {
  stage1_context_agent: 'Context Agent',
  stage2_geo_strategist: 'GEO Strategist',
  stage3_authenticity_enricher: 'Authenticity Enricher',
  stage4_content_generator: 'Content Generator',
  stage5_compliance_gate: 'Compliance Gate',
  stage6_publisher: 'Publisher',
  stage7_analytics: 'Analytics',
  stage8_pattern_extractor: 'Pattern Extractor',
  brain_audit: 'Brain Audit',
};

const statusColor = (s: string) => s === 'success' ? '#10B981' : s === 'error' ? '#EF4444' : '#F59E0B';

function fmt(n: number) {
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n/1000).toFixed(1)}K`;
  return String(n);
}

export default function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [agentFilter, setAgentFilter] = useState('');
  const [page, setPage] = useState(0);
  const limit = 25;

  useEffect(() => {
    fetch('/api/admin/stats').then(r => r.json()).then(d => { if (d.success) setStats(d.stats); });
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
    if (agentFilter) params.set('agent', agentFilter);
    fetch(`/api/admin/activity?${params}`).then(r => r.json()).then(d => {
      if (d.success) { setActivity(d.activity); setTotal(d.total); }
      setLoading(false);
    });
  }, [agentFilter, page]);

  return (
    <AppShell pageTitle="Admin">
      <div className="admin-page">
        <div className="geo-header" style={{ marginBottom: 32 }}>
          <div>
            <div className="geo-eyebrow">System</div>
            <h1 className="geo-title">Admin Dashboard</h1>
            <p className="geo-description">Agent activity, token usage, and platform health.</p>
          </div>
        </div>

        {/* Stats grid */}
        {stats && (
          <>
            <div className="admin-kpi-grid">
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{fmt(stats.totalReach)}</div>
                <div className="admin-kpi-label">Total Reach</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{fmt(stats.totalContent)}</div>
                <div className="admin-kpi-label">Articles Generated</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{fmt(stats.totalPublished)}</div>
                <div className="admin-kpi-label">Published</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{fmt(stats.last30Days.totalTokens)}</div>
                <div className="admin-kpi-label">Tokens (30d)</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{fmt(stats.last30Days.totalCalls)}</div>
                <div className="admin-kpi-label">Agent Calls (30d)</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value" style={{ color: stats.last30Days.errorCount > 0 ? '#EF4444' : '#10B981' }}>
                  {stats.last30Days.errorCount}
                </div>
                <div className="admin-kpi-label">Errors (30d)</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{stats.last30Days.avgLatency}ms</div>
                <div className="admin-kpi-label">Avg Latency (30d)</div>
              </div>
              <div className="admin-kpi-card">
                <div className="admin-kpi-value">{stats.last30Days.activeBrands}</div>
                <div className="admin-kpi-label">Active Brands (30d)</div>
              </div>
            </div>

            {/* Agent breakdown */}
            {stats.agentBreakdown.length > 0 && (
              <div className="admin-section">
                <div className="admin-section-title">Agent Breakdown — Last 30 Days</div>
                <div className="admin-agent-grid">
                  {stats.agentBreakdown.map(a => (
                    <div key={a.agent_name} className="admin-agent-card" onClick={() => setAgentFilter(agentFilter === a.agent_name ? '' : a.agent_name)}
                      style={{ borderColor: agentFilter === a.agent_name ? 'var(--color-accent)' : undefined }}>
                      <div className="admin-agent-name">{AGENT_LABELS[a.agent_name] || a.agent_name}</div>
                      <div className="admin-agent-stats">
                        <span>{fmt(a.calls)} calls</span>
                        <span>{fmt(a.tokens)} tokens</span>
                        <span>{Math.round(a.avg_latency)}ms avg</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Activity log */}
        <div className="admin-section">
          <div className="admin-section-header">
            <div className="admin-section-title">
              Activity Log {agentFilter && <span className="admin-filter-badge">{AGENT_LABELS[agentFilter] || agentFilter} <button onClick={() => setAgentFilter('')}>✕</button></span>}
            </div>
            <span className="admin-total">{total.toLocaleString()} entries</span>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Brand</th>
                  <th>Status</th>
                  <th className="num">Tokens</th>
                  <th className="num">Latency</th>
                  <th>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="admin-loading">Loading...</td></tr>
                ) : activity.length === 0 ? (
                  <tr><td colSpan={7} className="admin-loading">No activity yet</td></tr>
                ) : activity.map(row => (
                  <tr key={row.id}>
                    <td className="admin-time">{new Date(row.created_at).toLocaleString()}</td>
                    <td className="admin-agent">{AGENT_LABELS[row.agent_name] || row.agent_name}</td>
                    <td className="admin-brand">{row.brand_name || row.brand_profile_id?.slice(0,8) || '—'}</td>
                    <td><span className="admin-status" style={{ color: statusColor(row.status) }}>● {row.status}</span></td>
                    <td className="num">{row.tokens_used?.toLocaleString() || 0}</td>
                    <td className="num">{row.latency_ms || 0}ms</td>
                    <td className="admin-meta">{row.metadata?.title || row.metadata?.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > limit && (
            <div className="admin-pagination">
              <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span>Page {page + 1} of {Math.ceil(total / limit)}</span>
              <button disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
