import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './ComplianceGatePage.css';
import { useApp } from '../context/AppContext';
import { useAuth } from '@clerk/clerk-react';
import GateModal from '../components/GateModal';
import '../components/GateModal.css';

type ReviewMode = 'auto-ship' | 'approve-to-ship' | 'full-review';
type ComplianceStatus = 'pending' | 'reviewed' | 'approved' | 'rejected';

const IconZap = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const IconCheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);


interface ArticleSection {
  heading: string;
  content?: string;
  body?: string;
  confidenceTier: 'green' | 'yellow' | 'red';
  confidence: number;
  confidenceReason: string;
  eeaTags?: string[];
}

interface Article {
  id: string;
  title: string;
  article_json: {
    title: string;
    sections: ArticleSection[];
    overallConfidence: number;
    brainMatchScore: number;
  };
  compliance_status: ComplianceStatus;
  compliance_report: ComplianceReport | null;
  hero_image_url: string | null;
  created_at: string;
  brand_profile_id: string;
}

interface ComplianceFlag {
  sectionIndex: number;
  sectionHeading: string;
  severity: 'yellow' | 'red';
  type: string;
  reason: string;
  suggestion: string;
}

interface ComplianceReport {
  overallScore: number;
  brandVoiceScore: number;
  factualConfidence: number;
  autoApprovable: boolean;
  summary: string;
  flags: ComplianceFlag[];
  mistakesApplied: string[];
}

const MODES: { id: ReviewMode; label: string; sub: string; icon: React.ReactNode; color: string }[] = [
  { id: 'auto-ship', label: 'Auto-Ship', sub: 'AI self-critique passes → publishes automatically. Human notified only.', icon: <IconZap />, color: '#14B8A6' },
  { id: 'approve-to-ship', label: 'Approve-to-Ship', sub: 'Review yellows & reds. One-click approve on greens. Standard workflow.', icon: <IconCheck />, color: '#3563FF' },
  // { id: 'full-review', label: 'Full Review', sub: 'Every section routes to named approver. Full audit log written to Brain.', icon: '🔒', color: '#F5B942' }, // Enterprise — re-enable when team workflow is needed
];

const tierColor = (tier: string) => tier === 'green' ? '#22C55E' : tier === 'yellow' ? '#F5B942' : '#EF4444';

function HighlightedBody({ body, flag }: { body: string; flag: any }) {
  if (!flag?.reason) return <p className="comp-section-body">{body}</p>;
  const quotes = Array.from(flag.reason.matchAll(/[“”"']([^“”"']{8,})[“”"']/g)).map((m: any) => m[1] as string);
  if (!quotes.length) return <p className="comp-section-body">{body}</p>;
  const flagColor = flag.type === 'factual_claim' ? '#EF4444' : flag.type === 'legal_risk' ? '#DC2626' : '#F59E0B';
  type Part = { text: string; highlight: boolean };
  let parts: Part[] = [{ text: body, highlight: false }];
  for (const quote of quotes) {
    parts = parts.flatMap((p: Part) => {
      if (p.highlight || !p.text.includes(quote)) return [p];
      const i = p.text.indexOf(quote);
      return [
        { text: p.text.slice(0, i), highlight: false },
        { text: quote, highlight: true },
        { text: p.text.slice(i + quote.length), highlight: false },
      ].filter((x: Part) => x.text.length > 0);
    });
  }
  return (
    <p className="comp-section-body">
      {parts.map((part: Part, i: number) => part.highlight
        ? <mark key={i} style={{ background: flagColor + '28', color: flagColor, borderBottom: `2px solid ${flagColor}`, borderRadius: 2, padding: '0 2px' }}>{part.text}</mark>
        : <span key={i}>{part.text}</span>
      )}
    </p>
  );
}

function ComplianceGateContent() {
  const { activeBrand, authToken } = useApp();
  const { getToken } = useAuth();


  const [mode, setMode] = useState<ReviewMode>('approve-to-ship');
  const [brandProfileId, setBrandProfileId] = useState(activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '');
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [editedSections, setEditedSections] = useState<Record<number, string>>({});
  const [decisions, setDecisions] = useState<Record<number, 'approved' | 'rejected'>>({});
  const [loading, setLoading] = useState(false);
  const [critiqueLoading, setCritiqueLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [rewritingIdx, setRewritingIdx] = useState<number | null>(null);
  const [rewrittenSections, setRewrittenSections] = useState<Set<number>>(new Set());
  const [sourcesMap, setSourcesMap] = useState<Record<number, {title:string;url:string;snippet:string;year:string}[]>>({});
  const [findingSourcesIdx, setFindingSourcesIdx] = useState<number | null>(null);
  const [selectedSource, setSelectedSource] = useState<Record<number, number>>({});
  const [step, setStep] = useState<'select' | 'review' | 'done'>('select');
  const [error, setError] = useState('');

  // Always get a fresh token at call time — never rely on state which may be stale
  const freshToken = async () => {
    try { return await getToken({ template: 'jwt-template-600' }) || authToken || (window as any).__forgeToken || ''; }
    catch { return authToken || (window as any).__forgeToken || ''; }
  };

  // authFetch: auto-retries once on 401 with a forced fresh token
  const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const token = await freshToken();
    const headers = { ...options.headers as Record<string,string>, 'Authorization': `Bearer ${token}` };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      // Token was stale — wait 500ms for Clerk to refresh then retry once
      await new Promise(r => setTimeout(r, 500));
      const retryToken = await getToken({ template: 'jwt-template-600' }) || '';
      const retryHeaders = { ...options.headers as Record<string,string>, 'Authorization': `Bearer ${retryToken}` };
      return fetch(url, { ...options, headers: retryHeaders });
    }
    return res;
  };

  // Seed brandProfileId from active brand context
  useEffect(() => {
    const id = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
    if (id) { setBrandProfileId(id); loadArticles(id); }
  }, [activeBrand?.id]);

  // Persist edits to localStorage whenever editedSections or decisions change
  useEffect(() => {
    if (!selectedArticle) return;
    try {
      localStorage.setItem(`forge_compliance_edits_${selectedArticle.id}`, JSON.stringify({
        edits: editedSections,
        decisions,
        savedAt: Date.now(),
      }));
    } catch {}
  }, [editedSections, decisions, selectedArticle]);

  const loadArticles = async (bpId: string) => {
    if (!bpId) return;
    setLoading(true);
    setError('');
    try {
      const r = await authFetch(`/api/compliance/latest/${bpId}`);
      const d = await r.json();
      if (d.success) {
        setArticles(d.articles || []);
      } else {
        setError(d.error || 'Failed to load articles');
      }
    } catch {
      setError('Failed to load articles');
    } finally {
      setLoading(false);
    }
  };

  const runCritique = async (article: Article) => {
    setCritiqueLoading(true);
    setError('');
    try {
      const r = await authFetch('/api/compliance/critique', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId, contentId: article.id })
      });
      const d = await r.json();
      if (d.success) {
        setReport(d.report);
        setSelectedArticle(prev => prev ? { ...prev, compliance_report: d.report } : prev);
        if (mode === 'auto-ship' && d.report.autoApprovable) {
          await submitApproval(article);
          return;
        }
        setStep('review');
      } else {
        setError(d.error || 'Critique failed');
      }
    } catch {
      setError('Critique request failed');
    } finally {
      setCritiqueLoading(false);
    }
  };

  const findSources = async (idx: number, sectionBody: string, claim: string) => {
    setFindingSourcesIdx(idx);
    setError('');
    try {
      const r = await authFetch('/api/compliance/find-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim, sectionBody }),
      });
      const d = await r.json();
      if (d.success && d.sources?.length) {
        setSourcesMap(p => ({ ...p, [idx]: d.sources }));
        setSelectedSource(p => ({ ...p, [idx]: 0 }));
      } else {
        setError('No sources found — try rewriting without a citation.');
      }
    } catch { setError('Source search failed.'); }
    finally { setFindingSourcesIdx(null); }
  };

  const acceptSuggestion = async (idx: number, sectionBody: string, _reason: string, suggestion: string) => {
    setRewritingIdx(idx);
    try {
      const r = await authFetch('/api/compliance/rewrite-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionBody, suggestion, brandProfileId, source: sourcesMap[idx]?.[selectedSource[idx] ?? 0] || null }),
      });
  
      const d = await r.json();
      if (d.success) {
        setEditedSections(p => ({ ...p, [idx]: d.rewritten }));
        setRewrittenSections(p => new Set([...p, idx]));
        setSourcesMap(p => { const n = {...p}; delete n[idx]; return n; });
      } else {
        setError('Rewrite failed: ' + (d.error || 'server error'));
        setRewrittenSections(p => { const n = new Set(p); n.delete(idx); return n; });
      }
    } catch (e: any) { setError('Rewrite failed: ' + (e?.message || 'unknown error')); /* leave section unchanged */ }
    finally { setRewritingIdx(null); }
  };

  const submitApproval = async (article: Article) => {
    setSubmitLoading(true);
    try {
      const edits = Object.entries(editedSections).map(([idx, content]) => ({
        sectionIndex: parseInt(idx),
        content
      }));
      const r = await authFetch('/api/compliance/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandProfileId,
          contentId: article.id,
          reviewMode: mode,
          editedSections: edits,
          decisions
        })
      });
      const d = await r.json();
      if (d.success) {
        setStep('done');
      } else {
        setError(d.error || 'Approval failed');
      }
    } catch {
      setError('Approval request failed');
    } finally {
      setSubmitLoading(false);
    }
  };

  const selectArticle = (article: Article) => {
    setSelectedArticle(article);
    setReport(article.compliance_report || null);
    if (article.compliance_report) setStep('review');
    // Restore any in-progress edits for this article from localStorage
    try {
      const saved = localStorage.getItem(`forge_compliance_edits_${article.id}`);
      if (saved) {
        const { edits, decisions: savedDecisions } = JSON.parse(saved);
        setEditedSections(edits || {});
        setDecisions(savedDecisions || {});
      } else {
        setEditedSections({});
        setDecisions({});
      }
    } catch { setEditedSections({}); setDecisions({}); }
  };

  const statusBadge = (status: ComplianceStatus) => {
    const map = { pending: '⏳ Pending', reviewed: '🔍 Reviewed', approved: '✅ Approved', rejected: '❌ Rejected' };
    return map[status] || status;
  };

  return (
    <AppShell pageTitle="Compliance Gate">
      <div className="comp-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Stage 5</div>
            <h1 className="geo-title">Compliance Gate</h1>
            <p className="geo-description">AI self-critique + human refinement. Every edit trains the Brain.</p>
          </div>
        </div>

        {/* Mode Selector */}
        <div className="comp-mode-bar">
          {MODES.map(m => (
            <button
              key={m.id}
              className={`comp-mode-card ${mode === m.id ? 'active' : ''}`}
              style={{ '--mode-color': m.color } as React.CSSProperties}
              onClick={() => setMode(m.id)}
            >
              <span className="comp-mode-icon">{m.icon}</span>
              <span className="comp-mode-label">{m.label}</span>
              <span className="comp-mode-sub">{m.sub}</span>
              {mode === m.id && <span className="comp-mode-active-dot" />}
            </button>
          ))}
        </div>

        {/* Brand + Article selector */}
        {step === 'select' && (
          <div className="comp-select-panel">
            {loading && <div className="comp-loading"><span className="comp-spinner" /> Loading articles...</div>}

            {!loading && articles.length > 0 && (
              <div className="comp-article-list">
                <div className="comp-list-label">Select an article to review</div>
                {articles.map(a => (
                  <button key={a.id} className={`comp-article-row${selectedArticle?.id === a.id ? " selected" : ""}`} onClick={() => selectArticle(a)}>
                    <div className="comp-article-title">{a.article_json?.title || a.title}</div>
                    <div className="comp-article-meta">
                      <span className={`comp-status-pill ${a.compliance_status}`}>{statusBadge(a.compliance_status)}</span>
                      {a.article_json?.overallConfidence !== undefined && (
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                          background: a.article_json.overallConfidence >= 80 ? 'var(--color-success-muted)' : a.article_json.overallConfidence >= 65 ? 'var(--color-warning-muted)' : 'var(--color-error-muted)',
                          color: a.article_json.overallConfidence >= 80 ? 'var(--color-success)' : a.article_json.overallConfidence >= 65 ? 'var(--color-warning)' : 'var(--color-error)',
                        }}>{a.article_json.overallConfidence}%</span>
                      )}
                      <span className="comp-article-date">{new Date(a.created_at).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {selectedArticle && !report && (
              <button
                className="comp-run-btn"
                onClick={() => runCritique(selectedArticle)}
                disabled={critiqueLoading}
              >
                {critiqueLoading
                  ? <><span className="comp-spinner-sm" /> Running AI Critique...</>
                  : <><IconZap /> Run Compliance Critique</>}
              </button>
            )}
          </div>
        )}

        {error && <div className="geo-error">{error}</div>}

        {/* Review panel */}
        {step === 'review' && selectedArticle && (
          <div className="comp-review-panel">

            {/* Compliance report summary */}
            {report && (
              <div className="comp-report-bar">
                <div className="comp-score-block">
                  <div className="comp-score-num">{report.overallScore}</div>
                  <div className="comp-score-lbl">Overall</div>
                </div>
                <div className="comp-score-block">
                  <div className="comp-score-num">{report.brandVoiceScore}</div>
                  <div className="comp-score-lbl">Brand Voice</div>
                </div>
                <div className="comp-score-block">
                  <div className="comp-score-num">{report.factualConfidence}</div>
                  <div className="comp-score-lbl">Factual Confidence</div>
                </div>
                <div className="comp-report-summary">{report.summary}</div>
                {report.autoApprovable && (
                  <div className="comp-auto-badge">✅ Auto-approvable</div>
                )}
              </div>
            )}

            {/* Sections */}
            <div className="comp-sections">
              {selectedArticle.article_json?.sections?.map((section, idx) => {
                const flag = report?.flags?.find(f => f.sectionIndex === idx);
                const sectionText = section.body || section.content || '';
                const hasPlaceholder = /\[NEEDS[_ ]?CITATION[^\]]*\]|\[CITATION[^\]]*\]|\[INSERT[^\]]*\]/i.test(sectionText);
                const isEditing = section.confidenceTier !== 'green' || !!flag || mode === 'full-review' || hasPlaceholder;
                const editVal = editedSections[idx] ?? (section.body || section.content || '');

                return (
                  <div key={idx} className={`comp-section tier-${section.confidenceTier}`}>
                    <div className="comp-section-header">
                      <div className="comp-section-meta">
                        <span className="comp-tier-dot" style={{ background: tierColor(section.confidenceTier) }} />
                        <span className="comp-section-heading">{section.heading}</span>
                        <span className="comp-confidence-pill" style={{ background: tierColor(section.confidenceTier) + '22', color: tierColor(section.confidenceTier) }}>
                          {section.confidence}%
                        </span>
                      </div>
                      {section.confidenceTier === 'green' && mode !== 'full-review' && !flag && (
                        <span className="comp-green-approve">✓ Auto-approved</span>
                      )}
                      {section.confidenceTier === 'red' && (
                        <div className="comp-decision-btns">
                          <button
                            className={`comp-decision-btn approve ${decisions[idx] === 'approved' ? 'active' : ''}`}
                            onClick={() => setDecisions(p => ({ ...p, [idx]: 'approved' }))}
                          >Approve</button>
                          <button
                            className={`comp-decision-btn reject ${decisions[idx] === 'rejected' ? 'active' : ''}`}
                            onClick={() => setDecisions(p => ({ ...p, [idx]: 'rejected' }))}
                          >Reject</button>
                        </div>
                      )}
                    </div>

                    {hasPlaceholder && !flag && (
                      <div className="comp-flag flag-yellow" style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#D97706' }}>⚠ Contains unresolved placeholder text</span>
                          <button
                            className="comp-accept-suggestion-btn"
                            style={{ background: '#D97706', color: '#fff', borderColor: '#D97706' }}
                            onClick={() => {
                              const stripped = sectionText.replace(/\[NEEDS[_ ]?CITATION[^\]]*\]|\[CITATION[^\]]*\]|\[INSERT[^\]]*\]/gi, '').replace(/  +/g, ' ').trim();
                              setEditedSections(p => ({ ...p, [idx]: stripped }));
                            }}
                          >
                            Strip Placeholder
                          </button>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                          This section contains a citation placeholder that must be resolved before publishing.
                        </div>
                      </div>
                    )}
                    {flag && (
                      <div className={`comp-flag flag-${flag.severity}`}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: flag.type === 'factual_claim' ? 'rgba(239,68,68,0.12)' : flag.type === 'legal_risk' ? 'rgba(220,38,38,0.12)' : 'rgba(245,158,11,0.12)',
                            color: flag.type === 'factual_claim' ? '#EF4444' : flag.type === 'legal_risk' ? '#DC2626' : '#D97706',
                          }}>
                            {flag.type.replace(/_/g, ' ')}
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)' }}>Severity: {flag.severity}</span>
                        </div>
                        {flag.reason}
                        {flag.suggestion && (
                          <div className="comp-flag-suggestion-wrap">
                            <div className="comp-flag-suggestion">{flag.suggestion}</div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                              {/* Find Sources for factual claims */}
                              {(flag.type === 'factual_claim' || flag.type === 'legal_risk') && !sourcesMap[idx] && (
                                <button
                                  className="comp-accept-suggestion-btn"
                                  style={{ background: 'rgba(139,92,246,0.12)', color: '#7C3AED', borderColor: 'rgba(139,92,246,0.3)' }}
                                  onClick={() => findSources(idx, section.body || section.content || '', flag.reason || '')}
                                  disabled={findingSourcesIdx === idx}
                                >
                                  {findingSourcesIdx === idx ? 'Searching...' : 'Find Sources'}
                                </button>
                              )}
                              <button
                                className="comp-accept-suggestion-btn"
                                onClick={() => acceptSuggestion(idx, editedSections[idx] ?? (section.body || section.content || ''), flag.reason || '', flag.suggestion || '')}
                                disabled={rewritingIdx === idx}
                                style={{
                                  background: rewrittenSections.has(idx) ? 'var(--color-accent)' : undefined,
                                  color: rewrittenSections.has(idx) ? '#fff' : undefined,
                                  borderColor: rewrittenSections.has(idx) ? 'var(--color-accent)' : undefined,
                                }}
                              >
                                {rewritingIdx === idx ? 'Rewriting...' : rewrittenSections.has(idx) ? 'Rewrite Applied' : 'Accept Suggestion'}
                              </button>
                            </div>

                            {/* Source candidates */}
                            {sourcesMap[idx] && (
                              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>Select a source — AI will cite it in the rewrite</div>
                                {sourcesMap[idx].map((src, si) => (
                                  <div
                                    key={si}
                                    onClick={() => setSelectedSource(p => ({ ...p, [idx]: si }))}
                                    style={{
                                      padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                                      border: `1.5px solid ${selectedSource[idx] === si ? '#7C3AED' : 'var(--color-border)'}`,
                                      background: selectedSource[idx] === si ? 'rgba(139,92,246,0.06)' : 'var(--color-bg-card)',
                                      transition: 'all 0.15s',
                                    }}
                                  >
                                    <div style={{ fontSize: 13, fontWeight: 600, color: selectedSource[idx] === si ? '#7C3AED' : 'var(--color-text-primary)', marginBottom: 2 }}>
                                      {src.title} {src.year ? `(${src.year})` : ''}
                                    </div>
                                    {src.snippet && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 4 }}>{src.snippet.slice(0, 160)}...</div>}
                                    <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--color-accent)', textDecoration: 'none' }} onClick={e => e.stopPropagation()}>
                                      {src.url.replace(/^https?:\/\//, '').slice(0, 60)}
                                    </a>
                                  </div>
                                ))}
                                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                  <button
                                    className="comp-accept-suggestion-btn"
                                    onClick={() => acceptSuggestion(idx, editedSections[idx] ?? (section.body || section.content || ''), flag.reason || '', flag.suggestion || '')}
                                    disabled={rewritingIdx === idx}
                                    style={{ background: '#7C3AED', color: '#fff', borderColor: '#7C3AED' }}
                                  >
                                    {rewritingIdx === idx ? 'Rewriting with source...' : `Rewrite with Source`}
                                  </button>
                                  <button
                                    onClick={() => setSourcesMap(p => { const n = {...p}; delete n[idx]; return n; })}
                                    style={{ fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                                  >
                                    Skip sources
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Highlighted section body — shows flagged excerpts inline */}
                    <HighlightedBody body={section.body || section.content || ''} flag={flag} />

                    {isEditing ? (
                      <div className="comp-edit-wrap">
                        <div className="comp-edit-label">Edit section copy below — your changes replace this section before publishing</div>
                        <textarea
                          className="comp-section-edit"
                          value={editVal}
                          onChange={e => setEditedSections(p => ({ ...p, [idx]: e.target.value }))}
                          placeholder="Edit the section text here. Address the flagged issue above, then submit below to approve and stage for publishing."
                          rows={8}
                        />
                      </div>
                    ) : (
                      <p className="comp-section-body">{section.body || section.content}</p>
                    )}
                    {/* Section footer — confidence + decision status */}
                    <div className="comp-section-footer">
                      <span>{(section.confidenceTier === 'green' && !flag) ? 'Auto-approved' : decisions[idx] === 'approved' ? 'Approved' : decisions[idx] === 'rejected' ? 'Rejected' : 'Pending review'}</span>
                      <span>{section.confidence}% confidence · {flag ? flag.type.replace(/_/g, ' ') : 'No flags'}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Submit bar */}
            <div className="comp-submit-bar">
              <button className="comp-back-btn" onClick={() => setStep('select')}>← Back</button>
              <button
                className="comp-approve-btn"
                disabled={submitLoading}
                onClick={() => submitApproval(selectedArticle)}
              >
                {submitLoading
                  ? <><span className="comp-spinner-sm" /> Saving...</>
                  : mode === 'full-review'
                    ? 'Submit for Final Approval'
                    : <><IconCheck /> Approve &amp; Save to Brain</>}
              </button>
            </div>
          </div>
        )}

        {/* Done state */}
        {step === 'done' && (
          <div className="comp-done">
            <div className="comp-done-icon">✅</div>
            <h2 className="comp-done-title">Article Approved</h2>
            <p className="comp-done-sub">Human edits written to Brain Mistakes. Stage 4 will avoid these patterns on next generation.</p>
            <div className="comp-done-actions">
              <button className="comp-run-btn" onClick={() => { setStep('select'); setSelectedArticle(null); setReport(null); }}>
                Review Another Article
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function ComplianceGatePage() {
  const { isPaid, brandLoading } = useApp();
  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell>
        <div className="geo-gate-wrapper">
          <GateModal
            featureName="Compliance Gate"
            onClose={() => window.location.href = '/app/context-hub'}
            onUnlocked={() => {}}
          />
        </div>
      </AppShell>
    );
  }
  return <ComplianceGateContent />;
}
