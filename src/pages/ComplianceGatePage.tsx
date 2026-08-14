import { useState, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './ComplianceGatePage.css';
import { useApp } from '../context/AppContext';
import { useAuth } from '@clerk/clerk-react';
import GateModal from '../components/GateModal';
import '../components/GateModal.css';

type ReviewMode = 'auto-ship' | 'approve-to-ship' | 'full-review';
type ComplianceStatus = 'pending' | 'reviewed' | 'approved' | 'rejected';

const REJECT_REASON_OPTIONS: { code: string; label: string }[] = [
  { code: 'invented_claim', label: 'Invented or unsupported claim' },
  { code: 'wrong_voice', label: 'Off-brand voice / tone' },
  { code: 'nda_risk', label: 'NDA / naming risk' },
  { code: 'off_thesis', label: 'Off thesis / wrong framing' },
  { code: 'too_salesy', label: 'Too salesy / hype' },
  { code: 'factual_error', label: 'Factual error' },
  { code: 'legal_risk', label: 'Legal / compliance risk' },
  { code: 'other', label: 'Other' },
];

const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>
);

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
    metaDescription?: string;
    keyTakeaway?: string;
    faqs?: Array<{ question: string; answer: string }>;
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
  
  // Primary: use flaggedExcerpt from Claude (the exact quote we asked for)
  let quotes: string[] = [];
  if (flag.flaggedExcerpt && flag.flaggedExcerpt.length >= 8) {
    // Try exact match first
    if (body.includes(flag.flaggedExcerpt)) {
      quotes.push(flag.flaggedExcerpt);
    } else {
      // Case-insensitive fallback
      const idx = body.toLowerCase().indexOf(flag.flaggedExcerpt.toLowerCase());
      if (idx >= 0) {
        quotes.push(body.slice(idx, idx + flag.flaggedExcerpt.length));
      }
    }
  }
  
  // Fallback: extract quoted phrases from the reason text
  if (!quotes.length) {
    const extracted = Array.from(flag.reason.matchAll(/[\u201c\u201d"']([^\u201c\u201d"']{8,})[\u201c\u201d"']/g)).map((m: any) => m[1] as string);
    for (const q of extracted) {
      if (body.includes(q)) quotes.push(q);
      else {
        const idx = body.toLowerCase().indexOf(q.toLowerCase());
        if (idx >= 0) quotes.push(body.slice(idx, idx + q.length));
      }
    }
  }
  
  // Last resort: sliding window over reason words
  if (!quotes.length) {
    const words = flag.reason.replace(/[.,;:!?]+/g, ' ').split(/\s+/).filter(Boolean);
    for (let w = 0; w <= words.length - 5; w++) {
      for (let len = Math.min(10, words.length - w); len >= 5; len--) {
        const phrase = words.slice(w, w + len).join(' ');
        if (body.includes(phrase)) { quotes.push(phrase); break; }
      }
      if (quotes.length >= 2) break;
    }
  }
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
        ? <mark key={i} style={{ background: flagColor + '28', color: flagColor, borderBottom: `2px solid ${flagColor}`, borderRadius: 2, padding: '1px 2px' }}>{part.text}</mark>
        : <span key={i}>{part.text}</span>
      )}
    </p>
  );
}

function ComplianceGateContent() {
  const { activeBrand, authToken, reportError } = useApp();
  const { getToken } = useAuth();


  const [mode, setMode] = useState<ReviewMode>('approve-to-ship');
  const [brandProfileId, setBrandProfileId] = useState(activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '');
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [editedSections, setEditedSections] = useState<Record<number, string>>({});
  const [manualEditSections, setManualEditSections] = useState<Record<number, boolean>>({});
  const [dismissedFlags, setDismissedFlags] = useState<Record<number, boolean>>({});
  // Dismiss reason picker: which section's menu is open, per-section outcome label,
  // and the private referent typed for a "verified but unnameable (NDA)" dismissal.
  const [dismissMenuIdx, setDismissMenuIdx] = useState<number | null>(null);
  const [dismissOutcome, setDismissOutcome] = useState<Record<number, string>>({});
  const [ndaReferent, setNdaReferent] = useState<string>('');
  const [decisions, setDecisions] = useState<Record<number, 'approved' | 'rejected'>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<number, { code: string; note?: string }>>({});
  // FAQ edits — parallel structure to editedSections. Each FAQ entry can have its question
  // and/or answer overridden. Empty fields default to the LLM-generated original on submit.
  const [editedFaqs, setEditedFaqs] = useState<Record<number, { question?: string; answer?: string }>>({});
  // Key Takeaway (TL;DR) edit — null = untouched (publish the original). Surfaced for
  // review so the TL;DR stops shipping unreviewed; the edit flows to /approve.
  const [editedKeyTakeaway, setEditedKeyTakeaway] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [critiqueLoading, setCritiqueLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [rewritingIdx, setRewritingIdx] = useState<number | null>(null);
  const [rewrittenSections, setRewrittenSections] = useState<Set<number>>(new Set());
  const [sourcesMap, setSourcesMap] = useState<Record<number, {title:string;url:string;snippet:string;year:string}[]>>({});
  const [findingSourcesIdx, setFindingSourcesIdx] = useState<number | null>(null);
  const [selectedSource, setSelectedSource] = useState<Record<number, number>>({});
  // Outcome of verify-and-cite per section idx — lets the UI show 'Cited vs Softened'
  // status without forcing the founder to re-read the rewritten prose to figure out
  // what the agent did. Source object is null when softened, populated when cited.
  const [rewriteOutcomes, setRewriteOutcomes] = useState<Record<number, { mode: 'cited' | 'softened'; source?: { title: string; url: string; domain?: string; year?: string } | null }>>({});
  const [step, setStep] = useState<'select' | 'review' | 'done'>('select');
  const [error, setError] = useState('');

  // Targeted rewrite state
  const [selectionToolbar, setSelectionToolbar] = useState<{ idx: number; text: string; start: number; end: number; top: number; left: number } | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [rewriteSelLoading, setRewriteSelLoading] = useState(false);
  const [rewriteUndo, setRewriteUndo] = useState<{ idx: number; original: string } | null>(null);

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
      // First token was rejected (typically already-expired at verify time).
      // Force Clerk to mint a brand-new token — skipCache bypasses the cached
      // (possibly near-expired) token the plain getToken would hand back.
      await new Promise(r => setTimeout(r, 500));
      const retryToken = await getToken({ template: 'jwt-template-600', skipCache: true }) || '';
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

  // Auto-select article when deep-linked from Publishing Queue (?contentId=...)
  useEffect(() => {
    if (!articles.length) return;
    const params = new URLSearchParams(window.location.search);
    const contentId = params.get('contentId');
    if (!contentId) return;
    const match = articles.find(a => a.id === contentId || (a as any).content_id === contentId);
    if (match) {
      setSelectedArticle(match);
      setStep('review');
      // Clean URL without triggering nav
      window.history.replaceState({}, '', '/app/compliance-gate');
    }
  }, [articles]);

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
        if (d.message && (!d.articles || d.articles.length === 0)) {
          setError(d.message);
        }
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

  // Dismiss with a typed reason. The reason is the brain signal (see compliance.js
  // /dismiss-flag). For 'verified_unnameable' we also pass the flagged excerpt as the
  // public `surface` and the optional private `trueReferent` (stored write-only, never
  // fed back to a model) so the fact is promoted to Factual Ground and stops being
  // re-flagged and under-scored on every future article.
  const DISMISS_REASONS: { key: string; label: string; outcome: string }[] = [
    { key: 'verified_nameable',   label: 'Verified — can name',        outcome: 'Verified fact — Brain updated' },
    { key: 'verified_unnameable', label: "Verified — can't name (NDA)", outcome: 'Redacted fact — added to Factual Ground' },
    { key: 'intentional_style',   label: 'Intentional voice/style',    outcome: 'Style, not a claim — Brain updated' },
    { key: 'actually_wrong',      label: 'Flag was right',             outcome: 'Confirmed — no change' },
  ];

  const dismissFlag = async (sectionIdx: number, flag: any, reason: string) => {
    if (!selectedArticle || !activeBrand?.id) return;
    const meta = DISMISS_REASONS.find(r => r.key === reason);
    try {
      const token = await getToken({ template: 'jwt-template-600' });
      await fetch('/api/compliance/dismiss-flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          brandProfileId: activeBrand.id,
          contentId: selectedArticle.id,
          flagType: flag.type,
          flagReason: flag.reason,
          sectionHeading: flag.sectionHeading || '',
          reason,
          surface: flag.flaggedExcerpt || flag.reason || '',
          trueReferent: reason === 'verified_unnameable' ? (ndaReferent.trim() || null) : undefined,
        })
      });
      setDismissedFlags(p => ({ ...p, [sectionIdx]: true }));
      setDismissOutcome(p => ({ ...p, [sectionIdx]: meta?.outcome || 'Dismissed — Brain updated' }));
      setDismissMenuIdx(null);
      setNdaReferent('');
    } catch(e) {
      console.error('Dismiss flag error:', e);
      reportError(e, { area: 'compliance-gate' });
    }
  };

  const findSources = async (idx: number, sectionBody: string, claim: string) => {
    setFindingSourcesIdx(idx);
    setError('');
    try {
      const r = await authFetch('/api/compliance/find-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim, sectionBody, brandProfileId }),
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

  // One-shot verify-and-rewrite. Calls the server endpoint that does Sonar lookup +
  // citation integration in one pass, returning a one-click-applicable rewrite. This
  // is the friction-asymmetry fix: the previous flow required Find Sources → pick →
  // Apply → manually verify the stitch, with a 90% rework rate. This collapses to one
  // human action (review the result), and falls back to soften behavior if Sonar found
  // no usable source.
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
        // Capture outcome for the manual flow too — if a source was picked, this is a
        // 'cited' outcome equivalent to verify-and-cite. If no source was picked
        // (just Soften Without Citation), this is a 'softened' outcome with no source.
        const pickedSource = sourcesMap[idx]?.[selectedSource[idx] ?? 0] || null;
        setRewriteOutcomes(p => ({ ...p, [idx]: { mode: pickedSource ? 'cited' : 'softened', source: pickedSource } }));
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
    setError(''); // clear any stale 401 banner from a prior attempt — the retry may now succeed
    try {
      const edits = Object.entries(editedSections).map(([idx, content]) => ({
        sectionIndex: parseInt(idx),
        content
      }));
      const faqEdits = Object.entries(editedFaqs).map(([idx, qa]) => ({
        index: parseInt(idx),
        ...(qa.question !== undefined ? { question: qa.question } : {}),
        ...(qa.answer !== undefined ? { answer: qa.answer } : {})
      }));
      // Reject without typed reason is not allowed (server also enforces)
      const rejectedIdxs = Object.entries(decisions)
        .filter(([, v]) => v === 'rejected')
        .map(([k]) => Number(k));
      for (const ri of rejectedIdxs) {
        const rr = rejectReasons[ri];
        if (!rr?.code) {
          setError(`Section ${ri + 1}: pick a reject reason before submitting`);
          setSubmitLoading(false);
          return;
        }
        if (rr.code === 'other' && !(rr.note || '').trim()) {
          setError(`Section ${ri + 1}: "Other" requires a short note`);
          setSubmitLoading(false);
          return;
        }
      }
      const r = await authFetch('/api/compliance/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandProfileId,
          contentId: article.id,
          reviewMode: mode,
          editedSections: edits,
          editedFaqs: faqEdits,
          ...(editedKeyTakeaway !== null ? { keyTakeaway: editedKeyTakeaway } : {}),
          decisions,
          rejectReasons,
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
    setEditedKeyTakeaway(null); // reset per-article so a prior article's TL;DR edit doesn't carry
    if (article.compliance_report) setStep('review');
    // Restore any in-progress edits for this article from localStorage
    try {
      const saved = localStorage.getItem(`forge_compliance_edits_${article.id}`);
      if (saved) {
        const { edits, decisions: savedDecisions, faqEdits: savedFaqs } = JSON.parse(saved);
        setEditedSections(edits || {});
        setDecisions(savedDecisions || {});
        setEditedFaqs(savedFaqs || {});
      } else {
        setEditedSections({});
        setDecisions({});
        setEditedFaqs({});
      }
    } catch { setEditedSections({}); setDecisions({}); setEditedFaqs({}); }
  };

  const statusBadge = (status: ComplianceStatus) => {
    const labels: Record<ComplianceStatus, string> = { pending: 'Pending', reviewed: 'Reviewed', approved: 'Approved', rejected: 'Rejected' };
    return (
      <>
        <span className="comp-status-dot" aria-hidden="true" />
        {labels[status] || status}
      </>
    );
  };

  // Targeted rewrite — text selection handler for edit textareas
  const handleTextSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>, idx: number) => {
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = ta.value.slice(start, end).trim();
    // Require at least 15 chars and 3 words to avoid triggering on accidental drags
    if (text.length < 15 || text.split(/\s+/).length < 3) { setSelectionToolbar(null); return; }
    const rect = ta.getBoundingClientRect();
    // Position toolbar above the textarea, offset by rough caret position
    const lineHeight = 20;
    const charsPerLine = Math.max(Math.floor(rect.width / 8), 1);
    const lineOffset = Math.floor(start / charsPerLine) * lineHeight;
    setSelectionToolbar({ idx, text, start, end, top: rect.top + lineOffset - 50 + window.scrollY, left: rect.left + 10 + window.scrollX });
    setRewriteInstruction('');
  };

  const handleSelectionRewrite = async (idx: number) => {
    if (!selectionToolbar || !rewriteInstruction.trim() || !selectedArticle) return;
    setRewriteSelLoading(true);
    try {
      const sections = selectedArticle.article_json?.sections || [];
      const sectionText = editedSections[idx] ?? sections[idx]?.body ?? sections[idx]?.content ?? '';
      const res = await authFetch('/api/compliance/rewrite-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedText: selectionToolbar.text,
          instruction: rewriteInstruction,
          fullSectionText: sectionText,
          sectionHeading: sections[idx]?.heading || '',
          brandProfileId,
        }),
      });
      const data = await res.json();
      if (data.rewrittenText) {
        setRewriteUndo({ idx, original: sectionText });
        // Use string matching instead of numeric offsets (offsets can go stale)
        const pos = sectionText.indexOf(selectionToolbar.text);
        if (pos >= 0) {
          const before = sectionText.slice(0, pos);
          const after = sectionText.slice(pos + selectionToolbar.text.length);
          setEditedSections(p => ({ ...p, [idx]: before + data.rewrittenText + after }));
        }
        setSelectionToolbar(null);
        setRewriteInstruction('');
      }
    } catch (err) {
      console.error('[rewrite-selection]', err);
      reportError(err, { area: 'compliance-gate' });
    } finally {
      setRewriteSelLoading(false);
    }
  };

  return (
    <AppShell pageTitle="Compliance Gate">
      <div className="comp-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Stage 5</div>
            <h1 className="geo-title">Compliance Gate</h1>
            <p className="geo-description">
              AI self-critique + human refinement. Every edit trains the Brain.
              <span className="comp-scoring-tip-trigger" tabIndex={0}>
                <IconInfo /> How scoring works
                <span className="comp-scoring-tip">
                  <strong>Auto-approved</strong> — No flags from the AI critique. Safe to publish.<br/>
                  <strong>Pending review</strong> — AI flagged a concern (factual claim, brand voice, legal risk, or SME required). Review the flag, edit if needed, then approve.<br/>
                  <strong>Yellow flags</strong> — Caution. The AI found something worth checking but not blocking.<br/>
                  <strong>Red flags</strong> — High severity. Review before publishing.<br/><br/>
                  Every human edit is written to the Brain as a learning signal — the more you review, the smarter future articles get.
                </span>
              </span>
            </p>
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

            {/* Sections layout caption */}
            <div className="comp-sections-caption">
              <strong>All {selectedArticle.article_json?.sections?.length || 0} sections below will be included in the published article.</strong>{' '}
              <span style={{ color: 'var(--color-text-muted)' }}>
                Green sections passed AI review — shown read-only, but you can still edit them before publishing. Yellow/red sections have flags that need your decision.
              </span>
            </div>

            {/* Key Takeaway (TL;DR) — surfaced for review so it stops shipping
                unreviewed. It renders at the top of every published export. */}
            {(selectedArticle.article_json?.keyTakeaway || editedKeyTakeaway !== null) && (
              <div className="comp-tldr">
                <div className="comp-tldr-label">TL;DR / Key Takeaway — review before publish</div>
                <textarea
                  className="comp-section-edit"
                  value={editedKeyTakeaway ?? selectedArticle.article_json?.keyTakeaway ?? ''}
                  onChange={e => setEditedKeyTakeaway(e.target.value)}
                  rows={3}
                  placeholder="This summary ships at the top of every published article. Edit it here before approving."
                />
              </div>
            )}

            {/* Sections */}
            <div className="comp-sections">
              {selectedArticle.article_json?.sections?.map((section, idx) => {
                const flag = report?.flags?.find(f => f.sectionIndex === idx);
                const sectionText = section.body || section.content || '';
                const hasPlaceholder = /\[NEEDS[_ ]?CITATION[^\]]*\]|\[CITATION[^\]]*\]|\[INSERT[^\]]*\]/i.test(sectionText);
                const isEditing = section.confidenceTier !== 'green' || !!flag || mode === 'full-review' || hasPlaceholder || manualEditSections[idx];
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
                      {section.confidenceTier === 'green' && mode !== 'full-review' && !flag && !manualEditSections[idx] && (
                        <button
                          type="button"
                          className="comp-edit-section-btn"
                          onClick={() => {
                            setManualEditSections(p => ({ ...p, [idx]: true }));
                            setEditedSections(p => ({ ...p, [idx]: section.body || section.content || '' }));
                          }}
                          title="Edit this section before publishing"
                        >
                          Edit
                        </button>
                      )}
                      {section.confidenceTier === 'red' && (
                        <div className="comp-decision-btns">
                          <button
                            className={`comp-decision-btn approve ${decisions[idx] === 'approved' ? 'active' : ''}`}
                            onClick={() => {
                              setDecisions(p => ({ ...p, [idx]: 'approved' }));
                              setRejectReasons(p => {
                                const n = { ...p };
                                delete n[idx];
                                return n;
                              });
                            }}
                          >Approve</button>
                          <button
                            className={`comp-decision-btn reject ${decisions[idx] === 'rejected' ? 'active' : ''}`}
                            onClick={() => {
                              setDecisions(p => ({ ...p, [idx]: 'rejected' }));
                              setRejectReasons(p => (p[idx] ? p : { ...p, [idx]: { code: '', note: '' } }));
                            }}
                          >Reject</button>
                        </div>
                      )}
                      {decisions[idx] === 'rejected' && (
                        <div className="comp-reject-reason" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)' }}>
                            Reject reason (required)
                          </label>
                          <select
                            className="comp-reject-reason-select"
                            value={rejectReasons[idx]?.code || ''}
                            onChange={(e) => setRejectReasons(p => ({
                              ...p,
                              [idx]: { ...(p[idx] || {}), code: e.target.value },
                            }))}
                            style={{
                              fontSize: 12,
                              padding: '6px 8px',
                              borderRadius: 6,
                              border: '1px solid var(--color-border, #e5e7eb)',
                              background: 'var(--color-surface, #fff)',
                            }}
                          >
                            <option value="">Select a reason…</option>
                            {REJECT_REASON_OPTIONS.map((o) => (
                              <option key={o.code} value={o.code}>{o.label}</option>
                            ))}
                          </select>
                          {(rejectReasons[idx]?.code === 'other' || (rejectReasons[idx]?.code && rejectReasons[idx]?.code !== '')) && (
                            <input
                              className="comp-reject-reason-note"
                              placeholder={rejectReasons[idx]?.code === 'other' ? 'Brief note (required for Other)…' : 'Optional note…'}
                              value={rejectReasons[idx]?.note || ''}
                              onChange={(e) => setRejectReasons(p => ({
                                ...p,
                                [idx]: { ...(p[idx] || { code: '' }), note: e.target.value },
                              }))}
                              style={{
                                fontSize: 12,
                                padding: '6px 8px',
                                borderRadius: 6,
                                border: '1px solid var(--color-border, #e5e7eb)',
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {hasPlaceholder && !flag && (
                      <div className="comp-flag flag-yellow" style={{ marginBottom: 8 }}>
                        <div className="comp-placeholder-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                            <div className="comp-flag-actions-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                              {/* Single citation entry point — merged from the old "Verify & Cite"
                                  (auto-pick) + "Choose Source" (manual-pick). Fetches candidate
                                  sources, pre-selects the best, and lets the user confirm or swap
                                  before citing. One door instead of two confusingly-similar ones. */}
                              {(flag.type === 'factual_claim' || flag.type === 'legal_risk') && !sourcesMap[idx] && !rewrittenSections.has(idx) && (
                                <button
                                  className="comp-accept-suggestion-btn"
                                  style={{ background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)', fontWeight: 600 }}
                                  onClick={() => findSources(idx, section.body || section.content || '', flag.reason || '')}
                                  disabled={findingSourcesIdx === idx || rewritingIdx === idx}
                                  title="Find verified sources for this claim, pick one (the best is pre-selected), and cite it in the rewrite."
                                >
                                  {findingSourcesIdx === idx ? 'Finding sources...' : 'Find & cite'}
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
                                title={(flag.type === 'factual_claim' || flag.type === 'legal_risk')
                                  ? 'Apply the suggestion as written, without finding a source. Use this when softening the claim is the right call.'
                                  : 'Apply the suggestion as written.'}
                              >
                                {rewritingIdx === idx
                                  ? 'Rewriting...'
                                  : rewrittenSections.has(idx)
                                    ? (rewriteOutcomes[idx]?.mode === 'cited' ? 'Cited & Applied' : rewriteOutcomes[idx]?.mode === 'softened' ? 'Softened & Applied' : 'Rewrite Applied')
                                    : ((flag.type === 'factual_claim' || flag.type === 'legal_risk') ? 'Soften Without Citation' : 'Accept Suggestion')}
                              </button>
                              {!dismissedFlags[idx] && dismissMenuIdx !== idx && (
                                <button
                                  className="comp-dismiss-flag-btn"
                                  onClick={() => { setDismissMenuIdx(idx); setNdaReferent(''); }}
                                >
                                  Dismiss Flag ▾
                                </button>
                              )}
                              {!dismissedFlags[idx] && dismissMenuIdx === idx && (
                                <div className="comp-dismiss-menu" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, padding: 10, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface, rgba(148,163,184,0.06))' }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Why is this a false positive?</div>
                                  {DISMISS_REASONS.map(r => (
                                    <button
                                      key={r.key}
                                      className="comp-dismiss-flag-btn"
                                      style={{ textAlign: 'left' }}
                                      onClick={() => dismissFlag(idx, flag, r.key)}
                                      title={r.key === 'verified_unnameable'
                                        ? 'True and owner-attested, but the client is contractually redacted. Promotes it to Factual Ground so it stops being flagged and under-scored.'
                                        : r.outcome}
                                    >
                                      {r.label}
                                    </button>
                                  ))}
                                  <input
                                    type="text"
                                    value={ndaReferent}
                                    onChange={e => setNdaReferent(e.target.value)}
                                    placeholder="(optional) private note: real client — stored, never published"
                                    style={{ marginTop: 4, padding: '6px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-bg, #fff)', color: 'var(--color-text)' }}
                                  />
                                  <button
                                    className="comp-dismiss-flag-btn"
                                    style={{ opacity: 0.7 }}
                                    onClick={() => { setDismissMenuIdx(null); setNdaReferent(''); }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                              {dismissedFlags[idx] && (
                                <span className="comp-dismissed-label">{dismissOutcome[idx] || 'Dismissed — Brain updated'}</span>
                              )}
                            </div>

                            {/* Outcome footer — shows the integrated citation, or a soften note. */}
                            {rewriteOutcomes[idx] && rewrittenSections.has(idx) && (
                              <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, background: rewriteOutcomes[idx].mode === 'cited' ? 'rgba(124,58,237,0.08)' : 'rgba(148,163,184,0.10)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                {rewriteOutcomes[idx].mode === 'cited' && rewriteOutcomes[idx].source ? (
                                  <>
                                    <strong style={{ color: '#7C3AED' }}>Cited:</strong> {rewriteOutcomes[idx].source!.title}
                                    {rewriteOutcomes[idx].source!.year ? ` (${rewriteOutcomes[idx].source!.year})` : ''}
                                    {' — '}
                                    <a href={rewriteOutcomes[idx].source!.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>
                                      {(rewriteOutcomes[idx].source!.domain || rewriteOutcomes[idx].source!.url.replace(/^https?:\/\//, '').split('/')[0])}
                                    </a>
                                  </>
                                ) : (
                                  <><strong>Softened:</strong> No qualifying source found. The named-third-party assertion was hedged. <span style={{ opacity: 0.7 }}>Use 'Find &amp; cite' to try sourcing it.</span></>
                                )}
                              </div>
                            )}

                            {/* Source candidates */}
                            {sourcesMap[idx] && (
                              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>Top result is pre-selected as the best match — cite it, pick another, or soften the claim instead.</div>
                                {sourcesMap[idx].map((src, si) => (
                                  <div
                                    key={si}
                                    onClick={() => setSelectedSource(p => ({ ...p, [idx]: si }))}
                                    style={{
                                      padding: '10px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
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
                                <div className="comp-source-actions" style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                  <button
                                    className="comp-accept-suggestion-btn"
                                    onClick={() => acceptSuggestion(idx, editedSections[idx] ?? (section.body || section.content || ''), flag.reason || '', flag.suggestion || '')}
                                    disabled={rewritingIdx === idx}
                                    style={{ background: '#7C3AED', color: '#fff', borderColor: '#7C3AED' }}
                                  >
                                    {rewritingIdx === idx ? 'Citing source...' : `Cite this source`}
                                  </button>
                                  <button
                                    onClick={() => setSourcesMap(p => { const n = {...p}; delete n[idx]; return n; })}
                                    style={{ fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* One-card model: render EITHER the static published copy OR the editor,
                        never both. When a flag exists, we still want the highlighted read-only
                        preview ABOVE the editor so the user can see what Claude flagged while
                        editing — in that case HighlightedBody renders. When there's no flag and
                        the user has clicked Edit (manualEditSections[idx]), just the textarea. */}
                    {isEditing && !!flag && (
                      <HighlightedBody body={editedSections[idx] ?? section.body ?? section.content ?? ''} flag={flag} />
                    )}

                    {isEditing ? (
                      <div className="comp-edit-wrap" style={{ position: 'relative' }}>
                        <div className="comp-edit-label">Edit section copy below — select text and describe a change for AI rewrite</div>
                        <textarea
                          className="comp-section-edit"
                          value={editVal}
                          onChange={e => { setEditedSections(p => ({ ...p, [idx]: e.target.value })); setRewriteUndo(null); }}
                          onMouseUp={e => handleTextSelection(e, idx)}
                          onKeyUp={e => handleTextSelection(e as unknown as React.SyntheticEvent<HTMLTextAreaElement>, idx)}
                          placeholder="Edit the section text here. Address the flagged issue above, then submit below to approve and stage for publishing."
                          rows={8}
                        />
                        {selectionToolbar && selectionToolbar.idx === idx && (
                          <div className="comp-rewrite-toolbar" style={{ top: selectionToolbar.top, left: selectionToolbar.left }}>
                            <div className="comp-rewrite-toolbar-selected">"{selectionToolbar.text.length > 80 ? selectionToolbar.text.slice(0, 80) + '…' : selectionToolbar.text}"</div>
                            <div className="comp-rewrite-toolbar-row">
                              <input
                                className="comp-rewrite-input"
                                value={rewriteInstruction}
                                onChange={e => setRewriteInstruction(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleSelectionRewrite(idx); if (e.key === 'Escape') setSelectionToolbar(null); }}
                                placeholder="Describe your change…"
                                autoFocus
                              />
                              <button className="comp-rewrite-btn" onClick={() => handleSelectionRewrite(idx)} disabled={rewriteSelLoading || !rewriteInstruction.trim()}>
                                {rewriteSelLoading ? 'Rewriting…' : 'Rewrite'}
                              </button>
                              <button className="comp-rewrite-delete" onClick={() => {
                                if (!selectionToolbar) return;
                                if (!confirm(`Delete ${selectionToolbar.text.length} characters?\n\n"${selectionToolbar.text.slice(0, 100)}${selectionToolbar.text.length > 100 ? '…' : ''}"`)) return;
                                const sectionText = editedSections[idx] ?? selectedArticle?.article_json?.sections?.[idx]?.body ?? selectedArticle?.article_json?.sections?.[idx]?.content ?? '';
                                setRewriteUndo({ idx, original: sectionText });
                                // Use the actual selected text to find and remove — not numeric offsets which can go stale
                                const pos = sectionText.indexOf(selectionToolbar.text);
                                if (pos >= 0) {
                                  const before = sectionText.slice(0, pos);
                                  const after = sectionText.slice(pos + selectionToolbar.text.length);
                                  setEditedSections(p => ({ ...p, [idx]: (before + after).replace(/  +/g, ' ').replace(/\n{3,}/g, '\n\n').trim() }));
                                }
                                setSelectionToolbar(null);
                              }} title="Remove selected text">✕</button>
                            </div>
                          </div>
                        )}
                        {rewriteUndo && rewriteUndo.idx === idx && (
                          <button className="comp-rewrite-undo" onClick={() => { setEditedSections(p => ({ ...p, [idx]: rewriteUndo.original })); setRewriteUndo(null); }}>
                            ↩ Undo rewrite
                          </button>
                        )}
                      </div>
                    ) : (
                      <HighlightedBody body={editedSections[idx] ?? section.body ?? section.content ?? ''} flag={null} />
                    )}
                    {/* Section footer — confidence + decision status */}
                    <div className="comp-section-footer">
                      <span>
                        {flag
                          ? (decisions[idx] === 'approved' ? 'Approved' : decisions[idx] === 'rejected' ? 'Rejected' : 'Pending review')
                          : manualEditSections[idx]
                            ? 'Editing'
                            : 'Auto-approved'}
                      </span>
                      <span>{section.confidence}% confidence · {flag ? flag.type.replace(/_/g, ' ') : 'No flags'}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* FAQ editor — separate from sections because faqs live on article.faqs[],
                not article.sections[]. The Brand Profile/Strategy stages set FAQ structure
                (questions + answer direction); the Content Generator fills in actual answers.
                Operator edits here so wrong-year text, mis-phrasings, or off-brand copy in
                Q/A blocks can be fixed before publishing. */}
            {Array.isArray(selectedArticle.article_json?.faqs) && selectedArticle.article_json.faqs.length > 0 && (
              <div className="comp-faqs-block">
                <div className="comp-faqs-header">
                  <h3 className="comp-faqs-title">FAQs ({selectedArticle.article_json.faqs.length})</h3>
                  <p className="comp-faqs-sub">Edit Q&amp;A copy below — same submit button approves the whole article including FAQ edits.</p>
                </div>
                <div className="comp-faqs-list">
                  {selectedArticle.article_json.faqs.map((faq: any, idx: number) => {
                    const qVal = editedFaqs[idx]?.question ?? faq.question ?? '';
                    const aVal = editedFaqs[idx]?.answer ?? faq.answer ?? '';
                    return (
                      <div key={idx} className="comp-faq-edit-card">
                        <div className="comp-faq-label">Question {idx + 1}</div>
                        <input
                          className="comp-faq-q-input"
                          value={qVal}
                          onChange={e => setEditedFaqs(p => ({
                            ...p,
                            [idx]: { ...p[idx], question: e.target.value }
                          }))}
                          placeholder="FAQ question"
                        />
                        <div className="comp-faq-label">Answer</div>
                        <textarea
                          className="comp-faq-a-input"
                          value={aVal}
                          onChange={e => setEditedFaqs(p => ({
                            ...p,
                            [idx]: { ...p[idx], answer: e.target.value }
                          }))}
                          placeholder="FAQ answer"
                          rows={4}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
