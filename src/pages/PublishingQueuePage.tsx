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
const Eye = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);
const Edit2 = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
  </svg>
);

// ── Markdown renderer ────────────────────────────────────────────────────────
function renderMarkdown(text: string): React.ReactNode[] {
  if (!text) return [];
  // Strip AI artifact tags
  const cleaned = text
    .replace(/\[NEEDS CITATION:[^\]]*\]/gi, '')
    .replace(/\[CITATION:[^\]]*\]/gi, '')
    .replace(/\[SOURCE:[^\]]*\]/gi, '')
    .trim();

  // Split into paragraphs on double newline
  return cleaned.split(/\n\n+/).map((para, pi) => {
    // Parse inline: **bold**, *italic*, then plain text
    const parts: React.ReactNode[] = [];
    const inlineRegex = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`/g;
    let last = 0, match;
    while ((match = inlineRegex.exec(para)) !== null) {
      if (match.index > last) parts.push(para.slice(last, match.index));
      if (match[1]) parts.push(<strong key={match.index}>{match[1]}</strong>);
      else if (match[2]) parts.push(<em key={match.index}>{match[2]}</em>);
      else if (match[3]) parts.push(<code key={match.index} style={{background:'rgba(255,255,255,0.08)',padding:'1px 5px',borderRadius:'3px',fontSize:'0.9em'}}>{match[3]}</code>);
      last = match.index + match[0].length;
    }
    if (last < para.length) parts.push(para.slice(last));
    return <p key={pi} className="pq-preview-body" style={{marginBottom: pi < cleaned.split(/\n\n+/).length - 1 ? '12px' : 0}}>{parts}</p>;
  });
}

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
  const [contentPreview, setContentPreview] = useState<{ item: QueueItem; article: any; postCopy: Record<string, string> } | null>(null);
  const [publishLog, setPublishLog] = useState<Record<string, { channel: string; live_status: string; published_url?: string; last_synced_at?: string }[]>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [republishing, setRepublishing] = useState<string | null>(null); // "itemId:channel" 

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/publishing/queue');
      const d = await r.json();
      if (d.success) {
        setItems(d.items);
        setSelectedChannels(prev => {
          const next = { ...prev };
          for (const item of d.items) {
            if (!next[item.id]) next[item.id] = item.channels || [];
          }
          return next;
        });
        // Load publish logs for published items
        for (const item of d.items) {
          if (item.status === 'published' || item.status === 'partial') {
            fetch(`/api/publishing/log/${item.id}`)
              .then(r => r.json())
              .then(ld => {
                if (ld.success) setPublishLog(prev => ({ ...prev, [item.id]: ld.log }));
              }).catch(() => {});
          }
        }
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

  const handleSync = async (itemId: string) => {
    setSyncing(itemId);
    try {
      const r = await fetch(`/api/publishing/sync/${itemId}`);
      const d = await r.json();
      if (d.success) {
        // Refresh log
        const ld = await fetch(`/api/publishing/log/${itemId}`).then(r => r.json());
        if (ld.success) setPublishLog(prev => ({ ...prev, [itemId]: ld.log }));
        setSuccessMsg('Status synced with live channels');
        setTimeout(() => setSuccessMsg(''), 3000);
      }
    } finally {
      setSyncing(null);
    }
  };

  const handleRepublish = async (itemId: string, channel: string) => {
    const key = `${itemId}:${channel}`;
    setRepublishing(key);
    setError('');
    try {
      const r = await fetch('/api/publishing/republish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueItemId: itemId, channel })
      });
      const d = await r.json();
      if (d.success) {
        setSuccessMsg(`Re-published to ${CHANNEL_LABELS[channel]?.label || channel} ✓`);
        setTimeout(() => setSuccessMsg(''), 4000);
        // Refresh log
        const ld = await fetch(`/api/publishing/log/${itemId}`).then(r => r.json());
        if (ld.success) setPublishLog(prev => ({ ...prev, [itemId]: ld.log }));
        loadQueue();
      } else {
        setError(d.error || 'Republish failed');
      }
    } finally {
      setRepublishing(null);
    }
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

  const openContentPreview = async (item: QueueItem) => {
    try {
      await fetch(`/api/publishing/channels/${item.brand_profile_id}`);
      const safeId = item.brand_profile_id.replace(/-/g, '_');
      const artRes = await fetch(`/api/content/${safeId}/${item.content_id}`);
      const artData = await artRes.json();
      const article = artData.success ? artData.article : null;

      // Build default post copy — fetch AI-generated copy from server
      const sections = article?.article_json?.sections || [];
      const liBrandSlug = (article?.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().split('-').slice(0,3).join('-') || item.brand_profile_id.slice(0,8);
      const artSlug = (article?.title || item.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
      const articleUrl = `https://forgeintelligence.ai/articles/${liBrandSlug}/${artSlug}`;
      const wordCount = sections.reduce((acc: number, s: any) => acc + ((s.body || s.content || '').split(' ').length), 0);
      const readMin = Math.max(2, Math.round(wordCount / 200));
      const headings = sections.slice(1, 5).map((s: any) => s.heading).filter(Boolean).join(', ');

      // Ask server to generate the LinkedIn copy
      let liCopy = `${article?.title || item.title}\n\nRead more: ${articleUrl}`;
      try {
        const copyRes = await fetch('/api/publishing/generate-post-copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: article?.title || item.title, headings, readMinutes: readMin, articleUrl })
        });
        const copyData = await copyRes.json();
        if (copyData.copy) liCopy = copyData.copy;
      } catch(_) {}

      const defaultCopy: Record<string, string> = {
        linkedin: liCopy,
        x: `${(article?.title || item.title).slice(0, 200)}\n\nRead more: ${articleUrl}`,
        wordpress: article?.title || item.title,
        webflow: article?.title || item.title,
      };
      setContentPreview({ item, article, postCopy: defaultCopy });
    } finally {
    }
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
                      <button className="pq-icon-btn" title="Preview & Edit Post" onClick={() => openContentPreview(item)}>
                        <Eye />
                      </button>
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

                  {/* Publish actions — show for staged/failed AND for published to allow re-targeting new channels */}
                  {(item.status !== 'published' || availChannels.some(ch => !results[ch])) && (
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

                  {/* Publish results with live status + sync + republish */}
                  {Object.keys(results).length > 0 && (
                    <div className="pq-results">
                      <div className="pq-results-header">
                        <span className="pq-results-label">Published to</span>
                        <button
                          className="pq-sync-btn"
                          onClick={() => handleSync(item.id)}
                          disabled={syncing === item.id}
                          title="Check live status on each channel"
                        >
                          <RefreshCw /> {syncing === item.id ? 'Syncing...' : 'Sync Status'}
                        </button>
                      </div>
                      {Object.entries(results).map(([ch, res]) => {
                        const log = (publishLog[item.id] || []).find(l => l.channel === ch);
                        const liveStatus = log?.live_status || res.status;
                        const isDeleted = liveStatus === 'deleted';
                        const isUnknown = liveStatus === 'unknown';
                        const repKey = `${item.id}:${ch}`;
                        return (
                        <div key={ch} className={`pq-result-row result-${liveStatus}`}>
                          <span className="pq-result-channel">{CHANNEL_LABELS[ch]?.label || ch}</span>
                          <span className={`pq-result-status live-${liveStatus}`}>
                            {isDeleted ? '🗑 Deleted' : isUnknown ? '⚠ Unknown' : '✓ Live'}
                          </span>
                          {res.url && !isDeleted && (
                            <a href={res.url} target="_blank" rel="noreferrer" className="pq-result-url">
                              View post <ExternalLink />
                            </a>
                          )}
                          {log?.last_synced_at && (
                            <span className="pq-synced-at">synced {new Date(log.last_synced_at).toLocaleTimeString()}</span>
                          )}
                          {(isDeleted || isUnknown) && (
                            <button
                              className="pq-republish-btn"
                              onClick={() => handleRepublish(item.id, ch)}
                              disabled={republishing === repKey}
                            >
                              {republishing === repKey ? 'Republishing...' : '↺ Republish'}
                            </button>
                          )}
                          {res.error && <span className="pq-result-error">{res.error}</span>}
                          {res.message && <span className="pq-result-msg">{res.message}</span>}
                        </div>
                        );
                      })}
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

      {/* ── Content Preview & Edit Modal ─────────────────────────────── */}
      {contentPreview && (() => {
        const { item, article, postCopy } = contentPreview;
        const sections = article?.article_json?.sections || [];
        const heroImageUrl = article?.hero_image_url;
        const connChannels = connectedChannels[item.brand_profile_id] || [];
        const sel = selectedChannels[item.id] || [];

        return (
          <div className="pq-modal-overlay" onClick={() => setContentPreview(null)}>
            <div className="pq-modal pq-preview-modal" onClick={e => e.stopPropagation()}>
              <div className="pq-modal-header">
                <div>
                  <div className="pq-modal-title">Content Preview</div>
                  <div className="pq-modal-sub">{item.title}</div>
                </div>
                <button className="pq-modal-close" onClick={() => setContentPreview(null)}><X /></button>
              </div>

              <div className="pq-preview-layout">
                {/* Left: article preview */}
                <div className="pq-preview-article">
                  {heroImageUrl ? (
                    <img src={heroImageUrl} alt={item.title} className="pq-preview-hero" />
                  ) : (
                    <div className="pq-preview-no-image">
                      <span>No hero image generated</span>
                      <button
                        className="pq-regen-image-btn"
                        onClick={async () => {
                          const r = await fetch(`/api/content/regenerate-image/${item.content_id}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ brandProfileId: item.brand_profile_id })
                          });
                          const d = await r.json();
                          if (d.imageUrl) {
                            setContentPreview(prev => prev ? {
                              ...prev,
                              article: { ...prev.article, hero_image_url: d.imageUrl }
                            } : null);
                          }
                        }}
                      >↺ Generate Image</button>
                    </div>
                  )}
                  <h1 className="pq-preview-title">{article?.title || item.title}</h1>
                  {article?.article_json?.metaDescription && (
                    <p className="pq-preview-meta-desc">{article.article_json.metaDescription}</p>
                  )}
                  <div className="pq-preview-sections">
                    {sections.map((s: any, i: number) => (
                      <div key={i} className="pq-preview-section">
                        {s.heading && <h2 className="pq-preview-heading">{s.heading}</h2>}
                        <>{renderMarkdown(s.body || s.content || '')}</>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right: post copy editor per channel */}
                <div className="pq-preview-side">
                  <div className="pq-preview-side-title"><Edit2 /> Post Copy</div>
                  <p className="pq-preview-side-hint">Edit the intro copy for each social channel before publishing.</p>

                  {connChannels.map(ch => {
                    const def = CHANNEL_LABELS[ch];
                    const isTextChannel = ch === 'linkedin' || ch === 'x';
                    if (!isTextChannel) return null;
                    return (
                      <div key={ch} className="pq-copy-block">
                        <div className="pq-copy-channel-label" style={{ color: def?.color }}>
                          {def?.label}
                          <span className="pq-copy-char-count">
                            {(postCopy[ch] || '').length} chars
                            {ch === 'x' && (postCopy[ch] || '').length > 280 && (
                              <span className="pq-copy-over"> · over 280!</span>
                            )}
                          </span>
                        </div>
                        <textarea
                          className="pq-copy-textarea"
                          value={postCopy[ch] || ''}
                          rows={ch === 'linkedin' ? 6 : 4}
                          onChange={e => setContentPreview(prev => prev ? {
                            ...prev,
                            postCopy: { ...prev.postCopy, [ch]: e.target.value }
                          } : null)}
                        />
                      </div>
                    );
                  })}

                  <div className="pq-preview-actions">
                    <button className="pq-cancel-btn" onClick={() => setContentPreview(null)}>Cancel</button>
                    <button
                      className="pq-publish-now-btn"
                      disabled={publishing === item.id || sel.length === 0}
                      onClick={async () => {
                        setPublishing(item.id);
                        setError('');
                        try {
                          const r = await fetch('/api/publishing/publish', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ queueItemId: item.id, channels: sel, postCopy: contentPreview.postCopy })
                          });
                          const d = await r.json();
                          if (d.success) {
                            setSuccessMsg(`Published to ${sel.join(', ')}`);
                            setContentPreview(null);
                            loadQueue();
                            setTimeout(() => setSuccessMsg(''), 5000);
                          } else { setError(d.error || 'Publish failed'); }
                        } finally { setPublishing(null); }
                      }}
                    >
                      <Send /> {publishing === item.id ? 'Publishing...' : `Publish to ${sel.length} channel${sel.length !== 1 ? 's' : ''}`}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

    </AppShell>
  );
}
