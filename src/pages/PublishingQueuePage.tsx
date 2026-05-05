import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import { NoBrandEmpty } from '../components/NoBrandEmpty';
import GateModal from '../components/GateModal';
import { useApp } from '../context/AppContext';
import './PublishingQueuePage.css';

// ── Icons ────────────────────────────────────────────────────────────────────
const Copy = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
  </svg>
);
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
const Share = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
  </svg>
);
const Archive = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>
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
const Download = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
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
  x:         { label: 'X',         color: '#E7E9EA' },
  facebook:  { label: 'Facebook',   color: '#1877F2' },
  reddit:    { label: 'Reddit',     color: '#FF4500' },
  medium:    { label: 'Medium',     color: '#A8A8A8' },
  ghost:     { label: 'Ghost',      color: '#738A94' },
};
const ALL_CHANNELS = Object.keys(CHANNEL_LABELS);

// ── UTM token resolver ────────────────────────────────────────────────────────
function resolveUtmTemplate(
  template: Record<string, string>,
  params: { campaignSlug: string; articleSlug: string; brandSlug: string; channel: string }
): string {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) {
    resolved[k] = v
      .replace(/\{campaign_slug\}/g, params.campaignSlug)
      .replace(/\{article_slug\}/g,  params.articleSlug)
      .replace(/\{brand_slug\}/g,    params.brandSlug)
      .replace(/\{channel\}/g,       params.channel);
  }
  return Object.entries(resolved).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}



// ── Types ─────────────────────────────────────────────────────────────────────
interface QueueItem {
  id: string;
  brand_profile_id: string;
  content_id: string;
  title: string;
  channels: string[];
  status: 'staged' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'archived';
  scheduled_at: string | null;
  published_at: string | null;
  publish_results: Record<string, any>;  // channel keys (linkedin, x, etc.) plus optional __social metadata
  hero_image_url?: string | null;        // social posts populate this with their square 1:1 image
  created_at: string;
  brand_name?: string;
  brand_url?: string;
  campaign_id?: string | null;
  campaign_name?: string | null;
  campaign_topic?: string | null;
  campaign_article_index?: number | null;
  week_number?: number | null;
  publish_day?: string | null;
  content_type?: string | null;
  funnel_position?: string | null;
  primary_persona?: string | null;
  review_status?: string | null;
  review_comment?: string | null;
  review_actioned_at?: string | null;
}

// Social-post metadata stored under publish_results.__social.
// Returns null for regular article queue items.
interface SocialMeta {
  kind: 'social_post';
  platform: 'x' | 'instagram';
  hashtags?: string[];
  cta?: string | null;
  post_id?: string;
}
function getSocialMeta(item: QueueItem): SocialMeta | null {
  const m = item.publish_results?.__social;
  return m && m.kind === 'social_post' ? m as SocialMeta : null;
}

interface ConnectedChannel { channel: string; }

export default function PublishingQueuePage() {
  const { isPaid, activeBrand, brandLoading, authToken } = useApp();
  const activeBrandId = activeBrand?.id ?? null;
  const ah: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  
  if (brandLoading) return null;
  if (!activeBrand) {
    return (
      <AppShell pageTitle="Publishing Queue">
        <NoBrandEmpty
          pageName="Publishing Queue"
          pageDescription="Your campaign articles ship from here — schedule, edit, and publish to multiple channels with one click."
          features={[
            'Manage drafts, scheduled posts, and published articles',
            'Push to LinkedIn, X, Facebook, Ghost, and your own site',
            'Track which articles converted with UTM-tagged share links',
            'Send articles to reviewers before publishing',
          ]}
        />
      </AppShell>
    );
  }
  if (!isPaid) {
    return (
      <AppShell>
        <GateModal 
          featureName="Publishing Queue" 
          onClose={() => window.location.href = '/app/context-hub'} 
          onUnlocked={() => {}} 
        />
      </AppShell>
    );
  }

  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectedChannels, setConnectedChannels] = useState<Record<string, string[]>>({});
  const [publishing, setPublishing] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState<Record<string, string>>({});
  const [selectedChannels, setSelectedChannels] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [contentPreview, setContentPreview] = useState<{ item: QueueItem; article: any; postCopy: Record<string, string> } | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [exportModal, setExportModal] = useState<{ item: QueueItem; article: any; brandSettingsData?: any; channelUtms?: Record<string, Record<string, string>> } | null>(null);
  const [customUtmBase, setCustomUtmBase] = useState<string>('');
  const [brandSettings, setBrandSettings] = useState<Record<string, { article_base_url?: string; article_url_suffix?: string; settings?: { siteTemplate?: any } }>>({});
  const [exportTab, setExportTab] = useState<'html' | 'markdown' | 'json' | 'link'>('html');
  const [copied, setCopied] = useState<string>('');
  const [publishLog, setPublishLog] = useState<Record<string, { channel: string; live_status: string; published_url?: string; last_synced_at?: string }[]>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [republishing, setRepublishing] = useState<string | null>(null);
  const [reviewers, setReviewers] = useState<{id:string;name:string;email:string;title:string}[]>([]);
  const [reviewDropdown, setReviewDropdown] = useState<string | null>(null); // itemId // "itemId:channel"
  const [deleteModal, setDeleteModal] = useState<{ item: QueueItem; publishedChannels: string[] } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Sort direction for the queue list. 'desc' (newest first) is the operator default —
  // most-recently-created articles surface at the top so the daily-use scan-for-fresh-content
  // workflow doesn't require scrolling through historical articles. Within a campaign,
  // articles always stay in publication sequence (week_number, article_index) regardless.
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [campaignScheduler, setCampaignScheduler] = useState<{
    campId: string;
    name: string;
    items: QueueItem[];
    startDate: string;
    publishTime: string;
    preview: { id: string; title: string; week: number; day: string; scheduledAt: string }[];
  } | null>(null);
  const [schedCampaignChannels, setSchedCampaignChannels] = useState<string[]>([]);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewCopied, setReviewCopied] = useState(false);
  const [editingTitleVal, setEditingTitleVal] = useState('');
  const [precogScores, setPrecogScores] = useState<Record<string, { score: number | null; tier: string; color: string; prediction: string; signals?: any[]; recommendedActions?: string[]; dataPoints?: number }>>({});
  const [deleteChannelSelection, setDeleteChannelSelection] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState(false);

  const buildSchedulePreview = (items: QueueItem[], startDate: string, publishTime: string) => {
    if (!startDate || !publishTime) return [];
    const base = new Date(`${startDate}T${publishTime}`);
    const dayOfWeekIndex: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
    };
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const sorted = items
      .filter(i => i.week_number)
      .sort((a, b) => (a.week_number! - b.week_number!) || 0);
    const results: { id: string; title: string; week: number; day: string; scheduledAt: string }[] = [];
    let prevDate = new Date(base);
    sorted.forEach((item, idx) => {
      let d: Date;
      if (idx === 0) {
        // Article 1 publishes on the exact chosen start date
        d = new Date(base);
      } else {
        // Find the next occurrence of this article's target day-of-week after the previous article
        const targetDay = dayOfWeekIndex[(item.publish_day || 'monday').toLowerCase()] ?? 1;
        d = new Date(prevDate);
        d.setDate(d.getDate() + 1); // start looking from the day after previous
        while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
        d.setHours(base.getHours(), base.getMinutes(), 0, 0);
      }
      results.push({
        id: item.id,
        title: item.title,
        week: item.week_number || 1,
        day: DAY_NAMES[d.getDay()], // derive label from actual computed date
        scheduledAt: d.toISOString()
      });
      prevDate = new Date(d);
    });
    return results;
  };

  const scheduleCampaign = async () => {
    if (!campaignScheduler) return;
    const { items, startDate, publishTime } = campaignScheduler;
    if (!schedCampaignChannels.length) { setError('Select at least one publish channel'); return; }
    const connected = connectedChannels[items[0]?.brand_profile_id] || [];
    const disconnected = schedCampaignChannels.filter(ch => !connected.includes(ch));
    if (disconnected.length > 0) {
      setError(`Cannot schedule — ${disconnected.map(ch => (CHANNEL_LABELS as any)[ch]?.label || ch).join(', ')} ${disconnected.length === 1 ? 'is' : 'are'} no longer connected. Reconnect in Settings → Integrations.`);
      return;
    }
    const preview = buildSchedulePreview(items, startDate, publishTime);
    if (!preview.length) { setError('Set a start date before scheduling'); return; }
    try {
      const results = await Promise.all(preview.map(p =>
        fetch(`/api/publishing/queue/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...ah },
          body: JSON.stringify({ scheduledAt: p.scheduledAt, channels: schedCampaignChannels, status: 'scheduled' })
        }).then(r => r.json())
      ));
      const failed = results.filter((r: any) => !r.success);
      if (failed.length) {
        setError(`${failed.length} article(s) failed to schedule`);
      } else {
        setCampaignScheduler(null);
        setSchedCampaignChannels([]);
        loadQueue();
        setSuccessMsg(`Campaign scheduled — ${preview.length} articles queued`);
        setTimeout(() => setSuccessMsg(''), 5000);
      }
    } catch {
      setError('Scheduling failed — please try again');
    }
  };

  const saveTitle = async (item: QueueItem) => {
    if (!editingTitleVal.trim() || editingTitleVal === item.title) {
      setEditingTitleId(null); return;
    }
    try {
      await fetch(`/api/publishing/queue/${item.id}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ title: editingTitleVal.trim() })
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, title: editingTitleVal.trim() } : i));
    } finally { setEditingTitleId(null); }
  };

  const sendForReview = async (item: QueueItem, reviewerId?: string) => {
    try {
      const r = await fetch(`/api/publishing/queue/${item.id}/request-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ reviewerId: reviewerId || null })
      });
      const d = await r.json();
      if (d.reviewUrl) {
        setReviewUrl(d.reviewUrl);
        navigator.clipboard.writeText(d.reviewUrl).catch(() => {});
        setReviewCopied(true);
        setReviewDropdown(null);
        setTimeout(() => { setReviewCopied(false); setReviewUrl(null); }, 5000);
      }
    } catch { /* silent */ }
  };

  const archiveItem = async (item: QueueItem) => {
    try {
      await fetch(`/api/publishing/queue/${item.id}/archive`, { method: 'POST', headers: ah });
      loadQueue();
    } catch(e) { console.error('Archive failed', e); }
  };

  const unarchiveItem = async (item: QueueItem) => {
    try {
      await fetch(`/api/publishing/queue/${item.id}/unarchive`, { method: 'POST', headers: ah });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'staged' } : i));
    } catch(e) { console.error('Unarchive failed', e); }
  };

  const loadQueue = useCallback(async () => {
    if (!activeBrandId) return;
    setLoading(true);
    try {
      // Load only the active brand's queue
      const allItems: QueueItem[] = [];
      const r = await fetch(`/api/publishing/queue/${activeBrandId}`, { headers: ah })
        .then(r => r.json())
        .catch(() => ({ success: false, items: [] }));
      if (r.success) allItems.push(...r.items);

      setItems(allItems);
      setSelectedChannels(prev => {
        const next = { ...prev };
        for (const item of allItems) {
          if (!next[item.id]) next[item.id] = item.channels || [];
        }
        return next;
      });

      // Load publish logs for items that have been published to at least one channel
      for (const item of allItems) {
        if (item.publish_results && Object.keys(item.publish_results).length > 0) {
          fetch(`/api/publishing/log/${item.id}`, { headers: ah })
            .then(r => r.json())
            .then(ld => {
              if (ld.success) setPublishLog(prev => ({ ...prev, [item.id]: ld.log }));
            }).catch(() => {});
        }
      }
    } finally {
      setLoading(false);
    }
  }, [activeBrandId]);

  useEffect(() => {
    if (activeBrandId) loadQueue();
  }, [loadQueue, activeBrandId]);

  // Load reviewers when items load
  useEffect(() => {
    if (!items.length) return;
    const brandId = items[0]?.brand_profile_id;
    if (!brandId) return;
    fetch(`/api/reviewers/${brandId}`, { headers: ah }).then(r=>r.json()).then(d => {
      if (d.success) setReviewers(d.reviewers);
    });
  }, [items]);

  // Load connected channels per brand
  useEffect(() => {
    const brandIds = [...new Set(items.map(i => i.brand_profile_id))];
    brandIds.forEach(bid => {
      if (connectedChannels[bid]) return;
      fetch(`/api/publishing/channels/${bid}`, { headers: ah })
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            const PUBLISH_ONLY = ['wordpress','webflow','hubspot','linkedin','x','facebook','reddit','medium','ghost'];
            setConnectedChannels(prev => ({
              ...prev,
              [bid]: d.channels.map((c: ConnectedChannel) => c.channel).filter((ch: string) => PUBLISH_ONLY.includes(ch))
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
    const connected = connectedChannels[item.brand_profile_id] || [];
    const disconnected = channels.filter(ch => !connected.includes(ch));
    if (disconnected.length > 0) {
      setError(`Cannot publish — ${disconnected.map(ch => (CHANNEL_LABELS as any)[ch]?.label || ch).join(', ')} ${disconnected.length === 1 ? 'is' : 'are'} not connected. Set up in Settings → Integrations.`);
      return;
    }
    setPublishing(item.id);
    setError('');
    try {
      const r = await fetch('/api/publishing/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
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
    const connected = connectedChannels[item.brand_profile_id] || [];
    const disconnected = channels.filter(ch => !connected.includes(ch));
    if (disconnected.length > 0) {
      setError(`Cannot schedule — ${disconnected.map(ch => (CHANNEL_LABELS as any)[ch]?.label || ch).join(', ')} ${disconnected.length === 1 ? 'is' : 'are'} not connected. Set up in Settings → Integrations.`);
      return;
    }
    setScheduling(item.id);
    try {
      await fetch(`/api/publishing/queue/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ scheduledAt: new Date(dt).toISOString(), channels, status: 'scheduled' })
      });
      setSuccessMsg(`"${item.title}" scheduled for ${new Date(dt).toLocaleString()}`);
      setTimeout(() => setSuccessMsg(''), 5000);
      loadQueue();
    } finally {
      setScheduling(null);
    }
  };



  const openDeleteModal = (item: QueueItem) => {
    // Deduplicate by channel — pull from publishLog AND publish_results on the item
    const seen = new Set<string>();
    const fromLog = (publishLog[item.id] || [])
      .filter(l => ['published','unknown','error','x:error'].includes(l.live_status))
      .filter(l => { if (seen.has(l.channel)) return false; seen.add(l.channel); return true; })
      .map(l => l.channel);
    // Also pick up channels from item.publish_results that may not be in log yet.
    // Skip namespaced metadata keys (e.g. __social) — those aren't channels.
    const fromResults = Object.entries(item.publish_results || {})
      .filter(([ch, r]: [string, any]) => r && !ch.startsWith('__') && !seen.has(ch))
      .map(([ch]) => { seen.add(ch); return ch; });
    const publishedChannels = [...fromLog, ...fromResults];
    setDeleteModal({ item, publishedChannels });
    // Default: all live channels selected for deletion
    const sel: Record<string, boolean> = {};
    publishedChannels.forEach(ch => { sel[ch] = true; });
    setDeleteChannelSelection(sel);
  };

  const handleUnpublish = async (removeFromQueue: boolean) => {
    if (!deleteModal) return;
    setDeleting(true);
    const { item } = deleteModal;
    // Only unpublish channels the user has checked
    const channelsToDelete = Object.entries(deleteChannelSelection)
      .filter(([, checked]) => checked)
      .map(([ch]) => ch);
    try {
      if (channelsToDelete.length > 0) {
        await Promise.all(channelsToDelete.map(channel =>
          fetch('/api/publishing/unpublish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...ah },
            body: JSON.stringify({ queueItemId: item.id, channel, deleteFromChannel: true, removeFromQueue: false })
          })
        ));
      }
      if (removeFromQueue) {
        await fetch(`/api/publishing/queue/${item.id}`, { method: 'DELETE', headers: ah });
      }
      setDeleteModal(null);
      loadQueue();
    } catch {
      setError('Delete failed — try again');
    } finally {
      setDeleting(false);
    }
  };

  const handleSync = async (itemId: string) => {
    setSyncing(itemId);
    try {
      const r = await fetch(`/api/publishing/sync/${itemId}`, { headers: ah });
      const d = await r.json();
      if (d.success) {
        // Refresh log
        const ld = await fetch(`/api/publishing/log/${itemId}`, { headers: ah }).then(r => r.json());
        if (ld.success) setPublishLog(prev => ({ ...prev, [itemId]: ld.log }));
        setSuccessMsg('Status synced with live channels');
        setTimeout(() => setSuccessMsg(''), 3000);
      }
    } finally {
      setSyncing(null);
    }
  };

  const handleRetry = async (itemId: string, channel: string) => {
    const key = `${itemId}:${channel}`;
    setRepublishing(key);
    try {
      await fetch(`/api/publishing/queue/${itemId}/reset-channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ channel })
      });
      // Clear local publish log for this channel so chip resets immediately
      setPublishLog(prev => ({
        ...prev,
        [itemId]: (prev[itemId] || []).filter(l => l.channel !== channel)
      }));
      await loadQueue();
    } catch {
      setError('Reset failed — try again');
    } finally {
      setRepublishing(null);
    }
  };

  const handleRepublish = async (itemId: string, channel: string) => {
    const key = `${itemId}:${channel}`;
    setRepublishing(key);
    setError('');
    try {
      const r = await fetch('/api/publishing/republish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ queueItemId: itemId, channel })
      });
      const d = await r.json();
      if (d.success) {
        setSuccessMsg(`Re-published to ${CHANNEL_LABELS[channel]?.label || channel} ✓`);
        setTimeout(() => setSuccessMsg(''), 4000);
        // Refresh log
        const ld = await fetch(`/api/publishing/log/${itemId}`, { headers: ah }).then(r => r.json());
        if (ld.success) setPublishLog(prev => ({ ...prev, [itemId]: ld.log }));
        loadQueue();
      } else {
        setError(d.error || 'Republish failed');
      }
    } finally {
      setRepublishing(null);
    }
  };

  const openExportModal = async (item: QueueItem) => {
    const safeId = item.brand_profile_id.replace(/-/g, '_');
    const [artRes, settingsRes, chRes] = await Promise.all([
      fetch(`/api/content/${safeId}/${item.content_id}`, { headers: ah }),
      fetch(`/api/brand-settings/${item.brand_profile_id}`, { headers: ah }),
      fetch(`/api/publishing/channels/${item.brand_profile_id}`, { headers: ah }).catch(() => null),
    ]);
    const artData    = await artRes.json();
    const settingsData = await settingsRes.json();
    const chData     = chRes ? await chRes.json().catch(() => ({ success: false, channels: [] })) : { success: false, channels: [] };
    const article = artData.success ? artData.article : null;
    if (settingsData.success) {
      setBrandSettings(prev => ({ ...prev, [item.brand_profile_id]: { ...settingsData.settings, settings: settingsData.settings.settings } }));
    }
    // Build channelUtms — fall back to DEFAULT_UTM when stored template is null/empty
    const channelUtms: Record<string, Record<string, string>> = {};
    if (chData.success) {
      for (const ch of chData.channels) {
        const stored = ch.utm_template;
        channelUtms[ch.channel] = (stored && Object.keys(stored).length > 0) ? stored : { utm_source: ch.channel, utm_medium: ['linkedin','x','facebook','reddit','medium'].includes(ch.channel) ? 'social' : 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' };
      }
    }
    setExportTab('html');
    setCopied('');
    setCustomUtmBase('');
    setExportModal({ item, article, brandSettingsData: settingsData.success ? settingsData.settings : null, channelUtms });
  };

  const buildExportUrl = (item: QueueItem, article: any, settingsOverride?: any) => {
    const brandSlug = (article?.brand_url || item.brand_url || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    const articleSlug = (item.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const settings = settingsOverride || brandSettings[item.brand_profile_id];
    const articleBaseUrl = settings?.article_base_url?.trim()
      ? settings.article_base_url.replace(/\/+$/, '')
      : `https://${window.location.hostname}/articles/${brandSlug}`;
    const suffix = (settings?.article_url_suffix || settingsOverride?.article_url_suffix || '').trim();
    return `${articleBaseUrl}/${articleSlug}${suffix}`;
  };

  const buildMarkdown = (article: any, item: QueueItem) => {
    const sections = article?.article_json?.sections || [];
    const lines: string[] = [`# ${item.title || 'Untitled'}`, ''];
    if (article?.article_json?.metaDescription) {
      lines.push(`> ${article.article_json.metaDescription}`, '');
    }
    for (const s of sections) {
      if (s.heading) lines.push(`## ${s.heading}`, '');
      if (s.body || s.content) lines.push(s.body || s.content, '');
    }
    return lines.join('\n');
  };

  const buildHTML = (article: any, item: QueueItem) => {
    const sections = article?.article_json?.sections || [];
    const canonical = buildExportUrl(item, article);
    const meta = (article?.article_json?.metaDescription || '').replace(/"/g, '&quot;');
    const title = (item.title || '').replace(/"/g, '&quot;');
    const hero = article?.hero_image_url || '';
    const wordCount = sections.reduce((acc: number, s: any) => acc + ((s.body || s.content || '').split(' ').length), 0);
    const readMin = Math.max(1, Math.round(wordCount / 200));
    const brandName = item.brand_name || item.brand_url || '';

    // Use scraped site template class names if available, otherwise generic
    const rawTmpl = exportModal?.brandSettingsData?.settings?.siteTemplate?.article
      || brandSettings[item.brand_profile_id]?.settings?.siteTemplate?.article;
    const catalogSrc = exportModal?.brandSettingsData?.settings?.siteTemplate?.catalog?.sourceUrl
      || brandSettings[item.brand_profile_id]?.settings?.siteTemplate?.catalog?.sourceUrl;
    // Ensure backLink.href uses the catalog source URL if scraped value is just '/'
    const tmpl = rawTmpl ? {
      ...rawTmpl,
      backLink: {
        ...(rawTmpl.backLink || {}),
        href: (rawTmpl.backLink?.href && rawTmpl.backLink.href !== '/') ? rawTmpl.backLink.href : (catalogSrc || rawTmpl.backLink?.href || '/'),
      }
    } : rawTmpl;
    const safeAttr = (v: string) => (v || '').replace(/["'<>]/g, '');
    const C = {
      nav:          safeAttr(tmpl?.nav?.class || 'navbar'),
      heroSection:  safeAttr(tmpl?.hero?.sectionClass || 'article-hero'),
      eyebrow:      safeAttr(tmpl?.hero?.eyebrowClass || 'article-hero-eyebrow'),
      meta:         safeAttr(tmpl?.hero?.metaClass || 'article-meta'),
      imageWrap:    safeAttr(tmpl?.hero?.imageWrapClass || 'article-hero-image'),
      bodySection:  safeAttr(tmpl?.body?.sectionClass || 'article-body-section'),
      body:         safeAttr(tmpl?.body?.bodyClass || 'article-body'),
      backClass:    safeAttr(tmpl?.backLink?.class || 'article-back'),
      backText:     (tmpl?.backLink?.text || 'Back to Articles').replace(/[<>]/g, ''),
      backHref:     (() => {
        const stored = tmpl?.backLink?.href;
        if (stored && stored !== '/') return safeAttr(stored);
        if (catalogSrc) return safeAttr(catalogSrc);
        // Fall back to article_base_url (the articles index page)
        const baseUrl = exportModal?.brandSettingsData?.article_base_url || brandSettings[item.brand_profile_id]?.article_base_url;
        return safeAttr(baseUrl || '/');
      })(),
      cta:          safeAttr(tmpl?.cta?.class || 'article-cta-section'),
      footer:       safeAttr(tmpl?.footer?.class || 'site-footer'),
    };
    const navHtml = tmpl?.nav?.linksHtml || '';

    const stripAnnotations = (text: string) =>
      text
        .replace(/\[NEEDS CITATION[^\]]*\]/g, '')
        .replace(/\[SME Hook[^\]]*\]/g, '')
        .replace(/\[NEEDS CLIENT[^\]]*\]/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .trim();

    const bodyHtml = sections.map((s: any) => {
      const heading = s.heading ? `    <h2>${s.heading}</h2>` : '';
      const rawBody = stripAnnotations(s.body || s.content || '');
      const paras = rawBody.split('\n').filter(Boolean).map((p: string) => `    <p>${p}</p>`).join('\n');
      return [heading, paras].filter(Boolean).join('\n');
    }).join('\n\n');

    // ── Pull author + brand metadata from brand settings (mirrors server.js article SSR) ──
    // Cast brandSettings entries to any — the local type only declares siteTemplate +
    // article_base_url, but the API actually returns factualGround, brand_url, voice_profile
    // and others. Server.js consumes the wider shape; we just need to read it here too.
    const bs: any = brandSettings[item.brand_profile_id];
    const fg = exportModal?.brandSettingsData?.settings?.factualGround
      || bs?.settings?.factualGround;
    const primaryAuthor = (fg?.authors || []).find((a: any) => a?.name && a.name.trim()) || null;
    const authorName = (primaryAuthor?.name || brandName).replace(/"/g, '&quot;');
    const realBrandUrl = exportModal?.brandSettingsData?.brand_url
      || bs?.brand_url
      || (item.brand_url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const brandHomeUrl = realBrandUrl
      ? (realBrandUrl.startsWith('http') ? realBrandUrl : `https://${realBrandUrl}`)
      : canonical;
    const logoUrl = exportModal?.brandSettingsData?.settings?.voice_profile?.logo_url
      || bs?.settings?.voice_profile?.logo_url
      || '';

    // ── Article schema (Person/Organization author with credentials) ──
    const authorBlock: any = primaryAuthor ? {
      "@type": "Person",
      "name": primaryAuthor.name.trim(),
      "jobTitle": primaryAuthor.title || '',
      "url": brandHomeUrl,
      "sameAs": (primaryAuthor.linkedinUrl && primaryAuthor.linkedinUrl.trim()) ? [primaryAuthor.linkedinUrl.trim()] : [],
      "knowsAbout": (primaryAuthor.expertise || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      "description": primaryAuthor.bio || '',
      ...(primaryAuthor.credentials ? { "hasCredential": primaryAuthor.credentials.split(/[,.]/).map((s: string) => s.trim()).filter(Boolean) } : {})
    } : { "@type": "Organization", "name": brandName, "url": brandHomeUrl };

    const aj = article?.article_json || {};
    const publishedISO = (article?.created_at || article?.updated_at || new Date().toISOString());
    const modifiedISO = (article?.updated_at || article?.created_at || new Date().toISOString());
    const articleKeywords = Array.isArray(aj.keywords) ? aj.keywords : [];
    const articleAbout = Array.isArray(aj.about) ? aj.about.map((t: string) => ({ "@type": "Thing", "name": t })) : [];

    const articleSchema = {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": item.title,
      "description": meta,
      ...(hero ? { "image": hero } : {}),
      "author": authorBlock,
      "publisher": {
        "@type": "Organization",
        "name": brandName,
        "url": brandHomeUrl,
        ...(logoUrl ? { "logo": { "@type": "ImageObject", "url": logoUrl } } : {})
      },
      "datePublished": publishedISO,
      "dateModified": modifiedISO,
      "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
      "wordCount": wordCount,
      "timeRequired": `PT${readMin}M`,
      "inLanguage": "en-US",
      ...(articleKeywords.length ? { "keywords": articleKeywords } : {}),
      ...(articleAbout.length ? { "about": articleAbout } : {}),
    };

    // ── FAQPage schema (highest GEO impact) ──
    const faqs = Array.isArray(aj.faqs) ? aj.faqs.filter((f: any) => f?.question && f?.answer) : [];
    const faqSchema = faqs.length ? {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqs.map((f: any) => ({
        "@type": "Question",
        "name": String(f.question).trim(),
        "acceptedAnswer": { "@type": "Answer", "text": String(f.answer).trim() }
      }))
    } : null;

    // ── Author footer for bot consumption (LLMs read DOM, not just schema) ──
    const authorFooterHtml = primaryAuthor ? `
  <footer style="margin-top:2em;padding-top:1em;border-top:1px solid #e5e5e5">
    <h3>About the author</h3>
    <p><strong>${primaryAuthor.name.replace(/</g, '&lt;')}</strong>${primaryAuthor.title ? ', ' + primaryAuthor.title.replace(/</g, '&lt;') : ''}</p>
    ${primaryAuthor.bio ? `<p>${primaryAuthor.bio.replace(/</g, '&lt;')}</p>` : ''}
  </footer>` : '';

    // ── FAQ DOM rendering (Q&A visible, not just in schema) ──
    const faqDomHtml = faqs.length ? `
  <section class="article-faqs">
    <h2>Frequently asked questions</h2>
    ${faqs.map((f: any) => `
    <div class="article-faq-item">
      <h3>${String(f.question).trim().replace(/</g, '&lt;')}</h3>
      <p>${String(f.answer).trim().replace(/</g, '&lt;').replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>
    </div>`).join('')}
  </section>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} | ${brandName}</title>
  <meta name="description" content="${meta}" />
  <link rel="canonical" href="${canonical}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="author" content="${authorName}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="${brandName}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${meta}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:locale" content="en_US" />
  ${hero ? `<meta property="og:image" content="${hero}" />
  <meta property="og:image:secure_url" content="${hero}" />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height" content="720" />
  <meta property="og:image:type" content="image/jpeg" />` : ''}
  <meta property="article:author" content="${authorName}" />
  <meta property="article:published_time" content="${publishedISO}" />
  <meta property="article:modified_time" content="${modifiedISO}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${meta}" />
  ${hero ? `<meta name="twitter:image" content="${hero}" />` : ''}
  <script type="application/ld+json">${JSON.stringify(articleSchema, null, 2)}</script>${faqSchema ? `
  <script type="application/ld+json">${JSON.stringify(faqSchema, null, 2)}</script>` : ''}
</head>
<body>

  <nav class="${C.nav}">
    ${navHtml || `<!-- paste your site nav here -->`}
  </nav>

  <section class="${C.heroSection}">
    <span class="${C.eyebrow}">${article?.article_json?.category || 'Thought Leadership'}</span>
    <h1>${item.title}</h1>
    <p class="${C.meta}">By ${brandName}${readMin ? ` &mdash; ${readMin} min read` : ''}</p>
    ${hero ? `<div class="${C.imageWrap}"><img src="${hero}" alt="${title}" /></div>` : ''}
  </section>

  <section class="${C.bodySection}">
    <div class="${C.body}">
      <a href="${C.backHref}" class="${C.backClass}">${C.backText}</a>
${bodyHtml}
${faqDomHtml}
${authorFooterHtml}
    </div>
  </section>

  <footer class="${C.footer}">
    <!-- paste your site footer here -->
  </footer>

</body>
</html>`;
  };

  const buildJSON = (article: any, item: QueueItem) => {
    const sections = article?.article_json?.sections || [];
    return JSON.stringify({
      title: item.title,
      metaDescription: article?.article_json?.metaDescription || '',
      heroImageUrl: article?.hero_image_url || '',
      canonicalUrl: buildExportUrl(item, article),
      sections: sections.map((s: any) => ({
        heading: s.heading || '',
        body: s.body || s.content || '',
        confidence: s.confidence || null,
      })),
      exportedAt: new Date().toISOString(),
    }, null, 2);
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 2500);
    });
  };



  const saveArticleEdit = async (field: string, value: string, sectionIndex?: number) => {
    if (!contentPreview) return;
    const { item, article } = contentPreview;
    let updatedArticle = { ...article };

    if (field === 'title') {
      updatedArticle.title = value;
      // Also update queue item title
      await fetch(`/api/publishing/queue/${item.id}/title`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ title: value })
      });
    } else if (field === 'metaDescription') {
      updatedArticle.article_json = { ...updatedArticle.article_json, metaDescription: value };
    } else if (field === 'sectionHeading' && sectionIndex !== undefined) {
      const sections = [...(updatedArticle.article_json?.sections || [])];
      sections[sectionIndex] = { ...sections[sectionIndex], heading: value };
      updatedArticle.article_json = { ...updatedArticle.article_json, sections };
    } else if (field === 'sectionBody' && sectionIndex !== undefined) {
      const sections = [...(updatedArticle.article_json?.sections || [])];
      sections[sectionIndex] = { ...sections[sectionIndex], body: value, content: value };
      updatedArticle.article_json = { ...updatedArticle.article_json, sections };
    }

    // Persist to DB
    const safeId = item.brand_profile_id.replace(/-/g, '_');
    await fetch(`/api/content/${safeId}/${item.content_id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...ah },
      body: JSON.stringify({ article_json: updatedArticle.article_json, title: updatedArticle.title })
    }).catch(() => {});

    setContentPreview(prev => prev ? { ...prev, article: updatedArticle } : null);
    setEditingField(null);
  };

  const openContentPreview = async (item: QueueItem) => {
    try {
      // Fetch channels for UTM templates + brand settings for article URL
      const [chRes, bsRes] = await Promise.all([
        fetch(`/api/publishing/channels/${item.brand_profile_id}`, { headers: ah }).then(r => r.json()).catch(() => ({ success: false, channels: [] })),
        fetch(`/api/brand-settings/${item.brand_profile_id}`, { headers: ah }).then(r => r.json()).catch(() => ({ success: false })),
      ]);
      const safeId = item.brand_profile_id.replace(/-/g, '_');
      const artRes = await fetch(`/api/content/${safeId}/${item.content_id}`, { headers: ah });
      const artData = await artRes.json();
      const article = artData.success ? artData.article : null;

      // Build article URL using Brand Settings base URL
      const bs = bsRes.success ? bsRes.settings : null;
      const sections = article?.article_json?.sections || [];
      const articleBaseUrl = buildExportUrl(item, article, bs);
      const articleSlug = (item.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const brandSlug = (article?.brand_url || item.brand_url || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
      const campaignSlug = item.campaign_name
        ? item.campaign_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
        : 'forge-content';

      // Build channel UTM map — fall back to DEFAULT_UTM when stored template is null/empty
      const channelUtmMap: Record<string, Record<string, string>> = {};
      if (chRes.success) {
        for (const ch of chRes.channels) {
          const stored = ch.utm_template;
          channelUtmMap[ch.channel] = (stored && Object.keys(stored).length > 0) ? stored : { utm_source: ch.channel, utm_medium: ['linkedin','x','facebook','reddit','medium'].includes(ch.channel) ? 'social' : 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' };
        }
      }

      // Build article URL with UTMs per channel
      const buildChannelUrl = (ch: string) => {
        const tmpl = channelUtmMap[ch];
        if (!tmpl || Object.keys(tmpl).length === 0) return articleBaseUrl;
        const utmStr = resolveUtmTemplate(tmpl, { campaignSlug, articleSlug, brandSlug, channel: ch });
        return `${articleBaseUrl}?${utmStr}`;
      };

      const wordCount = sections.reduce((acc: number, s: any) => acc + ((s.body || s.content || '').split(' ').length), 0);
      const readMin = Math.max(2, Math.round(wordCount / 200));
      const headings = sections.slice(1, 5).map((s: any) => s.heading).filter(Boolean).join(', ');
      const liUrl  = buildChannelUrl('linkedin');
      const xUrl   = buildChannelUrl('x');

      // Shorten URLs via Bitly for cleaner post copy
      const shorten = async (url: string, channel?: string): Promise<string> => {
        try {
          const brandTag = item.brand_name || item.brand_url?.replace(/https?:\/\//, '') || 'unknown';
          const tags = ['forge', brandTag, channel || 'social', item.campaign_name ? 'campaign' : 'standalone'].filter(Boolean);
          const r = await fetch('/api/utils/shorten-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...ah },
            body: JSON.stringify({ url, tags })
          });
          const d = await r.json();
          return d.shortUrl || url;
        } catch { return url; }
      };

      // LinkedIn uses the full canonical URL — Bitly links break OG unfurl and kill the preview card.
      // X still uses a short URL for post-length economy.
      const xShort = await shorten(xUrl, 'x');

      let liCopy = `${article?.title || item.title}\n\nRead more: ${liUrl}`;
      try {
        const copyRes = await fetch('/api/publishing/generate-post-copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ah },
          body: JSON.stringify({ title: article?.title || item.title, headings, readMinutes: readMin, articleUrl: liUrl })
        });
        const copyData = await copyRes.json();
        if (copyData.copy) liCopy = copyData.copy;
      } catch(_) {}

      // X: title capped at 240 chars to leave room for the short URL + newlines
      const xTitle = (article?.title || item.title).slice(0, 240);
      const defaultCopy: Record<string, string> = {
        linkedin: liCopy,
        x: `${xTitle}\n\nRead more: ${xShort}`,
        wordpress: article?.title || item.title,
        webflow: article?.title || item.title,
      };
      setContentPreview({ item, article, postCopy: defaultCopy });
    } finally {}
  };

  // Filter logic
  const archivedItems = items.filter(i => i.status === 'archived');
  const filteredItems = items.filter(item => {
    if (activeBrandId && item.brand_profile_id !== activeBrandId) return false;
    if (showArchived) return item.status === 'archived';
    return item.status !== 'archived';
  });

  // Split into campaign groups and standalone
  const campaignGroups: Record<string, { name: string; topic: string; items: QueueItem[] }> = {};
  const standaloneItems: QueueItem[] = [];
  for (const item of filteredItems) {
    if (item.campaign_id && item.campaign_name) {
      if (!campaignGroups[item.campaign_id]) {
        campaignGroups[item.campaign_id] = { name: item.campaign_name, topic: item.campaign_topic || '', items: [] };
      }
      campaignGroups[item.campaign_id].items.push(item);
    } else {
      standaloneItems.push(item);
    }
  }
  // Within each campaign, articles ALWAYS sort by publication sequence regardless of sortDir.
  // Campaign sequence is intentional — article 1 comes before article 8.
  for (const g of Object.values(campaignGroups)) {
    g.items.sort((a, b) => (a.week_number || 0) - (b.week_number || 0) || (a.campaign_article_index || 0) - (b.campaign_article_index || 0));
  }

  // Sort standalone items by created_at, direction controlled by user.
  const sortMul = sortDir === 'desc' ? -1 : 1;
  standaloneItems.sort((a, b) => {
    const aT = new Date(a.created_at || 0).getTime();
    const bT = new Date(b.created_at || 0).getTime();
    return (aT - bT) * sortMul;
  });

  // Sort campaign GROUPS by their newest article's created_at (matches sortDir).
  // 'desc' = most recently active campaign appears first.
  const sortedCampaignEntries = Object.entries(campaignGroups).sort(([, a], [, b]) => {
    const aT = Math.max(...a.items.map(i => new Date(i.created_at || 0).getTime()));
    const bT = Math.max(...b.items.map(i => new Date(i.created_at || 0).getTime()));
    return (aT - bT) * sortMul;
  });



  // Fetch pre-cog score for a single item (non-blocking)
  const fetchPrecogScore = useCallback(async (item: QueueItem) => {
    if (!item.brand_profile_id || precogScores[item.content_id]) return;
    try {
      const r = await fetch(`/api/precog/score/${item.brand_profile_id}/${item.content_id}`, { headers: ah });
      const d = await r.json();
      if (d.success && d.tier) {
        setPrecogScores(prev => ({ ...prev, [item.content_id]: {
          score: d.score,
          tier: d.tier,
          color: d.color || '#64748B',
          prediction: d.prediction || '',
          signals: d.signals,
          recommendedActions: d.recommendedActions,
          dataPoints: d.dataPoints,
        }}));
      }
    } catch { /* non-fatal */ }
  }, [precogScores]);

  // Load precog scores for visible items
  useEffect(() => {
    const staged = items.filter(i => i.status !== 'archived');
    staged.forEach(item => fetchPrecogScore(item));
  }, [items]);

  const brandName = (item: QueueItem) =>
    item.brand_name || item.brand_url || '—';

  return (
    <>
    <AppShell pageTitle="Publishing Queue">
      <div className="pq-page">
        {/* Header */}
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Publishing</div>
            <h1 className="geo-title">Publishing Queue</h1>
            <p className="geo-description">Approved articles staged for distribution. Select channels, publish now or schedule — every publish writes to the Brain.</p>
          </div>
          <button className="pq-refresh-btn" onClick={loadQueue} disabled={loading}>
            <RefreshCw /> {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        {error && <div className="geo-error">{error}</div>}
        {reviewUrl && (
          <div className="pq-review-toast">
            <span className="pq-review-link-label"><Link2 /> Review link {reviewCopied ? 'copied!' : 'ready'}:</span>
            <a href={reviewUrl} target="_blank" rel="noopener noreferrer" className="pq-review-link">{reviewUrl}</a>
          </div>
        )}
      <div className="pq-controls-row">
        <button
          className="pq-sort-toggle"
          onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
          title={sortDir === 'desc' ? 'Newest first' : 'Oldest first'}
        >
          {sortDir === 'desc' ? '↓ Newest first' : '↑ Oldest first'}
        </button>
        {archivedItems.length > 0 && (
          <button className="pq-archive-toggle" onClick={() => setShowArchived(p => !p)}>
            <Archive /> {showArchived ? 'Hide Archived' : `Show Archived (${archivedItems.length})`}
          </button>
        )}
      </div>
        {successMsg && <div className="int-success">{successMsg}</div>}

        {/* Queue — campaign groups + standalone */}
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

            {/* Campaign groups */}
            {sortedCampaignEntries.map(([campId, group]) => {
              const publishedCount = group.items.filter(i => i.publish_results && Object.keys(i.publish_results).length > 0).length;
              return (
                <div key={campId} className="pq-campaign-group">
                  <div className="pq-campaign-group-header">
                    <div className="pq-campaign-group-left">
                      <span className="pq-campaign-badge">Campaign · {campId.slice(0, 8).toUpperCase()}</span>
                      <div>
                        <div className="pq-campaign-group-name">{group.name}</div>
                        <div className="pq-campaign-group-topic">{group.topic}</div>
                      </div>
                    </div>
                    <div className="pq-campaign-group-right">
                      <span className="pq-campaign-group-stats">{publishedCount}/{group.items.length} published</span>
                      <button
                        className="pq-schedule-campaign-btn"
                        onClick={() => setCampaignScheduler({
                          campId,
                          name: group.name,
                          items: group.items,
                          startDate: '',
                          publishTime: '09:00',
                          preview: []
                        })}
                        title="Schedule all articles in this campaign"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                        Schedule Campaign
                      </button>
                    </div>
                  </div>
                  {[1,2,3,4].filter(w => group.items.some(i => i.week_number === w)).map(week => (
                    <div key={week} className="pq-campaign-week">
                      <div className="pq-campaign-week-label">Week {week}</div>
                      <div className="pq-campaign-week-items">
                        {group.items.filter(i => i.week_number === week).map(item => {
                          const availChannels = connectedChannels[item.brand_profile_id] || [];
                          const sel = selectedChannels[item.id] || [];
                          const isPublishing = publishing === item.id;
                          const isScheduling = scheduling === item.id;
                          const results = item.publish_results || {};

              return (
                <div key={item.id} className={`pq-item status-${item.status}`}>
                  {item.week_number != null && (
                    <div className="pq-campaign-meta-row">
                      <span className="pq-campaign-meta-week">Wk {item.week_number}{item.scheduled_at ? ` · ${new Date(item.scheduled_at).toLocaleDateString('en-US', { weekday: 'long' })}` : item.publish_day ? ` · ${item.publish_day}` : ''}</span>
                      {item.content_type && <span className="pq-campaign-meta-type">{item.content_type}</span>}
                      {item.funnel_position && <span className={`pq-campaign-meta-funnel funnel-${(item.funnel_position||'').toLowerCase()}`}>{item.funnel_position}</span>}
                    </div>
                  )}
                  {/* Row top: title + meta + status */}
                  <div className="pq-item-top">
                    <div className="pq-item-meta">
                      {item.review_status && (
                        <div className={`pq-review-badge pq-review-badge--${item.review_status}`}>
                          {item.review_status === 'approved' && '✓ Approved'}
                          {item.review_status === 'changes_requested' && '↩ Changes Requested'}
                          {item.review_status === 'pending' && '⏳ Awaiting Review'}
                          {item.review_comment && (
                            <span className="pq-review-comment" title={item.review_comment}>
                              · "{item.review_comment.length > 40 ? item.review_comment.slice(0, 40) + '…' : item.review_comment}"
                            </span>
                          )}
                        </div>
                      )}
                      {editingTitleId === item.id ? (
                        <input
                          className="pq-title-edit-input"
                          value={editingTitleVal}
                          onChange={e => setEditingTitleVal(e.target.value)}
                          onBlur={() => saveTitle(item)}
                          onKeyDown={e => { if (e.key === 'Enter') saveTitle(item); if (e.key === 'Escape') setEditingTitleId(null); }}
                          autoFocus
                        />
                      ) : (
                        <div
                          className="pq-item-title pq-item-title-editable"
                          title="Click to edit title"
                          onClick={() => { setEditingTitleId(item.id); setEditingTitleVal(item.title || ''); }}
                        >
                          {item.title || 'Untitled Article'}
                          <span className="pq-title-edit-hint">✎</span>
                        </div>
                      )}
                      <div className="pq-item-sub">
                        <span className="pq-brand-tag">{brandName(item)}</span>
                        <span className="pq-dot">·</span>
                        <span className="pq-date">{
                          item.scheduled_at && item.status !== 'staged'
                            ? `${item.status === 'published' || item.status === 'partial' ? 'Published' : 'Scheduled'} ${new Date(item.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${new Date(item.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                            : `Generated ${new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                        }</span>
                      </div>
                    </div>
                    {(() => {
                      const ps = precogScores[item.content_id];
                      if (!ps) return null;
                      if (ps.tier === 'insufficient_data') return (
                        <div className="pq-precog-badge pq-precog-insufficient" title="Not enough analytics data yet to score this article">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          No data yet
                        </div>
                      );
                      return (
                        <div className="pq-precog-badge" style={{ '--precog-color': ps.color } as React.CSSProperties}
                          title={ps.prediction + (ps.recommendedActions?.length ? '\n\nSuggested: ' + ps.recommendedActions[0] : '')}>
                          <span className="pq-precog-dot" />
                          <span className="pq-precog-score">{ps.score}</span>
                          <span className="pq-precog-label">Pre-cog</span>
                        </div>
                      );
                    })()}
                    <div className="pq-item-actions-top">

                      <button className="pq-icon-btn" title="Smart Export" onClick={() => openExportModal(item)}>
                        <Download />
                      </button>
                      {(() => {
                        const brandUrl = item.brand_url || '';
                        const bSlug = brandUrl.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
                        const aSlug = (item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
                        return (
                          <a className="pq-icon-btn" title="Preview live article" href={`/articles/${bSlug}/${aSlug}`} target="_blank" rel="noopener noreferrer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                            </svg>
                          </a>
                        );
                      })()}
                      <button className="pq-icon-btn" title="Preview & Edit Post" onClick={() => openContentPreview(item)}>
                        <Eye />
                      </button>

                      <div style={{ position: 'relative' }}>
                        <button className="pq-icon-btn" title="Send for Review"
                          onClick={() => setReviewDropdown(reviewDropdown === item.id ? null : item.id)}>
                          <Share />
                        </button>
                        {reviewDropdown === item.id && (
                          <div className="pq-reviewer-dropdown">
                            <div className="pq-reviewer-dropdown-title">Send for Review</div>
                            {reviewers.length === 0 ? (
                              <div className="pq-reviewer-empty">No reviewers — add them in Admin</div>
                            ) : reviewers.map(rv => (
                              <button key={rv.id} className="pq-reviewer-option"
                                onClick={() => sendForReview(item, rv.id)}>
                                <span className="pq-reviewer-avatar">{rv.name[0].toUpperCase()}</span>
                                <span>
                                  <div className="pq-reviewer-rname">{rv.name}</div>
                                  {rv.title && <div className="pq-reviewer-rtitle">{rv.title}</div>}
                                </span>
                              </button>
                            ))}
                            <div className="pq-reviewer-divider" />
                            <button className="pq-reviewer-option pq-reviewer-link-only"
                              onClick={() => sendForReview(item)}>
                              <span className="pq-reviewer-avatar"><Link2 /></span>
                              <span><div className="pq-reviewer-rname">Copy link only</div></span>
                            </button>
                          </div>
                        )}
                      </div>
                      {item.status === 'archived' ? (
                        <button className="pq-icon-btn" title="Unarchive — restore to queue" onClick={() => unarchiveItem(item)} style={{ color: '#10b981' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      ) : (
                        <button className="pq-icon-btn" title="Archive" onClick={() => archiveItem(item)}>
                          <Archive />
                        </button>
                      )}
                      <button className="pq-icon-btn danger" title="Remove from queue" onClick={() => openDeleteModal(item)}>
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
                          return (() => {
                              const logEntry = (publishLog[item.id] || []).find(l => l.channel === ch);
                              const liveStatus = logEntry?.live_status;
                              const isPublished = liveStatus === 'published' || (!logEntry && result?.status === 'published');
                              const chipClass = (() => {
                                if (!logEntry) {
                                  if (result?.status === 'published') return 'published';
                                  if (result?.status === 'error') return 'error';
                                  return '';
                                }
                                if (logEntry.live_status === 'published') return 'published';
                                if (logEntry.live_status === 'deleted') return 'published-deleted';
                                if (logEntry.live_status === 'unknown') return 'published-deleted';
                                if (logEntry.live_status === 'error') return 'error';
                                if (result?.status === 'error') return 'error';
                                return result?.status === 'published' ? 'published' : '';
                              })();

                              // Published + has URL → non-interactive link to the live post
                              if (isPublished && result?.url) {
                                return (
                                  <a
                                    key={ch}
                                    href={result.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={`pq-chip published`}
                                    style={{ '--chip-color': def?.color } as React.CSSProperties}
                                    title={`View on ${def?.label || ch}`}
                                  >
                                    {def?.label || ch} <ExternalLink />
                                  </a>
                                );
                              }

                              // Not published → toggle button for channel selection
                              return (
                                <button
                                  key={ch}
                                  className={`pq-chip ${isSelected ? 'selected' : ''} ${chipClass}`}
                                  style={{ '--chip-color': def?.color } as React.CSSProperties}
                                  onClick={() => toggleChannel(item.id, ch)}
                                  title={result ? `${result.status}${result.url ? ': ' + result.url : result.error ? ': ' + result.error : ''}` : ''}
                                >
                                  {def?.label || ch}
                                </button>
                              );
                          })();
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
                        <div className="pq-datetime-wrap">
                          <input
                            type="datetime-local"
                            className="pq-datetime-input"
                            value={scheduleDate[item.id] || ''}
                            onChange={e => setScheduleDate(prev => ({ ...prev, [item.id]: e.target.value }))}
                          />
                          <span className="pq-datetime-tz">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
                        </div>
                        <button
                          className="pq-schedule-btn"
                          onClick={() => handleSchedule(item)}
                          disabled={isScheduling || !scheduleDate[item.id]}
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
                      {Object.entries(results).filter(([ch]) => !ch.startsWith('__')).map(([ch, res]) => {
                        const log = (publishLog[item.id] || []).find(l => l.channel === ch);
                        // Prefer publish log live_status (most accurate) over publish result status
                        // If log says deleted, show deleted regardless of publish_results JSONB
                        const liveStatus = log?.live_status ?? (res.status === 'published' ? 'published' : res.status);
                        const isDeleted = liveStatus === 'deleted';
                        const isUnknown = liveStatus === 'unknown';
                        const repKey = `${item.id}:${ch}`;
                        return (
                        <div key={ch} className={`pq-result-row result-${liveStatus}`}>
                          <span className="pq-result-channel">{CHANNEL_LABELS[ch]?.label || ch}</span>
                          <span className={`pq-result-status live-${liveStatus}`}>
                            {isDeleted ? '🗑 Deleted' : isUnknown ? '⚠ Unknown' : '✓ Live'}
                          </span>
                          {res.url && !isDeleted && !isUnknown && (
                            <a href={res.url} target="_blank" rel="noreferrer" className="pq-result-url">
                              View post <ExternalLink />
                            </a>
                          )}
                          {!isDeleted && !isUnknown && (() => {
                            const bSlug = (item.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
                            const aSlug = (item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
                            const cSlug = (item.campaign_name || 'forge-content').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
                            const bs = brandSettings[item.brand_profile_id];
                            const base = bs?.article_base_url?.trim()
                              ? bs.article_base_url.replace(/\/+$/, '')
                              : `https://${window.location.hostname}/articles/${bSlug}`;
                            const suffix = (bs?.article_url_suffix || '').trim();
                            const utmUrl = `${base}/${aSlug}${suffix}?utm_source=${ch}&utm_medium=social&utm_campaign=${cSlug}&utm_content=${aSlug}`;
                            return (
                              <button
                                className="pq-utm-copy-btn"
                                title="Copy UTM link"
                                onClick={() => { navigator.clipboard.writeText(utmUrl); }}
                              >
                                UTM
                              </button>
                            );
                          })()}
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
                          {(res.status === 'error' || liveStatus === 'error') && (
                            <button
                              className="pq-retry-btn"
                              onClick={() => handleRetry(item.id, ch)}
                              disabled={republishing === repKey}
                              title="Clear error and retry"
                            >
                              {republishing === repKey ? 'Resetting...' : '↺ Reset & Retry'}
                            </button>
                          )}
                          {res.error && liveStatus !== 'error' && liveStatus !== 'published' && <span className="pq-result-error">{res.error}</span>}
                          {res.message && liveStatus !== 'published' && !res.skipped && <span className="pq-result-msg">{res.message}</span>}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
                        })} {/* week items */}
                      </div>
                    </div>
                  ))} {/* weeks */}
                </div>
              );
            })} {/* campaign groups */}

            {/* Standalone articles */}
            {standaloneItems.length > 0 && (
              <>
                {Object.keys(campaignGroups).length > 0 && (
                  <div className="pq-standalone-label">Standalone Articles</div>
                )}
                {standaloneItems.map(item => {
                  const availChannels = connectedChannels[item.brand_profile_id] || [];
                  const sel = selectedChannels[item.id] || [];
                  const isPublishing = publishing === item.id;
                  const isScheduling = scheduling === item.id;
                  const results = item.publish_results || {};
return (
                <div key={item.id} className={`pq-item status-${item.status}`}>
                  {item.week_number != null && (
                    <div className="pq-campaign-meta-row">
                      <span className="pq-campaign-meta-week">Wk {item.week_number}{item.scheduled_at ? ` · ${new Date(item.scheduled_at).toLocaleDateString('en-US', { weekday: 'long' })}` : item.publish_day ? ` · ${item.publish_day}` : ''}</span>
                      {item.content_type && <span className="pq-campaign-meta-type">{item.content_type}</span>}
                      {item.funnel_position && <span className={`pq-campaign-meta-funnel funnel-${(item.funnel_position||'').toLowerCase()}`}>{item.funnel_position}</span>}
                    </div>
                  )}
                  {/* Row top: title + meta + status */}
                  <div className="pq-item-top">
                    <div className="pq-item-meta">
                      {editingTitleId === item.id ? (
                        <input
                          className="pq-title-edit-input"
                          value={editingTitleVal}
                          onChange={e => setEditingTitleVal(e.target.value)}
                          onBlur={() => saveTitle(item)}
                          onKeyDown={e => { if (e.key === 'Enter') saveTitle(item); if (e.key === 'Escape') setEditingTitleId(null); }}
                          autoFocus
                        />
                      ) : (
                        <div
                          className="pq-item-title pq-item-title-editable"
                          title="Click to edit title"
                          onClick={() => { setEditingTitleId(item.id); setEditingTitleVal(item.title || ''); }}
                        >
                          {item.title || 'Untitled Article'}
                          <span className="pq-title-edit-hint">✎</span>
                        </div>
                      )}
                      <div className="pq-item-sub">
                        <span className="pq-brand-tag">{brandName(item)}</span>
                        <span className="pq-dot">·</span>
                        <span className="pq-date">{
                          item.scheduled_at && item.status !== 'staged'
                            ? `${item.status === 'published' || item.status === 'partial' ? 'Published' : 'Scheduled'} ${new Date(item.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${new Date(item.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                            : `Generated ${new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                        }</span>
                      </div>
                    </div>
                    {(() => {
                      const ps = precogScores[item.content_id];
                      if (!ps) return null;
                      if (ps.tier === 'insufficient_data') return (
                        <div className="pq-precog-badge pq-precog-insufficient" title="Not enough analytics data yet to score this article">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          No data yet
                        </div>
                      );
                      return (
                        <div className="pq-precog-badge" style={{ '--precog-color': ps.color } as React.CSSProperties}
                          title={ps.prediction + (ps.recommendedActions?.length ? '\n\nSuggested: ' + ps.recommendedActions[0] : '')}>
                          <span className="pq-precog-dot" />
                          <span className="pq-precog-score">{ps.score}</span>
                          <span className="pq-precog-label">Pre-cog</span>
                        </div>
                      );
                    })()}
                    <div className="pq-item-actions-top">

                      <button className="pq-icon-btn" title="Smart Export" onClick={() => openExportModal(item)}>
                        <Download />
                      </button>
                      <button className="pq-icon-btn" title="Preview & Edit Post" onClick={() => openContentPreview(item)}>
                        <Eye />
                      </button>

                      <div style={{ position: 'relative' }}>
                        <button className="pq-icon-btn" title="Send for Review"
                          onClick={() => setReviewDropdown(reviewDropdown === item.id ? null : item.id)}>
                          <Share />
                        </button>
                        {reviewDropdown === item.id && (
                          <div className="pq-reviewer-dropdown">
                            <div className="pq-reviewer-dropdown-title">Send for Review</div>
                            {reviewers.length === 0 ? (
                              <div className="pq-reviewer-empty">No reviewers — add them in Admin</div>
                            ) : reviewers.map(rv => (
                              <button key={rv.id} className="pq-reviewer-option"
                                onClick={() => sendForReview(item, rv.id)}>
                                <span className="pq-reviewer-avatar">{rv.name[0].toUpperCase()}</span>
                                <span>
                                  <div className="pq-reviewer-rname">{rv.name}</div>
                                  {rv.title && <div className="pq-reviewer-rtitle">{rv.title}</div>}
                                </span>
                              </button>
                            ))}
                            <div className="pq-reviewer-divider" />
                            <button className="pq-reviewer-option pq-reviewer-link-only"
                              onClick={() => sendForReview(item)}>
                              <span className="pq-reviewer-avatar"><Link2 /></span>
                              <span><div className="pq-reviewer-rname">Copy link only</div></span>
                            </button>
                          </div>
                        )}
                      </div>
                      {item.status === 'archived' ? (
                        <button className="pq-icon-btn" title="Unarchive — restore to queue" onClick={() => unarchiveItem(item)} style={{ color: '#10b981' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      ) : (
                        <button className="pq-icon-btn" title="Archive" onClick={() => archiveItem(item)}>
                          <Archive />
                        </button>
                      )}
                      <button className="pq-icon-btn danger" title="Remove from queue" onClick={() => openDeleteModal(item)}>
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
                          return (() => {
                              const logEntry = (publishLog[item.id] || []).find(l => l.channel === ch);
                              const liveStatus = logEntry?.live_status;
                              const isPublished = liveStatus === 'published' || (!logEntry && result?.status === 'published');
                              const chipClass = (() => {
                                if (!logEntry) {
                                  if (result?.status === 'published') return 'published';
                                  if (result?.status === 'error') return 'error';
                                  return '';
                                }
                                if (logEntry.live_status === 'published') return 'published';
                                if (logEntry.live_status === 'deleted') return 'published-deleted';
                                if (logEntry.live_status === 'unknown') return 'published-deleted';
                                if (logEntry.live_status === 'error') return 'error';
                                if (result?.status === 'error') return 'error';
                                return result?.status === 'published' ? 'published' : '';
                              })();

                              // Published + has URL → non-interactive link to the live post
                              if (isPublished && result?.url) {
                                return (
                                  <a
                                    key={ch}
                                    href={result.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={`pq-chip published`}
                                    style={{ '--chip-color': def?.color } as React.CSSProperties}
                                    title={`View on ${def?.label || ch}`}
                                  >
                                    {def?.label || ch} <ExternalLink />
                                  </a>
                                );
                              }

                              // Not published → toggle button for channel selection
                              return (
                                <button
                                  key={ch}
                                  className={`pq-chip ${isSelected ? 'selected' : ''} ${chipClass}`}
                                  style={{ '--chip-color': def?.color } as React.CSSProperties}
                                  onClick={() => toggleChannel(item.id, ch)}
                                  title={result ? `${result.status}${result.url ? ': ' + result.url : result.error ? ': ' + result.error : ''}` : ''}
                                >
                                  {def?.label || ch}
                                </button>
                              );
                          })();
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
                        <div className="pq-datetime-wrap">
                          <input
                            type="datetime-local"
                            className="pq-datetime-input"
                            value={scheduleDate[item.id] || ''}
                            onChange={e => setScheduleDate(prev => ({ ...prev, [item.id]: e.target.value }))}
                          />
                          <span className="pq-datetime-tz">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
                        </div>
                        <button
                          className="pq-schedule-btn"
                          onClick={() => handleSchedule(item)}
                          disabled={isScheduling || !scheduleDate[item.id]}
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
                      {Object.entries(results).filter(([ch]) => !ch.startsWith('__')).map(([ch, res]) => {
                        const log = (publishLog[item.id] || []).find(l => l.channel === ch);
                        // Prefer publish log live_status (most accurate) over publish result status
                        // If log says deleted, show deleted regardless of publish_results JSONB
                        const liveStatus = log?.live_status ?? (res.status === 'published' ? 'published' : res.status);
                        const isDeleted = liveStatus === 'deleted';
                        const isUnknown = liveStatus === 'unknown';
                        const repKey = `${item.id}:${ch}`;
                        return (
                        <div key={ch} className={`pq-result-row result-${liveStatus}`}>
                          <span className="pq-result-channel">{CHANNEL_LABELS[ch]?.label || ch}</span>
                          <span className={`pq-result-status live-${liveStatus}`}>
                            {isDeleted ? '🗑 Deleted' : isUnknown ? '⚠ Unknown' : '✓ Live'}
                          </span>
                          {res.url && !isDeleted && !isUnknown && (
                            <a href={res.url} target="_blank" rel="noreferrer" className="pq-result-url">
                              View post <ExternalLink />
                            </a>
                          )}
                          {!isDeleted && !isUnknown && (() => {
                            const bSlug = (item.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
                            const aSlug = (item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
                            const cSlug = (item.campaign_name || 'forge-content').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
                            const bs = brandSettings[item.brand_profile_id];
                            const base = bs?.article_base_url?.trim()
                              ? bs.article_base_url.replace(/\/+$/, '')
                              : `https://${window.location.hostname}/articles/${bSlug}`;
                            const suffix = (bs?.article_url_suffix || '').trim();
                            const utmUrl = `${base}/${aSlug}${suffix}?utm_source=${ch}&utm_medium=social&utm_campaign=${cSlug}&utm_content=${aSlug}`;
                            return (
                              <button
                                className="pq-utm-copy-btn"
                                title="Copy UTM link"
                                onClick={() => { navigator.clipboard.writeText(utmUrl); }}
                              >
                                UTM
                              </button>
                            );
                          })()}
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
                          {(res.status === 'error' || liveStatus === 'error') && (
                            <button
                              className="pq-retry-btn"
                              onClick={() => handleRetry(item.id, ch)}
                              disabled={republishing === repKey}
                              title="Clear error and retry"
                            >
                              {republishing === repKey ? 'Resetting...' : '↺ Reset & Retry'}
                            </button>
                          )}
                          {res.error && liveStatus !== 'error' && liveStatus !== 'published' && <span className="pq-result-error">{res.error}</span>}
                          {res.message && liveStatus !== 'published' && !res.skipped && <span className="pq-result-msg">{res.message}</span>}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );

                })} {/* standalone items */}
              </>
            )}
          </div>
        )}
      </div>


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

              {/* Editing hint — route back to Compliance Gate for deeper edits */}
              <div className="pq-modal-edit-hint" style={{
                padding: '10px 20px',
                background: 'rgba(59, 130, 246, 0.06)',
                borderBottom: '1px solid rgba(59, 130, 246, 0.15)',
                fontSize: 12,
                color: '#475569',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12
              }}>
                <span>
                  <span style={{ marginRight: 6 }}>💡</span>
                  Need more than quick edits? The Compliance Gate has Forge's full context, the AI rewrite toolbar, and flagged-section guidance.
                </span>
                <button
                  onClick={() => { setContentPreview(null); window.location.href = `/app/compliance-gate?contentId=${item.content_id || item.id}&brandId=${item.brand_profile_id}`; }}
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    background: '#3B82F6',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                >Open Compliance Gate →</button>
              </div>

              <div className="pq-preview-layout">
                {/* Left: article preview */}
                <div className="pq-preview-article">
                  {heroImageUrl ? (
                    <div className="pq-preview-hero-wrap">
                      <img src={heroImageUrl} alt={item.title} className="pq-preview-hero" />
                      <button
                        className="pq-regen-image-overlay-btn"
                        disabled={generatingImage}
                        onClick={async () => {
                          setGeneratingImage(true);
                          try {
                            const r = await fetch(`/api/content/regenerate-image/${item.content_id}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', ...ah },
                              body: JSON.stringify({ brandProfileId: item.brand_profile_id })
                            });
                            const d = await r.json();
                            if (d.imageUrl) setContentPreview(prev => prev ? { ...prev, article: { ...prev.article, hero_image_url: d.imageUrl } } : null);
                          } finally { setGeneratingImage(false); }
                        }}
                      >{generatingImage ? <span className="pq-spin">↺</span> : '↺'} {generatingImage ? 'Generating...' : 'Regenerate Image'}</button>
                    </div>
                  ) : (
                    <div className="pq-preview-no-image">
                      <span>No hero image generated</span>
                      <button
                        className="pq-regen-image-btn"
                        disabled={generatingImage}
                        onClick={async () => {
                          setGeneratingImage(true);
                          try {
                            const r = await fetch(`/api/content/regenerate-image/${item.content_id}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', ...ah },
                              body: JSON.stringify({ brandProfileId: item.brand_profile_id })
                            });
                            const d = await r.json();
                            if (d.imageUrl) setContentPreview(prev => prev ? { ...prev, article: { ...prev.article, hero_image_url: d.imageUrl } } : null);
                          } finally { setGeneratingImage(false); }
                        }}
                      >{generatingImage ? <span className="pq-spin">↺</span> : '↺'} {generatingImage ? 'Generating...' : 'Generate Image'}</button>
                    </div>
                  )}
                  {editingField === 'title' ? (
                    <textarea
                      className="pq-edit-inline pq-edit-title"
                      defaultValue={article?.title || item.title}
                      autoFocus
                      rows={2}
                      onBlur={e => saveArticleEdit('title', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveArticleEdit('title', (e.target as HTMLTextAreaElement).value); } if (e.key === 'Escape') setEditingField(null); }}
                    />
                  ) : (
                    <h1 className="pq-preview-title pq-editable" onClick={() => setEditingField('title')} title="Click to edit">
                      {article?.title || item.title}
                      <span className="pq-edit-hint">✎</span>
                    </h1>
                  )}
                  {article?.article_json?.metaDescription !== undefined && (
                    editingField === 'metaDescription' ? (
                      <textarea
                        className="pq-edit-inline pq-edit-meta"
                        defaultValue={article.article_json.metaDescription}
                        autoFocus
                        rows={3}
                        onBlur={e => saveArticleEdit('metaDescription', e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); }}
                      />
                    ) : (
                      <p className="pq-preview-meta-desc pq-editable" onClick={() => setEditingField('metaDescription')} title="Click to edit">
                        {article.article_json.metaDescription}
                        <span className="pq-edit-hint">✎</span>
                      </p>
                    )
                  )}
                  <div className="pq-preview-sections">
                    {sections.map((s: any, i: number) => (
                      <div key={i} className="pq-preview-section">
                        {s.heading && (
                          editingField === `heading-${i}` ? (
                            <textarea
                              className="pq-edit-inline pq-edit-heading"
                              defaultValue={s.heading}
                              autoFocus
                              rows={2}
                              onBlur={e => saveArticleEdit('sectionHeading', e.target.value, i)}
                              onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); }}
                            />
                          ) : (
                            <h2 className="pq-preview-heading pq-editable" onClick={() => setEditingField(`heading-${i}`)} title="Click to edit">
                              {s.heading}<span className="pq-edit-hint">✎</span>
                            </h2>
                          )
                        )}
                        {editingField === `body-${i}` ? (
                          <textarea
                            className="pq-edit-inline pq-edit-body"
                            defaultValue={s.body || s.content || ''}
                            autoFocus
                            rows={8}
                            onBlur={e => saveArticleEdit('sectionBody', e.target.value, i)}
                            onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); }}
                          />
                        ) : (
                          <div className="pq-editable pq-editable-body" onClick={() => setEditingField(`body-${i}`)} title="Click to edit">
                            <>{renderMarkdown(s.body || s.content || '')}</>
                            <span className="pq-edit-hint pq-edit-hint-body">✎ Edit</span>
                          </div>
                        )}
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
                          <button
                            className="pq-copy-btn"
                            onClick={() => { navigator.clipboard.writeText(postCopy[ch] || ''); setSuccessMsg('Copied!'); setTimeout(() => setSuccessMsg(''), 2000); }}
                            title="Copy to clipboard"
                          >
                            <Copy size={13} /> Copy
                          </button>
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
                            headers: { 'Content-Type': 'application/json', ...ah },
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

    {/* ── Delete / Unpublish Modal ── */}
    {deleteModal && (
      <div className="pq-modal-overlay" onClick={() => !deleting && setDeleteModal(null)}>
        <div className="pq-modal pq-delete-modal" onClick={e => e.stopPropagation()}>
          <div className="pq-modal-header">
            <h3 className="pq-modal-title">Remove article</h3>
            <button className="pq-modal-close" onClick={() => !deleting && setDeleteModal(null)}>✕</button>
          </div>

          <div className="pq-delete-article-title">{deleteModal.item.title}</div>

          {deleteModal.publishedChannels.length > 0 ? (
            <>
              <p className="pq-delete-desc">Select which live channels to unpublish from, then choose what to do in Forge.</p>

              {/* Per-channel checkboxes */}
              <div className="pq-delete-channel-list">
                {deleteModal.publishedChannels.map(ch => (
                  <label key={ch} className="pq-delete-channel-row">
                    <input
                      type="checkbox"
                      className="pq-delete-checkbox"
                      checked={!!deleteChannelSelection[ch]}
                      disabled={deleting}
                      onChange={e => setDeleteChannelSelection(prev => ({ ...prev, [ch]: e.target.checked }))}
                    />
                    <span className="pq-delete-channel-name" style={{ color: CHANNEL_LABELS[ch]?.color || 'inherit' }}>
                      {CHANNEL_LABELS[ch]?.label || ch}
                    </span>
                    <span className="pq-delete-channel-status">
                      {(publishLog[deleteModal.item.id]||[]).find(l=>l.channel===ch)?.live_status === 'published' ? 'Live' : 'Error / Stale'}
                    </span>
                  </label>
                ))}
              </div>

              <div className="pq-delete-actions">
                <button
                  className="pq-delete-option-btn full"
                  onClick={() => handleUnpublish(true)}
                  disabled={deleting}
                >
                  <span className="pq-delete-option-icon">🗑</span>
                  <div>
                    <div className="pq-delete-option-label">
                      {Object.values(deleteChannelSelection).some(Boolean)
                        ? `Unpublish selected + remove from Forge`
                        : 'Remove from Forge only'}
                    </div>
                    <div className="pq-delete-option-sub">
                      {Object.values(deleteChannelSelection).some(Boolean)
                        ? 'Deletes checked live posts and clears from queue'
                        : 'All live posts stay up — only clears from queue'}
                    </div>
                  </div>
                </button>
                <button
                  className="pq-delete-option-btn forge-only"
                  onClick={() => handleUnpublish(false)}
                  disabled={deleting}
                >
                  <span className="pq-delete-option-icon">📋</span>
                  <div>
                    <div className="pq-delete-option-label">
                      {Object.values(deleteChannelSelection).some(Boolean)
                        ? 'Unpublish selected — keep in Forge'
                        : 'No action'}
                    </div>
                    <div className="pq-delete-option-sub">
                      {Object.values(deleteChannelSelection).some(Boolean)
                        ? 'Removes checked live posts but keeps article in queue as staged'
                        : 'Uncheck channels above to unpublish without removing from Forge'}
                    </div>
                  </div>
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="pq-delete-desc">This article has not been published to any channels yet.</p>
              <div className="pq-delete-actions">
                <button
                  className="pq-delete-option-btn full"
                  onClick={() => handleUnpublish(true)}
                  disabled={deleting}
                >
                  <span className="pq-delete-option-icon">🗑</span>
                  <div>
                    <div className="pq-delete-option-label">Remove from queue</div>
                    <div className="pq-delete-option-sub">Clears the article from Forge</div>
                  </div>
                </button>
              </div>
            </>
          )}

          {deleting && <div className="pq-delete-loading">Working…</div>}

          <button className="pq-delete-cancel" onClick={() => !deleting && setDeleteModal(null)} disabled={deleting}>
            Cancel
          </button>
        </div>
      </div>
    )}

    {/* ── Smart Export Modal ── */}
    {exportModal && (() => {
      const { item, article } = exportModal;
      const exportUrl = buildExportUrl(item, article, exportModal.brandSettingsData);
      const campaignSlug = item.campaign_name
        ? item.campaign_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
        : 'forge-content';
      const contentSlug = (item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const tabs: { key: 'html'|'markdown'|'json'|'link'; label: string }[] = [
        { key: 'html',     label: 'HTML' },
        { key: 'markdown', label: 'Markdown' },
        { key: 'json',     label: 'JSON' },
        { key: 'link',     label: 'UTM Link' },
      ];
      const customUtmUrl = (customUtmBase.trim() ? customUtmBase.trim().replace(/[?#].*$/, '') : exportUrl) + `?utm_source=export&utm_medium=byo&utm_campaign=${campaignSlug}&utm_content=${contentSlug}`;
      const exportContent = {
        html:     buildHTML(article, item),
        markdown: buildMarkdown(article, item),
        json:     buildJSON(article, item),
        link:     customUtmUrl,
      }[exportTab];

      return (
        <div className="pq-modal-overlay" onClick={() => setExportModal(null)}>
          <div className="pq-modal pq-export-modal" onClick={e => e.stopPropagation()}>
            <div className="pq-modal-header">
              <div>
                <div className="pq-modal-title">Smart Export</div>
                <div className="pq-modal-sub">{item.title}</div>
              </div>
              <button className="pq-modal-close" onClick={() => setExportModal(null)}><X /></button>
            </div>

            {/* Tab-aware pro tip. The right advice differs by format — generic
                'here's how to use the export' copy doesn't help anyone, but a one-line
                hint scoped to what they're actually about to copy does. */}
            <div className="pq-export-protip">
              <span className="pq-export-protip-label">PRO TIP</span>
              <span className="pq-export-protip-text">
                {exportTab === 'html' && (
                  <>Paste the full HTML into your CMS's source/code view (Webflow Embed, WordPress &lt;/&gt; HTML block, Ghost HTML card, Framer Code component). All schema, OG tags, and FAQs travel with it — don't strip the &lt;script&gt; tags or you lose the GEO signals.</>
                )}
                {exportTab === 'json' && (
                  <>This is the article's structured data. Pipe it into a headless CMS via API (Sanity, Contentful, Strapi), feed it to a static site generator, or POST it to your own publishing endpoint. Field names match standard CMS conventions.</>
                )}
                {exportTab === 'markdown' && (
                  <>Drop straight into Notion, Obsidian, Ghost, or any Markdown-native CMS. Headers, lists, and links translate cleanly. For SEO/schema-heavy targets like WordPress or Webflow, use the HTML tab instead — markdown loses the structured data.</>
                )}
                {exportTab === 'link' && (
                  <>One-click ready URLs with UTM tracking pre-baked. Paste directly into LinkedIn, X, your newsletter, or anywhere you'd share a link. Each channel's UTMs come from your saved templates in Integrations.</>
                )}
              </span>
            </div>

            <div className="pq-export-tabs">
              {tabs.map(t => (
                <button
                  key={t.key}
                  className={`pq-export-tab ${exportTab === t.key ? 'active' : ''}`}
                  onClick={() => { setExportTab(t.key); setCopied(''); }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {exportTab === 'link' ? (
              <div className="pq-export-link-wrap">
                <p className="pq-export-link-desc">
                  Ready-to-use UTM links per channel, built from your saved templates in Integrations.
                </p>
                {Object.keys(exportModal?.channelUtms || {}).length === 0 ? (
                  <p className="pq-utm-empty">No channels connected yet. Connect channels in Integrations to generate UTM links.</p>
                ) : (
                  <div className="pq-utm-channel-list">
                    {Object.entries(exportModal?.channelUtms || {}).map(([ch, tmpl]) => {
                      const utmStr = resolveUtmTemplate(tmpl, { campaignSlug, articleSlug: contentSlug, brandSlug: item.brand_profile_id.slice(0,8), channel: ch });
                      const fullUrl = utmStr ? `${exportUrl}?${utmStr}` : exportUrl;
                      return (
                        <div key={ch} className="pq-utm-channel-row">
                          <span className="pq-utm-channel-label" style={{ color: CHANNEL_LABELS[ch]?.color || 'inherit' }}>
                            {CHANNEL_LABELS[ch]?.label || ch}
                          </span>
                          <div className="pq-utm-channel-url">{fullUrl}</div>
                          <button
                            className="pq-utm-copy-btn"
                            onClick={() => handleCopy(fullUrl, `utm-${ch}`)}
                          >
                            {copied === `utm-${ch}` ? '✓' : 'Copy'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="pq-export-code-wrap">
                <pre className="pq-export-code"><code>{exportContent}</code></pre>
              </div>
            )}

            <div className="pq-export-footer">
              <span className="pq-export-base-url">
                Base: {exportUrl}
              </span>
              <button
                className="pq-export-copy-btn"
                onClick={() => handleCopy(exportContent, exportTab)}
              >
                {copied === exportTab ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      );
    })()}

      {/* Campaign Scheduler Modal */}
      {campaignScheduler && (() => {
        const { name, items, startDate, publishTime } = campaignScheduler;
        const livePreview = startDate && publishTime ? buildSchedulePreview(items, startDate, publishTime) : [];
        return (
          <div className="pq-modal-overlay" onClick={() => setCampaignScheduler(null)}>
            <div className="pq-modal pq-campaign-sched-modal" onClick={e => e.stopPropagation()}>
              <div className="pq-modal-header">
                <div>
                  <div className="pq-modal-title">Schedule Campaign</div>
                  <div className="pq-modal-sub">{name} · {items.filter(i => i.week_number).length} articles</div>
                </div>
                <button className="pq-modal-close" onClick={() => setCampaignScheduler(null)}><X /></button>
              </div>
              <div className="pq-sched-body">
                <div className="pq-sched-inputs">
                  <div className="pq-sched-field">
                    <label className="pq-sched-label">Campaign Start Date</label>
                    <input
                      type="date"
                      className="pq-sched-input"
                      value={startDate}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={e => setCampaignScheduler(prev => prev ? { ...prev, startDate: e.target.value } : null)}
                    />
                    <span className="pq-sched-hint">Week 1 articles publish relative to this date</span>
                  </div>
                  <div className="pq-sched-field">
                    <label className="pq-sched-label">Publish Time</label>
                    <input
                      type="time"
                      className="pq-sched-input"
                      value={publishTime}
                      onChange={e => setCampaignScheduler(prev => prev ? { ...prev, publishTime: e.target.value } : null)}
                    />
                    <span className="pq-sched-hint">Applied to all articles</span>
                  </div>
                  <div className="pq-sched-field">
                    <label className="pq-sched-label">Publish Channels</label>
                    <div className="pq-channel-checkboxes">
                      {(connectedChannels[items[0]?.brand_profile_id] || []).map(ch => (
                        <label key={ch} className={`pq-channel-checkbox ${schedCampaignChannels.includes(ch) ? 'checked' : ''}`}>
                          <input
                            type="checkbox"
                            checked={schedCampaignChannels.includes(ch)}
                            onChange={e => {
                              if (e.target.checked) setSchedCampaignChannels(prev => [...prev, ch]);
                              else setSchedCampaignChannels(prev => prev.filter(c => c !== ch));
                            }}
                          />
                          {ch.charAt(0).toUpperCase() + ch.slice(1)}
                        </label>
                      ))}
                    </div>
                    <span className="pq-sched-hint">{schedCampaignChannels.length ? `${schedCampaignChannels.length} channel${schedCampaignChannels.length > 1 ? 's' : ''} selected` : 'Select channels to publish to'}</span>
                  </div>
                </div>
                {livePreview.length > 0 ? (
                  <div className="pq-sched-preview">
                    <div className="pq-sched-preview-label">Schedule Preview</div>
                    <div className="pq-sched-preview-list">
                      {livePreview.map(p => (
                        <div key={p.id} className="pq-sched-preview-row">
                          <span className="pq-sched-preview-week">Wk {p.week} · {p.day}</span>
                          <span className="pq-sched-preview-article">{p.title.length > 52 ? p.title.slice(0, 52) + '…' : p.title}</span>
                          <span className="pq-sched-preview-date">
                            {new Date(p.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {new Date(p.scheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="pq-sched-empty">Pick a start date to preview the full schedule ↑</div>
                )}
              </div>
              <div className="pq-sched-footer">
                <button className="pq-cancel-btn" onClick={() => setCampaignScheduler(null)}>Cancel</button>
                <button
                  className="pq-publish-now-btn"
                  disabled={!startDate || livePreview.length === 0 || !schedCampaignChannels.length}
                  onClick={scheduleCampaign}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:6}}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  Schedule {livePreview.length} Articles
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}
