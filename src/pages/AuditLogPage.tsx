import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { AppShell } from '../layouts/AppShell';

// Settings → Audit Log. Super-admin-only read + CSV export of the security /
// GDPR evidence trail (issue #25). Server enforces the super-admin gate; this
// page is also hidden from the nav for non-super-admins.

interface AuditRow {
  id: string;
  actor_clerk_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  brand_profile_id: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

const PAGE = 100;

export default function AuditLogPage() {
  const { getToken } = useAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actions, setActions] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // filters
  const [fAction, setFAction] = useState('');
  const [fActor, setFActor] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');

  const qs = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (fAction) p.set('action', fAction);
    if (fActor) p.set('actor', fActor.trim());
    if (fFrom) p.set('from', fFrom);
    if (fTo) p.set('to', fTo);
    Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    return p.toString();
  }, [fAction, fActor, fFrom, fTo]);

  const load = useCallback(async (off: number) => {
    setLoading(true); setError('');
    try {
      const token = await getToken();
      const r = await fetch(`/api/admin/audit-log?${qs({ limit: String(PAGE), offset: String(off) })}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
      setRows(d.rows); setTotal(d.total); setOffset(off);
    } catch (e) { setError(e instanceof Error ? e.message : 'Load failed'); }
    setLoading(false);
  }, [getToken, qs]);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      try {
        const r = await fetch('/api/admin/audit-log/actions', { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        if (d.success) setActions(d.actions || []);
      } catch { /* non-fatal */ }
    })();
    load(0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = async () => {
    const token = await getToken();
    const r = await fetch(`/api/admin/audit-log?${qs({ format: 'csv' })}`, { headers: { Authorization: `Bearer ${token}` } });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const S: Record<string, React.CSSProperties> = {
    page: { padding: '24px 28px', maxWidth: 1200, margin: '0 auto', color: '#0F172A' },
    bar: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', margin: '16px 0 20px' },
    field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#64748B' },
    input: { padding: '7px 10px', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#0F172A', background: '#fff' },
    btn: { padding: '8px 16px', borderRadius: 8, border: '1px solid #3563FF', background: '#3563FF', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    btnGhost: { padding: '8px 16px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #E2E8F0', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' },
    td: { padding: '8px 10px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'top' },
    chip: { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#3563FF', fontWeight: 600 },
    meta: { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, background: '#F8FAFC', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0 0' },
  };

  return (
    <AppShell pageTitle="Audit Log">
      <div style={S.page}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', color: '#3563FF' }}>SECURITY · GDPR</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 2px' }}>Audit Log</h1>
        <p style={{ color: '#64748B', fontSize: 14, margin: 0 }}>Privileged + data-access events. {total.toLocaleString()} total.</p>

        <div style={S.bar}>
          <label style={S.field}>Action
            <select style={S.input} value={fAction} onChange={e => setFAction(e.target.value)}>
              <option value="">All</option>
              {actions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label style={S.field}>Actor (clerk id or label)
            <input style={S.input} value={fActor} onChange={e => setFActor(e.target.value)} placeholder="user_… / admin-relay-password" />
          </label>
          <label style={S.field}>From
            <input style={S.input} type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} />
          </label>
          <label style={S.field}>To
            <input style={S.input} type="date" value={fTo} onChange={e => setFTo(e.target.value)} />
          </label>
          <button style={S.btn} onClick={() => load(0)}>Apply</button>
          <button style={S.btnGhost} onClick={() => { setFAction(''); setFActor(''); setFFrom(''); setFTo(''); setTimeout(() => load(0), 0); }}>Clear</button>
          <button style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={exportCsv}>Export CSV</button>
        </div>

        {error && <div style={{ color: '#DC2626', fontSize: 13, marginBottom: 12 }}>Error: {error}</div>}

        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Time</th><th style={S.th}>Actor</th><th style={S.th}>Action</th>
            <th style={S.th}>Target</th><th style={S.th}>Summary</th>
          </tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)} style={{ cursor: 'pointer' }}>
                <td style={{ ...S.td, whiteSpace: 'nowrap', color: '#64748B' }}>{fmt(row.created_at)}</td>
                <td style={{ ...S.td, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{row.actor_email || row.actor_clerk_user_id || '—'}</td>
                <td style={S.td}><span style={S.chip}>{row.action}</span></td>
                <td style={{ ...S.td, color: '#475569' }}>{row.target_type || ''}{row.target_id ? ` · ${row.target_id.slice(0, 12)}` : ''}</td>
                <td style={S.td}>
                  {row.summary || ''}
                  {expanded === row.id && (
                    <pre style={S.meta}>{JSON.stringify({ id: row.id, brand_profile_id: row.brand_profile_id, ip: row.ip, metadata: row.metadata }, null, 2)}</pre>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td style={{ ...S.td, color: '#94A3B8', textAlign: 'center', padding: 32 }} colSpan={5}>No audit events match these filters.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
          <button style={S.btnGhost} disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - PAGE))}>← Prev</button>
          <span style={{ fontSize: 13, color: '#64748B' }}>
            {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + PAGE, total)}`} of {total.toLocaleString()}
          </span>
          <button style={S.btnGhost} disabled={offset + PAGE >= total || loading} onClick={() => load(offset + PAGE)}>Next →</button>
          {loading && <span style={{ fontSize: 13, color: '#94A3B8' }}>Loading…</span>}
        </div>
      </div>
    </AppShell>
  );
}
