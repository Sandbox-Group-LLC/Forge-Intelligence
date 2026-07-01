import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './ContentGeneratorPage.css';

interface Brain { id: string; brandName: string; brandUrl: string }

interface PackItem { text: string; anchor: string; length: number; overLimit: boolean }
interface Sitelink {
  linkText: string;
  description1: string;
  description2: string;
  finalUrl: string;
  linkTextLength: number;
  description1Length: number;
  description2Length: number;
  overLimit: boolean;
}
interface Callout { text: string; length: number; overLimit: boolean }
interface KeywordSet { broad: string[]; phrase: string[]; exact: string[] }

interface AssetPack {
  headlines: PackItem[];
  descriptions: PackItem[];
  paths: string[];
  sitelinks: Sitelink[];
  callouts: Callout[];
  keywords: KeywordSet;
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
  // Push-to-Topic-Queue state. Lets the user send Google-flagged low-volume
  // keywords straight into the Topic Queue as content opportunities (the GEO
  // play: keywords with no search volume are uncommoditized territory the
  // brand should be creating content for, not bidding on).
  const [pushingTopics, setPushingTopics] = useState(false);
  const [pushResult, setPushResult] = useState<{ inserted: number; skipped: number } | null>(null);

  // Recent packs drawer. Mirrors Social Generator's history pattern — the
  // drawer is collapsed by default; opens to show topic + finalUrl + date.
  // "Open pack" rehydrates the existing pack UI without a server roundtrip
  // because the full pack JSON ships with the list response.
  interface RecentPack { id: string; topic: string; finalUrl: string; overages: number; createdAt: string; pack: AssetPack }
  const [recentPacks, setRecentPacks] = useState<RecentPack[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const fetchRecent = async (brandId: string) => {
    if (!brandId) return;
    try {
      const r = await fetch(`/api/ads-generator/recent/${brandId}`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      const d = await r.json();
      if (d.success) setRecentPacks(d.packs || []);
    } catch { /* non-fatal */ }
  };

  const brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));
  if (brains.length === 0 && activeBrand) {
    brains.push({ id: activeBrand.id, brandName: activeBrand.brandName || activeBrand.brandUrl, brandUrl: activeBrand.brandUrl });
  }

  useEffect(() => {
    const id = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
    if (id) setSelectedBrainId(id);
  }, []);
  useEffect(() => { if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id); }, [activeBrand?.id]);
  // Load recent packs whenever brand changes (or first arrives)
  useEffect(() => { if (selectedBrainId && authToken) fetchRecent(selectedBrainId); }, [selectedBrainId, authToken]);

  const openPack = (rp: RecentPack) => {
    setPack(rp.pack);
    setOverages(rp.overages);
    setError('');
    setRecentOpen(false);
  };

  const deleteRecentPack = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this saved pack?')) return;
    try {
      const r = await fetch(`/api/ads-generator/pack/${id}`, {
        method: 'DELETE',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (r.ok) setRecentPacks(prev => prev.filter(p => p.id !== id));
    } catch { /* non-fatal */ }
  };

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
      // Refresh the recent drawer so the new pack appears immediately
      if (selectedBrainId) fetchRecent(selectedBrainId);
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

  // Google Ads bulk-upload CSV — one row per asset, with the columns each asset
  // type needs. The Google Ads bulk-upload spec uses one column set per asset
  // type and ignores blank columns for types that don't use them, so a single
  // wide CSV works for all 6 asset types here.
  const downloadCSV = () => {
    if (!pack) return;
    const esc = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
    const header = 'Asset Type,Asset Text,Description 1,Description 2,Final URL,Path 1,Path 2,Match Type';
    const rows: string[] = [header];
    pack.headlines.forEach(h => rows.push(`Headline,${esc(h.text)},,,${esc(pack.finalUrl)},${esc(pack.paths[0] || '')},${esc(pack.paths[1] || '')},`));
    pack.descriptions.forEach(d => rows.push(`Description,${esc(d.text)},,,${esc(pack.finalUrl)},${esc(pack.paths[0] || '')},${esc(pack.paths[1] || '')},`));
    pack.sitelinks.forEach(s => rows.push(`Sitelink,${esc(s.linkText)},${esc(s.description1)},${esc(s.description2)},${esc(s.finalUrl || pack.finalUrl)},,,`));
    pack.callouts.forEach(c => rows.push(`Callout,${esc(c.text)},,,,,,`));
    pack.keywords.broad.forEach(k => rows.push(`Keyword,${esc(k)},,,,,,Broad`));
    pack.keywords.phrase.forEach(k => rows.push(`Keyword,${esc(k)},,,,,,Phrase`));
    pack.keywords.exact.forEach(k => rows.push(`Keyword,${esc(k)},,,,,,Exact`));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `search-pack-${pack.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyAllHeadlines = () => pack && copy(pack.headlines.map(h => h.text).join('\n'), 'all-h');
  const copyAllDescriptions = () => pack && copy(pack.descriptions.map(d => d.text).join('\n'), 'all-d');
  const copyAllCallouts = () => pack && copy(pack.callouts.map(c => c.text).join('\n'), 'all-co');
  // Match-typed keyword export: applies Google Ads bulk-add syntax — phrase
  // gets quotes, exact gets brackets, broad is bare. User can paste straight
  // into the Google Ads keyword bulk-add textarea.
  const copyAllKeywords = () => {
    if (!pack) return;
    const lines = [
      ...pack.keywords.broad,
      ...pack.keywords.phrase.map(k => `"${k}"`),
      ...pack.keywords.exact.map(k => `[${k}]`),
    ];
    copy(lines.join('\n'), 'all-kw');
  };

  // Push all keywords (deduped across match types) into the brand's Topic
  // Queue so the team can spin them up as content briefs. Match type is meta
  // for ads, not for content — so we dedupe by raw phrase.
  const pushKeywordsToTopicQueue = async () => {
    if (!pack || !selectedBrainId || pushingTopics) return;
    const all = Array.from(new Set([
      ...pack.keywords.broad,
      ...pack.keywords.phrase,
      ...pack.keywords.exact,
    ].map(k => k.trim()).filter(Boolean)));
    if (!all.length) return;
    setPushingTopics(true);
    setPushResult(null);
    try {
      const r = await fetch('/api/topic-ideas/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({
          brandProfileId: selectedBrainId,
          topics: all,
          note: `From Ads Generator — "${pack.topic}" keyword set. GEO play: low-volume Google keyword = uncommoditized content territory to own.`,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Push failed');
      setPushResult({ inserted: d.inserted, skipped: d.skipped });
    } catch (e) {
      setPushResult({ inserted: 0, skipped: 0 });
      setError(`Couldn't push to Topic Queue: ${(e as Error).message}`);
    } finally {
      setPushingTopics(false);
    }
  };

  return (
    <div className="geo-content">
      <div className="geo-header">
        <div>
          <div className="geo-eyebrow">Stage 4.7 — Google Ads</div>
          <h1 className="geo-title">Ads Generator</h1>
          <p className="geo-description">
            Complete Google Search campaign asset pack — 15 headlines, 4 descriptions, 2 display paths, 6 sitelinks, 8 callouts, and match-typed keywords — anchored to your brain, GEO territories, and Factual Ground. Paste straight into Google Ads or export the full pack as CSV.
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
            <div style={{ padding: 12, background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 'var(--radius-sm)', fontSize: 13, color: '#92400E' }}>
              ⚠ {overages} asset(s) exceeded the character limit. Regenerate or edit before pasting into Google Ads.
            </div>
          )}

          {pack.notes && (
            <div style={{ padding: 14, background: 'var(--color-accent-muted, #eef2ff)', borderRadius: 'var(--radius-sm)', fontSize: 13, color: 'var(--color-text-secondary, #475569)' }}>
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

          {pack.sitelinks && pack.sitelinks.length > 0 && (
            <section>
              <div style={sectionHeader}>
                <span>Sitelinks · {pack.sitelinks.length} · link 25 / desc 35 max</span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {pack.sitelinks.map((s, i) => (
                  <SitelinkRow
                    key={`sl${i}`}
                    index={i + 1}
                    sitelink={s}
                    fallbackUrl={pack.finalUrl}
                    onCopy={() => copy(`${s.linkText}\n${s.description1}\n${s.description2}\n${s.finalUrl || pack.finalUrl}`, `sl${i}`)}
                    copied={copiedKey === `sl${i}`}
                  />
                ))}
              </div>
            </section>
          )}

          {pack.callouts && pack.callouts.length > 0 && (
            <section>
              <div style={sectionHeader}>
                <span>Callouts · {pack.callouts.length} · 25 char max</span>
                <button onClick={copyAllCallouts} style={smallBtn}><Copy size={12} /> {copiedKey === 'all-co' ? 'Copied' : 'Copy all'}</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {pack.callouts.map((c, i) => (
                  <button
                    key={`co${i}`}
                    onClick={() => copy(c.text, `co${i}`)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '6px 10px', fontSize: 13,
                      background: c.overLimit ? '#FEE2E2' : 'var(--color-bg-card, #fff)',
                      border: c.overLimit ? '1px solid #FCA5A5' : '1px solid var(--color-border, #e2e8f0)',
                      borderRadius: 6, cursor: 'pointer',
                      color: c.overLimit ? '#991B1B' : 'inherit',
                    }}
                    title={`${c.length}/25${c.overLimit ? ' — over limit' : ''}`}
                  >
                    {c.text}
                    <span style={{ fontSize: 10, color: c.overLimit ? '#991B1B' : 'var(--color-text-muted, #94a3b8)', fontFamily: 'ui-monospace, monospace' }}>
                      {copiedKey === `co${i}` ? '✓' : `${c.length}`}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {pack.keywords && (pack.keywords.broad.length + pack.keywords.phrase.length + pack.keywords.exact.length > 0) && (
            <section>
              <div style={sectionHeader}>
                <span>Keywords · {pack.keywords.broad.length + pack.keywords.phrase.length + pack.keywords.exact.length} total · match-typed for bulk paste</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={pushKeywordsToTopicQueue}
                    disabled={pushingTopics}
                    style={smallBtn}
                    title="Send these keywords to the Topic Queue as content opportunities — the GEO play for low-volume terms"
                  >
                    {pushingTopics ? '…' : '↗'} {pushingTopics ? 'Pushing…' : 'Push to Topic Queue'}
                  </button>
                  <button onClick={copyAllKeywords} style={smallBtn}><Copy size={12} /> {copiedKey === 'all-kw' ? 'Copied' : 'Copy all (match-typed)'}</button>
                </div>
              </div>
              {pushResult && (
                <div style={{
                  padding: '8px 12px',
                  marginBottom: 8,
                  background: 'var(--color-accent-muted, #eef2ff)',
                  border: '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: 6,
                  fontSize: 12,
                  color: 'var(--color-text-secondary, #475569)',
                }}>
                  Pushed <strong>{pushResult.inserted}</strong> new {pushResult.inserted === 1 ? 'topic' : 'topics'} to the Topic Queue
                  {pushResult.skipped > 0 && <> · {pushResult.skipped} skipped as duplicates</>}.
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                <KeywordColumn label="Broad" hint="bare phrases" keywords={pack.keywords.broad} wrap={k => k} />
                <KeywordColumn label="Phrase" hint='wrap "quotes"' keywords={pack.keywords.phrase} wrap={k => `"${k}"`} />
                <KeywordColumn label="Exact" hint="wrap [brackets]" keywords={pack.keywords.exact} wrap={k => `[${k}]`} />
              </div>
            </section>
          )}
        </div>
      )}

      {/* Recent packs drawer — appears below input (when empty) or below
          the rendered pack (when one is open). Collapsed by default to keep
          the surface focused on the generation flow. */}
      {recentPacks.length > 0 && (
        <div style={{ marginTop: 24, borderTop: '1px solid var(--color-border, #e2e8f0)', paddingTop: 16 }}>
          <button
            onClick={() => setRecentOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 0', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary, #475569)',
            }}
          >
            <span>Recent packs</span>
            <span style={{
              padding: '1px 8px', background: 'var(--color-accent-muted, #eef2ff)',
              borderRadius: 999, fontSize: 11, color: 'var(--color-text-secondary, #475569)',
            }}>{recentPacks.length}</span>
            <span style={{ fontSize: 12, marginLeft: 'auto', color: 'var(--color-text-muted, #94a3b8)' }}>{recentOpen ? '−' : '+'}</span>
          </button>
          {recentOpen && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {recentPacks.map(rp => (
                <button
                  key={rp.id}
                  onClick={() => openPack(rp)}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 12,
                    padding: 10, alignItems: 'center',
                    background: 'var(--color-bg-card, #fff)',
                    border: '1px solid var(--color-border, #e2e8f0)',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer', textAlign: 'left',
                  }}
                  title="Open this pack"
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary, #1a1a1a)' }}>{rp.topic}</div>
                    {rp.finalUrl && (
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', marginTop: 2, wordBreak: 'break-all' }}>→ {rp.finalUrl}</div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', whiteSpace: 'nowrap' }}>
                    {(() => {
                      const raw = String(rp.createdAt || '');
                      const normalized = /T/.test(raw) ? raw : raw.replace(' ', 'T') + (/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? '' : 'Z');
                      const d = new Date(normalized);
                      return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                    })()}
                  </div>
                  {rp.overages > 0 && (
                    <div style={{ fontSize: 10, color: '#92400E', background: '#FEF3C7', padding: '2px 6px', borderRadius: 4 }}>
                      {rp.overages} over
                    </div>
                  )}
                  <span
                    onClick={(e) => deleteRecentPack(rp.id, e)}
                    style={{
                      fontSize: 11, color: 'var(--color-text-muted, #94a3b8)',
                      padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
                    }}
                    title="Delete pack"
                  >
                    ✕
                  </span>
                </button>
              ))}
            </div>
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
      borderRadius: 'var(--radius-sm)',
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

function SitelinkRow({ index, sitelink, fallbackUrl, onCopy, copied }: {
  index: number; sitelink: Sitelink; fallbackUrl: string; onCopy: () => void; copied: boolean;
}) {
  const s = sitelink;
  const ltColor = s.linkTextLength > 25 ? '#EF4444' : s.linkTextLength > 22 ? '#F5B942' : '#10B981';
  const d1Color = s.description1Length > 35 ? '#EF4444' : s.description1Length > 32 ? '#F5B942' : '#10B981';
  const d2Color = s.description2Length > 35 ? '#EF4444' : s.description2Length > 32 ? '#F5B942' : '#10B981';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 10, alignItems: 'flex-start',
      padding: 10, background: 'var(--color-bg-card, #fff)',
      border: s.overLimit ? '1px solid #FCA5A5' : '1px solid var(--color-border, #e2e8f0)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', paddingTop: 2 }}>{index}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, color: s.linkTextLength > 25 ? '#991B1B' : 'inherit' }}>{s.linkText}</div>
        <div style={{ fontSize: 13, color: s.description1Length > 35 ? '#991B1B' : 'var(--color-text-secondary, #475569)', marginTop: 2 }}>{s.description1}</div>
        <div style={{ fontSize: 13, color: s.description2Length > 35 ? '#991B1B' : 'var(--color-text-secondary, #475569)' }}>{s.description2}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', marginTop: 4, wordBreak: 'break-all' }}>
          → {s.finalUrl || fallbackUrl || '(uses ad Final URL)'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <div style={{ fontSize: 10, color: ltColor, fontFamily: 'ui-monospace, monospace' }}>link {s.linkTextLength}/25</div>
        <div style={{ fontSize: 10, color: d1Color, fontFamily: 'ui-monospace, monospace' }}>d1 {s.description1Length}/35</div>
        <div style={{ fontSize: 10, color: d2Color, fontFamily: 'ui-monospace, monospace' }}>d2 {s.description2Length}/35</div>
        <button onClick={onCopy} style={{ ...smallBtn, padding: '4px 8px', marginTop: 4 }}>
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function KeywordColumn({ label, hint, keywords, wrap }: {
  label: string; hint: string; keywords: string[]; wrap: (k: string) => string;
}) {
  return (
    <div style={{ background: 'var(--color-bg-card, #fff)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--color-text-muted, #94a3b8)' }}>{hint} · {keywords.length}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
        {keywords.length === 0
          ? <div style={{ color: 'var(--color-text-muted, #94a3b8)', fontStyle: 'italic' }}>(none)</div>
          : keywords.map((k, i) => <div key={`${label}-${i}`} style={{ color: 'var(--color-text-secondary, #475569)' }}>{wrap(k)}</div>)
        }
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
