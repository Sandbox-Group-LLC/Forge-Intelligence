import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './ComplianceGatePage.css';

type ReviewMode = 'auto-ship' | 'approve-to-ship' | 'full-review';
type ComplianceStatus = 'pending' | 'reviewed' | 'approved' | 'rejected';

interface ArticleSection {
  heading: string;
  content: string;
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

const MODES: { id: ReviewMode; label: string; sub: string; icon: string; color: string }[] = [
  { id: 'auto-ship', label: 'Auto-Ship', sub: 'AI self-critique passes → publishes automatically. Human notified only.', icon: '⚡', color: '#14B8A6' },
  { id: 'approve-to-ship', label: 'Approve-to-Ship', sub: 'Review yellows & reds. One-click approve on greens. Standard workflow.', icon: '✓', color: '#3563FF' },
  { id: 'full-review', label: 'Full Review', sub: 'Every section routes to named approver. Full audit log written to Brain.', icon: '🔒', color: '#F5B942' },
];

const tierColor = (tier: string) => tier === 'green' ? '#22C55E' : tier === 'yellow' ? '#F5B942' : '#EF4444';

export default function ComplianceGatePage() {
  const [mode, setMode] = useState<ReviewMode>('approve-to-ship');
  const [brandProfileId, setBrandProfileId] = useState('');
  const [brands, setBrands] = useState<{ id: string; domain: string }[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [editedSections, setEditedSections] = useState<Record<number, string>>({});
  const [decisions, setDecisions] = useState<Record<number, 'approved' | 'rejected'>>({});
  const [loading, setLoading] = useState(false);
  const [critiqueLoading, setCritiqueLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [step, setStep] = useState<'select' | 'review' | 'done'>('select');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/brands').then(r => r.json()).then(d => {
      if (d.success) setBrands(d.brands || []);
    }).catch(() => {});
  }, []);

  const loadArticles = async (bpId: string) => {
    if (!bpId) return;
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`/api/compliance/latest/${bpId}`);
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
      const r = await fetch('/api/compliance/critique', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId, contentId: article.id })
      });
      const d = await r.json();
      if (d.success) {
        setReport(d.report);
        setSelectedArticle(prev => prev ? { ...prev, compliance_report: d.report } : prev);
        if (mode === 'auto-ship' && d.report.autoApprovable) {
          await submitApproval(article, d.report);
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

  const submitApproval = async (article: Article, critiqueReport?: ComplianceReport) => {
    setSubmitLoading(true);
    try {
      const edits = Object.entries(editedSections).map(([idx, content]) => ({
        sectionIndex: parseInt(idx),
        content
      }));
      const r = await fetch('/api/compliance/approve', {
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
    setEditedSections({});
    setDecisions({});
    setReport(article.compliance_report || null);
    if (article.compliance_report) setStep('review');
  };

  const allRedDecided = () => {
    if (!selectedArticle?.article_json?.sections) return true;
    return selectedArticle.article_json.sections
      .filter(s => s.confidenceTier === 'red')
      .every((_, i) => {
        const realIdx = selectedArticle.article_json.sections.findIndex((s, idx) => s.confidenceTier === 'red' && idx === i);
        return decisions[realIdx] !== undefined;
      });
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
            <div className="comp-row">
              <select
                className="geo-select"
                value={brandProfileId}
                onChange={e => { setBrandProfileId(e.target.value); loadArticles(e.target.value); }}
              >
                <option value="">Select a Brain...</option>
                {brands.map(b => <option key={b.id} value={b.id}>{b.domain}</option>)}
              </select>
            </div>

            {loading && <div className="comp-loading"><span className="comp-spinner" /> Loading articles...</div>}

            {!loading && articles.length > 0 && (
              <div className="comp-article-list">
                <div className="comp-list-label">Select an article to review</div>
                {articles.map(a => (
                  <button key={a.id} className="comp-article-row" onClick={() => selectArticle(a)}>
                    <div className="comp-article-title">{a.article_json?.title || a.title}</div>
                    <div className="comp-article-meta">
                      <span className={`comp-status-pill ${a.compliance_status}`}>{statusBadge(a.compliance_status)}</span>
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
                  : <>⚡ Run Compliance Critique</>}
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
                const isEditing = section.confidenceTier !== 'green' || mode === 'full-review';
                const editVal = editedSections[idx] ?? section.content;

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
                      {section.confidenceTier === 'green' && mode !== 'full-review' && (
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

                    {flag && (
                      <div className={`comp-flag flag-${flag.severity}`}>
                        <strong>{flag.type.replace(/_/g, ' ')}</strong> — {flag.reason}
                        {flag.suggestion && <div className="comp-flag-suggestion">💡 {flag.suggestion}</div>}
                      </div>
                    )}

                    {isEditing ? (
                      <textarea
                        className="comp-section-edit"
                        value={editVal}
                        onChange={e => setEditedSections(p => ({ ...p, [idx]: e.target.value }))}
                        rows={8}
                      />
                    ) : (
                      <p className="comp-section-body">{section.content}</p>
                    )}
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
                    : '✓ Approve & Save to Brain'}
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
