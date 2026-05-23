import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';
import './GetHelpModal.css';

interface GetHelpModalProps {
  onClose: () => void;
}

type Category = 'bug' | 'question' | 'feature' | 'other';
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

const SUBJECT_MAX = 120;
const BODY_MAX = 2000;

export default function GetHelpModal({ onClose }: GetHelpModalProps) {
  const { user } = useUser();
  const { alerts, activeBrand, authToken } = useApp();

  const [category, setCategory] = useState<Category>('bug');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachedIds, setAttachedIds] = useState<Set<string>>(() => {
    // Default: attach the most recent 5 alerts (server-confirmed ids only)
    const recent = alerts
      .filter(a => !a.id.startsWith('local-'))
      .slice(0, 5)
      .map(a => a.id);
    return new Set(recent);
  });
  const [state, setState] = useState<SubmitState>('idle');
  const [errMsg, setErrMsg] = useState('');

  const recentAlerts = useMemo(
    () => alerts.filter(a => !a.id.startsWith('local-')).slice(0, 5),
    [alerts]
  );

  // Auto-close on success after 4s
  useEffect(() => {
    if (state !== 'success') return;
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [state, onClose]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const userEmail = user?.primaryEmailAddress?.emailAddress || '';

  const toggleAlert = (id: string) => {
    setAttachedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const canSubmit = subject.trim().length > 0 && body.trim().length > 0 && state !== 'submitting';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setState('submitting');
    setErrMsg('');
    try {
      const res = await fetch('/api/support/ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          category,
          subject: subject.trim(),
          body: body.trim(),
          attachedAlertIds: Array.from(attachedIds),
          pageUrl: window.location.href,
          userEmail,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
      }
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || 'Submit failed');
      setState('success');
    } catch (err) {
      setState('error');
      setErrMsg(err instanceof Error ? err.message : 'Submit failed. Please retry.');
    }
  };

  return (
    <div className="gethelp-backdrop" onClick={onClose}>
      <div
        className="gethelp-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Get Help"
        onClick={e => e.stopPropagation()}
      >
        <div className="gethelp-header">
          <div>
            <p className="gethelp-eyebrow">Get Help</p>
            <h2 className="gethelp-title">Send a note to the Forge team</h2>
          </div>
          <button type="button" className="gethelp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {state === 'success' ? (
          <div className="gethelp-success">
            <div className="gethelp-success-icon">✓</div>
            <h3>Thanks — we got it.</h3>
            <p>
              Brian will follow up
              {userEmail ? <> at <strong>{userEmail}</strong></> : null}.
            </p>
          </div>
        ) : (
          <form className="gethelp-form" onSubmit={handleSubmit}>
            <div className="gethelp-field">
              <label htmlFor="gh-category">Category</label>
              <select
                id="gh-category"
                value={category}
                onChange={e => setCategory(e.target.value as Category)}
                disabled={state === 'submitting'}
              >
                <option value="bug">Bug — something broke</option>
                <option value="question">Question</option>
                <option value="feature">Feature request</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="gethelp-field">
              <label htmlFor="gh-subject">Subject</label>
              <input
                id="gh-subject"
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value.slice(0, SUBJECT_MAX))}
                placeholder="One-line summary"
                maxLength={SUBJECT_MAX}
                disabled={state === 'submitting'}
                required
              />
              <div className="gethelp-counter">{subject.length} / {SUBJECT_MAX}</div>
            </div>

            <div className="gethelp-field">
              <label htmlFor="gh-body">Description</label>
              <textarea
                id="gh-body"
                rows={5}
                value={body}
                onChange={e => setBody(e.target.value.slice(0, BODY_MAX))}
                placeholder="What were you trying to do? What did you expect? What actually happened?"
                maxLength={BODY_MAX}
                disabled={state === 'submitting'}
                required
              />
              <div className="gethelp-counter">{body.length} / {BODY_MAX}</div>
            </div>

            <div className="gethelp-context">
              <div className="gethelp-context-row">
                <span className="gethelp-context-label">Page</span>
                <code>{window.location.pathname}</code>
              </div>
              {activeBrand && (
                <div className="gethelp-context-row">
                  <span className="gethelp-context-label">Brand</span>
                  <span>{activeBrand.brandName || activeBrand.brandUrl}</span>
                </div>
              )}
            </div>

            {recentAlerts.length > 0 && (
              <div className="gethelp-field">
                <label>Attach recent alerts ({attachedIds.size} of {recentAlerts.length})</label>
                <div className="gethelp-alerts">
                  {recentAlerts.map(a => (
                    <label key={a.id} className="gethelp-alert-row">
                      <input
                        type="checkbox"
                        checked={attachedIds.has(a.id)}
                        onChange={() => toggleAlert(a.id)}
                        disabled={state === 'submitting'}
                      />
                      <span className="gethelp-alert-msg">{a.shortMessage}</span>
                      {a.area && <span className="gethelp-alert-tag">{a.area}</span>}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {state === 'error' && (
              <div className="gethelp-error">
                {errMsg || "Submit failed. Please retry."}
              </div>
            )}

            <div className="gethelp-actions">
              <button
                type="button"
                className="gethelp-btn-secondary"
                onClick={onClose}
                disabled={state === 'submitting'}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="gethelp-btn-primary"
                disabled={!canSubmit}
              >
                {state === 'submitting' ? 'Sending…' : 'Send to Forge team'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
