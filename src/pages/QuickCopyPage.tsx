import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import GateModal from '../components/GateModal';
import '../components/GateModal.css';
import './QuickCopyPage.css';

// Annotation helpers live in src/lib (pure) — same logic as src/server/quick-copy.js.
import { buildAnnotatedSegments } from '../lib/quick-copy.js';

type Format = 'email_reply' | 'cold_email' | 'dm' | 'social_post' | 'comment' | 'custom';
type Platform = 'email' | 'linkedin' | 'x' | 'instagram' | 'generic';
type LengthHint = 'short' | 'medium' | 'long';

interface Variant {
  id: string;
  label: string;
  subject?: string | null;
  preview?: string | null;
  body: string;
  cta?: string | null;
  hook?: string | null;
  confidence?: number | null;
  confidenceReason?: string | null;
}

interface ComplianceFlag {
  n: number;
  severity: 'red' | 'yellow';
  type: string;
  excerpt: string;
  start: number;
  end: number;
  reason: string;
  suggestion?: string;
}

interface ComplianceResult {
  checkedAt: string;
  variantIdx: number;
  bodySnapshot: string;
  summary: string;
  flags: ComplianceFlag[];
  dismissed: number[];
}

interface HistoryItem {
  id: string;
  format: Format;
  platform: string;
  prompt: string;
  variantCount: number;
  preview: string;
  confidence: number | null;
  status: string;
  createdAt: string;
}

const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: 'email_reply', label: 'Email reply', hint: 'Answer an inbound' },
  { id: 'cold_email', label: 'Cold email', hint: 'One-shot outreach' },
  { id: 'dm', label: 'DM', hint: 'LinkedIn / X message' },
  { id: 'social_post', label: 'Social post', hint: 'Single post, no article' },
  { id: 'comment', label: 'Comment', hint: 'Reply on a thread' },
  { id: 'custom', label: 'Custom', hint: 'Anything else' },
];

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'email', label: 'Email' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'generic', label: 'Generic' },
];

const VARIANT_COUNTS = [1, 2, 3, 4] as const;
const LENGTHS: { id: LengthHint; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'long', label: 'Long' },
];

const REFINE_CHIPS: { id: string; label: string }[] = [
  { id: 'shorter', label: 'Shorter' },
  { id: 'warmer', label: 'Warmer' },
  { id: 'direct', label: 'More direct' },
  { id: 'less_salesy', label: 'Less salesy' },
];

const Zap = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);
const Copy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);
const Shield = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function defaultPlatformFor(format: Format): Platform {
  if (format === 'email_reply' || format === 'cold_email') return 'email';
  if (format === 'dm' || format === 'social_post') return 'linkedin';
  return 'generic';
}

function ConfidencePill({ score }: { score: number | null | undefined }) {
  if (score == null) return null;
  const color = score >= 85 ? '#22C55E' : score >= 70 ? '#F5B942' : '#EF4444';
  return (
    <span className="qc-confidence" style={{ background: `${color}18`, color, borderColor: `${color}40` }}>
      {score}%
    </span>
  );
}

function AnnotatedBody({
  body,
  flags,
  dismissed,
  onJump,
}: {
  body: string;
  flags: ComplianceFlag[];
  dismissed: number[];
  onJump: (n: number) => void;
}) {
  const segments = useMemo(
    () => buildAnnotatedSegments(body, flags, dismissed),
    [body, flags, dismissed]
  );

  if (!flags.length || flags.every((f) => dismissed.includes(f.n))) {
    return <div className="qc-body-plain">{body}</div>;
  }

  return (
    <div className="qc-body-annotated">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return <span key={i}>{seg.text}</span>;
        }
        const color = seg.severity === 'red' ? '#EF4444' : '#F5B942';
        const n = seg.n;
        return (
          <span key={i} className="qc-flag-span" style={{ textDecorationColor: color }}>
            {seg.text}
            <button
              type="button"
              className="qc-sup"
              style={{ color }}
              onClick={() => onJump(n)}
              title={`Issue ${n}`}
            >
              {n}
            </button>
          </span>
        );
      })}
    </div>
  );
}

export default function QuickCopyPage() {
  const { isPaid, brandLoading, activeBrand, authToken } = useApp();
  const brandId = activeBrand?.id ?? null;
  const ah: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};

  const [format, setFormat] = useState<Format>('email_reply');
  const [platform, setPlatform] = useState<Platform>('email');
  const [prompt, setPrompt] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [audience, setAudience] = useState('');
  const [mandatories, setMandatories] = useState('');
  const [constraints, setConstraints] = useState('');
  const [lengthHint, setLengthHint] = useState<LengthHint>('medium');
  const [variantCount, setVariantCount] = useState<number>(2);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const [draftId, setDraftId] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [editSubject, setEditSubject] = useState('');

  const [compliance, setCompliance] = useState<ComplianceResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [refining, setRefining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [focusFlag, setFocusFlag] = useState<number | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const active = variants[activeIdx] || null;
  const displayBody = editing ? editBody : (active?.body || '');
  const displaySubject = editing ? editSubject : (active?.subject || '');

  const fetchHistory = useCallback(async () => {
    if (!brandId || !authToken) return;
    try {
      const r = await fetch(`/api/quick-copy/history/${brandId}`, { headers: ah });
      const d = await r.json();
      if (d.success) setHistory(d.drafts || []);
    } catch { /* non-fatal */ }
  }, [brandId, authToken]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // Gate after hooks so hook order stays stable across paid/unpaid renders.
  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell>
        <GateModal
          featureName="Quick Copy"
          onClose={() => { window.location.href = '/app/context-hub'; }}
          onUnlocked={() => {}}
        />
      </AppShell>
    );
  }

  const onFormatChange = (f: Format) => {
    setFormat(f);
    setPlatform(defaultPlatformFor(f));
  };

  const handleGenerate = async () => {
    if (!brandId || !prompt.trim() || running) return;
    setRunning(true);
    setError('');
    setStatus('Starting…');
    setVariants([]);
    setDraftId(null);
    setCompliance(null);
    setEditing(false);
    setActiveIdx(0);

    try {
      const r = await fetch('/api/quick-copy/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({
          brandProfileId: brandId,
          format,
          platform,
          prompt: prompt.trim(),
          sourceText: sourceText.trim() || undefined,
          audience: audience.trim() || undefined,
          mandatories: mandatories.trim() || undefined,
          constraints: constraints.trim() || undefined,
          lengthHint,
          variantCount,
        }),
      });

      if (!r.ok || !r.body) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.error || `Generate failed (${r.status})`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleEvent = (event: string, data: string) => {
        let parsed: any = data;
        try { parsed = JSON.parse(data); } catch { /* plain */ }
        if (event === 'status') {
          setStatus(parsed?.message || String(data));
        } else if (event === 'chunk') {
          setStatus(`Writing… ${parsed?.chars ? `${parsed.chars} chars` : ''}`.trim());
        } else if (event === 'busy') {
          setError(parsed?.message || 'Already generating for this brand.');
        } else if (event === 'error') {
          setError(parsed?.message || String(data));
        } else if (event === 'done') {
          setDraftId(parsed.id);
          setVariants(parsed.variants || []);
          setActiveIdx(0);
          setStatus('');
          fetchHistory();
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const block of parts) {
          const lines = block.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) handleEvent(event, data);
        }
      }
    } catch (e) {
      setError((e as Error).message || 'Generation failed');
    } finally {
      setRunning(false);
      setStatus('');
    }
  };

  const startEdit = () => {
    if (!active) return;
    setEditBody(active.body || '');
    setEditSubject(active.subject || '');
    setEditing(true);
    // Edits invalidate prior compliance on a different snapshot
    setCompliance(null);
  };

  const saveEdit = async () => {
    if (!draftId || !active) return;
    const next = variants.map((v, i) =>
      i === activeIdx
        ? { ...v, body: editBody, subject: editSubject || null }
        : v
    );
    setVariants(next);
    setEditing(false);
    try {
      await fetch(`/api/quick-copy/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ variants: next, activeVariantIdx: activeIdx }),
      });
    } catch { /* non-fatal — local state already updated */ }
  };

  const copyActive = async () => {
    if (!active && !editing) return;
    const body = editing ? editBody : active!.body;
    const subject = editing ? editSubject : active?.subject;
    const text = subject ? `Subject: ${subject}\n\n${body}` : body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setError('Clipboard blocked — select and copy manually.');
    }
  };

  const runCheck = async () => {
    if (!draftId || checking) return;
    // Persist in-progress edits first so check sees current text
    let bodyForCheck = active?.body || '';
    if (editing) {
      await saveEdit();
      bodyForCheck = editBody;
    }
    setChecking(true);
    setError('');
    try {
      const r = await fetch(`/api/quick-copy/${draftId}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ variantIdx: activeIdx, body: bodyForCheck }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Check failed');
      setCompliance(d.compliance);
      setFocusFlag(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const dismissFlag = async (n: number) => {
    if (!compliance || !draftId) return;
    const dismissed = Array.from(new Set([...(compliance.dismissed || []), n]));
    const next = { ...compliance, dismissed };
    setCompliance(next);
    try {
      await fetch(`/api/quick-copy/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ compliance: next }),
      });
    } catch { /* non-fatal */ }
  };

  const refine = async (direction: string) => {
    if (!draftId || refining) return;
    if (editing) await saveEdit();
    setRefining(true);
    setError('');
    try {
      const r = await fetch(`/api/quick-copy/${draftId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ direction }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Refine failed');
      setVariants(d.variants || []);
      setActiveIdx(d.activeVariantIdx ?? 0);
      setCompliance(null);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefining(false);
    }
  };

  const openHistoryItem = async (id: string) => {
    try {
      const r = await fetch(`/api/quick-copy/${id}`, { headers: ah });
      const d = await r.json();
      if (!d.success || !d.draft) throw new Error(d.error || 'Load failed');
      const draft = d.draft;
      setDraftId(draft.id);
      setFormat(draft.format);
      setPlatform(draft.platform || 'generic');
      setPrompt(draft.prompt || '');
      setSourceText(draft.source_text || '');
      setAudience(draft.audience || '');
      setMandatories(draft.mandatories || '');
      setConstraints(draft.constraints || '');
      setLengthHint((draft.length_hint as LengthHint) || 'medium');
      setVariantCount(draft.variant_count || 2);
      const vs = Array.isArray(draft.variants_json) ? draft.variants_json : [];
      setVariants(vs);
      setActiveIdx(draft.active_variant_idx || 0);
      setCompliance(draft.compliance_json || null);
      setEditing(false);
      setHistoryOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const complianceApplies =
    compliance &&
    active &&
    compliance.bodySnapshot === (editing ? editBody : active.body);

  const visibleFlags = complianceApplies
    ? (compliance!.flags || []).filter((f) => !(compliance!.dismissed || []).includes(f.n))
    : [];

  return (
    <AppShell>
      <div className="qc-page">
        <header className="qc-header">
          <div>
            <h1 className="qc-title">Quick Copy</h1>
            <p className="qc-subtitle">
              Brand-voiced one-offs — replies, DMs, posts, notes. Copy out. No pipeline required.
            </p>
          </div>
          <button type="button" className="qc-btn-ghost" onClick={() => setHistoryOpen((o) => !o)}>
            {historyOpen ? 'Hide history' : `History${history.length ? ` (${history.length})` : ''}`}
          </button>
        </header>

        {error && (
          <div className="qc-error">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')}>×</button>
          </div>
        )}

        {historyOpen && (
          <div className="qc-history">
            {!history.length && <div className="qc-muted">No Quick Copies yet for this brand.</div>}
            {history.map((h) => (
              <button key={h.id} type="button" className="qc-history-row" onClick={() => openHistoryItem(h.id)}>
                <div className="qc-history-meta">
                  <span className="qc-chip-sm">{h.format.replace('_', ' ')}</span>
                  <span className="qc-muted">{new Date(h.createdAt).toLocaleString()}</span>
                </div>
                <div className="qc-history-prompt">{h.prompt}</div>
                {h.preview && <div className="qc-history-preview">{h.preview}</div>}
              </button>
            ))}
          </div>
        )}

        <div className="qc-layout">
          {/* ── Intent panel ── */}
          <section className="qc-panel qc-intent">
            <div className="qc-section-label">Format</div>
            <div className="qc-chips">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`qc-chip ${format === f.id ? 'active' : ''}`}
                  onClick={() => onFormatChange(f.id)}
                  title={f.hint}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="qc-row">
              <div className="qc-field">
                <label className="qc-label">Platform</label>
                <select
                  className="qc-input"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as Platform)}
                >
                  {PLATFORMS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div className="qc-field">
                <label className="qc-label">Variants</label>
                <div className="qc-segment">
                  {VARIANT_COUNTS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`qc-seg ${variantCount === n ? 'active' : ''}`}
                      onClick={() => setVariantCount(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="qc-field">
                <label className="qc-label">Length</label>
                <div className="qc-segment">
                  {LENGTHS.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      className={`qc-seg ${lengthHint === l.id ? 'active' : ''}`}
                      onClick={() => setLengthHint(l.id)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="qc-field">
              <label className="qc-label">What do you need? <span className="qc-req">*</span></label>
              <textarea
                className="qc-textarea"
                rows={4}
                placeholder='e.g. "Reply to this pricing question — firm but helpful, offer a 15-min call"'
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <div className="qc-field">
              <label className="qc-label">Paste source <span className="qc-optional">(optional)</span></label>
              <textarea
                className="qc-textarea"
                rows={4}
                placeholder="Inbound email, DM, or thread you're answering…"
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="qc-advanced-toggle"
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              {advancedOpen ? '▾' : '▸'} Advanced — audience, must-include, avoid
            </button>
            {advancedOpen && (
              <div className="qc-advanced">
                <div className="qc-field">
                  <label className="qc-label">Audience</label>
                  <input className="qc-input" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Persona or role" />
                </div>
                <div className="qc-field">
                  <label className="qc-label">Must include</label>
                  <textarea className="qc-textarea" rows={2} value={mandatories} onChange={(e) => setMandatories(e.target.value)} />
                </div>
                <div className="qc-field">
                  <label className="qc-label">Must not</label>
                  <textarea className="qc-textarea" rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
                </div>
              </div>
            )}

            <button
              type="button"
              className="qc-btn-primary"
              disabled={!brandId || !prompt.trim() || running}
              onClick={handleGenerate}
            >
              <Zap /> {running ? (status || 'Generating…') : 'Generate'}
            </button>
            {!brandId && <div className="qc-muted">Select a brand brain to generate.</div>}
          </section>

          {/* ── Output panel ── */}
          <section className="qc-panel qc-output">
            {!variants.length && !running && (
              <div className="qc-empty">
                <div className="qc-empty-title">Ready when you are</div>
                <ul className="qc-empty-list">
                  <li>Reply to this inbound pricing question — firm but helpful</li>
                  <li>LinkedIn DM after they liked our post</li>
                  <li>X post: contrarian take on [topic], no CTA</li>
                  <li>One email: re-engage a quiet trial user</li>
                </ul>
              </div>
            )}

            {running && (
              <div className="qc-loading">
                <div className="qc-spinner" />
                <div>{status || 'Loading brand brain…'}</div>
              </div>
            )}

            {!!variants.length && (
              <>
                <div className="qc-variant-tabs">
                  {variants.map((v, i) => (
                    <button
                      key={v.id || i}
                      type="button"
                      className={`qc-tab ${i === activeIdx ? 'active' : ''}`}
                      onClick={() => {
                        if (editing) saveEdit();
                        setActiveIdx(i);
                        setEditing(false);
                        // Keep compliance only if it matches this variant body
                      }}
                    >
                      {v.label || String.fromCharCode(65 + i)}
                      <ConfidencePill score={v.confidence} />
                    </button>
                  ))}
                </div>

                <div className="qc-actions">
                  <button type="button" className="qc-btn-primary-sm" onClick={copyActive}>
                    {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
                  </button>
                  {!editing ? (
                    <button type="button" className="qc-btn-ghost-sm" onClick={startEdit}>Edit</button>
                  ) : (
                    <button type="button" className="qc-btn-ghost-sm" onClick={saveEdit}>Save edit</button>
                  )}
                  <button
                    type="button"
                    className="qc-btn-ghost-sm"
                    onClick={runCheck}
                    disabled={checking || !draftId}
                    title="Optional claim check — inline, same card"
                  >
                    <Shield /> {checking ? 'Checking…' : 'Check claims'}
                  </button>
                </div>

                <div className="qc-refine">
                  <span className="qc-muted">Refine:</span>
                  {REFINE_CHIPS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="qc-chip-sm"
                      disabled={refining || !draftId}
                      onClick={() => refine(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                {displaySubject != null && displaySubject !== '' && (
                  <div className="qc-subject-row">
                    <span className="qc-label">Subject</span>
                    {editing ? (
                      <input className="qc-input" value={editSubject} onChange={(e) => setEditSubject(e.target.value)} />
                    ) : (
                      <div className="qc-subject">{displaySubject}</div>
                    )}
                  </div>
                )}

                <div className="qc-body-card">
                  {editing ? (
                    <textarea
                      className="qc-textarea qc-body-edit"
                      rows={12}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                  ) : complianceApplies && visibleFlags.length ? (
                    <AnnotatedBody
                      body={displayBody}
                      flags={compliance!.flags}
                      dismissed={compliance!.dismissed || []}
                      onJump={(n) => {
                        setFocusFlag(n);
                        const el = document.getElementById(`qc-flag-${n}`);
                        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      }}
                    />
                  ) : (
                    <div className="qc-body-plain">{displayBody}</div>
                  )}
                </div>

                {active?.cta && (
                  <div className="qc-meta-line"><span className="qc-label">CTA</span> {active.cta}</div>
                )}
                {active?.confidenceReason && (
                  <div className="qc-meta-line qc-muted">{active.confidenceReason}</div>
                )}

                {/* Inline compliance notes — same card, never a tab */}
                {complianceApplies && (
                  <div className="qc-compliance">
                    <div className="qc-compliance-head">
                      <Shield />
                      <span>
                        {visibleFlags.length === 0
                          ? 'Clean pass — nothing flagged'
                          : `${visibleFlags.length} issue${visibleFlags.length === 1 ? '' : 's'}`}
                      </span>
                      {compliance!.summary && (
                        <span className="qc-muted">· {compliance!.summary}</span>
                      )}
                    </div>
                    {visibleFlags.map((f) => (
                      <div
                        key={f.n}
                        id={`qc-flag-${f.n}`}
                        className={`qc-flag-row ${focusFlag === f.n ? 'focus' : ''} sev-${f.severity}`}
                      >
                        <span className="qc-flag-n" style={{ color: f.severity === 'red' ? '#EF4444' : '#F5B942' }}>
                          {f.n}
                        </span>
                        <div className="qc-flag-body">
                          <div className="qc-flag-type">{f.type.replace('_', ' ')} · {f.severity}</div>
                          <div className="qc-flag-excerpt">"{f.excerpt}"</div>
                          <div className="qc-flag-reason">{f.reason}</div>
                          {f.suggestion && <div className="qc-flag-suggestion">{f.suggestion}</div>}
                        </div>
                        <button type="button" className="qc-btn-ghost-sm" onClick={() => dismissFlag(f.n)}>
                          Dismiss
                        </button>
                      </div>
                    ))}
                    <div className="qc-muted qc-copy-note">
                      Copy always uses clean text — underlines and superscripts stay on-screen only.
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
