// Mission Control — Substack read-only test harness (super-admin only; the
// server gates every route on SUPER_ADMIN_IDS). Substack has no official API;
// this replays its private /api/v1/* GET endpoints against one of our brands'
// publications, authed by a connect.sid cookie. GET-only by design — a test
// cannot mutate or blast subscribers. The cookie is stored write-only.
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';

const PRESETS: { label: string; path: string; useCookie: boolean }[] = [
  { label: 'Recent posts (public)', path: '/api/v1/archive?sort=new&limit=20', useCookie: false },
  { label: 'Publication (public)', path: '/api/v1/publication', useCookie: false },
  { label: 'Subscriber count (auth)', path: '/api/v1/subscriber_count', useCookie: true },
  { label: 'My subscriptions (auth)', path: '/api/v1/subscriptions', useCookie: true },
];

export default function SubstackPanel() {
  const { getToken } = useAuth();
  const { allBrands, isSuperAdmin } = useApp();

  const [brandId, setBrandId] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [cookie, setCookie] = useState('');
  const [hasCookie, setHasCookie] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [path, setPath] = useState(PRESETS[0].path);
  const [useCookie, setUseCookie] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  const authed = useCallback(async (p: string, init: RequestInit = {}) => {
    const token = await getToken();
    return fetch(p, { ...init, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  }, [getToken]);

  const loadConfig = useCallback(async (id: string) => {
    setSubdomain(''); setHasCookie(false); setConfigured(false); setResult(null); setErr('');
    if (!id) return;
    try {
      const r = await authed(`/api/admin/substack/${id}`);
      const d = await r.json();
      if (d.configured) { setSubdomain(d.subdomain || ''); setHasCookie(!!d.hasCookie); setConfigured(true); }
    } catch (e: any) { setErr(e.message); }
  }, [authed]);

  useEffect(() => { loadConfig(brandId); }, [brandId, loadConfig]);

  const save = async () => {
    setBusy(true); setErr(''); setSavedMsg('');
    try {
      const r = await authed(`/api/admin/substack/${brandId}`, { method: 'POST', body: JSON.stringify({ subdomain, cookie: cookie.trim() || undefined }) });
      const d = await r.json();
      if (!r.ok) setErr(d.error || 'Save failed');
      else { setCookie(''); setSavedMsg('Saved.'); await loadConfig(brandId); }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  const run = async () => {
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await authed(`/api/admin/substack/${brandId}/get`, { method: 'POST', body: JSON.stringify({ path, useCookie }) });
      const d = await r.json();
      if (!r.ok) setErr(d.error || 'Request failed');
      else setResult(d);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  if (!isSuperAdmin) return null;

  const label = { fontSize: '0.68rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 4, display: 'block' };
  const input: React.CSSProperties = { width: '100%', height: 34, padding: '0 10px', fontSize: '0.82rem', border: '1px solid var(--color-border-input)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-card)', color: 'var(--color-text-primary)', fontFamily: 'inherit', boxSizing: 'border-box' };

  return (
    <div className="mc-panel">
      <div className="mc-panel-header">
        <div className="mc-panel-title">Substack <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--color-warning)', background: 'var(--color-warning-muted)', padding: '2px 6px', borderRadius: 'var(--radius-sm)', marginLeft: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Experimental</span></div>
        <div className="mc-panel-meta">read-only test harness</div>
      </div>

      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', background: 'var(--color-warning-muted)', border: '1px solid rgba(217,119,6,0.22)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: '12px 0', lineHeight: 1.5 }}>
        Unofficial API. The <code>connect.sid</code> cookie is a full-access session token (valid for months, survives MFA). Stored write-only, super-admin-only, GET-only (no writes possible here). Use a Sandbox account, and rotate the cookie (sign out/in) periodically.
      </div>

      {/* Brand + config */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, paddingBottom: 14, borderBottom: '1px solid var(--color-border-subtle)' }}>
        <div>
          <label style={label}>Brand</label>
          <select style={input} value={brandId} onChange={e => setBrandId(e.target.value)}>
            <option value="">Select a brand…</option>
            {(allBrands || []).map(b => <option key={b.id} value={b.id}>{b.brandName}{b.isPaid ? ' (paid)' : ''}</option>)}
          </select>
        </div>
        <div>
          <label style={label}>Publication subdomain</label>
          <input style={input} value={subdomain} onChange={e => setSubdomain(e.target.value)} placeholder="e.g. acme  (from acme.substack.com)" disabled={!brandId} />
        </div>
        <div>
          <label style={label}>connect.sid cookie {hasCookie && <span style={{ color: 'var(--color-success)', fontWeight: 400, textTransform: 'none' }}>· stored</span>}</label>
          <input style={input} type="password" value={cookie} onChange={e => setCookie(e.target.value)} placeholder={hasCookie ? '•••••• (leave blank to keep)' : 'paste connect.sid value'} disabled={!brandId} autoComplete="off" />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button onClick={save} disabled={!brandId || !subdomain.trim() || busy} style={{ height: 34, padding: '0 16px', background: 'var(--color-accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', opacity: (!brandId || !subdomain.trim() || busy) ? 0.5 : 1, fontFamily: 'inherit' }}>Save</button>
          {savedMsg && <span style={{ fontSize: '0.75rem', color: 'var(--color-success)', alignSelf: 'center' }}>{savedMsg}</span>}
        </div>
      </div>

      {/* Request runner */}
      <div style={{ paddingTop: 14 }}>
        <label style={label}>Run a GET request</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {PRESETS.map(p => (
            <button key={p.path} onClick={() => { setPath(p.path); setUseCookie(p.useCookie); }} style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>{p.label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...input, flex: 1, minWidth: 220, fontFamily: 'var(--font-mono, monospace)', fontSize: '0.76rem' }} value={path} onChange={e => setPath(e.target.value)} placeholder="/api/v1/…" disabled={!configured} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={useCookie} onChange={e => setUseCookie(e.target.checked)} /> use cookie
          </label>
          <button onClick={run} disabled={!configured || busy} style={{ height: 34, padding: '0 16px', background: 'var(--color-accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', opacity: (!configured || busy) ? 0.5 : 1, fontFamily: 'inherit' }}>{busy ? 'Running…' : 'Run GET'}</button>
        </div>
      </div>

      {err && <div style={{ color: 'var(--color-error)', fontSize: '0.8rem', paddingTop: 10 }}>{err}</div>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginBottom: 6 }}>
            HTTP {result.status} {result.ok ? '✓' : '✕'}
          </div>
          <pre style={{ maxHeight: 360, overflow: 'auto', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, fontSize: '0.72rem', lineHeight: 1.5, color: 'var(--color-text-primary)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {result.json ? JSON.stringify(result.json, null, 2) : (result.raw || '(empty response)')}
          </pre>
        </div>
      )}
    </div>
  );
}
