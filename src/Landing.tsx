import { useState } from 'react';

const DiamondIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 22 12 12 22 2 12" />
  </svg>
);

const ArrowRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

export default function Landing() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes('@')) {
      setStatus('error');
      setMessage('Please enter a valid email address.');
      return;
    }
    setStatus('loading');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setStatus('success');
        setMessage("You're on the list. We'll be in touch.");
        setEmail('');
      } else {
        throw new Error('Request failed');
      }
    } catch {
      setStatus('error');
      setMessage('Something went wrong. Try again or email hello@forgeintelligence.ai');
    }
  };

  return (
    <div style={styles.root}>
      <div style={styles.gridOverlay} aria-hidden="true" />
      <div style={styles.container}>
        <div style={styles.wordmark}>
          <span style={styles.diamondWrap}><DiamondIcon /></span>
          <span style={styles.wordmarkText}>Forge Intelligence</span>
        </div>

        <div style={styles.content}>
          <p style={styles.eyebrow}>Context Agent · Early Access</p>
          <h1 style={styles.headline}>The intelligence layer behind modern marketing.</h1>
          <p style={styles.subline}>
            Forge Intelligence gives marketing teams a unified view of brand context, audience signals, and strategic direction — so every decision starts from clarity, not guesswork.
          </p>

          {status === 'success' ? (
            <div style={styles.successState}>
              <span style={styles.successDot} />
              {message}
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={styles.form}>
              <div style={styles.inputRow}>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  style={styles.input}
                  disabled={status === 'loading'}
                  autoComplete="email"
                />
                <button
                  type="submit"
                  style={{
                    ...styles.button,
                    opacity: status === 'loading' ? 0.7 : 1,
                    cursor: status === 'loading' ? 'not-allowed' : 'pointer',
                  }}
                  disabled={status === 'loading'}
                >
                  {status === 'loading' ? 'Sending...' : (
                    <span style={styles.buttonInner}>
                      Request early access <ArrowRightIcon />
                    </span>
                  )}
                </button>
              </div>
              {status === 'error' && (
                <p style={styles.errorMsg}>{message}</p>
              )}
              <p style={styles.formCaption}>No spam. No noise. Just a heads-up when we're ready.</p>
            </form>
          )}
        </div>

        <div style={styles.footer}>
          <span>© 2026 Sandbox Group LLC</span>
          <span style={styles.footerDivider}>·</span>
          <a href="mailto:hello@forgeintelligence.ai" style={styles.footerLink}>hello@forgeintelligence.ai</a>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    backgroundColor: '#0F1720',
    color: '#F8FAFC',
    fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif",
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  gridOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
    backgroundSize: '48px 48px',
    pointerEvents: 'none',
    zIndex: 0,
  },
  container: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: '600px',
    padding: '48px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '64px',
  },
  wordmark: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    color: '#F8FAFC',
  },
  diamondWrap: {
    display: 'flex',
    alignItems: 'center',
    color: '#3563FF',
    animation: 'pulse 3s ease-in-out infinite',
  },
  wordmarkText: {
    fontSize: '18px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  eyebrow: {
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#3563FF',
    margin: 0,
  },
  headline: {
    fontSize: 'clamp(28px, 5vw, 42px)',
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: '-0.02em',
    color: '#F8FAFC',
    margin: 0,
  },
  subline: {
    fontSize: '16px',
    lineHeight: 1.7,
    color: '#94A3B8',
    margin: 0,
    maxWidth: '520px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  inputRow: {
    display: 'flex',
    gap: '10px',
    flexWrap: 'wrap',
  },
  input: {
    flex: '1 1 220px',
    padding: '11px 16px',
    backgroundColor: '#1E293B',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '10px',
    color: '#F8FAFC',
    fontSize: '14px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  button: {
    padding: '11px 20px',
    backgroundColor: '#3563FF',
    border: 'none',
    borderRadius: '10px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 500,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    transition: 'background-color 0.15s ease',
  },
  buttonInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  formCaption: {
    fontSize: '12px',
    color: '#64748B',
    margin: 0,
  },
  errorMsg: {
    fontSize: '13px',
    color: '#F87171',
    margin: 0,
  },
  successState: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '15px',
    color: '#14B8A6',
    padding: '14px 18px',
    backgroundColor: 'rgba(20, 184, 166, 0.08)',
    border: '1px solid rgba(20, 184, 166, 0.2)',
    borderRadius: '10px',
  },
  successDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#14B8A6',
    flexShrink: 0,
  },
  footer: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    fontSize: '12px',
    color: '#475569',
  },
  footerDivider: {
    color: '#334155',
  },
  footerLink: {
    color: '#475569',
    textDecoration: 'none',
  },
};
