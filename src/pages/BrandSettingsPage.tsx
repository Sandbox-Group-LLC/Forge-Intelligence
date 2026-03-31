import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import './BrandSettingsPage.css';

interface BrandSettings {
  id: string;
  brand_name: string;
  brand_url: string;
  article_base_url: string;
  logo_url: string;
  settings: Record<string, any>;
}

export default function BrandSettingsPage() {
  const [brands, setBrands] = useState<BrandSettings[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [form, setForm] = useState<Partial<BrandSettings>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const loadBrands = useCallback(async () => {
    try {
      const r = await fetch('/api/context-hub/brains').then(r => r.json());
      const list = r.success ? (r.data || []) : [];
      setBrands(list);
      if (list.length > 0 && !selected) setSelected(list[0].id);
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { loadBrands(); }, []);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/brand-settings/${selected}`)
      .then(r => r.json())
      .then(d => { if (d.success) setForm(d.settings); });
  }, [selected]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const r = await fetch(`/api/brand-settings/${selected}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandName: form.brand_name,
          articleBaseUrl: form.article_base_url,
          logoUrl: form.logo_url,
        })
      });
      const d = await r.json();
      if (d.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        setError(d.error || 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof BrandSettings, val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const activeBrand = brands.find(b => b.id === selected);

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

        {loading ? (
          <div className="bs-loading">Loading...</div>
        ) : brands.length === 0 ? (
          <div className="bs-empty">No brands found. Run a Brain analysis first to create a brand profile.</div>
        ) : (
          <div className="bs-layout">
            {/* Brand selector — left rail if multiple brands */}
            {brands.length > 1 && (
              <div className="bs-brand-rail">
                {brands.map(b => (
                  <button
                    key={b.id}
                    className={`bs-brand-btn ${selected === b.id ? 'active' : ''}`}
                    onClick={() => setSelected(b.id)}
                  >
                    <span className="bs-brand-initial">
                      {(b.brand_name || b.brand_url || '?')[0].toUpperCase()}
                    </span>
                    <span className="bs-brand-name">{b.brand_name || b.brand_url}</span>
                  </button>
                ))}
              </div>
            )}

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
                    <input
                      className="bs-input"
                      value={form.brand_name || ''}
                      onChange={e => set('brand_name', e.target.value)}
                      placeholder="Acme Corp"
                    />
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Brand URL</label>
                    <input
                      className="bs-input bs-input-readonly"
                      value={form.brand_url || ''}
                      readOnly
                      title="Set during Brain analysis — cannot be changed here"
                    />
                    <span className="bs-field-hint">Set during Brain analysis. To change, run a new analysis.</span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Logo URL <span className="bs-optional">optional</span></label>
                    <input
                      className="bs-input"
                      value={form.logo_url || ''}
                      onChange={e => set('logo_url', e.target.value)}
                      placeholder="https://yoursite.com/logo.png"
                    />
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
                    <input
                      className="bs-input"
                      value={form.article_base_url || ''}
                      onChange={e => set('article_base_url', e.target.value)}
                      placeholder="https://yoursite.com/articles"
                    />
                    <span className="bs-field-hint">
                      Leave blank to use Forge-hosted article pages at <code>dev.forgeintelligence.ai/articles</code>.
                      Set this to your own domain and Forge will build all article URLs, UTM links, and canonical tags using it.
                    </span>
                  </div>
                  <div className="bs-url-preview">
                    <span className="bs-url-preview-label">Article URL preview</span>
                    <code className="bs-url-preview-value">
                      {(form.article_base_url || `https://dev.forgeintelligence.ai/articles/${activeBrand?.brand_url?.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'your-brand'}`)
                        .replace(/\/+$/, '')}/your-article-title
                    </code>
                  </div>
                </div>
              </section>

              {/* Billing — stub */}
              <section className="bs-section bs-section-billing">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Plan & Billing</h2>
                  <p className="bs-section-sub">Manage your subscription and usage.</p>
                </div>
                <div className="bs-billing-stub">
                  <div className="bs-plan-badge">Forge Intelligence — Development</div>
                  <p className="bs-billing-note">Billing management coming in a future release.</p>
                </div>
              </section>

              {/* Danger zone */}
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

              {/* Save bar */}
              <div className="bs-save-bar">
                {error && <span className="bs-error">{error}</span>}
                {saved && <span className="bs-saved">✓ Saved</span>}
                <button
                  className="bs-save-btn"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
