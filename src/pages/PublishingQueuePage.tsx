import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import './PublishingQueuePage.css';

// ── Icons ────────────────────────────────────────────────────────────────────
const Send = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
);
const Clock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);
const Trash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const Link2 = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);
const X = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const RefreshCw = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);
const ExternalLink = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// ── Constants ─────────────────────────────────────────────────────────────────
const CHANNEL_LABELS: Record<string, { label: string; color: string }> = {
  wordpress: { label: 'WordPress', color: '#3858E9' },
  webflow:   { label: 'Webflow',   color: '#4353FF' },
  hubspot:   { label: 'HubSpot',   color: '#FF7A59' },
  linkedin:  { label: 'LinkedIn',  color: '#0A66C2' },
  x:         { label: 'X',         color: '#000000' },
};
const ALL_CHANNELS = Object.keys(CHANNEL_LABELS);

// ── Types ─────────────────────────────────────────────────────────────────────
interface QueueItem {
  id: string;
  brand_profile_id: string;
  content_id: string;
  title: string;
  channels: string[];
  status: 'staged' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed';
  scheduled_at: string | null;
  published_at: string | null;
  publish_results: Record<string, { status: string; url?: string; error?: string; message?: string }>;
  created_at: string;
  brand_name?: string;
  brand_url?: string;
}

interface ConnectedChannel { channel: string; }

interface UtmPreview {
  item: QueueItem;
  channels: Record<string, Record<string, string>>;
}

export default function PublishingQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [brands, setBrands] = useState<{ id: string; brandName?: string; brandUrl?: string }[]>([]);
  const [connectedChannels, setConnectedChannels] = useState<Record<string, string[]>>({});
  const [publishing, setPublishing] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState<Record<string, string>>({});
  const [selectedChannels, setSelectedChannels] = useState<Record<string, string[]>>({});
  const [utmPreview, setUtmPreview] = useState<UtmPreview | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterBrand, setFilterBrand] = useState<string>('all');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/publishing/queue');
      const d = await r.json();
      if (d.success) {
        setItems(d.items);
        // Init selectedChannels for any new items
        setSelectedChannels(prev => {
          const next = { ...prev };
          for (const item of d.items) {
            if (!next[item.id]) next[item.id] = item.channels || [];
          }
          return next;
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    fetch('/api/context-hub/brains').then(r => r.json()).then(d => {
      if (d.success) setBrands(d.data || []);
    });
  }, [loadQueue]);

  // Load connected channels per brand
  useEffect(() => {
    const brandIds = [...new Set(items.map(i => i.brand_profile_id))];
    brandIds.forEach(bid => {
      if (connectedChannels[bid]) return;
      fetch(`/api/publishing/channels/${bid}`)
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            setConnectedChannels(prev => ({
              ...prev,
              [bid]: d.channels.map((c: ConnectedChannel) => c.channel)
            }));
          }
        });
    });
  }, [items]);

  const toggleChannel = (itemId: string, channel: string) => {
    setSelectedChannels(prev => {
      const cur = prev[itemId] || [];
      return {
        ...prev,
        [itemId]: cur.includes(channel) ? cur.filter(c => c !== channel) : [...cur, channel]
      };
    });
  };

  const handlePublishNow = async (item: QueueItem) => {
    const channels = selectedChannels[item.id] || [];
    if (channels.length === 0) { setError('Select at least one channel'); return; }
    setPublishing(item.id);
    setError('');
    try {
      const r = await fetch('/api/publishing/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueItemId: item.id, channels })
      });
      const d = await r.json();
      if (d.success) {
        setSuccessMsg(`"${item.title}" sent to ${channels.join(', ')} — status: ${d.status}`);
        setTimeout(() => setSuccessMsg(''), 5000);
        loadQueue();
      } else {
        setError(d.error || 'Publish failed');
      }
    } catch {
      setError('Request failed');
    } finally {
      setPublishing(null);
    }
  };

  const handleSchedule = async (item: QueueItem) => {
    const dt = scheduleDate[item.id];
    if (!dt) { setError('Pick a date and time'); return; }
    const channels = selectedChannels[item.id] || [];
    if (channels.length === 0) { setError('Select at least one channel'); return; }
    setScheduling(item.id);
    try {
      await fetch(`/api/publishing/queue/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: new Date(dt).toISOString(), channels, status: 'scheduled' })
      });
      setSuccessMsg(`"${item.title}" scheduled for ${new Date(dt).toLocaleString()}`);
      setTimeout(() => setSuccessMsg(''), 5000);
      loadQueue();
    } finally {
      setScheduling(null);
    }
  };

  const handleRemove = async (itemId: string) => {
    await fetch(`/api/publishing/queue/${itemId}`, { method: 'DELETE' });
    loadQueue();
  };

  const openUtmPreview = async (item: QueueItem) => {
    // Fetch UTM templates for this brand's connected channels
    const r = await fetch(`/api/publishing/channels/${item.brand_profile_id}`);
    const d = await r.json();
    const channelMap: Record<string, Record<string, string>> = {};
    if (d.success) {
      for (const ch of d.channels) channelMap[ch.channel] = ch.utm_template || {};
    }
    setUtmPreview({ item, channels: channelMap });
  };

  // Filter logic
  const filteredItems = items.filter(item => {
    if (filterStatus !== 'all' && item.status !== filterStatus) return false;
    if (filterBrand !== 'all' && item.brand_profile_id !== filterBrand) return false;
    return true;
  });

  const statusCounts = {
    all: items.length,
    staged: items.filter(i => i.status === 'staged').length,
    scheduled: items.filter(i => i.status === 'scheduled').length,
    published: items.filter(i => i.status === 'published').length,
    partial: items.filter(i => i.status === 'partial').length,
    failed: items.filter(i => i.status === 'failed').length,
  };

  const brandName = (item: QueueItem) =>
    item.brand_name || brands.find(b => b.id === item.brand_profile_id)?.brandName || item.brand_url || '—';

  return (
    <AppShell pageTitle="Publishing Queue">
      <div className="pq-page">
        {/* Header */}
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Stage 6</div>
            <h1 className="geo-title">Publishing Queue</h1>
            <p className="geo-description">Approved articles staged for distribution. Select channels, publish now or schedule — every publish writes to the Brain.</p>
          </div>
          <button className="pq-refresh-btn" onClick={loadQueue} disabled={loading}>
            <RefreshCw /> {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {/* Status filter tabs */}
        <div className="pq-filter-bar">
          <div className="pq-tabs">
            {(['all', 'staged', 'scheduled', 'published', 'partial', 'failed'] as const).map(s => (
              <button
                key={s}
                className={`pq-tab ${filterStatus === s ? 'active' : ''}`}
                onClick={() => setFilterStatus(s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
                {statusCounts[s] > 0 && <span className="pq-tab-count">{statusCounts[s]}</span>}
              </button>
            ))}
          </div>
          <select
            className="geo-select pq-brand-filter"
            value={filterBrand}
            onChange={e => setFilterBrand(e.target.value)}
          >
            <option value="all">All Brands</option>
            {brands.map(b => (
              <option key={b.id} value={b.id}>{b.brandName || b.brandUrl}</option>
            ))}
          </select>
        </div>

        {error && <div className="geo-error">{error}</div>}
        {successMsg && <div className="int-success">{successMsg}</div>}

        {/* Queue table */}
        {loading ? (
          <div className="pq-empty">Loading queue...</div>
        ) : filteredItems.length === 0 ? (
          <div className="pq-empty">
            {items.length === 0
              ? 'No articles in queue yet. Approve an article in the Compliance Gate to stage it here.'
              : 'No articles match the current filters.'}
          </div>
        ) : (
          <div className="pq-list">
            {filteredItems.map(item => {
              const availChannels = connectedChannels[item.brand_profile_id] || [];
              const sel = selectedChannels[item.id] || [];
              const isPublishing = publishing === item.id;
              const isScheduling = scheduling === item.id;
              const results = item.publish_results || {};

              return (
                <div key={item.id} className={`pq-item status-${item.status}`}>
                  {/* Row top: title + meta + status */}
                  <div className="pq-item-top">
                    <div className="pq-item-meta">
                      <div className="pq-item-title">{item.title || 'Untitled Article'}</div>
                      <div className="pq-item-sub">
                        <span className="pq-brand-tag">{brandName(item)}</span>
                        <span className="pq-dot">·</span>
                        <span className="pq-date">Staged {new Date(item.created_at).toLocaleDateString()}</span>
                        {item.scheduled_at && (
                          <>
                            <span className="pq-dot">·</span>
                            <span className="pq-scheduled-tag"><Clock /> {new Date(item.scheduled_at).toLocaleString()}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="pq-item-actions-top">
                      <span className={`pq-status-pill status-${item.status}`}>
                        {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                      </span>
                      <button className="pq-icon-btn" title="UTM Preview" onClick={() => openUtmPreview(item)}>
                        <Link2 />
                      </button>
                      <button className="pq-icon-btn danger" title="Remove from queue" onClick={() => handleRemove(item.id)}>
                        <Trash />
                      </button>
                    </div>
                  </div>

                  {/* Channel selector */}
                  <div className="pq-channel-row">
                    <span className="pq-channel-label">Publish to:</span>
                    <div className="pq-channel-chips">
                      {availChannels.length === 0 ? (
                        <span className="pq-no-channels">No channels connected — set up in Integrations</span>
                      ) : (
                        availChannels.map(ch => {
                          const def = CHANNEL_LABELS[ch];
                          const isSelected = sel.includes(ch);
                          const result = results[ch];
                          return (
                            <button
                              key={ch}
                              className={`pq-chip ${isSelected ? 'selected' : ''} ${result?.status === 'published' ? 'published' : ''}`}
                              style={{ '--chip-color': def?.color } as React.CSSProperties}
                              onClick={() => toggleChannel(item.id, ch)}
                              title={result ? `${result.status}${result.url ? ': ' + result.url : result.error ? ': ' + result.error : ''}` : ''}
                            >
                              {def?.label || ch}
                              {result?.status === 'published' && result.url && (
                                <a href={result.url} target="_blank" rel="noreferrer" className="pq-chip-link" onClick={e => e.stopPropagation()}>
                                  <ExternalLink />
                                </a>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                    {ALL_CHANNELS.filter(ch => !availChannels.includes(ch)).length > 0 && availChannels.length > 0 && (
                      <span className="pq-unconnected-hint">
                        {ALL_CHANNELS.filter(ch => !availChannels.includes(ch)).map(ch => CHANNEL_LABELS[ch]?.label).join(', ')} not connected
                      </span>
                    )}
                  </div>

                  {/* Publish actions */}
                  {item.status !== 'published' && (
                    <div className="pq-item-actions">
                      <button
                        className="pq-publish-now-btn"
                        onClick={() => handlePublishNow(item)}
                        disabled={isPublishing || sel.length === 0}
                      >
                        <Send /> {isPublishing ? 'Publishing...' : 'Publish Now'}
                      </button>
                      <div className="pq-schedule-group">
                        <input
                          type="datetime-local"
                          className="pq-datetime-input"
                          value={scheduleDate[item.id] || ''}
                          onChange={e => setScheduleDate(prev => ({ ...prev, [item.id]: e.target.value }))}
                        />
                        <button
                          className="pq-schedule-btn"
                          onClick={() => handleSchedule(item)}
                          disabled={isScheduling || !scheduleDate[item.id] || sel.length === 0}
                        >
                          <Clock /> {isScheduling ? 'Scheduling...' : 'Schedule'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Publish results */}
                  {Object.keys(results).length > 0 && (
                    <div className="pq-results">
                      {Object.entries(results).map(([ch, res]) => (
                        <div key={ch} className={`pq-result-row result-${res.status}`}>
                          <span className="pq-result-channel">{CHANNEL_LABELS[ch]?.label || ch}</span>
                          <span className="pq-result-status">{res.status}</span>
                          {res.url && (
                            <a href={res.url} target="_blank" rel="noreferrer" className="pq-result-url">
                              {res.url.slice(0, 50)}{res.url.length > 50 ? '...' : ''} <ExternalLink />
                            </a>
                          )}
                          {res.error && <span className="pq-result-error">{res.error}</span>}
                          {res.message && <span className="pq-result-msg">{res.message}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* UTM Preview Modal */}
      {utmPreview && (
        <div className="pq-modal-overlay" onClick={() => setUtmPreview(null)}>
          <div className="pq-modal" onClick={e => e.stopPropagation()}>
            <div className="pq-modal-header">
              <div className="pq-modal-title">UTM Preview</div>
              <div className="pq-modal-sub">{utmPreview.item.title}</div>
              <button className="pq-modal-close" onClick={() => setUtmPreview(null)}><X /></button>
            </div>
            <div className="pq-modal-body">
              {Object.keys(utmPreview.channels).length === 0 ? (
                <p className="pq-modal-empty">No channels connected for this Brain yet.</p>
              ) : (
                Object.entries(utmPreview.channels).map(([ch, utm]) => {
                  const utmStr = Object.entries(utm).map(([k, v]) => `${k}=${v}`).join('&');
                  const previewUrl = `https://yoursite.com/article-slug?${utmStr}`;
                  return (
                    <div key={ch} className="pq-utm-block">
                      <div className="pq-utm-channel" style={{ color: CHANNEL_LABELS[ch]?.color }}>
                        {CHANNEL_LABELS[ch]?.label || ch}
                      </div>
                      <div className="pq-utm-params">
                        {Object.entries(utm).map(([k, v]) => (
                          <div key={k} className="pq-utm-param">
                            <span className="pq-utm-k">{k}</span>
                            <span className="pq-utm-v">{v}</span>
                          </div>
                        ))}
                      </div>
                      <div className="pq-utm-preview-url">{previewUrl}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
