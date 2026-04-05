import { useAuth } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';
import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import './ContentLibraryPage.css';

interface LibraryItem {
  id: string;
  title: string;
  overall_confidence: number;
  brain_match_score: number;
  compliance_status: string;
  hero_image_url: string | null;
  campaign_id: string | null;
  created_at: string;
  queue_status: string;
  published_at: string | null;
  published_channels: string[] | null;
  live_urls: string[] | null;
  impressions: number;
  clicks: number;
  brand_profile_id: string;
  brand_name: string;
  brand_url: string;
  meta_description: string | null;
}

interface Brain { id: string; brandName?: string; brandUrl?: string; }

const statusColor: Record<string, string> = {
  published: '#10B981',
  staged:    '#3563FF',
  draft:     '#94A3B8',
  archived:  '#475569',
};

const confidenceColor = (score: number) =>
  score >= 80 ? '#10B981' : score >= 60 ? '#F59E0B' : '#EF4444';

const timeAgo = (date: string) => {
  const diff = Date.now() - new Date(date).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d/30)}mo ago`;
  return `${Math.floor(d/365)}y ago`;
};

export default function ContentLibraryPage() {
  const { getToken } = useAuth();
  const { activeBrandId } = useApp();
    // Using activeBrandId from context instead
  // const [activeBrandId, () => {}] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  const [page, setPage] = useState(0);
  const LIMIT = 24;

  useEffect(() => {
    (async () => {
      const token = await getToken();
      const res = await fetch('/api/context-hub/brains', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const d = await res.json();
      if (d.success) setBrains(d.data);
    })();
  }, []);

  // Sync with global brand selection from TopBar
  useEffect(() => {
    if (activeBrandId) () => {}(activeBrandId);
  }, [activeBrandId]);

  const load = useCallback(async (brandId: string, q: string, status: string, pg: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(LIMIT),
        offset: String(pg * LIMIT),
        ...(brandId && { brandProfileId: brandId }),
        ...(q && { search: q }),
        ...(status !== 'all' && { status }),
      });
      const d = await fetch(`/api/content-library?${params}`).then(r => r.json());
      if (d.success) { setItems(d.items); setTotal(d.total); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load(activeBrandId, search, statusFilter, page);
  }, [activeBrandId, statusFilter, page, load]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setPage(0); load(activeBrandId, search, statusFilter, 0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const statusCounts = {
    all: total,
    published: items.filter(i => i.queue_status === 'published').length,
    staged: items.filter(i => i.queue_status === 'staged').length,
    draft: items.filter(i => i.queue_status === 'draft').length,
  };

  return (
    <AppShell pageTitle="Content Library">
      <div className="cl-page">
        {/* Header */}
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Content</div>
            <h1 className="geo-title">Content Library</h1>
            <p className="geo-description">Every article generated across all brands — searchable, filterable, actionable.</p>
          </div>
          {/* Brand filter — agency/internal, remove for single-brand production */}
          <div className="cl-brand-filter">
            {/* Brain selector removed - using TopBar */}
          </div>
        </div>

        {/* Search + status tabs */}
        <div className="cl-toolbar">
          <input
            className="cl-search"
            placeholder="Search articles..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="cl-status-tabs">
            {(['all', 'published', 'staged', 'draft'] as const).map(s => (
              <button
                key={s}
                className={`cl-status-tab ${statusFilter === s ? 'active' : ''}`}
                onClick={() => { setStatusFilter(s); setPage(0); }}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
                <span className="cl-tab-count">{statusCounts[s]}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="cl-loading">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="cl-skeleton" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="cl-empty">
            <div className="cl-empty-icon">◈</div>
            <p className="cl-empty-title">No articles found</p>
            <p className="cl-empty-sub">Generate content to start building your library.</p>
          </div>
        ) : (
          <div className="cl-grid">
            {items.map(item => (
              <div key={item.id} className="cl-card" onClick={() => setPreview(item)}>
                {/* Hero image */}
                <div className="cl-card-hero">
                  {item.hero_image_url
                    ? <img src={item.hero_image_url} alt={item.title} />
                    : <div className="cl-card-hero-empty">◈</div>
                  }
                  <div className="cl-card-status" style={{ background: statusColor[item.queue_status] || '#94A3B8' }}>
                    {item.queue_status}
                  </div>
                  {item.overall_confidence > 0 && (
                    <div className="cl-card-score" style={{ color: confidenceColor(item.overall_confidence) }}>
                      {item.overall_confidence}%
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="cl-card-body">
                  <div className="cl-card-brand">{item.brand_name}</div>
                  <div className="cl-card-title">{item.title}</div>
                  <div className="cl-card-meta">
                    <span>{timeAgo(item.created_at)}</span>
                    {item.published_channels && item.published_channels.length > 0 && (
                      <span className="cl-card-channels">
                        {item.published_channels.filter(Boolean).slice(0, 3).join(' · ')}
                      </span>
                    )}
                  </div>
                  {(item.impressions > 0 || item.clicks > 0) && (
                    <div className="cl-card-perf">
                      <span>{item.impressions.toLocaleString()} impr</span>
                      <span>{item.clicks.toLocaleString()} clicks</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > LIMIT && (
          <div className="cl-pagination">
            <button className="cl-page-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="cl-page-info">{page * LIMIT + 1}–{Math.min((page + 1) * LIMIT, total)} of {total}</span>
            <button className="cl-page-btn" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}

        {/* Preview modal */}
        {preview && (
          <div className="cl-modal-overlay" onClick={() => setPreview(null)}>
            <div className="cl-modal" onClick={e => e.stopPropagation()}>
              <button className="cl-modal-close" onClick={() => setPreview(null)}>✕</button>
              {preview.hero_image_url && (
                <img src={preview.hero_image_url} alt={preview.title} className="cl-modal-hero" />
              )}
              <div className="cl-modal-body">
                <div className="cl-modal-brand">{preview.brand_name}</div>
                <h2 className="cl-modal-title">{preview.title}</h2>
                {preview.meta_description && (
                  <p className="cl-modal-desc">{preview.meta_description}</p>
                )}
                <div className="cl-modal-stats">
                  <div className="cl-modal-stat">
                    <span className="cl-modal-stat-label">Status</span>
                    <span className="cl-modal-stat-value" style={{ color: statusColor[preview.queue_status] }}>
                      {preview.queue_status}
                    </span>
                  </div>
                  <div className="cl-modal-stat">
                    <span className="cl-modal-stat-label">Confidence</span>
                    <span className="cl-modal-stat-value" style={{ color: confidenceColor(preview.overall_confidence) }}>
                      {preview.overall_confidence}%
                    </span>
                  </div>
                  <div className="cl-modal-stat">
                    <span className="cl-modal-stat-label">Created</span>
                    <span className="cl-modal-stat-value">{new Date(preview.created_at).toLocaleDateString()}</span>
                  </div>
                  {preview.impressions > 0 && (
                    <div className="cl-modal-stat">
                      <span className="cl-modal-stat-label">Impressions</span>
                      <span className="cl-modal-stat-value">{preview.impressions.toLocaleString()}</span>
                    </div>
                  )}
                </div>
                {preview.published_channels && preview.published_channels.filter(Boolean).length > 0 && (
                  <div className="cl-modal-channels">
                    <span className="cl-modal-stat-label">Published to</span>
                    <div className="cl-modal-channel-list">
                      {preview.published_channels.filter(Boolean).map((ch, i) => (
                        <span key={i} className="cl-modal-channel-badge">{ch}</span>
                      ))}
                    </div>
                  </div>
                )}
                {preview.live_urls && preview.live_urls.filter(Boolean).length > 0 && (
                  <div className="cl-modal-links">
                    {preview.live_urls.filter(Boolean).map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="cl-modal-link">
                        View live post ↗
                      </a>
                    ))}
                  </div>
                )}
                <div className="cl-modal-actions">
                  <a
                    href={`/articles/${(preview.brand_url||'').replace(/https?:\/\//,'').replace(/[^a-z0-9]/gi,'-').toLowerCase()}/${(preview.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="cl-modal-action-btn"
                  >
                    Preview Article ↗
                  </a>
                  <a href="/app/publishing-queue" className="cl-modal-action-btn secondary">
                    Go to Queue
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
