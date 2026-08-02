import { useState, useEffect } from 'react';
import { MarketingShell, Section } from './marketing/MarketingShell';
import { Eyebrow } from './ds/components/core/Eyebrow';
import { Button } from './ds/components/core/Button';
import { Card } from './ds/components/cards/Card';
import { Reveal } from './ds/components/marketing/Reveal';
import { Icon } from './ds/components/brand/Icon';

const SIGN_IN_URL = 'https://accounts.forgeintelligence.ai/sign-in';

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
    <MarketingShell activeHref="/">
      <Section style={{ paddingTop: 'var(--space-16)' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center' }}>
          <Reveal>
            <Eyebrow tone="accent">Brand Intelligence · Free Analysis</Eyebrow>
            <h1 style={{ fontSize: 'var(--text-display)', letterSpacing: 'var(--tracking-display, -0.025em)', margin: 'var(--space-4) 0' }}>
              The intelligence layer behind modern marketing.
            </h1>
            <p style={{ fontSize: 'var(--text-lg)', lineHeight: 'var(--leading-relaxed)', color: 'var(--text-muted)', margin: '0 auto', maxWidth: 540 }}>
              Drop your URL. Forge reads your brand the way a strategist would (voice, audience, competitive gaps) and gives you the intelligence brief in under 10 minutes. Free.
              <br /><br />
              Then unlock the full Forge pipeline free for 7 days. No credit card. Your brand profile stays saved when the trial ends.
            </p>
          </Reveal>

          <Reveal delay={120}>
            <div style={{ marginTop: 'var(--space-8)', textAlign: 'left' }}>
              {claimed ? (
                <Card variant="gradient" padding="lg" style={{ textAlign: 'center' }}>
                  <span style={{ color: 'var(--color-danger-text)', display: 'inline-flex', marginBottom: 'var(--space-3)' }}>
                    <Icon name="triangle-alert" size={28} />
                  </span>
                  <h2 style={{ fontSize: 'var(--text-h4)', margin: '0 0 var(--space-2)' }}>This domain is already claimed.</h2>
                  <p style={{ color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)', marginBottom: 'var(--space-5)' }}>
                    A brand profile for this domain exists and is tied to another account.<br />
                    If this is your brand, sign in to access it.
                  </p>
                  <Button variant="primary" href={SIGN_IN_URL}>Sign In to Your Account</Button>
                  <p style={{ color: 'var(--text-caption)', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-relaxed)', marginTop: 'var(--space-4)' }}>
                    Believe this is a mistake?{' '}
                    <a href="mailto:hello@forgeintelligence.ai">Contact us</a>
                    {' '}with proof of domain ownership and we'll make it right.
                  </p>
                  <button
                    onClick={() => { setClaimed(false); setUrl(''); }}
                    style={{ marginTop: 'var(--space-3)', background: 'none', border: 'none', color: 'var(--text-caption)', fontSize: 'var(--text-xs)', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    Try a different domain
                  </button>
                </Card>
              ) : returning ? (
                <Card variant="gradient" padding="md" glow>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-positive)', flexShrink: 0, boxShadow: '0 0 8px var(--color-positive)' }} />
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {returning.brandName || returning.brandUrl}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-caption)', marginTop: 2 }}>
                        Brain saved{returning.expiresAt ? ` · ${timeRemaining(returning.expiresAt)}` : ' permanently'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <Button variant="primary" trailingIcon="arrow-right" onClick={handleResume}>Resume Brain</Button>
                      <Button variant="secondary" onClick={handleNewScan}>New</Button>
                    </div>
                  </div>
                </Card>
              ) : (
                <form onSubmit={handleSubmit}>
                  <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                      placeholder="yourcompany.com"
                      disabled={status === 'loading'}
                      autoComplete="off"
                      autoFocus
                      style={{
                        flex: '1 1 220px',
                        padding: '12px 16px',
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--text-primary)',
                        fontSize: 'var(--text-sm)',
                        fontFamily: 'inherit',
                      }}
                    />
                    <Button variant="primary" type="submit" loading={status === 'loading'} trailingIcon="arrow-right">
                      {status === 'loading' ? 'Analyzing...' : 'Analyze My Brand Free'}
                    </Button>
                  </div>
                  {error && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-danger-text)', marginTop: 'var(--space-3)' }}>{error}</p>}
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-caption)', marginTop: 'var(--space-3)' }}>
                    No account needed. Enter your domain again within 24 hours to return to your brand profile.
                  </p>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-footer)', margin: 'var(--space-1) 0 0' }}>
                    Already scanned? Just enter your domain above to resume.
                  </p>
                </form>
              )}
            </div>
          </Reveal>
        </div>
      </Section>
    </MarketingShell>
  );
}
