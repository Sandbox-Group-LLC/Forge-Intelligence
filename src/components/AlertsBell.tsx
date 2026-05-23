import { useEffect, useRef, useState } from 'react';
import { useApp, Alert } from '../context/AppContext';
import { timeAgo } from '../lib/time';
import GetHelpModal from './GetHelpModal';
import './AlertsBell.css';

const BellIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

function severityClass(sev: Alert['severity']): string {
  if (sev === 'error') return 'alerts-dot error';
  if (sev === 'warn') return 'alerts-dot warn';
  return 'alerts-dot info';
}

export default function AlertsBell() {
  const { alerts, unreadAlertCount, markAlertsRead } = useApp();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const displayBadge = unreadAlertCount > 9 ? '9+' : String(unreadAlertCount);

  return (
    <>
      <div className="alerts-bell-root" ref={rootRef}>
        <button
          type="button"
          className="alerts-bell-btn"
          aria-label={`Alerts${unreadAlertCount > 0 ? ` (${unreadAlertCount} unread)` : ''}`}
          onClick={() => setOpen(o => !o)}
        >
          <BellIcon />
          {unreadAlertCount > 0 && (
            <span className="alerts-bell-badge" aria-hidden>{displayBadge}</span>
          )}
        </button>

        {open && (
          <div className="alerts-panel" role="dialog" aria-label="Alerts">
            <div className="alerts-panel-header">
              <span className="alerts-panel-title">Alerts</span>
              {unreadAlertCount > 0 ? (
                <button
                  type="button"
                  className="alerts-panel-link"
                  onClick={() => markAlertsRead()}
                >
                  Mark all read
                </button>
              ) : (
                <span className="alerts-panel-meta">All caught up</span>
              )}
            </div>

            <button
              type="button"
              className="alerts-help-cta"
              onClick={() => { setHelpOpen(true); setOpen(false); }}
            >
              <span className="alerts-help-cta-icon">?</span>
              <span>
                <strong>Get Help</strong>
                <span className="alerts-help-cta-sub">Send a note to the Forge team</span>
              </span>
            </button>

            <div className="alerts-list">
              {alerts.length === 0 ? (
                <div className="alerts-empty">No alerts. You're all clear.</div>
              ) : (
                alerts.map(a => (
                  <div key={a.id} className={`alerts-row${a.readAt ? '' : ' unread'}`}>
                    <span className={severityClass(a.severity)} />
                    <div className="alerts-row-body">
                      <div className="alerts-row-msg">{a.shortMessage}</div>
                      <div className="alerts-row-meta">
                        {a.area && <span className="alerts-tag">{a.area}</span>}
                        {a.httpStatus != null && <span className="alerts-tag dim">HTTP {a.httpStatus}</span>}
                        <span className="alerts-time">{timeAgo(a.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {helpOpen && <GetHelpModal onClose={() => setHelpOpen(false)} />}
    </>
  );
}
