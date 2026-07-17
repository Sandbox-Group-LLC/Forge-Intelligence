// Mission Control — promo code admin (super-admin only; the server gates every
// route on SUPER_ADMIN_IDS). Mint custom or random codes, set discount / usage
// cap / expiry, see live redemption counts, activate/deactivate, delete.
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';

interface PromoCode {
  id: string;
  code: string;
  discount: number;
  description: string | null;
  max_uses: number | null;
  expires_at: string | null;
  active: boolean;
  created_at: string;
  used_count: number;
}

export default function PromoCodesPanel() {
  const { getToken } = useAuth();
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // Create form
  const [code, setCode] = useState('');
  const [discount, setDiscount] = useState('100');
  const [description, setDescription] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);

  const authed = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getToken();
    return fetch(path, { ...init, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  }, [getToken]);

  const load = useCallback(async () => {
    try {
      const r = await authed('/api/admin/promo-codes');
      const d = await r.json();
      if (d.success) setCodes(d.codes || []);
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  }, [authed]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true); setErr('');
    try {
      const r = await authed('/api/admin/promo-codes', {
        method: 'POST',
        body: JSON.stringify({
          code: code.trim() || undefined,
          discount,
          description: description.trim() || undefined,
          maxUses: maxUses.trim() || undefined,
          expiresAt: expiresAt || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Failed to create code'); }
      else {
        setCode(''); setDescription(''); setMaxUses(''); setExpiresAt(''); setDiscount('100');
        await load();
      }
    } catch (e: any) { setErr(e.message); }
    setCreating(false);
  };

  const toggle = async (c: PromoCode) => {
    await authed(`/api/admin/promo-codes/${c.id}`, { method: 'PATCH', body: JSON.stringify({ active: !c.active }) });
    load();
  };

  const remove = async (c: PromoCode) => {
    if (!window.confirm(`Delete promo code ${c.code}? Its ${c.used_count} redemption(s) stay on the brands that used it.`)) return;
    await authed(`/api/admin/promo-codes/${c.id}`, { method: 'DELETE' });
    load();
  };

  const label = { fontSize: '0.68rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 4, display: 'block' };
  const input: React.CSSProperties = { width: '100%', height: 34, padding: '0 10px', fontSize: '0.82rem', border: '1px solid var(--color-border-input)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-card)', color: 'var(--color-text-primary)', fontFamily: 'inherit', boxSizing: 'border-box' };

  return (
    <div className="mc-panel">
      <div className="mc-panel-header">
        <div className="mc-panel-title">Promo Codes</div>
        <div className="mc-panel-meta">{codes.length} code{codes.length === 1 ? '' : 's'}</div>
      </div>

      {/* Create form */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--color-border-subtle)' }}>
        <div>
          <label style={label}>Code <span style={{ color: 'var(--color-text-muted)', fontWeight: 400, textTransform: 'none' }}>(blank = random)</span></label>
          <input style={input} value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="AUTO-GENERATE" />
        </div>
        <div>
          <label style={label}>Discount %</label>
          <input style={input} type="number" min={0} max={100} value={discount} onChange={e => setDiscount(e.target.value)} />
        </div>
        <div>
          <label style={label}>Description</label>
          <input style={input} value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Acme Partnership" />
        </div>
        <div>
          <label style={label}>Max uses <span style={{ color: 'var(--color-text-muted)', fontWeight: 400, textTransform: 'none' }}>(blank = ∞)</span></label>
          <input style={input} type="number" min={1} value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="Unlimited" />
        </div>
        <div>
          <label style={label}>Expires <span style={{ color: 'var(--color-text-muted)', fontWeight: 400, textTransform: 'none' }}>(blank = never)</span></label>
          <input style={input} type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button
            onClick={create}
            disabled={creating}
            style={{ width: '100%', height: 34, background: 'var(--color-accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', fontWeight: 600, cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.6 : 1, fontFamily: 'inherit' }}
          >
            {creating ? 'Creating…' : (code.trim() ? 'Create Code' : 'Generate Code')}
          </button>
        </div>
      </div>

      {err && <div style={{ color: 'var(--color-error)', fontSize: '0.8rem', padding: '10px 0' }}>{err}</div>}

      {/* List */}
      {loading ? (
        <div className="mc-empty">Loading…</div>
      ) : codes.length === 0 ? (
        <div className="mc-empty">No promo codes yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12 }}>
          {codes.map(c => {
            const expired = c.expires_at && new Date(c.expires_at) < new Date();
            const capped = c.max_uses != null && c.used_count >= c.max_uses;
            const live = c.active && !expired && !capped;
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
                <code style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--color-text-emphasis)', letterSpacing: '0.03em' }}>{c.code}</code>
                <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-accent)', background: 'var(--color-accent-muted)', padding: '2px 7px', borderRadius: 'var(--radius-sm)' }}>{c.discount}% off</span>
                <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', flex: 1, minWidth: 120 }}>{c.description || '—'}</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {c.used_count}{c.max_uses != null ? ` / ${c.max_uses}` : ''} used
                </span>
                {c.expires_at && (
                  <span style={{ fontSize: '0.7rem', color: expired ? 'var(--color-error)' : 'var(--color-text-muted)' }}>
                    {expired ? 'expired' : `exp ${new Date(c.expires_at).toLocaleDateString()}`}
                  </span>
                )}
                <span style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 'var(--radius-sm)', color: live ? 'var(--color-success)' : 'var(--color-text-muted)', background: live ? 'var(--color-success-muted)' : 'var(--color-bg-hover)' }}>
                  {live ? 'Live' : !c.active ? 'Off' : capped ? 'Capped' : 'Expired'}
                </span>
                <button onClick={() => toggle(c)} style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
                  {c.active ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => remove(c)} title="Delete" style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-error)', background: 'transparent', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
