import { useState, useEffect } from 'react';

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

function timeRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return '';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m remaining`;
  return `${m}m remaining`;
}

export default function Landing() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const [claimed, setClaimed] = useState(false);
  const [returning, setReturning] = useState<{ brandUrl: string; brandName: string; expiresAt: string | null } | null>(null);

  // Check for existing unexpired brand on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('forge_active_brand');
      if (stored) {
        const b = JSON.parse(stored);
        const expired = b.expiresAt && new Date(b.expiresAt) < new Date();
        if (!expired && b.brandUrl) {
          setReturning({ brandUrl: b.brandUrl, brandName: b.brandName, expiresAt: b.expiresAt });
        } else if (expired) {
          localStorage.removeItem('forge_active_brand');
          localStorage.removeItem('forge_active_brand_id');
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('Failed to read forge_active_brand from localStorage:', err);
      }
    }
  }, []);

  useEffect(() => {
    const onBlocked = (e: Event) => {
      const msg = (e as CustomEvent).detail?.message || 'This domain already has a Brain. Sign in to access it.';
      setError(msg);
      setStatus('idle');
    };
    window.addEventListener('forge:scan-blocked', onBlocked);
    return () => window.removeEventListener('forge:scan-blocked', onBlocked);
  }, []);

  const isValidDomain = (input: string): boolean => {
    const cleaned = input.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    if (!cleaned.includes('.')) return false;
    if (!/^[a-zA-Z0-9.-]+$/.test(cleaned)) return false;
    const parts = cleaned.split('.');
    const tld = parts[parts.length - 1];
    if (tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) return false;
    for (const part of parts) {
      if (!part || part.startsWith('-') || part.endsWith('-')) return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) { setError('Enter your website URL to get started.'); return; }
    if (!isValidDomain(trimmed)) { setError('Please enter a valid domain (e.g. yourcompany.com).'); return; }
    setStatus('loading');
    setError('');
    const brandUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    // Check if domain is already claimed before going any further
    try {
      const check = await fetch('/api/domain/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: brandUrl }),
      });
      if (!check.ok) {
        throw new Error(`Domain check failed with status ${check.status}`);
      }
      const data = await check.json();
      if (data.claimed) {
        setClaimed(true);
        setStatus('idle');
        return;
      }
    } catch { /* non-fatal — let Context Hub handle it */ }

    // Don't await lookup — redirect immediately, let the app handle cache check
    sessionStorage.setItem('forge_onboard_url', brandUrl);
    window.location.href = '/app/context-hub?view=active-run';
  };

  const handleResume = () => {
    window.location.href = '/app/context-hub?view=brand-profile';
  };

  const handleNewScan = () => {
    localStorage.removeItem('forge_active_brand');
    localStorage.removeItem('forge_active_brand_id');
    setReturning(null);
  };


  return (
    <div style={styles.root}>
      <style>{`
        @keyframes productPulse {
          0%, 100% { color: #3B82F6; text-shadow: 0 0 4px rgba(59,130,246,0.3); }
          50% { color: #60A5FA; text-shadow: 0 0 12px rgba(59,130,246,0.6), 0 0 24px rgba(59,130,246,0.2); }
        }

        .signin-nav-link {
          color: rgba(255,255,255,0.5);
          font-size: 0.8rem;
          font-weight: 500;
          text-decoration: none;
          padding: 8px 16px;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          transition: all 0.2s;
        }

        .signin-nav-link:hover {
          color: #fff;
          border-color: rgba(255,255,255,0.3);
        }
      `}</style>
      <div style={styles.gridOverlay} aria-hidden="true" />
      <div style={styles.container}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 0 }}>
          <div style={styles.wordmark}>
            <span style={styles.diamondWrap}><DiamondIcon /></span>
            <span style={styles.wordmarkText}>Forge Intelligence</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <a href="/product"
              className="product-nav-link"
              style={{ color: '#3B82F6', fontSize: '0.8rem', fontWeight: 600, textDecoration: 'none', animation: 'productPulse 2s ease-in-out infinite' }}
            >Product</a>
            <a href="https://accounts.forgeintelligence.ai/sign-in?redirect_url=https://forgeintelligence.ai/app/context-hub"
              className="signin-nav-link"
            >Sign In</a>
          </div>
        </div>

        <div style={styles.content}>
          <p style={styles.eyebrow}>Brand Intelligence · Free Analysis</p>
          <h1 style={styles.headline}>The intelligence layer behind modern marketing.</h1>
          <p style={styles.subline}>
            Drop your URL. Forge reads your brand the way a strategist would (voice, audience, competitive gaps) and gives you the intelligence brief in under 10 minutes. Free.
            <br /><br />
            Then unlock the full Forge pipeline free for 7 days. No credit card. Your brand profile stays saved when the trial ends.
          </p>

          {claimed ? (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 16 }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
              </div>
              <h2 style={{ color: '#F8FAFC', fontSize: '1.25rem', fontWeight: 700, marginBottom: 8 }}>This domain is already claimed.</h2>
              <p style={{ color: '#94A3B8', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 20 }}>
                A brand profile for this domain exists and is tied to another account.<br />
                If this is your brand, sign in to access it.
              </p>
              <a href="https://accounts.forgeintelligence.ai/sign-in" style={{ display: 'inline-block', padding: '10px 28px', background: '#3563FF', color: '#fff', borderRadius: 8, fontSize: '0.875rem', fontWeight: 600, textDecoration: 'none', marginBottom: 16 }}>
                Sign In to Your Account
              </a>
              <p style={{ color: '#64748B', fontSize: '0.75rem', lineHeight: 1.6 }}>
                Believe this is a mistake?{' '}
                <a href="mailto:hello@forgeintelligence.ai" style={{ color: '#64748B', textDecoration: 'underline' }}>Contact us</a>
                {' '}with proof of domain ownership and we'll make it right.
              </p>
              <button onClick={() => { setClaimed(false); setUrl(''); }} style={{ marginTop: 12, background: 'none', border: 'none', color: '#64748B', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}>
                Try a different domain
              </button>
            </div>
          ) : returning ? (
            // Returning user — brain still alive
            <div style={styles.returningCard}>
              <div style={styles.returningDot} />
              <div style={styles.returningInfo}>
                <div style={styles.returningDomain}>{returning.brandName || returning.brandUrl}</div>
                <div style={styles.returningMeta}>
                  Brain saved
                  {returning.expiresAt ? ` · ${timeRemaining(returning.expiresAt)}` : ' permanently'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleResume} style={styles.resumeBtn}>
                  Resume Brain <ArrowRightIcon />
                </button>
                <button onClick={handleNewScan} style={styles.newScanBtn} title="Scan a different domain">
                  New
                </button>
              </div>
            </div>
          ) : (
            // New user — show input
            <form onSubmit={handleSubmit} style={styles.form}>
              <div style={styles.inputRow}>
                <input
                  type="text"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="yourcompany.com"
                  style={styles.input}
                  disabled={status === 'loading'}
                  autoComplete="off"
                  autoFocus
                />
                <button
                  type="submit"
                  style={{ ...styles.button, opacity: status === 'loading' ? 0.7 : 1, cursor: status === 'loading' ? 'not-allowed' : 'pointer' }}
                  disabled={status === 'loading'}
                >
                  {status === 'loading' ? (
                    <span style={styles.buttonInner}>Analyzing...</span>
                  ) : (
                    <span style={styles.buttonInner}>Analyze My Brand Free <ArrowRightIcon /></span>
                  )}
                </button>
              </div>
              {error && <p style={styles.errorMsg}>{error}</p>}
              <p style={styles.formCaption}>No account needed. Enter your domain again within 24 hours to return to your brand profile.</p>
              <p style={{ fontSize: '11px', color: '#475569', margin: 0 }}>Already scanned? Just enter your domain above to resume.</p>
            </form>
          )}
        </div>

        <div style={styles.footer}>
          <div style={styles.footerRow}>
            <span>© 2026 Forge Intelligence LLC</span>
            <span style={styles.footerDivider}>·</span>
            <a href="mailto:hello@forgeintelligence.ai" style={styles.footerLink}>hello@forgeintelligence.ai</a>
          </div>
          <div style={styles.footerRow}>
            <a href="/articles/forgeintelligence-ai" style={styles.footerLink}>Published by Forge</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/privacy" style={styles.footerLink}>Privacy Policy</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/terms" style={styles.footerLink}>Terms of Service</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/faq" style={styles.footerLink}>FAQ</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/docs" style={styles.footerLink}>Docs</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/acceptable-use" style={styles.footerLink}>Acceptable Use</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/dpa" style={styles.footerLink}>DPA</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/subprocessors" style={styles.footerLink}>Sub-processors</a>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    backgroundColor: '#0B0F1A',
    backgroundImage: 'radial-gradient(circle at top left, rgba(53,99,255,0.22), transparent 55%), radial-gradient(circle at bottom right, rgba(20,184,166,0.12), transparent 55%)',
    backgroundSize: '100% 100%, 100% 100%',
    backgroundAttachment: 'fixed',
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
  wordmark: { display: 'flex', alignItems: 'center', gap: '10px', color: '#F8FAFC' },
  diamondWrap: { display: 'flex', alignItems: 'center', color: '#3563FF' },
  wordmarkText: { fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em' },
  content: { display: 'flex', flexDirection: 'column', gap: '24px' },
  eyebrow: { fontSize: '11px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#3563FF', margin: 0 },
  headline: { fontSize: 'clamp(28px, 5vw, 42px)', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em', color: '#F8FAFC', margin: 0 },
  subline: { fontSize: '16px', lineHeight: 1.7, color: '#94A3B8', margin: 0, maxWidth: '520px' },
  form: { display: 'flex', flexDirection: 'column', gap: '10px' },
  inputRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' as const },
  input: {
    flex: '1 1 220px', padding: '11px 16px',
    backgroundColor: '#1E293B', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '10px', color: '#F8FAFC', fontSize: '14px',
    outline: 'none', fontFamily: 'inherit',
  },
  button: {
    padding: '11px 20px', backgroundColor: '#3563FF', border: 'none',
    borderRadius: '10px', color: '#fff', fontSize: '14px', fontWeight: 500,
    fontFamily: 'inherit', whiteSpace: 'nowrap' as const, transition: 'background-color 0.15s ease',
  },
  buttonInner: { display: 'flex', alignItems: 'center', gap: '8px' },
  formCaption: { fontSize: '12px', color: '#64748B', margin: 0 },
  errorMsg: { fontSize: '13px', color: '#F87171', margin: 0 },
  // Returning user styles
  returningCard: {
    display: 'flex', alignItems: 'center', gap: '14px',
    padding: '16px 20px',
    background: 'rgba(53,99,255,0.08)',
    border: '1px solid rgba(53,99,255,0.2)',
    borderRadius: '6px',
  },
  returningDot: {
    width: '8px', height: '8px', borderRadius: '50%',
    background: '#14B8A6', flexShrink: 0,
    boxShadow: '0 0 8px rgba(20,184,166,0.6)',
  },
  returningInfo: { flex: 1, minWidth: 0 },
  returningDomain: { fontSize: '15px', fontWeight: 600, color: '#F8FAFC', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  returningMeta: { fontSize: '12px', color: '#64748B', marginTop: '2px' },
  resumeBtn: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '9px 16px', backgroundColor: '#3563FF', border: 'none',
    borderRadius: '8px', color: '#fff', fontSize: '13px', fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
  },
  newScanBtn: {
    padding: '9px 14px', background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
    color: 'rgba(255,255,255,0.5)', fontSize: '13px',
    cursor: 'pointer', fontFamily: 'inherit',
  },
  footer: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start', fontSize: '12px', color: '#475569' },
  footerRow: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' },
  footerDivider: { color: '#334155' },
  footerLink: { color: '#475569', textDecoration: 'none' },
};
