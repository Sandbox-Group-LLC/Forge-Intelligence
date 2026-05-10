import { useState, useEffect, useRef } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import GateModal from '../components/GateModal';
import '../components/GateModal.css';
import './EmailCampaignPage.css';

// ── Icons ─────────────────────────────────────────────────────────────────────
const Mail = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>;
const Zap = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
const ChevronDown = ({ open }: { open: boolean }) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}><path d="m6 9 6 6 6-6"/></svg>;
const Copy = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>;
const HubSpot = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>;
const Save = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>;
const Check = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;

interface Brief {
  campaign_type: string;
  num_emails: number;
  business_problem: string;
  smart_goal: string;
  smp: string;
  uvp: string;
  pain_point: string;
  target_persona: string;
  current_mindset: string;
  desired_mindset: string;
  competitor: string;
  mandatories: string;
}

interface EmailRecord {
  id?: string;
  email_index: number;
  index?: number;
  job: string;
  send_day: number;
  subject_lines: { curiosity: string; benefit: string; pattern_interrupt: string };
  preview_text: string;
  body: string;
  cta_text: string;
  cta_url_placeholder: string;
  ps?: string | null;
  confidence_score: number;
  confidence_reason: string;
  flags: { type: string; severity: string; detail: string }[];
  // flag_resolutions: keyed by flag index (string), value is the resolution.
  // Stored in DB as JSONB, populated by /resolve-flag and
  // /dismiss-flag-as-false-positive endpoints. UI uses presence + action
  // value to render strikethrough + status badge on resolved flags.
  flag_resolutions?: Record<string, FlagResolution>;
}

interface FlagResolution {
  action: 'edited' | 'cited' | 'dismissed';
  resolvedAt: string;
  citationUrl?: string;
  dismissReason?: string;
}

const CAMPAIGN_TYPES = ['nurture', 'conversion', 'onboarding', 're-engagement', 'win-back'];
const EMAIL_COUNTS = [3, 5, 7];

const EMPTY_BRIEF: Brief = {
  campaign_type: 'nurture', num_emails: 5,
  business_problem: '', smart_goal: '', smp: '', uvp: '',
  pain_point: '', target_persona: '', current_mindset: '',
  desired_mindset: '', competitor: '', mandatories: '',
};

function ConfidenceBadge({ score }: { score: number }) {
  const color = score >= 85 ? '#22C55E' : score >= 70 ? '#F5B942' : '#EF4444';
  const label = score >= 85 ? 'High' : score >= 70 ? 'Medium' : 'Low';
  return (
    <span className="ec-confidence-badge" style={{ background: `${color}18`, color, borderColor: `${color}40` }}>
      {score}% · {label}
    </span>
  );
}

function FlagPill({ flag }: { flag: { type: string; severity: string; detail: string } }) {
  const color = flag.severity === 'red' ? '#EF4444' : '#F5B942';
  const label = flag.type.replace(/_/g, ' ');
  return (
    <span className="ec-flag-pill" style={{ background: `${color}15`, color, borderColor: `${color}40` }} title={flag.detail}>
      {label}
    </span>
  );
}

function EmailCard({
  email, idx, onCopyForHubSpot, onEditEmail, onResolveFlag, onDismissFlag,
}: {
  email: EmailRecord;
  idx: number;
  onCopyForHubSpot?: (email: EmailRecord) => void;
  onEditEmail?: (emailId: string, patch: Partial<EmailRecord>) => Promise<void>;
  onResolveFlag?: (emailId: string, flagIndex: number, action: 'edited' | 'cited' | 'dismissed', extras?: { citationUrl?: string; dismissReason?: string }) => Promise<void>;
  onDismissFlag?: (emailId: string, flagIndex: number, reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(idx === 0);
  const [copiedField, setCopiedField] = useState('');
  // Edit mode: when true, every text field becomes a textarea/input. Save
  // sends a PATCH and updates parent state; Cancel reverts the draft.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Partial<EmailRecord>>({});
  // Per-flag action UI state (which flag is in 'add citation' or 'dismiss' mode)
  const [flagActionIdx, setFlagActionIdx] = useState<number | null>(null);
  const [flagActionMode, setFlagActionMode] = useState<'cite' | 'dismiss' | null>(null);
  const [flagActionInput, setFlagActionInput] = useState('');
  const [flagSaving, setFlagSaving] = useState(false);

  const startEditing = () => {
    setDraft({
      body: email.body,
      ps: email.ps,
      cta_text: email.cta_text,
      cta_url_placeholder: email.cta_url_placeholder,
      subject_lines: { ...email.subject_lines },
    });
    setEditing(true);
  };
  const cancelEditing = () => { setDraft({}); setEditing(false); };
  const saveEdits = async () => {
    if (!email.id || !onEditEmail) return;
    setSaving(true);
    try {
      await onEditEmail(email.id, draft);
      setEditing(false);
      setDraft({});
    } catch (err) {
      // parent shows error toast
    } finally {
      setSaving(false);
    }
  };

  const beginFlagAction = (i: number, mode: 'cite' | 'dismiss') => {
    setFlagActionIdx(i);
    setFlagActionMode(mode);
    setFlagActionInput('');
  };
  const cancelFlagAction = () => {
    setFlagActionIdx(null);
    setFlagActionMode(null);
    setFlagActionInput('');
  };
  const submitFlagAction = async () => {
    if (flagActionIdx === null || !email.id) return;
    setFlagSaving(true);
    try {
      if (flagActionMode === 'cite' && onResolveFlag) {
        await onResolveFlag(email.id, flagActionIdx, 'cited', { citationUrl: flagActionInput });
      } else if (flagActionMode === 'dismiss' && onDismissFlag) {
        await onDismissFlag(email.id, flagActionIdx, flagActionInput);
      }
      cancelFlagAction();
    } catch (err) { /* parent toast */ } finally {
      setFlagSaving(false);
    }
  };
  const resolveAsEdited = async (i: number) => {
    if (!email.id || !onResolveFlag) return;
    setFlagSaving(true);
    try { await onResolveFlag(email.id, i, 'edited'); } catch (err) { /* toast */ }
    finally { setFlagSaving(false); }
  };

  const copy = (text: string, field: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(''), 2000);
    });
  };

  const emailIdx = email.email_index ?? email.index ?? idx + 1;
  const subjects = email.subject_lines || {};

  // Defense-in-depth body sanitizer. The system prompt now tells the LLM to
  // keep P.S./CTA/proof annotations OUT of body, but if it slips up we strip
  // the duplicates here so the user never sees them twice. Each pattern is
  // documented as it relates to the field-separation rules in the prompt.
  const sanitizeBody = (raw: string): string => {
    if (!raw) return '';
    let s = raw;
    // 1. Strip any inline {{cta_url}} / {{cta_link}} placeholder. The CTA
    //    URL renders as a button below body — inline placeholder is duplicate.
    s = s.replace(/\{\{\s*cta_(?:url|link)\s*\}\}/gi, '');
    // 2. Strip [NEEDS_PROOF: ...] / [NEEDS_REVIEW: ...] inline annotations.
    //    These should be flag entries, not body text. Multi-line capable.
    s = s.replace(/\[NEEDS_(?:PROOF|REVIEW|CITATION|VERIFICATION)\s*:[^\]]*\]/gi, '');
    // 3. Strip a trailing P.S. paragraph from body. The dedicated ps field
    //    renders separately. Match 'P.S.' (with or without periods/spacing)
    //    at the start of a line through the end of the body.
    s = s.replace(/(?:\r?\n){1,2}P\.?\s*S\.?\s*[\s\S]*$/i, '');
    // 4. Collapse 3+ consecutive newlines (left over from removed blocks) to 2.
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  };

  const cleanBody = sanitizeBody(email.body);

  return (
    <div className={`ec-email-card ${open ? 'open' : ''}`}>
      <button className="ec-email-header" onClick={() => setOpen(o => !o)}>
        <div className="ec-email-header-left">
          <span className="ec-email-num">Email {emailIdx}</span>
          <span className="ec-email-job">{email.job}</span>
        </div>
        <div className="ec-email-header-right">
          {email.flags?.filter(f => f.severity === 'red').length > 0 && (
            <span className="ec-flag-count red">{email.flags.filter(f => f.severity === 'red').length} ●</span>
          )}
          {email.flags?.filter(f => f.severity === 'yellow').length > 0 && (
            <span className="ec-flag-count yellow">{email.flags.filter(f => f.severity === 'yellow').length} ●</span>
          )}
          <ConfidenceBadge score={email.confidence_score} />
          <span className="ec-send-day">Day {email.send_day}</span>
          <ChevronDown open={open} />
        </div>
      </button>

      {open && (
        <div className="ec-email-body">
          {/* Subject Lines */}
          <div className="ec-section">
            <div className="ec-section-label">SUBJECT LINES</div>
            {(['curiosity', 'benefit', 'pattern_interrupt'] as const).map((key) => {
              const labelMap = { curiosity: 'Curiosity', benefit: 'Direct Benefit', pattern_interrupt: 'Pattern Interrupt' };
              const label = labelMap[key];
              const draftSubjects = (draft.subject_lines as any) || subjects;
              const value = editing ? (draftSubjects[key] || '') : (subjects as any)[key];
              if (!editing && !value) return null;
              return (
                <div key={key} className="ec-subject-row">
                  <span className="ec-subject-type">{label}</span>
                  {editing ? (
                    <input
                      className="ec-edit-input"
                      value={value}
                      onChange={(e) => setDraft({
                        ...draft,
                        subject_lines: { ...draftSubjects, [key]: e.target.value }
                      })}
                    />
                  ) : (
                    <>
                      <span className="ec-subject-text">{value}</span>
                      <button className="ec-copy-btn" onClick={() => copy(value, label)} title="Copy">
                        {copiedField === label ? <Check /> : <Copy />}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            {email.preview_text && (
              <div className="ec-subject-row preview">
                <span className="ec-subject-type">Preview</span>
                <span className="ec-subject-text" style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{email.preview_text}</span>
                <button className="ec-copy-btn" onClick={() => copy(email.preview_text, 'preview')} title="Copy">
                  {copiedField === 'preview' ? <Check /> : <Copy />}
                </button>
              </div>
            )}
          </div>

          {/* Body */}
          <div className="ec-section">
            <div className="ec-section-label-row">
              <span className="ec-section-label">EMAIL BODY</span>
              <div className="ec-section-label-actions">
                {!editing && onEditEmail && email.id && (
                  <button className="ec-copy-btn-sm" onClick={startEditing} title="Edit this email">
                    ✎ Edit
                  </button>
                )}
                {!editing && (
                  <button className="ec-copy-btn-sm" onClick={() => copy(cleanBody + (email.ps ? `\n\nP.S. ${email.ps}` : ''), 'body')}>
                    {copiedField === 'body' ? <><Check /> Copied</> : <><Copy /> Copy all</>}
                  </button>
                )}
                {!editing && onCopyForHubSpot && (
                  <button
                    className="ec-copy-btn-sm"
                    onClick={() => onCopyForHubSpot(email)}
                    title="Copy as HubSpot-paste-ready HTML"
                  >
                    <HubSpot /> Copy for HubSpot
                  </button>
                )}
                {editing && (
                  <>
                    <button className="ec-copy-btn-sm primary" onClick={saveEdits} disabled={saving}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button className="ec-copy-btn-sm" onClick={cancelEditing} disabled={saving}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
            {editing ? (
              <textarea
                className="ec-edit-textarea"
                value={draft.body || ''}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                rows={12}
              />
            ) : (
              <pre className="ec-body-text">{cleanBody}</pre>
            )}
            {editing ? (
              <div className="ec-edit-row">
                <label className="ec-edit-label">P.S.</label>
                <textarea
                  className="ec-edit-textarea"
                  value={draft.ps || ''}
                  onChange={(e) => setDraft({ ...draft, ps: e.target.value })}
                  rows={2}
                  placeholder="Optional postscript"
                />
              </div>
            ) : (
              email.ps && <p className="ec-ps-line"><strong>P.S.</strong> {email.ps}</p>
            )}
          </div>

          {/* CTA */}
          <div className="ec-section">
            <div className="ec-section-label">CTA</div>
            {editing ? (
              <div className="ec-edit-row">
                <input
                  className="ec-edit-input"
                  value={draft.cta_text || ''}
                  onChange={(e) => setDraft({ ...draft, cta_text: e.target.value })}
                  placeholder="CTA text (e.g. 'See how it works →')"
                />
                <input
                  className="ec-edit-input"
                  value={draft.cta_url_placeholder || ''}
                  onChange={(e) => setDraft({ ...draft, cta_url_placeholder: e.target.value })}
                  placeholder="CTA URL or {{cta_url}}"
                />
              </div>
            ) : (
              <div className="ec-cta-row">
                <span className="ec-cta-text">{email.cta_text}</span>
                <span className="ec-cta-url">{email.cta_url_placeholder}</span>
              </div>
            )}
          </div>

          {/* Flags */}
          {email.flags?.length > 0 && (
            <div className="ec-section">
              <div className="ec-section-label">COMPLIANCE FLAGS</div>
              <div className="ec-flags-row">
                {email.flags.map((f, i) => <FlagPill key={i} flag={f} />)}
              </div>
              <div className="ec-flags-detail">
                {email.flags.map((f, i) => {
                  const resolution = email.flag_resolutions?.[String(i)];
                  const isResolved = !!resolution;
                  const isActionOpen = flagActionIdx === i;
                  return (
                    <div key={i} className={`ec-flag-detail-item ${f.severity}${isResolved ? ' resolved' : ''}`}>
                      <div className="ec-flag-detail-row">
                        <span className="ec-flag-detail-type">{f.type.replace(/_/g, ' ')}</span>
                        <span className="ec-flag-detail-text">{f.detail}</span>
                        {isResolved && (
                          <span className={`ec-flag-status ${resolution.action}`}>
                            {resolution.action === 'edited' && '✓ Resolved (edited)'}
                            {resolution.action === 'cited' && '✓ Cited'}
                            {resolution.action === 'dismissed' && '× Dismissed'}
                          </span>
                        )}
                      </div>
                      {isResolved && resolution.citationUrl && (
                        <div className="ec-flag-resolution-detail">
                          Source: <a href={resolution.citationUrl} target="_blank" rel="noopener noreferrer">{resolution.citationUrl}</a>
                        </div>
                      )}
                      {isResolved && resolution.dismissReason && (
                        <div className="ec-flag-resolution-detail">
                          Reason: {resolution.dismissReason}
                        </div>
                      )}
                      {!isResolved && !isActionOpen && email.id && (onResolveFlag || onDismissFlag) && (
                        <div className="ec-flag-actions">
                          {onResolveFlag && (
                            <button className="ec-flag-action-btn" onClick={() => resolveAsEdited(i)} disabled={flagSaving} title="Mark as resolved (you've edited the body to address it)">
                              ✓ Mark resolved
                            </button>
                          )}
                          {onResolveFlag && (
                            <button className="ec-flag-action-btn" onClick={() => beginFlagAction(i, 'cite')} disabled={flagSaving} title="Add a citation URL backing the claim">
                              + Add citation
                            </button>
                          )}
                          {onDismissFlag && (
                            <button className="ec-flag-action-btn dismiss" onClick={() => beginFlagAction(i, 'dismiss')} disabled={flagSaving} title="Dismiss as false positive (writes to brain memory so future runs suppress)">
                              × Dismiss
                            </button>
                          )}
                        </div>
                      )}
                      {isActionOpen && (
                        <div className="ec-flag-action-form">
                          <input
                            className="ec-edit-input"
                            value={flagActionInput}
                            onChange={(e) => setFlagActionInput(e.target.value)}
                            placeholder={flagActionMode === 'cite' ? 'https://... (citation URL)' : 'Why is this a false positive? (10+ chars)'}
                            autoFocus
                          />
                          <button className="ec-flag-action-btn primary" onClick={submitFlagAction} disabled={flagSaving || (flagActionMode === 'dismiss' && flagActionInput.length < 10) || (flagActionMode === 'cite' && !flagActionInput)}>
                            {flagSaving ? 'Saving…' : flagActionMode === 'cite' ? 'Save citation' : 'Confirm dismiss'}
                          </button>
                          <button className="ec-flag-action-btn" onClick={cancelFlagAction} disabled={flagSaving}>
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Confidence */}
          <div className="ec-section">
            <div className="ec-section-label">CONFIDENCE REASONING</div>
            <p className="ec-confidence-text">{email.confidence_reason}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function EmailCampaignPage() {
  const { isPaid, brandLoading, activeBrand, authToken } = useApp();
  const activeBrandId = activeBrand?.id ?? null;
  const ah: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};

  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell>
        <GateModal featureName="Email Campaign Generator" onClose={() => window.location.href = '/app/context-hub'} onUnlocked={() => {}} />
      </AppShell>
    );
  }

  const [step, setStep] = useState<'brief' | 'generating' | 'results' | 'history'>('brief');
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [campaignId, setCampaignId] = useState('');
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [genStatus, setGenStatus] = useState('');
  const [genProgress, setGenProgress] = useState(0);
  const [error, setError] = useState('');
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [subjectVariant, setSubjectVariant] = useState<'benefit' | 'curiosity' | 'pattern_interrupt'>('benefit');
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [pushResult, setPushResult] = useState('');
  const [sequenceNotes, setSequenceNotes] = useState('');
  const esRef = useRef<EventSource | null>(null);

  const personas = (activeBrand as any)?.personas || [];

  useEffect(() => {
    if (!activeBrandId) return;
    fetch(`/api/email-campaign/list/${activeBrandId}`, { headers: ah }).then(r => r.json()).then(d => {
      if (d.success) setCampaigns(d.campaigns);
    }).catch(() => {});
    fetch(`/api/email-campaign/brief-templates/${activeBrandId}`, { headers: ah }).then(r => r.json()).then(d => {
      if (d.success) setTemplates(d.templates);
    }).catch(() => {});
  }, [activeBrandId]);

  const handleGenerate = async () => {
    if (!activeBrandId) return;
    setError('');
    setStep('generating');
    setEmails([]);
    setGenProgress(0);

    try {
      // Create campaign
      const createRes = await fetch('/api/email-campaign/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah },
        body: JSON.stringify({ brandProfileId: activeBrandId, brief }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);
      const newCampaignId = createData.campaignId;
      setCampaignId(newCampaignId);

      // SSE generation
      const es = new EventSource(`/api/email-campaign/generate/${newCampaignId}?token=${authToken}`);
      esRef.current = es;

      es.addEventListener('status', (e) => {
        setGenStatus(JSON.parse(e.data).message);
      });
      es.addEventListener('busy', () => {
      setError('Email campaign generation already in progress. Check back shortly.');
      setStep('brief');
      es.close();
    });

    es.addEventListener('email', (e) => {
        const data = JSON.parse(e.data);
        setGenProgress(p => p + 1);
        setGenStatus(`Email ${data.index} complete`);
      });
      es.addEventListener('complete', async (e) => {
        const data = JSON.parse(e.data);
        setSequenceNotes(data.sequenceNotes || '');
        es.close();
        // Load full emails from DB
        const campRes = await fetch(`/api/email-campaign/${newCampaignId}`, { headers: ah });
        const campData = await campRes.json();
        if (campData.success) setEmails(campData.emails);
          setStep('results');
        // Refresh campaigns list
        fetch(`/api/email-campaign/list/${activeBrandId}`, { headers: ah }).then(r => r.json()).then(d => {
          if (d.success) setCampaigns(d.campaigns);
        });
      });
      es.addEventListener('error', (e) => {
        try { const d = JSON.parse((e as any).data); setError(d.message); } catch {}
          setStep('brief');
        es.close();
      });
    } catch (err: any) {
      setError(err.message);
      setStep('brief');
    }
  };

  const loadCampaign = async (id: string) => {
    const res = await fetch(`/api/email-campaign/${id}`, { headers: ah });
    const data = await res.json();
    if (data.success) {
      setCampaignId(id);
      setEmails(data.emails);
      setBrief(data.campaign.brief);
      setSequenceNotes(data.campaign.sequence_notes || '');
      setStep('results');
    }
  };

  const saveTemplate = async () => {
    if (!templateName.trim() || !activeBrandId) return;
    setSavingTemplate(true);
    await fetch('/api/email-campaign/save-brief-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah },
      body: JSON.stringify({ brandProfileId: activeBrandId, name: templateName, brief }),
    });
    setSavingTemplate(false);
    setTemplateName('');
    fetch(`/api/email-campaign/brief-templates/${activeBrandId}`, { headers: ah }).then(r => r.json()).then(d => {
      if (d.success) setTemplates(d.templates);
    });
  };

  // Copy ONE email to clipboard as HubSpot-paste-ready HTML. The user
  // pastes into HubSpot Sales > Templates > New > Source view to create
  // a saved template. Two-click manual flow because HubSpot's public API
  // gates email-template creation behind Marketing Hub Pro+ at every
  // tier-accessible endpoint.
  // PATCH /api/email-campaign/email/:id — update one email's editable fields
  // Updates local state on success so the open card reflects the edit
  // without a full re-fetch.
  const editEmail = async (emailId: string, patch: Partial<EmailRecord>) => {
    const res = await fetch(`/api/email-campaign/email/${emailId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...ah },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (data.success && data.email) {
      setEmails((prev) => prev.map((e) => (e.id === emailId ? { ...e, ...data.email } : e)));
      setPushResult('✓ Email updated.');
    } else {
      setPushResult(`Edit failed: ${data.error || 'unknown'}`);
      throw new Error(data.error || 'edit failed');
    }
  };

  // POST /api/email-campaign/email/:id/resolve-flag — mark a flag resolved
  const resolveFlag = async (
    emailId: string,
    flagIndex: number,
    action: 'edited' | 'cited' | 'dismissed',
    extras?: { citationUrl?: string; dismissReason?: string }
  ) => {
    const res = await fetch(`/api/email-campaign/email/${emailId}/resolve-flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah },
      body: JSON.stringify({ flagIndex, action, ...(extras || {}) }),
    });
    const data = await res.json();
    if (data.success) {
      setEmails((prev) => prev.map((e) =>
        e.id === emailId ? { ...e, flag_resolutions: data.flag_resolutions } : e
      ));
      setPushResult('✓ Flag resolved.');
    } else {
      setPushResult(`Resolve failed: ${data.error || 'unknown'}`);
      throw new Error(data.error || 'resolve failed');
    }
  };

  // POST /api/email-campaign/email/:id/dismiss-flag-as-false-positive
  // Same outcome as resolve-flag dismissed, BUT also writes to brain_mistakes
  // so future Compliance Gate runs learn from this dismissal.
  const dismissFlag = async (emailId: string, flagIndex: number, reason: string) => {
    const res = await fetch(`/api/email-campaign/email/${emailId}/dismiss-flag-as-false-positive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah },
      body: JSON.stringify({ flagIndex, reason }),
    });
    const data = await res.json();
    if (data.success) {
      // Re-fetch the email to get fresh flag_resolutions
      const emailRes = await fetch(`/api/email-campaign/${campaignId}`, { headers: ah });
      const emailData = await emailRes.json();
      if (emailData.emails) setEmails(emailData.emails);
      setPushResult('✓ Flag dismissed. Brain updated.');
    } else {
      setPushResult(`Dismiss failed: ${data.error || 'unknown'}`);
      throw new Error(data.error || 'dismiss failed');
    }
  };

  const copyAsHubSpotHtml = (email: EmailRecord) => {
    const subjects = email.subject_lines || ({} as any);
    const subject = subjects[subjectVariant] || subjects.benefit || subjects.curiosity || '';
    // Apply same sanitization the EmailCard uses so the HubSpot copy doesn't
    // contain duplicate P.S./CTA/proof annotations either.
    const sanitized = (email.body || '')
      .replace(/\{\{\s*cta_(?:url|link)\s*\}\}/gi, '')
      .replace(/\[NEEDS_(?:PROOF|REVIEW|CITATION|VERIFICATION)\s*:[^\]]*\]/gi, '')
      .replace(/(?:\r?\n){1,2}P\.?\s*S\.?\s*[\s\S]*$/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const paragraphs = sanitized
      .split(/\n\n+/)
      .map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
      .join('\n  ');
    const psHtml = email.ps ? `\n  <p style="margin-top:24px;"><em>P.S. ${email.ps}</em></p>` : '';
    const ctaHtml = email.cta_text
      ? `\n  <p style="margin-top:24px;"><a href="${email.cta_url_placeholder || '#'}" style="color:#1d6ad8;">${email.cta_text}</a></p>`
      : '';
    const html = `<!-- Subject: ${subject} -->
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b; line-height: 1.6;">
  ${paragraphs}${ctaHtml}${psHtml}
</div>`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(html).then(() => {
        setPushResult('✓ HTML copied. Paste into HubSpot Sales > Templates > New > Source view.');
      }).catch(() => {
        setPushResult('Clipboard write blocked by browser. Try the .txt export instead.');
      });
    } else {
      setPushResult('Clipboard API unavailable. Use the .txt export instead.');
    }
  };

  const exportAsText = () => {
    const text = emails.map(e => {
      const idx = e.email_index ?? e.index;
      const s = e.subject_lines || {};
      return `EMAIL ${idx} — Day ${e.send_day}\n${'─'.repeat(50)}\nJOB: ${e.job}\n\nSUBJECT LINES:\n  Curiosity: ${s.curiosity}\n  Benefit: ${s.benefit}\n  Pattern Interrupt: ${s.pattern_interrupt}\n\nPREVIEW: ${e.preview_text}\n\n${e.body}${e.ps ? `\n\nP.S. ${e.ps}` : ''}\n\nCTA: ${e.cta_text} → ${e.cta_url_placeholder}`;
    }).join('\n\n' + '═'.repeat(50) + '\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `email-campaign-${campaignId.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // CSV export for Attio import. The user's Attio workspace has an Object
  // called "Generated Emails" with attributes "Email Subject" and "Email
  // Body". Header row matches those exactly so Attio's CSV importer maps
  // columns automatically with no manual step.
  //
  // One row per email. The user picks which subject variant
  // (benefit / curiosity / pattern_interrupt) to export — each Attio
  // sequence step takes a single subject, not three, so we don't ship all
  // three. Default variant is 'benefit' since it's the most universally
  // on-brand starting point; user can switch via the dropdown next to
  // the button before clicking export.
  const exportAsAttioCsv = () => {
    // CSV-safe field: wrap in quotes, double up internal quotes. Required
    // because email bodies contain commas, newlines, and (occasionally)
    // straight quotes in punctuation.
    const csvField = (v: string | null | undefined) => {
      const s = String(v ?? '');
      return `"${s.replace(/"/g, '""')}"`;
    };

    const variant = subjectVariant; // 'benefit' | 'curiosity' | 'pattern_interrupt'
    const header = ['Email Subject', 'Email Body'].map(csvField).join(',');

    const rows = emails.map(e => {
      const subjects = e.subject_lines || ({} as any);
      const subject = subjects[variant] || subjects.benefit || '';
      // Body + PS as a single field. Blank line between body and PS so
      // it renders cleanly when pasted into a sequence step or read in
      // Attio's record viewer.
      const body = e.ps ? `${e.body}\n\nP.S. ${e.ps}` : e.body;
      return [csvField(subject), csvField(body)].join(',');
    });

    // \r\n line endings are CSV-spec correct and what Attio's importer
    // expects. BOM upfront so Excel-on-Windows previews don't mangle
    // unicode (em dashes, smart quotes) if Brian opens the CSV before
    // uploading.
    const csv = '\uFEFF' + [header, ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attio-import-${campaignId.slice(0, 8)}-${variant}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell>
      <div className="ec-page">
        <div className="ec-header">
          <div className="geo-eyebrow">Stage 4.6</div>
          <h2 className="ec-title">Email Campaign Generator</h2>
          <p className="ec-subtitle">Brief-driven sequences — voice-matched, Brain-informed, HubSpot-ready.</p>
          <div className="ec-header-actions">
            {step !== 'brief' && <button className="ec-btn-ghost" onClick={() => setStep('brief')}>New Campaign</button>}
            <button className="ec-btn-ghost" onClick={() => setStep(step === 'history' ? 'brief' : 'history')}>
              {step === 'history' ? '← Back' : `Past Campaigns (${campaigns.length})`}
            </button>
          </div>
        </div>

        {error && <div className="ec-error">{error} <button onClick={() => setError('')}>✕</button></div>}

        {/* ── HISTORY ── */}
        {step === 'history' && (
          <div className="ec-history">
            {campaigns.length === 0 ? (
              <div className="ec-empty">No campaigns yet. Generate your first one.</div>
            ) : campaigns.map(c => (
              <button key={c.id} className="ec-history-item" onClick={() => loadCampaign(c.id)}>
                <div className="ec-history-smp">{c.brief?.smp || 'Untitled Campaign'}</div>
                <div className="ec-history-meta">{c.brief?.campaign_type} · {c.brief?.num_emails} emails · {new Date(c.created_at).toLocaleDateString()}</div>
                <span className={`ec-history-status ${c.status}`}>{c.status}</span>
              </button>
            ))}
            {templates.length > 0 && (
              <div className="ec-template-section">
                <div className="ec-section-label">SAVED BRIEF TEMPLATES</div>
                {templates.map(t => (
                  <button key={t.id} className="ec-history-item" onClick={() => { setBrief(t.brief); setStep('brief'); }}>
                    <div className="ec-history-smp">{t.name}</div>
                    <div className="ec-history-meta">{t.brief?.campaign_type} · {t.brief?.num_emails} emails</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── BRIEF FORM ── */}
        {step === 'brief' && (
          <div className="ec-brief-form">
            <div className="ec-form-grid">
              {/* Campaign type + count */}
              <div className="ec-form-row-2">
                <div className="ec-form-group">
                  <label className="ec-label">Campaign type</label>
                  <select className="ec-select" value={brief.campaign_type} onChange={e => setBrief({ ...brief, campaign_type: e.target.value })}>
                    {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
                <div className="ec-form-group">
                  <label className="ec-label">Number of emails</label>
                  <select className="ec-select" value={brief.num_emails} onChange={e => setBrief({ ...brief, num_emails: Number(e.target.value) })}>
                    {EMAIL_COUNTS.map(n => <option key={n} value={n}>{n} emails</option>)}
                  </select>
                </div>
              </div>

              {/* Section 1: Core Objective */}
              <div className="ec-form-section-header">1 — Core Objective</div>
              <div className="ec-form-group">
                <label className="ec-label">Business problem <span className="ec-required">*</span></label>
                <textarea className="ec-textarea" rows={2} placeholder="e.g. Customers buy once but never return. Repeat purchase rate is 12% vs. industry average of 35%." value={brief.business_problem} onChange={e => setBrief({ ...brief, business_problem: e.target.value })} />
              </div>
              <div className="ec-form-group">
                <label className="ec-label">SMART goal <span className="ec-required">*</span></label>
                <input className="ec-input" placeholder="e.g. Convert 15% of free users to Pro within 30 days of signup" value={brief.smart_goal} onChange={e => setBrief({ ...brief, smart_goal: e.target.value })} />
              </div>

              {/* Section 2: Product Intelligence */}
              <div className="ec-form-section-header">2 — Product Intelligence</div>
              <div className="ec-form-group">
                <label className="ec-label">Single-Minded Proposition (SMP) <span className="ec-required">*</span></label>
                <input className="ec-input" placeholder="e.g. This is the only platform that makes your content measurably smarter every time you publish." value={brief.smp} onChange={e => setBrief({ ...brief, smp: e.target.value })} />
              </div>
              <div className="ec-form-group">
                <label className="ec-label">UVP — what makes this better than competitors <span className="ec-required">*</span></label>
                <input className="ec-input" placeholder="e.g. Permanent brand memory. Every publish cycle trains the Brain — competitors start from zero each time." value={brief.uvp} onChange={e => setBrief({ ...brief, uvp: e.target.value })} />
              </div>
              <div className="ec-form-group">
                <label className="ec-label">Specific pain point being solved <span className="ec-required">*</span></label>
                {personas.length > 0 ? (
                  <select className="ec-select" value={brief.pain_point} onChange={e => setBrief({ ...brief, pain_point: e.target.value })}>
                    <option value="">Select from persona pain points...</option>
                    {personas.flatMap((p: any) => (p.painPoints || []).map((pp: string) => (
                      <option key={pp} value={pp}>{pp}</option>
                    )))}
                    <option value="custom">Custom...</option>
                  </select>
                ) : (
                  <input className="ec-input" placeholder="e.g. Spending 12+ hours/week on content that doesn't compound" value={brief.pain_point} onChange={e => setBrief({ ...brief, pain_point: e.target.value })} />
                )}
              </div>

              {/* Section 3: Audience */}
              <div className="ec-form-section-header">3 — Audience</div>
              <div className="ec-form-group">
                <label className="ec-label">Target persona <span className="ec-required">*</span></label>
                {personas.length > 0 ? (
                  <select className="ec-select" value={brief.target_persona} onChange={e => setBrief({ ...brief, target_persona: e.target.value })}>
                    <option value="">Select from Brain personas...</option>
                    {personas.map((p: any) => <option key={p.id} value={`${p.name} — ${p.role}`}>{p.name} — {p.role}</option>)}
                  </select>
                ) : (
                  <input className="ec-input" placeholder="e.g. VP of Marketing at a Series B SaaS, 50-200 employees" value={brief.target_persona} onChange={e => setBrief({ ...brief, target_persona: e.target.value })} />
                )}
              </div>
              <div className="ec-form-row-2">
                <div className="ec-form-group">
                  <label className="ec-label">Current mindset</label>
                  <input className="ec-input" placeholder="e.g. Never heard of it / skeptical of AI tools" value={brief.current_mindset} onChange={e => setBrief({ ...brief, current_mindset: e.target.value })} />
                </div>
                <div className="ec-form-group">
                  <label className="ec-label">Desired mindset after the sequence</label>
                  <input className="ec-input" placeholder="e.g. This will save my team 8 hours/week and make our content smarter" value={brief.desired_mindset} onChange={e => setBrief({ ...brief, desired_mindset: e.target.value })} />
                </div>
              </div>

              {/* Section 4: Competitive */}
              <div className="ec-form-section-header">4 — Competitive Context</div>
              <div className="ec-form-group">
                <label className="ec-label">Direct competitor for this campaign</label>
                <input className="ec-input" placeholder="e.g. Jasper, Copy.ai" value={brief.competitor} onChange={e => setBrief({ ...brief, competitor: e.target.value })} />
              </div>

              {/* Section 5: Constraints */}
              <div className="ec-form-section-header">5 — Mandatories &amp; Constraints</div>
              <div className="ec-form-group">
                <label className="ec-label">Mandatories (legal, CTAs, timing, required phrases)</label>
                <textarea className="ec-textarea" rows={2} placeholder="e.g. Must include 30-day money-back guarantee. CTA must link to /pricing. No claims about competitor pricing." value={brief.mandatories} onChange={e => setBrief({ ...brief, mandatories: e.target.value })} />
              </div>
            </div>

            <div className="ec-brief-actions">
              {/* Template save */}
              <div className="ec-template-save">
                <input className="ec-input-sm" placeholder="Save as template..." value={templateName} onChange={e => setTemplateName(e.target.value)} />
                <button className="ec-btn-ghost-sm" onClick={saveTemplate} disabled={savingTemplate || !templateName.trim()}>
                  <Save /> {savingTemplate ? 'Saving...' : 'Save'}
                </button>
              </div>
              <button
                className="ec-btn-primary"
                onClick={handleGenerate}
                disabled={!brief.business_problem || !brief.smart_goal || !brief.smp || !brief.uvp || !brief.pain_point || !brief.target_persona}
              >
                <Zap /> Generate {brief.num_emails}-Email Campaign
              </button>
            </div>
          </div>
        )}

        {/* ── GENERATING ── */}
        {step === 'generating' && (
          <div className="ec-generating">
            <div className="ec-gen-icon"><Mail /></div>
            <h3 className="ec-gen-title">Building your sequence...</h3>
            <p className="ec-gen-status">{genStatus || 'Reading Brain context...'}</p>
            <div className="ec-gen-progress">
              <div className="ec-gen-bar" style={{ width: `${(genProgress / brief.num_emails) * 100}%` }} />
            </div>
            <p className="ec-gen-count">{genProgress} of {brief.num_emails} emails</p>
          </div>
        )}

        {/* ── RESULTS ── */}
        {step === 'results' && emails.length > 0 && (
          <div className="ec-results">
            {sequenceNotes && (
              <div className="ec-sequence-notes">
                <div className="ec-section-label">SEQUENCE ASSESSMENT</div>
                {/* Sanitize: strip [bracket_identifier] tokens (LLM jargon) and
                    split into readable paragraphs. The system prompt now asks
                    for prose, but legacy campaigns and any future slip-ups
                    benefit from this defense-in-depth. */}
                {sequenceNotes
                  .replace(/\[([a-z][a-z0-9_]+)\]/gi, '')   // strip [snake_case_tokens]
                  .replace(/\s{2,}/g, ' ')                    // collapse multi-spaces from removed tokens
                  .split(/\n\n+|(?<=\.\s)(?=[A-Z])/)        // paragraphs OR sentence-boundary fallback
                  .map(s => s.trim())
                  .filter(Boolean)
                  .map((para, i) => <p key={i}>{para}</p>)}
              </div>
            )}

            <div className="ec-results-actions">
              <button className="ec-btn-ghost" onClick={exportAsText}>Export as .txt</button>
              <div className="ec-attio-export">
                <select
                  className="ec-attio-variant"
                  value={subjectVariant}
                  onChange={(e) => setSubjectVariant(e.target.value as 'benefit' | 'curiosity' | 'pattern_interrupt')}
                  title="Which subject line variant to export"
                >
                  <option value="benefit">Benefit subject</option>
                  <option value="curiosity">Curiosity subject</option>
                  <option value="pattern_interrupt">Pattern interrupt subject</option>
                </select>
                <button className="ec-btn-ghost" onClick={exportAsAttioCsv}>
                  Export for Attio (.csv)
                </button>
              </div>
            </div>

            {pushResult && (
              <div className={`ec-push-result ${pushResult.startsWith('Failed') ? 'error' : 'success'}`}>
                {pushResult}
              </div>
            )}

            <div className="ec-emails-list">
              {emails.map((email, idx) => (
                <EmailCard
                  key={email.id || idx}
                  email={email}
                  idx={idx}
                  onCopyForHubSpot={copyAsHubSpotHtml}
                  onEditEmail={editEmail}
                  onResolveFlag={resolveFlag}
                  onDismissFlag={dismissFlag}
                />
              ))}
            </div>

            <div className="ec-results-footer">
              <button className="ec-btn-ghost" onClick={() => { setStep('brief'); setEmails([]); }}>Adjust Brief &amp; Regenerate</button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
