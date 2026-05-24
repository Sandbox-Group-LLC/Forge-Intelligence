import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './ContentGeneratorPage.css';

interface Brain { id: string; brandName: string; brandUrl: string }

interface PackItem { text: string; anchor: string; length: number; overLimit: boolean }
interface AssetPack {
  headlines: PackItem[];
  descriptions: PackItem[];
  paths: string[];
  notes: string;
  finalUrl: string;
  topic: string;
  generatedAt: string;
}

const Copy = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);
const Download = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const Zap = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

function AdsGeneratorContent() {
  const { historyEntries, activeBrand, authToken } = useApp();
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [topic, setTopic] = useState('');
  const [finalUrl, setFinalUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [pack, setPack] = useState<AssetPack | null>(null);
  const [overages, setOverages] = useState(0);
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));
  if (brains.length === 0 && activeBrand) {
    brains.push({ id: activeBrand.id, brandName: activeBrand.brandName || activeBrand.brandUrl, brandUrl: activeBrand.brandUrl });
  }

  useEffect(() => {
    const id = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
    if (id) setSelectedBrainId(id);
  }, []);
  useEffect(() => { if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id); }, [activeBrand?.id]);

  const run = async () => {
    if (!selectedBrainId || !topic.trim() || running) return;
    setRunning(true); setPack(null); setOverages(0); setError('');
    try {
      const r = await fetch('/api/ads-generator/rsa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topic: topic.trim(), finalUrl: finalUrl.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Generation failed');
      setPack(d.pack);
      setOverages(d.overages || 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(k => k === key ? null : k), 1200);
    } catch {}
  };

  // Google Ads bulk-upload CSV — one row per asset. Format matches Google Ads
  // Editor / Google Ads UI's bulk-upload spec at the asset level so the user
  // can paste headlines/descriptions in directly without per-row reformatting.
  const downloadCSV = () => {
    if (!pack) return;
    const rows: string[] = ['Asset Type,Asset Text,Final URL,Path 1,Path 2'];
    pack.headlines.forEach(h => rows.push(`Headline,"${h.text.replace(/"/g, '""')}","${pack.finalUrl}","${pack.paths[0] || ''}","${pack.paths[1] || ''}"`));
    pack.descriptions.forEach(d => rows.push(`Description,"${d.text.replace(/"/g, '""')}","${pack.finalUrl}","${pack.paths[0] || ''}","${pack.paths[1] || ''}"`));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rsa-pack-${pack.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyAllHeadlines = () => pack && copy(pack.headlines.map(h => h.text).join('\n'), 'all-h');
  const copyAllDescriptions = () => pack && copy(pack.descriptions.map(d => d.text).join('\n'), 'all-d');

  return (
    <div className="geo-content">
      <div className="geo-header">
        <div>
          <div className="geo-eyebrow">Stage 4.7 · PoC</div>
          <h1 className="geo-title">Ads Generator</h1>
          <p className="geo-description">
            Google Responsive Search Ads asset pack — 15 headlines, 4 descriptions, 2 display paths — anchored to your brain, GEO territories, and Factual Ground. Paste straight into Google Ads or export as CSV.
          </p>
        </div>
      </div>

      {!running && !pack && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {brains.length > 1 && (
            <div className="geo-input-bar">
              <div className="geo-select-wrap" style={{ flex: 1 }}>
                <select className="geo-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
                  <option value="">Select a Brain...</option>
                  {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="geo-input-bar">
            <div style={{ flex: 1 }}>
              <input
                className="geo-input"
                placeholder="Ad group theme (e.g. Context Agent Architecture, AI content intelligence)"
                value={topic}
                onChange={e => setTopic(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <div className="geo-input-bar">
            <div style={{ flex: 1 }}>
              <input
                className="geo-input"
                placeholder="Final URL (optional — used for CSV export and display path inference)"
                value={finalUrl}
                onChange={e => setFinalUrl(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <button
              className="geo-run-btn"
              onClick={run}
              disabled={!selectedBrainId || !topic.trim() || running}
            >
              <Zap size={14} /> Generate RSA pack
            </button>
          </div>
          {error && <div style={{ color: '#EF4444', fontSize: 13, padding: '8px 4px' }}>{error}</div>}
        </div>
      )}

      {running && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 16px', color: 'var(--color-text-muted, #94a3b8)', fontSize: 14 }}>
          <div style={{ width: 14, height: 14, border: '2px solid var(--color-border, #e2e8f0)', borderTopColor: 'var(--color-accent, #6366F1)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          Generating asset pack — brain-anchored, char-budget-enforced…
        </div>
      )}

      {pack && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pack for</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{pack.topic}</div>
              {pack.finalUrl && <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #475569)', marginTop: 2 }}>→ {pack.finalUrl}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={downloadCSV} style={btnStyle}><Download size={14} /> CSV</button>
              <button onClick={() => { setPack(null); setOverages(0); }} style={btnStyle}>New pack</button>
            </div>
          </div>

          {overages > 0 && (
            <div style={{ padding: 12, background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 8, fontSize: 13, color: '#92400E' }}>
              ⚠ {overages} asset(s) exceeded the character limit. Regenerate or edit before pasting into Google Ads.
            </div>
          )}

          {pack.notes && (
            <div style={{ padding: 14, background: 'var(--color-accent-muted, #eef2ff)', borderRadius: 8, fontSize: 13, color: 'var(--color-text-secondary, #475569)' }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted, #94a3b8)', marginBottom: 4 }}>Angle strategy</div>
              {pack.notes}
            </div>
          )}

          <section>
            <div style={sectionHeader}>
              <span>Headlines · {pack.headlines.length} / 15 · 30 char max</span>
              <button onClick={copyAllHeadlines} style={smallBtn}><Copy size={12} /> {copiedKey === 'all-h' ? 'Copied' : 'Copy all'}</button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {pack.headlines.map((h, i) => (
                <AssetRow
                  key={`h${i}`}
                  index={i + 1}
                  text={h.text}
                  anchor={h.anchor}
                  length={h.length}
                  limit={30}
                  overLimit={h.overLimit}
                  onCopy={() => copy(h.text, `h${i}`)}
                  copied={copiedKey === `h${i}`}
                />
              ))}
            </div>
          </section>

          <section>
            <div style={sectionHeader}>
              <span>Descriptions · {pack.descriptions.length} / 4 · 90 char max</span>
              <button onClick={copyAllDescriptions} style={smallBtn}><Copy size={12} /> {copiedKey === 'all-d' ? 'Copied' : 'Copy all'}</button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {pack.descriptions.map((d, i) => (
                <AssetRow
                  key={`d${i}`}
                  index={i + 1}
                  text={d.text}
                  anchor={d.anchor}
                  length={d.length}
                  limit={90}
                  overLimit={d.overLimit}
                  onCopy={() => copy(d.text, `d${i}`)}
                  copied={copiedKey === `d${i}`}
                />
              ))}
            </div>
          </section>

          {pack.paths.length > 0 && (
            <section>
              <div style={sectionHeader}>
                <span>Display paths · {pack.paths.length} / 2 · 15 char max</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {pack.paths.map((p, i) => (
                  <div key={`p${i}`} style={{ padding: '8px 12px', background: 'var(--color-bg-card, #fff)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
                    /{p}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function AssetRow({ index, text, anchor, length, limit, overLimit, onCopy, copied }: {
  index: number; text: string; anchor: string; length: number; limit: number;
  overLimit: boolean; onCopy: () => void; copied: boolean;
}) {
  const pct = Math.min(100, (length / limit) * 100);
  const pctColor = overLimit ? '#EF4444' : pct > 85 ? '#F5B942' : '#10B981';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 10, alignItems: 'flex-start',
      padding: 10, background: 'var(--color-bg-card, #fff)',
      border: overLimit ? '1px solid #FCA5A5' : '1px solid var(--color-border, #e2e8f0)',
      borderRadius: 8,
    }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', paddingTop: 2 }}>{index}</div>
      <div>
        <div style={{ fontSize: 14, lineHeight: 1.4, color: overLimit ? '#991B1B' : 'inherit' }}>{text}</div>
        {anchor && <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', marginTop: 4 }}>{anchor}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <div style={{ fontSize: 11, color: pctColor, fontFamily: 'ui-monospace, monospace' }}>{length}/{limit}</div>
        <button onClick={onCopy} style={{ ...smallBtn, padding: '4px 8px' }}>
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px',
  fontSize: 13, fontWeight: 500, border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6, background: 'var(--color-bg-card, #fff)',
  color: 'var(--color-text-primary, #1a1a1a)', cursor: 'pointer',
};
const smallBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px',
  fontSize: 11, fontWeight: 500, border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6, background: 'transparent',
  color: 'var(--color-text-secondary, #475569)', cursor: 'pointer',
};
const sectionHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 12, color: 'var(--color-text-muted, #94a3b8)',
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8,
};

export default function AdsGeneratorPage() {
  return <AppShell><AdsGeneratorContent /></AppShell>;
}
