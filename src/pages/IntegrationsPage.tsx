import { useState, useEffect, useRef } from 'react';
import { AppShell } from '../layouts/AppShell';
import GateModal from '../components/GateModal';
import { useApp } from '../context/AppContext';
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
const HelpIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);
const ExternalLink = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// ── Setup Guide Tooltip ──────────────────────────────────────────────────────
interface SetupStep { text: string; url?: string; code?: string; }
interface SetupGuide { title: string; steps: SetupStep[]; }

function SetupGuide({ guide }: { guide: SetupGuide }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="int-guide-wrap" ref={ref}>
      <button className="int-guide-btn" onClick={() => setOpen(o => !o)} title="Setup guide">
        <HelpIcon /> How to get these
      </button>
      {open && (
        <div className="int-guide-tooltip">
          <div className="int-guide-title">{guide.title}</div>
          <ol className="int-guide-steps">
            {guide.steps.map((step, i) => (
              <li key={i} className="int-guide-step">
                <span>{step.text}</span>
                {step.url && (
                  <a href={step.url} target="_blank" rel="noopener noreferrer" className="int-guide-link">
                    Open <ExternalLink />
                  </a>
                )}
                {step.code && <code className="int-guide-code">{step.code}</code>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── Channel definitions ───────────────────────────────────────────────────────
type ChannelId = 'wordpress' | 'webflow' | 'hubspot' | 'linkedin' | 'x' | 'facebook' | 'medium' | 'ghost';

interface ChannelDef {
  id: ChannelId;
  label: string;
  description: string;
  color: string;
  logo: string;
  credentialFields: { key: string; label: string; placeholder: string; type?: string }[];
  liveStatus: 'live' | 'staged' | 'legacy';
  oauthFlow?: boolean;
  pipedreamApp?: string;
  setupGuide: SetupGuide;
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
    setupGuide: {
      title: 'WordPress Application Password',
      steps: [
        { text: 'Log into your WordPress admin dashboard.' },
        { text: 'Go to Users → Profile (or any user you want to publish as).' },
        { text: 'Scroll down to Application Passwords. Enter a name like "Forge Intelligence" and click Add New.' },
        { text: 'Copy the generated password -- it will only be shown once.' },
        { text: 'Paste your site URL, your WordPress username, and the application password above.' },
      ],
    },
  },
  {
    id: 'webflow',
    label: 'Webflow',
    oauthFlow: true,
    description: 'Publish articles to Webflow CMS collections via OAuth.',
    color: '#4353FF',
    logo: 'WF',
    liveStatus: 'live',
    credentialFields: [
      { key: 'apiToken', label: 'API Token', placeholder: 'eyJhbGci...', type: 'password' },
      { key: 'siteId', label: 'Site ID', placeholder: '5f4d...' },
      { key: 'collectionId', label: 'Collection ID', placeholder: 'Blog Posts collection ID' },
    ],
    setupGuide: {
      title: 'Webflow API Token',
      steps: [
        { text: 'Go to your Webflow dashboard and open your site settings.', url: 'https://webflow.com/dashboard' },
        { text: 'Navigate to Integrations → API Access → Generate API Token.' },
        { text: 'Copy the token and paste it above.' },
        { text: 'Find your Site ID: Settings → General → Site ID.' },
        { text: 'Find your Collection ID: CMS → Collections → click your blog collection → the ID is in the URL.' },
      ],
    },
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    oauthFlow: true,
    description: 'Contact tracking + campaign attribution. Connects published article UTMs to HubSpot contacts.',
    color: '#FF7A59',
    logo: 'HS',
    liveStatus: 'live',
    credentialFields: [
      { key: 'accessToken', label: 'Private App Token', placeholder: 'pat-na2-...', type: 'password' },
      { key: 'portalId', label: 'Portal ID', placeholder: '244954048' },
    ],
    setupGuide: {
      title: 'Connect HubSpot via OAuth',
      steps: [
        { text: 'Click Connect above. You\'ll be redirected to HubSpot to authorize Forge Intelligence.' },
        { text: 'Log in to HubSpot if prompted and select the account you want to connect.' },
        { text: 'HubSpot will redirect you back automatically once authorized — no token or portal ID needed.' },
      ],
    },
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Share articles to your LinkedIn profile via OAuth2. Click Connect to authorize Forge -- no manual token needed.',
    pipedreamApp: 'linkedin',
    color: '#0A66C2',
    logo: 'in',
    liveStatus: 'live',
    oauthFlow: true,
    credentialFields: [
      { key: 'accessToken', label: 'OAuth Access Token', placeholder: 'Auto-filled after OAuth', type: 'password' },
      { key: 'authorUrn', label: 'Author URN', placeholder: 'Auto-filled after OAuth' },
    ],
    setupGuide: {
      title: 'LinkedIn OAuth',
      steps: [
        { text: 'Click Connect above. You\'ll be redirected to LinkedIn to authorize Forge Intelligence.' },
        { text: 'Sign in with the LinkedIn account you want to publish from.' },
        { text: 'Click Allow to grant posting permissions.' },
        { text: 'You\'ll be redirected back automatically. No tokens to copy.' },
      ],
    },
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    description: 'Post articles with UTM links via X API v2. Tracks impressions, reactions, and link clicks.',
    color: '#000000',
    logo: '𝕏',
    liveStatus: 'live',
    credentialFields: [
      { key: 'accessToken', label: 'Access Token', placeholder: '2001461745...-...', type: 'password' },
      { key: 'accessSecret', label: 'Access Token Secret', placeholder: 'abc123...', type: 'password' },
    ],
    setupGuide: {
      title: 'X (Twitter) Access Token',
      steps: [
        { text: 'Open the X Developer Console and click "Apps" in the left sidebar. Click on your app name.', url: 'https://developer.x.com/en/portal/projects-and-apps' },
        { text: 'You\'ll see a section called "OAuth 1.0 Keys" with two items: Consumer Key and Access Token. You need the Access Token — NOT the Consumer Key.' },
        { text: 'Next to "Access Token," click Regenerate. This creates two values: an Access Token and an Access Token Secret. Copy both. Important: it should say "Read and write" underneath — if it says "Read only," go to App Settings → User authentication settings, change to Read and Write, then come back and regenerate.' },
        { text: 'Paste the Access Token and Access Token Secret into the two fields above. Do not paste the Consumer Key or Consumer Secret — those are already configured in Forge and are not the same thing.' },
      ],
    },
  },
  {
    id: 'facebook',
    label: 'Facebook',
    pipedreamApp: 'facebook_pages',
    description: 'Publish articles to your company Facebook Page via Graph API. Requires a Page Access Token.',
    color: '#1877F2',
    logo: 'f',
    liveStatus: 'live',
    credentialFields: [
      { key: 'pageId', label: 'Page ID', placeholder: '123456789012345' },
      { key: 'pageAccessToken', label: 'Page Access Token', placeholder: 'EAABsbCS...', type: 'password' },
    ],
    setupGuide: {
      title: 'How to get your Facebook Page Access Token',
      steps: [
        { text: 'Step 1 -- Create a Meta Developer app. Do this on desktop -- the portal is broken on mobile. Go to Meta for Developers and create a new app. Choose type "Business". Name it anything (e.g. "Forge").', url: 'https://developers.facebook.com/apps/create/' },
        { text: 'Step 2 -- Add Pages permissions. In your app dashboard, go to App Settings → Advanced. Under "Optional Permissions" add: pages_manage_posts, pages_read_engagement, pages_show_list, pages_manage_metadata. Some may require App Review for non-admin users -- for your own Pages you can proceed without review.' },
        { text: 'Step 3 -- Get a User Access Token. Go to Graph API Explorer. Select your app from the top-right dropdown. Add the permissions above, then click "Generate Access Token" and authorize with the Facebook account that admins your Page.', url: 'https://developers.facebook.com/tools/explorer/' },
        { text: 'Step 4 -- Exchange for a Page Access Token. This is the critical step most people miss. In Graph API Explorer, call GET /me/accounts using your user token. The response lists every Page you manage, each with its own Page ID and a Page access token. Copy the token for your Page -- this is what Forge needs, not the user token.' },
        { text: 'Step 5 -- Make the Page token long-lived. The token from /me/accounts is short-lived. Paste it into the Access Token Debugger and click "Extend Access Token". Copy the result -- it lasts 60 days.', url: 'https://developers.facebook.com/tools/debug/accesstoken/' },
        { text: 'Step 6 -- Get your Page ID. Your Page ID is in the /me/accounts response from Step 4, or find it on your Facebook Page under About → Page transparency. Paste both the Page ID and the long-lived Page token into Forge above.' },
      ],
    },
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Medium stopped issuing new API tokens in early 2025. Existing tokens still work -- if you have a pre-2025 token you can connect it here. New tokens are no longer available.',
    color: '#000000',
    logo: 'M',
    liveStatus: 'legacy',
    credentialFields: [
      { key: 'integrationToken', label: 'Integration Token', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'password' },
    ],
    setupGuide: {
      title: 'Medium Integration Token',
      steps: [
        { text: 'Go to your Medium settings page.', url: 'https://medium.com/me/settings/security' },
        { text: 'Scroll to "Integration tokens" at the bottom. Give it a name like "Forge Intelligence" and click Get integration token.' },
        { text: 'Copy the long hex token shown and paste it into the field above.' },
        { text: 'No OAuth or app creation needed. Medium uses simple bearer tokens for API access.' },
        { text: 'Note: Medium publishes as your personal account. Log into the account you want to publish from before generating the token.' },
      ],
    },
  },
  {
    id: 'ghost',
    label: 'Ghost',
    description: 'Publish full articles to your Ghost site via Admin API. No OAuth — just an Admin API key from your Ghost integration settings.',
    color: '#15171A',
    logo: 'GH',
    liveStatus: 'live',
    credentialFields: [
      { key: 'adminUrl', label: 'Admin URL', placeholder: 'https://yourblog.ghost.io' },
      { key: 'adminApiKey', label: 'Admin API Key', placeholder: 'id:secret (64-char hex)', type: 'password' },
    ],
    setupGuide: {
      title: 'Ghost Admin API Key',
      steps: [
        { text: 'Go to your Ghost Admin panel and navigate to Settings.', url: 'https://ghost.org/help/' },
        { text: 'Click Integrations in the left sidebar, then click Add custom integration at the bottom.' },
        { text: 'Name it anything (e.g. Forge Intelligence) and click Create.' },
        { text: 'Copy the Admin API Key shown — it looks like a long hex string with a colon in the middle (id:secret format).' },
        { text: 'Your Admin URL is the root of your Ghost site, e.g. https://yourblog.ghost.io. Paste both above.' },
      ],
    },
  },
];

const DEFAULT_UTM: Record<ChannelId, Record<string, string>> = {
  wordpress: { utm_source: 'forge', utm_medium: 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  webflow:   { utm_source: 'forge', utm_medium: 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  hubspot:   { utm_source: 'hubspot', utm_medium: 'attribution', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  linkedin:  { utm_source: 'linkedin', utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  x:         { utm_source: 'x',        utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  facebook:  { utm_source: 'facebook',   utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
    medium:    { utm_source: 'medium',     utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  ghost:     { utm_source: 'ghost',      utm_medium: 'blog',   utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
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

export default function IntegrationsPage() {
  const { isPaid, brandLoading, activeBrand } = useApp();
  
  const selectedBrand = activeBrand?.id || '';
  const [savedChannels, setSavedChannels] = useState<Record<ChannelId, SavedChannel | null>>({
    wordpress: null, webflow: null, hubspot: null, linkedin: null, x: null, facebook: null, medium: null, ghost: null
  });
  const [expanded, setExpanded] = useState<ChannelId | null>(null);
  const [credentials, setCredentials] = useState<Record<ChannelId, Record<string, string>>>({
    wordpress: {}, webflow: {}, hubspot: {}, linkedin: {}, x: {}, facebook: {}, medium: {}, ghost: {}
  });
  const [utmTemplates, setUtmTemplates] = useState<Record<ChannelId, Record<string, string>>>(DEFAULT_UTM);
  const [saving, setSaving] = useState<ChannelId | null>(null);
  const [disconnecting, setDisconnecting] = useState<ChannelId | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Load channels whenever active brand resolves
  useEffect(() => {
    const brandId = activeBrand?.id || '';
    if (brandId) loadChannels(brandId);
  }, [activeBrand?.id]);

  const loadChannels = (brandId: string) => {
    fetch(`/api/publishing/channels/${brandId}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const map: Record<ChannelId, SavedChannel | null> = {
            wordpress: null, webflow: null, hubspot: null, linkedin: null, x: null, facebook: null, medium: null, ghost: null
          };
          for (const ch of d.channels) map[ch.channel as ChannelId] = ch;
          setSavedChannels(map);
          const newUtm = { ...DEFAULT_UTM };
          for (const ch of d.channels) {
            if (ch.utm_template && Object.keys(ch.utm_template).length > 0) {
              newUtm[ch.channel as ChannelId] = ch.utm_template;
            }
          }
          setUtmTemplates(newUtm);
        }
      });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin_connected') === 'true') {
      setSuccess('LinkedIn connected successfully!');
      setExpanded('linkedin');
      window.history.replaceState({}, '', '/app/integrations');
      const brand = activeBrand?.id || (() => { try { return localStorage.getItem('forge_active_brand_id'); } catch(e) { return ''; } })() || new URLSearchParams(window.location.search).get('brand') || '';
      if (brand) setTimeout(() => loadChannels(brand), 500);
    }
    if (params.get('linkedin_error')) {
      setError(`LinkedIn authorization failed: ${decodeURIComponent(params.get('linkedin_error') || '')}`);
      window.history.replaceState({}, '', '/app/integrations');
    }
  }, []);

  const handleSave = async (channelId: ChannelId) => {
    const channel = CHANNELS.find(c => c.id === channelId);

    // Native OAuth channels — bypass Pipedream entirely
    const nativeOAuthRoutes: Record<string, string> = {
      linkedin: '/api/linkedin/auth',
      hubspot:  '/api/hubspot/auth',
      webflow:  '/api/webflow/auth',
    };
    if (channel?.oauthFlow && nativeOAuthRoutes[channelId]) {
      if (!selectedBrand) { setError('Select a Brain first'); return; }
      try {
        const r = await fetch(`${nativeOAuthRoutes[channelId]}?brandProfileId=${selectedBrand}`);
        const d = await r.json();
        if (d.authUrl) { window.location.href = d.authUrl; return; }
        // Some auth routes redirect directly (no JSON)
        throw new Error(d.error || `Failed to start ${channel.label} authorization`);
      } catch(e: any) {
        if (!String(e.message).includes('JSON')) {
          setError(`Could not connect ${channel.label}: ${e.message}`);
        }
      }
      return;
    }

    if (channel?.pipedreamApp) {
      if (!selectedBrand) { setError('Select a Brain first'); return; }
      try {
        // Get short-lived token from our server
        const tokenRes = await fetch('/api/pipedream/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brandProfileId: selectedBrand })
        });
        const { token } = await tokenRes.json();
        if (!token) throw new Error('Could not get connect token');

        // Open Pipedream Connect iframe directly — bypass SDK token resolution issues
        const iframeUrl = `https://pipedream.com/_static/connect.html?token=${encodeURIComponent(token)}&app=${encodeURIComponent(channel.pipedreamApp || '')}`;

        await new Promise<void>((resolve) => {
          const iframe = document.createElement('iframe');
          iframe.src = iframeUrl;
          iframe.style.cssText = 'position:fixed;inset:0;z-index:2147483647;border:0;display:block;width:100%;height:100%';
          document.body.appendChild(iframe);

          const onMessage = async (e: MessageEvent) => {
            if (!e.data?.type) return;
            if (e.data.type === 'success') {
              window.removeEventListener('message', onMessage);
              iframe.remove();
              const accountId = e.data.authProvisionId;
              await fetch('/api/pipedream/account', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ brandProfileId: selectedBrand, channel: channelId, accountId, appSlug: channel.pipedreamApp })
              });
              setSuccess(`${channel.label} connected via Pipedream ✓`);
              loadChannels(selectedBrand);
              setTimeout(() => setSuccess(''), 4000);
              resolve();
            } else if (e.data.type === 'error') {
              window.removeEventListener('message', onMessage);
              iframe.remove();
              setError(`Could not connect ${channel.label}: ${e.data.error || 'Unknown error'}`);
              resolve();
            } else if (e.data.type === 'close') {
              window.removeEventListener('message', onMessage);
              iframe.remove();
              resolve();
            }
          };
          window.addEventListener('message', onMessage);
        });
      } catch(e: any) {
        console.error('[Pipedream Connect Catch]', e);
        if (e?.message !== 'User closed the connect dialog') {
          setError(`Could not connect ${channel.label}: ${e?.message || JSON.stringify(e)}`);
        }
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
        loadChannels(selectedBrand);
        setExpanded(channelId);
        setTimeout(() => setSuccess(''), 4000);
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
      setExpanded(null);
      setSuccess('');
    } finally {
      setDisconnecting(null);
    }
  };

  const isConnected = (id: ChannelId) => !!savedChannels[id];

  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell>
        <GateModal
          featureName="Integrations"
          onClose={() => window.location.href = '/app/context-hub'}
          onUnlocked={() => {}}
        />
      </AppShell>
    );
  }

  return (
    <AppShell pageTitle="Integrations">
      <div className="int-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Settings</div>
            <h1 className="geo-title">Integrations</h1>
            <p className="geo-description">Connect publishing channels per Brain. Credentials are isolated per brand -- no cross-tenant leakage.</p>
          </div>
        </div>

        {selectedBrand && (
          <div className="int-connected-count">
            {Object.values(savedChannels).filter(Boolean).length} of {CHANNELS.length} channels connected
          </div>
        )}

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
                        {ch.liveStatus === 'legacy' && (
                          <span className="int-legacy-badge">Legacy</span>
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
                          title={isOpen ? 'Collapse' : 'View & edit settings'}
                        >
                          {isOpen ? <ChevronUp /> : <ChevronDown />}
                        </button>
                      </div>
                    ) : (
                      selectedBrand && (
                        ch.liveStatus === 'legacy' ? (
                          <button
                            className="int-connect-btn int-connect-legacy"
                            onClick={() => setExpanded(isOpen ? null : ch.id)}
                          >
                            {isOpen ? 'Cancel' : 'Connect existing token'}
                          </button>
                        ) : (
                          <button
                            className="int-connect-btn"
                            style={{ '--ch-color': ch.color } as React.CSSProperties}
                            onClick={() => (ch.pipedreamApp || ch.oauthFlow) ? handleSave(ch.id) : setExpanded(isOpen ? null : ch.id)}
                          >
                            {ch.pipedreamApp ? 'Connect' : (isOpen ? 'Cancel' : 'Connect')}
                          </button>
                        )
                      )
                    )}
                  </div>
                </div>

                {/* Expanded panel */}
                {isOpen && (
                  <div className="int-card-form">
                    {/* Pipedream-connected channels: no credential fields, just UTM + reconnect */}
                    {ch.pipedreamApp && connected && (
                      <div className="int-form-section">
                        <div className="int-pipedream-status">
                          <div className="int-pipedream-badge">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            Connected via Pipedream
                          </div>
                          <span className="int-pipedream-sub">OAuth managed by Pipedream · Token auto-refreshes · Last updated {saved?.updated_at ? new Date(saved.updated_at).toLocaleDateString() : '--'}</span>
                          <button className="int-reauth-btn" onClick={() => handleSave(ch.id)}>Reconnect</button>
                        </div>
                      </div>
                    )}

                    {/* OAuth reconnect for native OAuth channels */}
                    {ch.oauthFlow && connected && (
                      <div className="int-pipedream-section">
                        <div className="int-pipedream-info">
                          <div className="int-pipedream-badge">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
                            Connected via OAuth
                          </div>
                          <span className="int-pipedream-sub">Token managed by {ch.label} OAuth · Last updated {saved?.updated_at ? new Date(saved.updated_at).toLocaleDateString() : '--'}</span>
                          <button className="int-reauth-btn" onClick={() => handleSave(ch.id)}>Reconnect</button>
                        </div>
                      </div>
                    )}

                    {/* OAuth reconnect for native OAuth channels */}
                    {ch.oauthFlow && connected && (
                      <div className="int-pipedream-section">
                        <div className="int-pipedream-info">
                          <div className="int-pipedream-badge">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
                            Connected via OAuth
                          </div>
                          <span className="int-pipedream-sub">Authorized with {ch.label} · Last updated {saved?.updated_at ? new Date(saved.updated_at).toLocaleDateString() : '--'}</span>
                          <button className="int-reauth-btn" onClick={() => handleSave(ch.id)}>Reconnect</button>
                        </div>
                      </div>
                    )}

                    {/* Manual credential fields for non-Pipedream, non-OAuth channels */}
                    {!ch.pipedreamApp && !ch.oauthFlow && (
                      <div className="int-form-section">
                        <div className="int-form-label">
                          Credentials
                          <SetupGuide guide={ch.setupGuide} />
                        </div>
                        <div className="int-fields">
                          {ch.credentialFields.map(f => (
                            <div key={f.key} className="int-field">
                              <label className="int-field-label">{f.label}</label>
                              <input
                                className="int-field-input"
                                type={connected ? 'password' : (f.type || 'text')}
                                placeholder={connected ? '••••••••••••' : f.placeholder}
                                value={credentials[ch.id][f.key] !== undefined ? credentials[ch.id][f.key] : (connected ? (savedChannels[ch.id] as any)?.credentials?.[f.key] || '' : '')}
                                onChange={e => setCredentials(prev => ({
                                  ...prev,
                                  [ch.id]: { ...prev[ch.id], [f.key]: e.target.value }
                                }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

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
                      <button className="int-cancel-btn" onClick={() => setExpanded(null)}>Close</button>
                      {!ch.pipedreamApp && !ch.oauthFlow && (
                        <button
                          className="int-save-btn"
                          onClick={() => handleSave(ch.id)}
                          disabled={saving === ch.id}
                        >
                          {saving === ch.id ? 'Saving...' : connected ? 'Update Connection' : `Connect ${ch.label}`}
                        </button>
                      )}
                      {connected && (
                        <button
                          className="int-save-btn"
                          style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                          onClick={async () => {
                            if (!selectedBrand) return;
                            setSaving(ch.id);
                            try {
                              const r = await fetch('/api/publishing/channels', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ brandProfileId: selectedBrand, channel: ch.id, credentials: ch.pipedreamApp ? savedChannels[ch.id] : credentials[ch.id], utmTemplate: utmTemplates[ch.id] })
                              });
                              const d = await r.json();
                              if (d.success) { setSuccess('UTM template saved'); setTimeout(() => setSuccess(''), 3000); }
                            } finally { setSaving(null); }
                          }}
                          disabled={saving === ch.id}
                        >
                          {saving === ch.id ? 'Saving...' : 'Save UTM Template'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Subscription gate note */}
        <div className="int-gate-note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',marginRight:6,verticalAlign:'middle'}}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Channel credentials are encrypted at rest and scoped to this Brain only. Multi-tenant access requires an active subscription.
        </div>
      </div>
    </AppShell>
  );
}
