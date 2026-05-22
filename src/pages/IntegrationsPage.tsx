import { useState, useEffect, useRef } from 'react';
import { AppShell } from '../layouts/AppShell';
import GateModal from '../components/GateModal';
import { useApp } from '../context/AppContext';
import MyWebsiteForm from '../components/MyWebsiteForm';
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
type ChannelId = 'wordpress' | 'webflow' | 'linkedin' | 'x' | 'facebook' | 'reddit' | 'medium' | 'ghost' | 'website';

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
  pipedreamOauthAppId?: string;
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
        { text: 'Log into your WordPress admin dashboard at yourdomain.com/wp-admin. You need an account with Editor or Administrator role.' },
        { text: 'In the left sidebar, go to Users → Profile. Scroll all the way to the bottom of the page — past the color scheme and bio fields — until you see a section called "Application Passwords."' },
        { text: 'In the "New Application Password Name" field, type "Forge Intelligence" and click "Add New Application Password." WordPress will show a 24-character password with spaces (e.g. xxxx xxxx xxxx xxxx xxxx xxxx). Copy the entire thing including spaces — you will not be able to see it again.' },
        { text: 'Back in Forge, enter your Site URL (e.g. https://yourdomain.com — no /wp-admin, no trailing slash), your WordPress username (the one you logged in with, not your display name), and paste the application password.' },
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
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Share articles to your LinkedIn profile via Zernio. Click Connect to authorize — no manual token needed.',
    color: '#0A66C2',
    logo: 'in',
    liveStatus: 'live',
    oauthFlow: true,
    credentialFields: [],
    setupGuide: {
      title: 'LinkedIn via Zernio',
      steps: [
        { text: 'Click Connect above. You\'ll be redirected to LinkedIn to authorize via Zernio.' },
        { text: 'Sign in with the LinkedIn account you want to publish from.' },
        { text: 'Click Allow to grant posting permissions.' },
        { text: 'You\'ll be redirected back automatically. No tokens to copy.' },
      ],
    },
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    description: 'Post articles with UTM links via X API v2. Click Connect to authorize Forge -- no manual tokens needed.',
    color: '#000000',
    logo: '𝕏',
    liveStatus: 'live',
    oauthFlow: true,
    credentialFields: [],
    setupGuide: {
      title: 'Connect X (Twitter)',
      steps: [
        { text: 'Click Connect above. You\'ll be redirected to X to authorize Forge Intelligence.' },
        { text: 'Sign in with the X account you want to publish from.' },
        { text: 'Click Authorize app to grant posting permissions.' },
        { text: 'You\'ll be redirected back automatically. No tokens to copy.' },
      ],
    },
  },
  {
    id: 'facebook',
    label: 'Facebook',
    description: 'Publish articles to your Facebook Page via Zernio. Click Connect to authorize — no manual tokens needed.',
    color: '#1877F2',
    logo: 'f',
    liveStatus: 'live',
    oauthFlow: true,
    credentialFields: [],
    setupGuide: {
      title: 'Facebook via Zernio',
      steps: [
        { text: 'Click Connect above. You\'ll be redirected to Facebook to authorize via Zernio.' },
        { text: 'Sign in with the Facebook account that manages your Page.' },
        { text: 'Select the Page you want to publish to and click Allow.' },
        { text: 'You\'ll be redirected back automatically. No tokens or Page IDs to copy.' },
      ],
    },
  },
  {
    id: 'reddit',
    label: 'Reddit',
    description: 'Publish to subreddits where you have permission to post. Connect via Zernio, then add the subreddits you can post in. Forge will refuse to post outside your allowlist.',
    color: '#FF4500',
    logo: 'R',
    liveStatus: 'live',
    oauthFlow: true,
    credentialFields: [],
    setupGuide: {
      title: 'Reddit via Zernio (brand-owned subreddits only)',
      steps: [
        { text: 'Click Connect above. You\'ll be redirected to Reddit to authorize via Zernio.' },
        { text: 'Sign in to the Reddit account that has posting permission in your target subreddits.' },
        { text: 'After connecting, return here and add each subreddit you have permission to post in under "Allowed subreddits" below.' },
        { text: 'Forge will only publish to subreddits in your allowlist. Posting to subreddits where you don\'t have permission can get the account banned.' },
        { text: 'Reddit posts default to text-format with the article URL inline. Most subreddits ban link-only posts.' },
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
  {
    id: 'website',
    label: 'My Website',
    description: 'Publish Forge articles to your own self-hosted site via an authenticated webhook. Forge POSTs the article payload to an endpoint you control.',
    color: '#6366F1',
    logo: 'My',
    liveStatus: 'live',
    credentialFields: [],
    setupGuide: {
      title: 'Self-hosted webhook',
      steps: [
        { text: 'Add an authenticated POST endpoint to your site (e.g. /api/forge/publish). It accepts a JSON payload and validates the Authorization: Bearer header against a token you control.' },
        { text: 'In this form, paste the full URL of that endpoint into the "Receiver endpoint URL" field, choose your preferred payload format (HTML, Markdown, or both), and click "Save config".' },
        { text: 'Click "Generate token" to produce a Forge-issued bearer secret. It will be shown ONCE — copy it immediately. Put it in your server\'s environment as FORGE_BEARER_TOKEN (or equivalent) and use it to validate incoming requests.' },
        { text: 'Click "Send test payload" to fire a sample article at your endpoint. If your receiver returns 200 OK, you\'re live.' },
        { text: 'See the My Website docs page for the full payload schema and copy-paste receiver samples (Node/Express + Next.js + Postgres).', url: '/docs/my-website' },
      ],
    },
  },
];

const DEFAULT_UTM: Record<ChannelId, Record<string, string>> = {
  wordpress: { utm_source: 'forge', utm_medium: 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  webflow:   { utm_source: 'forge', utm_medium: 'organic', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  linkedin:  { utm_source: 'linkedin', utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  x:         { utm_source: 'x',        utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  facebook:  { utm_source: 'facebook', utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  reddit:    { utm_source: 'reddit',   utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  medium:    { utm_source: 'medium',   utm_medium: 'social', utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  ghost:     { utm_source: 'ghost',    utm_medium: 'blog',   utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
  website:   { utm_source: 'website',  utm_medium: 'blog',   utm_campaign: '{campaign_slug}', utm_content: '{article_slug}' },
};

// ── Types ────────────────────────────────────────────────────────────────────
interface SavedChannel {
  id: string;
  channel: ChannelId;
  utm_template: Record<string, string>;
  test_status: string;
  last_tested_at: string | null;
  updated_at: string;
  // Credentials shape varies per channel (pageId/pageName for facebook, pipedream_account_id for pipedream-connected, etc.).
  // Using Record<string, any> instead of a discriminated union because the surface is lightweight and channel-specific reads cast site-locally.
  credentials?: Record<string, any>;
}

// Reddit allowed-subreddits manager. Renders inside a connected Reddit channel card.
// Shows current allowlist + add/remove + default-subreddit picker. Calls
// POST /api/publishing/channels/reddit/allowed-subreddits which uses JSONB merge
// so it doesn't wipe the OAuth credentials.
function RedditAllowedSubreddits({
  brandProfileId,
  savedCredentials,
  onSaved,
}: {
  brandProfileId: string;
  savedCredentials: Record<string, unknown>;
  onSaved: () => void;
}) {
  const initialList = Array.isArray(savedCredentials.allowedSubreddits)
    ? (savedCredentials.allowedSubreddits as string[])
    : [];
  const initialDefault = (savedCredentials.defaultSubreddit as string) || (initialList[0] || '');

  const [allowedList, setAllowedList] = useState<string[]>(initialList);
  const [defaultSub, setDefaultSub] = useState<string>(initialDefault);
  const [draftSub, setDraftSub] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  // Re-hydrate when the parent reloads with fresh creds.
  useEffect(() => {
    const list = Array.isArray(savedCredentials.allowedSubreddits)
      ? (savedCredentials.allowedSubreddits as string[])
      : [];
    const def = (savedCredentials.defaultSubreddit as string) || (list[0] || '');
    setAllowedList(list);
    setDefaultSub(def);
  }, [JSON.stringify(savedCredentials.allowedSubreddits), savedCredentials.defaultSubreddit]);

  const normalize = (raw: string) => raw.trim().replace(/^r\//i, '').replace(/^\//, '');
  const valid = (raw: string) => /^[A-Za-z0-9][A-Za-z0-9_]{2,20}$/.test(raw);

  const addSub = () => {
    setErr(''); setOk('');
    const n = normalize(draftSub);
    if (!n) return;
    if (!valid(n)) { setErr('Subreddit names must be 3-21 characters, letters/numbers/underscores only.'); return; }
    if (allowedList.includes(n)) { setErr('Already in your allowlist.'); return; }
    const next = [...allowedList, n];
    setAllowedList(next);
    if (!defaultSub) setDefaultSub(n);
    setDraftSub('');
  };
  const removeSub = (n: string) => {
    setErr(''); setOk('');
    const next = allowedList.filter(s => s !== n);
    setAllowedList(next);
    if (defaultSub === n) setDefaultSub(next[0] || '');
  };

  const save = async () => {
    setErr(''); setOk(''); setSaving(true);
    try {
      const r = await fetch('/api/publishing/channels/reddit/allowed-subreddits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandProfileId,
          allowedSubreddits: allowedList,
          defaultSubreddit: defaultSub || null,
        }),
      });
      const d = await r.json();
      if (!d.success) { setErr(d.error || 'Save failed'); return; }
      setOk('Allowed subreddits saved.');
      onSaved();
      setTimeout(() => setOk(''), 2500);
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 14, padding: 14, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#9A3412', marginBottom: 4 }}>Allowed subreddits</div>
      <div style={{ fontSize: 12, color: '#7C2D12', marginBottom: 12, lineHeight: 1.5 }}>
        Add only subreddits where you have permission to post (your own communities, subs you moderate, or subs whose rules allow your content). Forge will refuse to publish to anything outside this list.
      </div>

      {/* Current list */}
      {allowedList.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {allowedList.map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#FFFFFF', border: '1px solid #FED7AA', borderRadius: 6 }}>
              <span style={{ fontSize: 13, color: '#1E293B', fontWeight: 500, flex: 1 }}>r/{s}</span>
              <label style={{ fontSize: 11, color: '#64748B', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="radio" name="default-sub" checked={defaultSub === s} onChange={() => setDefaultSub(s)} />
                Default
              </label>
              <button type="button" onClick={() => removeSub(s)} style={{ background: 'none', border: 'none', color: '#B91C1C', cursor: 'pointer', fontSize: 12, padding: '4px 8px' }}>Remove</button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#7C2D12', fontStyle: 'italic', marginBottom: 12 }}>No allowed subreddits yet. Add at least one before publishing.</div>
      )}

      {/* Add new */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: '#64748B' }}>r/</span>
        <input
          type="text"
          value={draftSub}
          onChange={e => setDraftSub(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } }}
          placeholder="forgeintelligence"
          className="int-field-input"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={addSub}
          disabled={!draftSub.trim()}
          className="int-save-btn"
          style={{ minWidth: 80 }}
        >
          Add
        </button>
      </div>

      {err && <div style={{ fontSize: 12, color: '#B91C1C', marginBottom: 8 }}>{err}</div>}
      {ok && <div style={{ fontSize: 12, color: '#15803D', marginBottom: 8 }}>{ok}</div>}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="int-save-btn"
        style={{ width: '100%' }}
      >
        {saving ? 'Saving…' : 'Save allowed subreddits'}
      </button>
    </div>
  );
}

export default function IntegrationsPage() {
  const { isPaid, brandLoading, activeBrand } = useApp();
  
  const selectedBrand = activeBrand?.id || '';
  const [savedChannels, setSavedChannels] = useState<Record<ChannelId, SavedChannel | null>>({
    wordpress: null, webflow: null, linkedin: null, x: null, facebook: null, reddit: null, medium: null, ghost: null, website: null
  });
  const [expanded, setExpanded] = useState<ChannelId | null>(null);
  const [credentials, setCredentials] = useState<Record<ChannelId, Record<string, string>>>({
    wordpress: {}, webflow: {}, linkedin: {}, x: {}, facebook: {}, reddit: {}, medium: {}, ghost: {}, website: {}
  });
  const [utmTemplates, setUtmTemplates] = useState<Record<ChannelId, Record<string, string>>>(DEFAULT_UTM);
  const [saving, setSaving] = useState<ChannelId | null>(null);
  const [disconnecting, setDisconnecting] = useState<ChannelId | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Facebook page-picker state — loaded when user opens the FB card and is Pipedream-connected.

  // Manual Page ID input — primary path while Pipedream's page picker doesn't return
  // pages reliably. Customer pastes the ID from their Facebook Page → Save persists it via
  // the same /api/facebook/pipedream/select-page endpoint the picker uses.


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
            wordpress: null, webflow: null, linkedin: null, x: null, facebook: null, reddit: null, medium: null, ghost: null, website: null
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
    const connected = params.get('connected');
    if (params.get('linkedin_connected') === 'true' || (connected && connected.startsWith('zernio:'))) {
      const platform = connected?.split(':')?.[1] || 'linkedin';
      setSuccess(`${platform.charAt(0).toUpperCase() + platform.slice(1)} connected via Zernio!`);
      setExpanded(platform as ChannelId);
      window.history.replaceState({}, '', '/app/integrations');
      const brand = activeBrand?.id || (() => { try { return localStorage.getItem('forge_active_brand_id'); } catch(e) { return ''; } })() || new URLSearchParams(window.location.search).get('brand') || '';
      if (brand) setTimeout(() => loadChannels(brand), 500);
    }
    if (params.get('linkedin_error') || connected === 'error') {
      const reason = params.get('reason') || params.get('linkedin_error') || 'Unknown error';
      setError(`Authorization failed: ${decodeURIComponent(reason)}`);
      window.history.replaceState({}, '', '/app/integrations');
    }
  }, []);

  const handleSave = async (channelId: ChannelId) => {
    const channel = CHANNELS.find(c => c.id === channelId);

    // Zernio-powered OAuth — redirect flow with callback
    const zernioPlatforms: Record<string, string> = { linkedin: 'linkedin', facebook: 'facebook', reddit: 'reddit' };
    if (zernioPlatforms[channelId] && channel?.oauthFlow) {
      if (!selectedBrand) { setError('Select a Brain first'); return; }
      try {
        const r = await fetch('/api/zernio/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brandProfileId: selectedBrand, platform: zernioPlatforms[channelId] })
        });
        const d = await r.json();
        if (d.authUrl) { window.location.href = d.authUrl; return; }
        throw new Error(d.error || 'No auth URL returned from Zernio');
      } catch(e: any) {
        setError(`Could not connect ${channel.label}: ${e.message}`);
      }
      return;
    }

    // Native OAuth channels — redirect flow
    const nativeOAuthRoutes: Record<string, string> = {
          webflow:  '/api/webflow/auth',
      x:        '/api/x/auth',
    };
    if (channel?.oauthFlow && nativeOAuthRoutes[channelId]) {
      if (!selectedBrand) { setError('Select a Brain first'); return; }
      try {
        const r = await fetch(`${nativeOAuthRoutes[channelId]}?brandProfileId=${selectedBrand}`);
        const d = await r.json();
        if (d.authUrl) { window.location.href = d.authUrl; return; }
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
        const oauthAppId = (channel as any).pipedreamOauthAppId && (channel as any).pipedreamOauthAppId !== 'FACEBOOK_OAUTH_APP_ID' ? (channel as any).pipedreamOauthAppId : (await fetch('/api/pipedream/config').then(r => r.json()).then(c => c.oauthAppIds?.[channel.pipedreamApp!]).catch(() => null));
        const iframeUrl = `https://pipedream.com/_static/connect.html?token=${encodeURIComponent(token)}${oauthAppId ? `&oauthAppId=${encodeURIComponent(oauthAppId)}` : ''}&app=${encodeURIComponent(channel.pipedreamApp || '')}`;

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


  // Save a manually entered Page ID. Reuses the same backend endpoint as the picker —
  // pageName is null because the customer didn't pick a Page object, just typed an ID.
  // The publish flow only needs pageId; pageName is decorative metadata.


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
                    {/* OAuth reconnect for native OAuth channels */}
                    {ch.oauthFlow && connected && (
                      <div className="int-pipedream-section">
                        <div className="int-pipedream-info">
                          {(() => {
                            // Data-driven badge: pick provider based on actual creds shape.
                            //   zernioAccountId set                     → Zernio
                            //   accessToken / authorUrn / pageAccessToken → direct OAuth
                            //   else (no creds yet)                     → OAuth (default for oauthFlow)
                            const creds = (saved?.credentials || {}) as Record<string, unknown>;
                            const usingZernio = !!creds.zernioAccountId;
                            const provider = usingZernio ? 'Zernio' : 'OAuth';
                            const subText = usingZernio
                              ? `Routed through Zernio · White-label · Last updated ${saved?.updated_at ? new Date(saved.updated_at).toLocaleDateString() : '--'}`
                              : `Token managed by ${ch.label} OAuth · Last updated ${saved?.updated_at ? new Date(saved.updated_at).toLocaleDateString() : '--'}`;
                            return (
                              <>
                                <div className="int-pipedream-badge">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
                                  Connected via {provider}
                                </div>
                                <span className="int-pipedream-sub">{subText}</span>
                              </>
                            );
                          })()}
                          <button className="int-reauth-btn" onClick={() => handleSave(ch.id)}>Reconnect</button>
                        </div>
                      </div>
                    )}

                    {/* Reddit-specific: allowed subreddits manager. Only renders for connected Reddit channels.
                        The brand declares which subs they have permission to post in; Forge refuses to publish
                        outside the list. Stored as creds.allowedSubreddits via a dedicated JSONB-merge endpoint
                        so this list update doesn't wipe the OAuth credentials. */}
                    {ch.id === 'reddit' && ch.oauthFlow && connected && (
                      <RedditAllowedSubreddits
                        brandProfileId={selectedBrand}
                        savedCredentials={(saved?.credentials || {}) as Record<string, unknown>}
                        onSaved={() => loadChannels(selectedBrand)}
                      />
                    )}

                    {/* My Website — fully custom form (URL + format + generate token + test) */}
                    {ch.id === 'website' && selectedBrand && (
                      <MyWebsiteForm
                        brandProfileId={selectedBrand}
                        saved={saved as unknown as { credentials?: { endpointUrl?: string; format?: 'html' | 'markdown' | 'both'; bearerToken?: string }; is_active?: boolean; updated_at?: string } | null}
                        onChange={() => loadChannels(selectedBrand)}
                      />
                    )}

                    {/* Manual credential fields for non-Pipedream, non-OAuth channels */}
                    {!ch.oauthFlow && ch.id !== 'website' && (
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
                      {!ch.oauthFlow && (
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
