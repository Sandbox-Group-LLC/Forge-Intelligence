import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { AppShell } from '../layouts/AppShell';

// Settings → Data Requests. Super-admin DSAR tool (GDPR Art. 15/17/20, #25).
// Lookup a person by email/name across Forge's reachable PII (reviewers,
// support tickets, Factual Ground authors), export the bundle, or erase.
// Server enforces the super-admin gate + writes every action to the audit log.

interface DsarData {
  reviewers: Array<{ id: string; brand_profile_id: string; name: string; email: string; title: string; created_at: string }>;
  supportTickets: Array<{ id: string; brand_profile_id: string; user_email: string; subject: string; status: string; created_at: string }>;
  factualGroundAuthors: Array<{ brand_profile_id: string; brand_name: string; matches: Array<Record<string, unknown>> }>;
}
interface LookupResp {
  subject: { email: string | null; name: string | null };
  counts: { reviewers: number; supportTickets: number; factualGroundAuthors: number };
  data: DsarData;
  note: string;
}

export default function DataRequestsPage() {
  const { getToken } = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<LookupResp | null>(null);
  const [erased, setErased] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const call = async (path: string, body: Record<string, unknown>) => {
    const token = await getToken();
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  const lookup = async () => {
    setBusy(true); setError(''); setErased(null); setResult(null);
    try { setResult(await call('/api/admin/dsar/lookup', { email: email.trim(), name: name.trim() })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Lookup failed'); }
    setBusy(false);
  };

  const total = result ? result.counts.reviewers + result.counts.supportTickets + result.counts.factualGroundAuthors : 0;

  const erase = async () => {
    if (!window.confirm(`Permanently erase all reachable PII for ${email || name}? This deletes reviewer rows, redacts support tickets, and removes Factual Ground authors. Logged to the audit trail. This cannot be undone.`)) return;
    setBusy(true); setError('');
    try {
      const d = await call('/api/admin/dsar/erase', { email: email.trim(), name: name.trim(), confirm: true });
      setErased(d.result); setResult(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Erase failed'); }
    setBusy(false);
  };

  const exportJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dsar-${(email || name).replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const S: Record<string, React.CSSProperties> = {
    page: { padding: '24px 28px', maxWidth: 1000, margin: '0 auto', color: '#0F172A' },
    bar: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', margin: '16px 0' },
    field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#64748B' },
    input: { padding: '8px 10px', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, minWidth: 240, background: '#fff' },
    btn: { padding: '9px 18px', borderRadius: 8, border: '1px solid #3563FF', background: '#3563FF', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    btnGhost: { padding: '9px 18px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    btnDanger: { padding: '9px 18px', borderRadius: 8, border: '1px solid #DC2626', background: '#fff', color: '#DC2626', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    card: { border: '1px solid #E2E8F0', borderRadius: 10, padding: 16, margin: '12px 0' },
    h3: { fontSize: 14, fontWeight: 700, margin: '0 0 8px' },
    note: { fontSize: 12, color: '#92400E', background: '#FEF3C7', padding: '10px 12px', borderRadius: 8, margin: '12px 0' },
    pre: { fontFamily: 'JetBrains Mono, monospace', fontSize: 12, background: '#F8FAFC', padding: 12, borderRadius: 8, overflow: 'auto', whiteSpace: 'pre-wrap' },
  };

  return (
    <AppShell pageTitle="Data Requests">
      <div style={S.page}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', color: '#3563FF' }}>GDPR · DSAR</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 2px' }}>Data Requests</h1>
        <p style={{ color: '#64748B', fontSize: 14, margin: 0 }}>Access, export, or erase a person's data across reviewers, support tickets, and Factual Ground authors. Every action is logged to the Audit Log.</p>

        <div style={S.bar}>
          <label style={S.field}>Email
            <input style={S.input} value={email} onChange={e => setEmail(e.target.value)} placeholder="person@example.com" />
          </label>
          <label style={S.field}>Name (matches authors / reviewers)
            <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" />
          </label>
          <button style={S.btn} onClick={lookup} disabled={busy || (!email.trim() && !name.trim())}>Look up</button>
        </div>

        {error && <div style={{ color: '#DC2626', fontSize: 13 }}>Error: {error}</div>}
        {busy && <div style={{ color: '#94A3B8', fontSize: 13 }}>Working…</div>}

        {erased && (
          <div style={{ ...S.card, borderColor: '#16A34A' }}>
            <div style={S.h3}>Erasure complete</div>
            <pre style={S.pre}>{JSON.stringify(erased, null, 2)}</pre>
          </div>
        )}

        {result && (
          <>
            <div style={S.bar}>
              <strong style={{ fontSize: 15 }}>{total} record{total === 1 ? '' : 's'} found</strong>
              <span style={{ flex: 1 }} />
              <button style={S.btnGhost} onClick={exportJson} disabled={total === 0}>Export JSON</button>
              <button style={S.btnDanger} onClick={erase} disabled={total === 0}>Erase all</button>
            </div>
            <div style={S.note}>{result.note}</div>

            <div style={S.card}>
              <div style={S.h3}>Reviewers ({result.counts.reviewers})</div>
              {result.data.reviewers.length === 0 ? <div style={{ color: '#94A3B8', fontSize: 13 }}>None.</div> :
                result.data.reviewers.map(r => <div key={r.id} style={{ fontSize: 13, padding: '4px 0' }}>{r.name} · {r.email} · {r.title || '—'} <span style={{ color: '#94A3B8' }}>(brand {r.brand_profile_id.slice(0, 8)})</span></div>)}
            </div>
            <div style={S.card}>
              <div style={S.h3}>Support tickets ({result.counts.supportTickets})</div>
              {result.data.supportTickets.length === 0 ? <div style={{ color: '#94A3B8', fontSize: 13 }}>None.</div> :
                result.data.supportTickets.map(t => <div key={t.id} style={{ fontSize: 13, padding: '4px 0' }}>{t.subject} · {t.status} <span style={{ color: '#94A3B8' }}>({new Date(t.created_at).toLocaleDateString()})</span></div>)}
            </div>
            <div style={S.card}>
              <div style={S.h3}>Factual Ground authors ({result.counts.factualGroundAuthors})</div>
              {result.data.factualGroundAuthors.length === 0 ? <div style={{ color: '#94A3B8', fontSize: 13 }}>None.</div> :
                result.data.factualGroundAuthors.map(b => <div key={b.brand_profile_id} style={{ fontSize: 13, padding: '4px 0' }}>{b.matches.length} in <strong>{b.brand_name}</strong></div>)}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
