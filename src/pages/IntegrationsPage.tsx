import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './IntegrationsPage.css';

// ── Icons ────────────────────────────────────────────────────────────────────
const CheckCircle = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
);
const Unlink = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="2" y1="2" x2="22" y2="22"/>
  </svg>
);
const ChevronDown = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);
const ChevronUp = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15"/>
  </svg>
);

// ── Channel definitions ───────────────────────────────────────────────────────
type ChannelId = 'wordpress' | 'webflow' | 'hubspot' | 'linkedin' | 'x';

interface ChannelDef {
  id: ChannelId;
  label: string;
  description: string;
  color: string;
  logo: string;
  credentialFields: { key: string; label: string; placeholder: string; type?: string }[];
  liveStatus: 'live' | 'staged';
}

const CHANNELS: ChannelDef[] = [
  {
    id: 'wordpress',
    label: 'WordPress',
    description: 'Publish full articles via WP REST API. Requires Application Password.',
    color: '#3858E9',
    logo: 'WP',
    liveStatus: 'live',
    credentialFields: [
      { key: 'siteUrl', label: 'Site URL', placeholder: 'https://yoursite.com' },
      { key: 'username', label: 'Username', placeholder: 'admin' },
      { key: 'appPassword', label: 'Application Password', placeholder: 'xxxx xxxx xxxx xxxx', type: 'password' },
    ],
  },
  {
    id: 'webflow',
    label: 'Webflow',
    description: 'Create CMS items via Webflow Data API. Live publish in Stage 6.1.',
    color: '#4353FF',
    logo: 'WF',
    liveStatus: 'staged',
    credentialFields: [
      { key: 'apiToken', label: 'API Token', placeholder: 'eyJhbGci...', type: 'password' },
      { key: 'siteId', label: 'Site ID', placeholder: '5f4d...' },
      { key: 'collectionId', label: 'Collection ID', placeholder: 'Blog Posts collection ID' },
    ],
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    description: 'Contact tracking + campaign attribution. Connects published article UTMs to HubSpot contacts. Not a publishing destination.',
    color: '#FF7A59',
    logo: 'HS',
    liveStatus: 'staged',
    credentialFields: [
      { key: 'accessToken', label: 'Private App Token', placeholder: 'pat-na2-...', type: 'password' },
      { key: 'portalId', label: 'Portal ID', placeholder: '244954048' },
    ],
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Share articles to your LinkedIn profile via OAuth2. Click Connect to authorize Forge — no manual token needed.',
    color: '#0A66C2',
    logo: 'in',
    liveStatus: 'live',
    credentialFields: [
      { key: 'accessToken', label: 'OAuth Access Token', placeholder: 'Auto-filled after OAuth', type: 'password' },
      { key: 'authorUrn', label: 'Author URN', placeholder: 'Auto-filled after OAuth' },
    ],
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    description: 'Post excerpts with UTM-tagged links via X API v2. Live in Stage 6.1.',
    color: '#000000',
    logo: '𝕏',
    liveStatus: 'staged',
    credentialFields: [
      { key: 'apiKey', label: 'API Key', placeholder: '...', type: 'password' },
      { key: 'apiSecret', label: 'API Secret', placeholder: '...', type: 'password' },
      { key: 'accessToken', label: 'Access Token', placeholder: '...', type: 'password' },
      { key: 'accessSecret', label: 'Access Token Secret', placeholder: '...', type: 'password' },
    ],
  },
];

const DEFAULT_UTM: Record<ChannelId, Record<string, string>> = {
  wordpress: { utm_source: 'forge', utm_medium: 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  webflow:   { utm_source: 'forge', utm_medium: 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  hubspot:   { utm_source: 'hubspot', utm_medium: 'attribution', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  linkedin:  { utm_source: 'linkedin', utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  x:         { utm_source: 'x', utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
};

// ── Types ────────────────────────────────────────────────────────────────────
interface SavedChannel {
  id: string;
  channel: ChannelId;
  utm_template: Record<string, string>;
  test_status: string;
  last_tested_at: string | null;
  updated_at: string;
}

interface Brain { id: string; brandName?: string; brandUrl?: string; }

export default function IntegrationsPage() {
  const [brands, setBrands] = useState<Brain[]>([]);
  const [selectedBrand, setSelectedBrand] = useState('');
  const [savedChannels, setSavedChannels] = useState<Record<ChannelId, SavedChannel | null>>({
    wordpress: null, webflow: null, hubspot: null, linkedin: null, x: null
  });
  const [expanded, setExpanded] = useState<ChannelId | null>(null);
  const [credentials, setCredentials] = useState<Record<ChannelId, Record<string, string>>>({
    wordpress: {}, webflow: {}, hubspot: {}, linkedin: {}, x: {}
  });
  const [utmTemplates, setUtmTemplates] = useState<Record<ChannelId, Record<string, string>>>(DEFAULT_UTM);
  const [saving, setSaving] = useState<ChannelId | null>(null);
  const [disconnecting, setDisconnecting] = useState<ChannelId | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetch('/api/context-hub/brains').then(r => r.json()).then(d => {
      if (d.success) setBrands(d.data || []);
    });
  }, []);

  useEffect(() => {
    if (!selectedBrand) return;
    fetch(`/api/publishing/channels/${selectedBrand}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const map: Record<ChannelId, SavedChannel | null> = {
            wordpress: null, webflow: null, hubspot: null, linkedin: null, x: null
          };
          for (const ch of d.channels) map[ch.channel as ChannelId] = ch;
          setSavedChannels(map);
          // Pre-fill UTM templates from saved data
          const newUtm = { ...DEFAULT_UTM };
          for (const ch of d.channels) {
            if (ch.utm_template && Object.keys(ch.utm_template).length > 0) {
              newUtm[ch.channel as ChannelId] = ch.utm_template;
            }
          }
          setUtmTemplates(newUtm);
        }
      });
  }, [selectedBrand]);

  const handleSave = async (channelId: ChannelId) => {
    // LinkedIn uses OAuth2 — redirect instead of credential form
    if (channelId === 'linkedin') {
      try {
        const res = await fetch('/api/linkedin/auth');
        const { authUrl } = await res.json();
        window.location.href = authUrl;
      } catch (e) {
        setError('Could not start LinkedIn authorization. Try again.');
      }
      return;
    }
    if (!selectedBrand) { setError('Select a Brain first'); return; }
    setSaving(channelId);
    setError(''); setSuccess('');
    try {
      const r = await fetch('/api/publishing/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandProfileId: selectedBrand,
          channel: channelId,
          credentials: credentials[channelId],
          utmTemplate: utmTemplates[channelId],
        })
      });
      const d = await r.json();
      if (d.success) {
        setSuccess(`${CHANNELS.find(c => c.id === channelId)?.label} connected successfully`);
        // Refresh saved channels
        const refresh = await fetch(`/api/publishing/channels/${selectedBrand}`).then(r => r.json());
        if (refresh.success) {
          const map: Record<ChannelId, SavedChannel | null> = {
            wordpress: null, webflow: null, hubspot: null, linkedin: null, x: null
          };
          for (const ch of refresh.channels) map[ch.channel as ChannelId] = ch;
          setSavedChannels(map);
        }
        setExpanded(null);
        setTimeout(() => setSuccess(''), 3000);
      } else {
        setError(d.error || 'Save failed');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setSaving(null);
    }
  };

  const handleDisconnect = async (channelId: ChannelId) => {
    const saved = savedChannels[channelId];
    if (!saved) return;
    setDisconnecting(channelId);
    try {
      await fetch(`/api/publishing/channels/${saved.id}`, { method: 'DELETE' });
      setSavedChannels(prev => ({ ...prev, [channelId]: null }));
      setCredentials(prev => ({ ...prev, [channelId]: {} }));
      setSuccess('');
    } finally {
      setDisconnecting(null);
    }
  };

  const isConnected = (id: ChannelId) => !!savedChannels[id];

  return (
    <AppShell pageTitle="Integrations">
      <div className="int-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Stage 6</div>
            <h1 className="geo-title">Integrations</h1>
            <p className="geo-description">Connect publishing channels per Brain. Credentials are isolated per brand — no cross-tenant leakage.</p>
          </div>
        </div>

        {/* Brain selector */}
        <div className="int-brain-bar">
          <select
            className="geo-select"
            value={selectedBrand}
            onChange={e => setSelectedBrand(e.target.value)}
          >
            <option value="">Select a Brain to configure...</option>
            {brands.map(b => (
              <option key={b.id} value={b.id}>{b.brandName || b.brandUrl}</option>
            ))}
          </select>
          {selectedBrand && (
            <div className="int-connected-count">
              {Object.values(savedChannels).filter(Boolean).length} of {CHANNELS.length} channels connected
            </div>
          )}
        </div>

        {error && <div className="geo-error">{error}</div>}
        {success && <div className="int-success">{success}</div>}

        {/* Channel cards */}
        <div className="int-channels">
          {CHANNELS.map(ch => {
            const connected = isConnected(ch.id);
            const isOpen = expanded === ch.id;
            const saved = savedChannels[ch.id];

            return (
              <div key={ch.id} className={`int-channel-card ${connected ? 'connected' : ''}`}>
                {/* Card header */}
                <div className="int-card-header">
                  <div className="int-card-left">
                    <div className="int-logo" style={{ background: ch.color }}>{ch.logo}</div>
                    <div>
                      <div className="int-card-title">
                        {ch.label}
                        {ch.liveStatus === 'staged' && (
                          <span className="int-coming-badge">Stage 6.1</span>
                        )}
                      </div>
                      <div className="int-card-desc">{ch.description}</div>
                    </div>
                  </div>
                  <div className="int-card-right">
                    {connected ? (
                      <div className="int-status-row">
                        <span className="int-status-pill connected"><CheckCircle /> Connected</span>
                        {saved?.updated_at && (
                          <span className="int-last-updated">
                            {new Date(saved.updated_at).toLocaleDateString()}
                          </span>
                        )}
                        <button
                          className="int-disconnect-btn"
                          onClick={() => handleDisconnect(ch.id)}
                          disabled={disconnecting === ch.id}
                        >
                          <Unlink /> {disconnecting === ch.id ? '...' : 'Disconnect'}
                        </button>
                        <button
                          className="int-edit-btn"
                          onClick={() => setExpanded(isOpen ? null : ch.id)}
                        >
                          {isOpen ? <ChevronUp /> : <ChevronDown />}
                        </button>
                      </div>
                    ) : (
                      selectedBrand && (
                        <button
                          className="int-connect-btn"
                          style={{ '--ch-color': ch.color } as React.CSSProperties}
                          onClick={() => setExpanded(isOpen ? null : ch.id)}
                        >
                          {isOpen ? 'Cancel' : 'Connect'}
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Expanded form */}
                {isOpen && (
                  <div className="int-card-form">
                    <div className="int-form-section">
                      <div className="int-form-label">Credentials</div>
                      <div className="int-fields">
                        {ch.credentialFields.map(f => (
                          <div key={f.key} className="int-field">
                            <label className="int-field-label">{f.label}</label>
                            <input
                              className="int-field-input"
                              type={f.type || 'text'}
                              placeholder={f.placeholder}
                              value={credentials[ch.id][f.key] || ''}
                              onChange={e => setCredentials(prev => ({
                                ...prev,
                                [ch.id]: { ...prev[ch.id], [f.key]: e.target.value }
                              }))}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="int-form-section">
                      <div className="int-form-label">
                        UTM Template
                        <span className="int-utm-hint">Tokens: {`{campaign_slug} {article_slug} {brand_slug} {channel}`}</span>
                      </div>
                      <div className="int-utm-grid">
                        {Object.entries(utmTemplates[ch.id]).map(([k, v]) => (
                          <div key={k} className="int-utm-row">
                            <span className="int-utm-key">{k}</span>
                            <input
                              className="int-field-input int-utm-val"
                              value={v}
                              onChange={e => setUtmTemplates(prev => ({
                                ...prev,
                                [ch.id]: { ...prev[ch.id], [k]: e.target.value }
                              }))}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="int-form-footer">
                      <button className="int-cancel-btn" onClick={() => setExpanded(null)}>Cancel</button>
                      <button
                        className="int-save-btn"
                        onClick={() => handleSave(ch.id)}
                        disabled={saving === ch.id}
                      >
                        {saving === ch.id ? 'Saving...' : connected ? 'Update Connection' : `Connect ${ch.label}`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Subscription gate note */}
        <div className="int-gate-note">
          🔒 Channel credentials are encrypted at rest and scoped to this Brain only. Multi-tenant access requires an active subscription.
        </div>
      </div>
    </AppShell>
  );
}
