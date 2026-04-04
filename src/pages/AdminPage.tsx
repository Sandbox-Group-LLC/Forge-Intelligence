import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './AdminPage.css';

interface Stats {
  totalReach: number;
  totalContent: number;
  totalQueued: number;
  totalPublished: number;
  avgConfidence: number;
}

interface Reviewer {
  id: string;
  name: string;
  email: string;
  title: string;
}

interface Brand { id: string; brandName?: string; brandUrl?: string; }

function fmt(n: number) {
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n/1000).toFixed(1)}K`;
  return String(Math.round(n));
}

export default function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selectedBrand, setSelectedBrand] = useState('');
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/stats').then(r => r.json()).then(d => { if (d.success) setStats(d.stats); });
    fetch('/api/context-hub/brains').then(r => r.json()).then(d => {
      if (d.success) { setBrands(d.data || []); if (d.data?.length) setSelectedBrand(d.data[0].id); }
    });
  }, []);

  useEffect(() => {
    if (!selectedBrand) return;
    fetch(`/api/reviewers/${selectedBrand}`).then(r => r.json()).then(d => {
      if (d.success) setReviewers(d.reviewers);
    });
  }, [selectedBrand]);

  const addReviewer = async () => {
    if (!name.trim() || !email.trim()) { setError('Name and email required'); return; }
    setSaving(true); setError('');
    const r = await fetch('/api/reviewers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandProfileId: selectedBrand, name: name.trim(), email: email.trim(), title: title.trim() })
    });
    const d = await r.json();
    if (d.success) {
      setReviewers(prev => [...prev, d.reviewer]);
      setName(''); setEmail(''); setTitle('');
    } else { setError(d.error || 'Failed to add reviewer'); }
    setSaving(false);
  };

  const removeReviewer = async (id: string) => {
    await fetch(`/api/reviewers/${id}`, { method: 'DELETE' });
    setReviewers(prev => prev.filter(r => r.id !== id));
  };

  return (
    <AppShell pageTitle="Admin">
      <div className="admin-page">
        <div className="geo-header" style={{ marginBottom: 32 }}>
          <div>
            <div className="geo-eyebrow">System</div>
            <h1 className="geo-title">Admin</h1>
            <p className="geo-description">Platform overview and reviewer management.</p>
          </div>
        </div>

        {/* KPI Cards */}
        {stats && (
          <div className="admin-kpi-grid">
            <div className="admin-kpi-card">
              <div className="admin-kpi-icon">👁</div>
              <div className="admin-kpi-value">{fmt(stats.totalReach)}</div>
              <div className="admin-kpi-label">Total Reach</div>
            </div>
            <div className="admin-kpi-card">
              <div className="admin-kpi-icon">✦</div>
              <div className="admin-kpi-value">{fmt(stats.totalContent)}</div>
              <div className="admin-kpi-label">Articles Generated</div>
            </div>
            <div className="admin-kpi-card">
              <div className="admin-kpi-icon">↗</div>
              <div className="admin-kpi-value">{fmt(stats.totalPublished)}</div>
              <div className="admin-kpi-label">Published</div>
            </div>
            <div className="admin-kpi-card">
              <div className="admin-kpi-icon">◈</div>
              <div className="admin-kpi-value">{stats.avgConfidence ? `${Math.round(stats.avgConfidence)}%` : '—'}</div>
              <div className="admin-kpi-label">Avg Confidence</div>
            </div>
          </div>
        )}

        {/* Reviewer Management */}
        <div className="admin-section">
          <div className="admin-section-header">
            <div className="admin-section-title">Reviewers</div>
            {brands.length > 1 && (
              <select className="geo-select" style={{ fontSize: '0.8125rem', padding: '6px 10px' }}
                value={selectedBrand} onChange={e => setSelectedBrand(e.target.value)}>
                {brands.map(b => <option key={b.id} value={b.id}>{b.brandName || b.brandUrl}</option>)}
              </select>
            )}
          </div>

          <p className="admin-desc">Reviewers receive an email with a unique link to approve or request changes on articles before they publish. No Forge account required.</p>

          {/* Add reviewer form */}
          <div className="admin-reviewer-form">
            <input className="admin-input" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
            <input className="admin-input" placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            <input className="admin-input" placeholder="Title (optional)" value={title} onChange={e => setTitle(e.target.value)} />
            <button className="admin-add-btn" onClick={addReviewer} disabled={saving}>
              {saving ? 'Adding...' : '+ Add Reviewer'}
            </button>
          </div>
          {error && <div className="geo-error">{error}</div>}

          {/* Reviewer list */}
          {reviewers.length === 0 ? (
            <div className="admin-empty">No reviewers added yet. Add one above to enable the approval workflow.</div>
          ) : (
            <div className="admin-reviewer-list">
              {reviewers.map(r => (
                <div key={r.id} className="admin-reviewer-row">
                  <div className="admin-reviewer-avatar">{r.name[0].toUpperCase()}</div>
                  <div className="admin-reviewer-info">
                    <div className="admin-reviewer-name">{r.name}</div>
                    <div className="admin-reviewer-meta">{r.email}{r.title ? ` · ${r.title}` : ''}</div>
                  </div>
                  <button className="admin-remove-btn" onClick={() => removeReviewer(r.id)} title="Remove reviewer">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
