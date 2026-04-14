import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import './BrandSettingsPage.css';

interface BrandSettings {
  id: string;
  brand_name: string;
  brand_url: string;
  article_base_url: string;
  article_url_suffix: string;
  logo_url: string;
  is_paid: boolean;
  created_at: string;
  digest_unsubscribed: boolean;
  settings: Record<string, any>;
}

const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M16 8h5V3"/>
  </svg>
);

const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

export default function BrandSettingsPage() {
  const { activeBrand } = useApp();
  const { getToken } = useAuth();
  const selected = activeBrand?.id || (() => { try { return localStorage.getItem('forge_active_brand_id'); } catch(e) { return ''; } })() || new URLSearchParams(window.location.search).get('brand') || '';

  const [form, setForm] = useState<Partial<BrandSettings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Reviewers
  interface Reviewer { id: string; name: string; email: string; title: string; }
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [revName, setRevName] = useState('');
  const [revEmail, setRevEmail] = useState('');
  const [revTitle, setRevTitle] = useState('');
  const [revSaving, setRevSaving] = useState(false);
  const [revError, setRevError] = useState('');

  const [scraping, setScraping] = useState(false);
  const [scrapeSuccess, setScrapeSuccess] = useState(false);
  const [scrapeError, setScrapeError] = useState('');
  const [articleTemplateUrl, setArticleTemplateUrl] = useState('');
  const [catalogTemplateUrl, setCatalogTemplateUrl] = useState('');

  const [voiceAttrs, setVoiceAttrs] = useState<{attribute: string; score: number; description: string}[]>([]);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceSaved, setVoiceSaved] = useState(false);

  const [digestOptOut, setDigestOptOut] = useState(false);
  const [digestSaving, setDigestSaving] = useState(false);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/brand-settings/${selected}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setForm(d.settings);
          setDigestOptOut(!!d.settings?.digest_unsubscribed);
        }
      });
    getToken().then(token => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch(`/api/brand-settings/${selected}/voice`, { headers })
        .then(r => r.json())
        .then(d => { if (d.success && d.toneAttributes?.length) setVoiceAttrs(d.toneAttributes); })
        .catch(() => {});
    });
  }, [selected, activeBrand?.id]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true); setError('');
    try {
      const r = await fetch(`/api/brand-settings/${selected}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandName: form.brand_name,
          articleBaseUrl: form.article_base_url,
          articleUrlSuffix: form.article_url_suffix,
          logoUrl: form.logo_url,
        })
      });
      const d = await r.json();
      if (d.success) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
      else setError(d.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleScrape = async () => {
    if (!selected || !articleTemplateUrl) return;
    setScraping(true); setScrapeError(''); setScrapeSuccess(false);
    try {
      const r = await fetch(`/api/brand-settings/${selected}/scrape-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleUrl: articleTemplateUrl, catalogUrl: catalogTemplateUrl || undefined })
      });
      const d = await r.json();
      if (d.success) { setScrapeSuccess(true); setTimeout(() => setScrapeSuccess(false), 4000); }
      else setScrapeError(d.error || 'Scrape failed');
    } catch { setScrapeError('Network error — check the URLs and try again'); }
    finally { setScraping(false); }
  };

  const handleVoiceSave = async () => {
    if (!selected || !voiceAttrs.length) return;
    setVoiceSaving(true);
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`/api/brand-settings/${selected}/voice`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ toneAdjustments: voiceAttrs.map(a => ({ attribute: a.attribute, score: a.score })) })
    }).catch(() => null);
    const d = r ? await r.json() : null;
    if (d?.success) { setVoiceSaved(true); setTimeout(() => setVoiceSaved(false), 3000); }
    setVoiceSaving(false);
  };

  const handleDigestToggle = async (optOut: boolean) => {
    if (!selected) return;
    setDigestSaving(true);
    const token = await getToken();
    await fetch('/api/digest/preference', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ brandProfileId: selected, unsubscribed: optOut })
    }).catch(() => {});
    setDigestOptOut(optOut);
    setDigestSaving(false);
  };

  const set = (key: keyof BrandSettings, val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const activatedDate = form.created_at
    ? new Date(form.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <AppShell pageTitle="Brand Settings">
      <div className="bs-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Settings</div>
            <h1 className="geo-title">Brand Settings</h1>
            <p className="geo-description">Configure publishing preferences, custom domain, and identity for each brand.</p>
          </div>
        </div>

        {!selected ? (
          <div className="bs-empty">No brands found. Run a Brain analysis first to create a brand profile.</div>
        ) : (
          <div className="bs-layout">
            <div className="bs-content">

              {/* Identity */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Identity</h2>
                  <p className="bs-section-sub">Basic brand information used across the platform.</p>
                </div>
                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">Brand Name</label>
                    <input className="bs-input" value={form.brand_name || ''} onChange={e => set('brand_name', e.target.value)} placeholder="Acme Corp" />
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Brand URL</label>
                    <input className="bs-input bs-input-readonly" value={form.brand_url || ''} readOnly title="Set during Brain analysis — cannot be changed here" />
                    <span className="bs-field-hint">Set during Brain analysis. To change, run a new analysis.</span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Logo URL <span className="bs-optional">optional</span></label>
                    <input className="bs-input" value={form.logo_url || ''} onChange={e => set('logo_url', e.target.value)} placeholder="https://yoursite.com/logo.png" />
                    <span className="bs-field-hint">Used in article page headers and OG meta images.</span>
                  </div>
                </div>
              </section>

              {/* Publishing */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Publishing</h2>
                  <p className="bs-section-sub">Configure where your articles live and how URLs are built.</p>
                </div>
                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">Article Base URL <span className="bs-optional">BYO domain</span></label>
                    <input className="bs-input" value={form.article_base_url || ''} onChange={e => set('article_base_url', e.target.value)} placeholder="https://yoursite.com/articles" />
                    <span className="bs-field-hint">
                      Leave blank to use Forge-hosted article pages at <code>forgeintelligence.ai/articles</code>.
                      Set this to your own domain and Forge will build all article URLs, UTM links, and canonical tags using it.
                    </span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Article URL Suffix <span className="bs-optional">optional</span></label>
                    <input className="bs-input" value={form.article_url_suffix || ''} onChange={e => set('article_url_suffix', e.target.value)} placeholder=".html" style={{ maxWidth: '160px' }} />
                    <span className="bs-field-hint">Append to every article URL — use <code>.html</code> for static sites. Leave blank for clean URLs (Ghost, WordPress, Webflow).</span>
                  </div>
                  <div className="bs-url-preview">
                    <span className="bs-url-preview-label">Article URL preview</span>
                    <code className="bs-url-preview-value">
                      {(form.article_base_url || `https://forgeintelligence.ai/articles/${activeBrand?.brandUrl?.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'your-brand'}`)
                        .replace(/\/+$/, '')}/your-article-title{form.article_url_suffix || ''}
                    </code>
                  </div>
                </div>
              </section>

              {/* Site Template */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Site Template</h2>
                  <p className="bs-section-sub">Paste a sample article URL and your catalog page URL. Forge will scrape the DOM structure so Smart Export HTML matches your site exactly.</p>
                </div>
                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">Sample Article URL <span className="bs-optional">required</span></label>
                    <input className="bs-input" value={articleTemplateUrl} onChange={e => setArticleTemplateUrl(e.target.value)} placeholder="https://yoursite.com/articles/any-article.html" />
                    <span className="bs-field-hint">Any published article on your site. Forge extracts class names and DOM structure only — no styling is copied.</span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Article Catalog URL <span className="bs-optional">optional</span></label>
                    <input className="bs-input" value={catalogTemplateUrl} onChange={e => setCatalogTemplateUrl(e.target.value)} placeholder="https://yoursite.com/articles" />
                    <span className="bs-field-hint">The page listing all your articles. Used to generate drop-in card HTML for Smart Export.</span>
                  </div>
                  <div className="bs-scrape-row">
                    {scrapeError && <span className="bs-error">{scrapeError}</span>}
                    {scrapeSuccess && <span className="bs-saved">✓ Template scraped — Smart Export HTML will now match your site structure</span>}
                    <button className="bs-scrape-btn" onClick={handleScrape} disabled={scraping || !articleTemplateUrl}>
                      <IconRefresh />
                      {scraping ? 'Scraping...' : 'Scrape Template'}
                    </button>
                  </div>
                </div>
              </section>

              {/* Voice Calibration */}
              {voiceAttrs.length > 0 && (
                <section className="bs-section">
                  <div className="bs-section-header">
                    <h2 className="bs-section-title">Voice Calibration</h2>
                    <p className="bs-section-sub">Fine-tune how your Brain interprets your brand voice. Adjustments take effect immediately — no re-analysis needed.</p>
                  </div>
                  <div className="bs-voice-sliders">
                    {voiceAttrs.map((attr, i) => (
                      <div key={attr.attribute} className="bs-voice-slider-row">
                        <div className="bs-voice-slider-header">
                          <span className="bs-voice-attr-name">{attr.attribute}</span>
                          <span className="bs-voice-attr-score" style={{ color: attr.score >= 75 ? 'var(--color-accent)' : attr.score >= 50 ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>{attr.score}</span>
                        </div>
                        <input
                          type="range" min={0} max={100} value={attr.score}
                          className="bs-voice-range"
                          onChange={e => setVoiceAttrs(prev => prev.map((a, j) => j === i ? { ...a, score: parseInt(e.target.value) } : a))}
                        />
                        {attr.description && <p className="bs-voice-attr-desc">{attr.description}</p>}
                      </div>
                    ))}
                  </div>
                  <div className="bs-voice-save-row">
                    {voiceSaved && <span className="bs-saved">✓ Voice profile updated</span>}
                    <button className="bs-save-btn" onClick={handleVoiceSave} disabled={voiceSaving}>
                      {voiceSaving ? 'Saving...' : 'Save Voice Calibration'}
                    </button>
                  </div>
                </section>
              )}

              {/* Email Preferences */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Email Preferences</h2>
                  <p className="bs-section-sub">Weekly Brain digest — what your Brain learned, top performers, decay alerts, and what to do next.</p>
                </div>
                <label className="bs-toggle-row">
                  <div>
                    <span className="bs-toggle-label">Weekly Brain Digest</span>
                    <span className="bs-toggle-hint">Sent every Monday · Unsubscribe anytime</span>
                  </div>
                  <button
                    className={`bs-toggle-btn ${!digestOptOut ? 'active' : ''}`}
                    onClick={() => handleDigestToggle(!digestOptOut)}
                    disabled={digestSaving}
                    title={digestOptOut ? 'Click to re-subscribe' : 'Click to unsubscribe'}
                  >
                    <span className="bs-toggle-knob" />
                  </button>
                </label>
              </section>

              {/* Plan & Billing */}
              <section className="bs-section bs-section-billing">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Plan & Billing</h2>
                  <p className="bs-section-sub">Your current plan and what's included.</p>
                </div>
                <div className="bs-billing-card">
                  <div className="bs-billing-top">
                    <div>
                      <div className="bs-plan-name">SMB Standard</div>
                      <div className="bs-plan-price">$99 <span className="bs-plan-price-sub">· one-time · lifetime access</span></div>
                      {activatedDate && <div className="bs-plan-since">Active since {activatedDate}</div>}
                    </div>
                    <div className="bs-plan-badge-active">Active</div>
                  </div>
                  <div className="bs-billing-includes">
                    <div className="bs-billing-includes-label">What's included</div>
                    <div className="bs-billing-features">
                      {[
                        'Full 8-stage content intelligence pipeline',
                        '1 brand Brain with compounding memory',
                        'Unlimited content generation',
                        'Multi-channel publishing (LinkedIn, X, Ghost, WordPress, Webflow, Facebook)',
                        'Pre-cog score badge on every article',
                        'Performance Dashboard with decay monitoring',
                        'Weekly Brain digest email',
                        'Pattern Extractor — Stage 8 feedback loop',
                      ].map(f => (
                        <div key={f} className="bs-billing-feature">
                          <span className="bs-billing-check"><IconCheck /></span>
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bs-billing-upgrade">
                    <div className="bs-billing-upgrade-label">Coming soon — Pro tier at $299/mo</div>
                    <div className="bs-billing-upgrade-sub">Full Pre-cog Predictions tab · Deep pattern analysis · HubSpot campaign attribution</div>
                  </div>
                </div>
              </section>

              {/* Danger Zone */}
              <section className="bs-section bs-section-danger">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Danger Zone</h2>
                  <p className="bs-section-sub">Irreversible actions. Proceed with caution.</p>
                </div>
                <div className="bs-danger-row">
                  <div>
                    <div className="bs-danger-label">Delete this brand</div>
                    <div className="bs-danger-sub">Permanently removes the brand profile, all generated content, campaigns, and publishing history.</div>
                  </div>
                  <button className="bs-danger-btn" disabled title="Coming soon">Delete Brand</button>
                </div>
              </section>

              {/* Save bar — Identity + Publishing fields only */}
              <div className="bs-save-bar">
                {error && <span className="bs-error">{error}</span>}
                {saved && <span className="bs-saved">✓ Saved</span>}
                <button className="bs-save-btn" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>

              {/* Reviewers Section */}
              <section style={{ marginTop: 32, padding: '24px', background: 'var(--color-bg-card, #fff)', borderRadius: 12, border: '1px solid var(--color-border, #e2e8f0)' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text, #1e293b)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reviewers</h3>
                <p style={{ fontSize: 13, color: 'var(--color-text-secondary, #64748b)', marginBottom: 16 }}>Reviewers receive an email with a unique link to approve or request changes on articles before publishing.</p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <input style={{ flex: 1, minWidth: 120, padding: '8px 12px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }} placeholder="Name" value={revName} onChange={e => setRevName(e.target.value)} />
                  <input style={{ flex: 1, minWidth: 160, padding: '8px 12px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }} placeholder="Email" type="email" value={revEmail} onChange={e => setRevEmail(e.target.value)} />
                  <input style={{ flex: 1, minWidth: 120, padding: '8px 12px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }} placeholder="Title (optional)" value={revTitle} onChange={e => setRevTitle(e.target.value)} />
                  <button onClick={addReviewer} disabled={revSaving} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: 'var(--color-accent, #4F46E5)', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {revSaving ? 'Adding...' : '+ Add'}
                  </button>
                </div>
                {revError && <div style={{ fontSize: 12, color: '#EF4444', marginBottom: 8 }}>{revError}</div>}
                {reviewers.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {reviewers.map(r => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--color-bg, #f8fafc)', borderRadius: 8, border: '1px solid var(--color-border, #e2e8f0)' }}>
                        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--color-accent, #4F46E5)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{r.name[0].toUpperCase()}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text, #1e293b)' }}>{r.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #64748b)' }}>{r.email}{r.title ? ` · ${r.title}` : ''}</div>
                        </div>
                        <button onClick={() => removeReviewer(r.id)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, padding: 4 }} title="Remove">✕</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #94a3b8)', textAlign: 'center', padding: '16px 0' }}>No reviewers added yet</div>
                )}
              </section>

            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
