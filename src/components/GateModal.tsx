import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';

interface GateModalProps {
  featureName: string;
  onClose: () => void;
  brandProfileId?: string;
  onUnlocked?: () => void;
}

declare global { interface Window { paypal: any; } }

const PAYPAL_CLIENT_ID = 'AV1QAbjyqG1YTRCWKXzWjZr1Ls7uNLRnk5SzoC-ajEb3rZaq5h58SCUoi9lcZgd9OCvJrM2WchL1om6l';
const CLERK_SIGNUP_URL = 'https://accounts.forgeintelligence.ai/sign-up';

export default function GateModal({ featureName, onClose, brandProfileId, onUnlocked }: GateModalProps) {
  const { isSignedIn, isLoaded } = useAuth();

  // Never render during Clerk loading or for signed-in users — they've paid.
  if (!isLoaded || isSignedIn) return null;
  const [ppLoading, setPpLoading] = useState(true);
  const [ppError, setPpError] = useState('');
  const [paid, setPaid] = useState(false);
  const [showPromo, setShowPromo] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoStatus, setPromoStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [promoMsg, setPromoMsg] = useState('');

  useEffect(() => {
    if (window.paypal) { setPpLoading(false); renderButtons(); return; }
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=USD`;
    script.async = true;
    script.onload = () => { setPpLoading(false); renderButtons(); };
    script.onerror = () => { setPpLoading(false); setPpError('PayPal failed to load. Refresh and try again.'); };
    document.body.appendChild(script);
    return () => { try { document.body.removeChild(script); } catch {} };
  }, []);

  // After successful payment, either refetch in place (signed in) or tether + redirect to Clerk (not signed in)
  function handleUnlocked() {
    setPaid(true);
    if (isSignedIn) {
      // Already authed — onUnlocked calls refetchBrand(), sidebar updates reactively
      onUnlocked?.();
    } else {
      // Pre-auth payment — tether brand to future Clerk account via localStorage
      if (brandProfileId) localStorage.setItem('forge_pending_brand_id', brandProfileId);
      setTimeout(() => {
        window.location.href = `${CLERK_SIGNUP_URL}?redirect_url=${encodeURIComponent(window.location.origin + '/app/context-hub')}`;
      }, 1200);
    }
  }

  const renderButtons = () => {
    if (!window.paypal) return;
    setTimeout(() => {
      window.paypal.Buttons({
        style: { layout: 'vertical', color: 'blue', shape: 'rect', label: 'pay', height: 44 },
        createOrder: (_: any, actions: any) => actions.order.create({
          purchase_units: [{ amount: { value: '99.00', currency_code: 'USD' }, description: 'Forge Intelligence — Full Suite Unlock' }],
        }),
        onApprove: async (_: any, actions: any) => {
          const order = await actions.order.capture();
          if (brandProfileId) {
            await fetch('/api/onboard/paypal-success', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ brandProfileId, orderId: order.id }),
            });
          }
          handleUnlocked();
        },
        onError: () => setPpError('Payment failed. Please try again.'),
      }).render('#forge-gate-paypal');
    }, 100);
  };

  const applyPromo = async () => {
    if (!promoCode.trim()) return;
    setPromoStatus('loading');
    try {
      const res = await fetch('/api/promo/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: promoCode.trim(), brandProfileId }),
      });
      const d = await res.json();
      if (d.valid) {
        setPromoStatus('success');
        setPromoMsg(d.message);
        setTimeout(() => handleUnlocked(), 1200);
      } else {
        setPromoStatus('error');
        setPromoMsg(d.message || 'Invalid code');
      }
    } catch {
      setPromoStatus('error');
      setPromoMsg('Something went wrong');
    }
  };

  if (paid) return null;

  return (
    <div className="gate-backdrop">
      <div className="gate-modal" onClick={e => e.stopPropagation()}>
        <button className="gate-close" onClick={onClose}>✕</button>

        <div className="gate-lock">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3563FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>

        <h2 className="gate-title">{featureName} is locked</h2>
        <p className="gate-desc">
          Unlock the full Forge Intelligence suite — GEO Strategy, Content Generation, Publishing, Performance, and more — for a one-time $99.
        </p>

        <ul className="gate-features">
          {[
            'GEO Strategist — citation opportunity mapping',
            'Authenticity Enricher — E-E-A-T signal injection',
            'Content Generator — long-form + social + email',
            'Compliance Gate + Publishing Queue',
            'Performance Dashboard',
            'Permanent Brand Brain — never expires',
          ].map(f => (
            <li key={f} className="gate-feature"><span className="gate-check">✓</span>{f}</li>
          ))}
        </ul>

        <div className="gate-price-row">
          <span className="gate-price">$99</span>
          <span className="gate-price-note">one-time · full suite · brain saved permanently</span>
        </div>

        {/* Promo code — collapsed behind toggle */}
        <div style={{ marginBottom: 4 }}>
          {!showPromo && promoStatus !== 'success' && (
            <button onClick={() => setShowPromo(true)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem', cursor: 'pointer', padding: '4px 0', fontFamily: 'inherit', textDecoration: 'underline' }}>
              Have a promo code?
            </button>
          )}
          {(showPromo || promoStatus === 'success') && (<div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1, padding: '9px 14px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#F8FAFC', fontSize: '0.875rem', fontFamily: 'inherit', outline: 'none' }}
              placeholder="Promo code"
              value={promoCode}
              onChange={e => { setPromoCode(e.target.value); setPromoStatus('idle'); setPromoMsg(''); }}
              onKeyDown={e => e.key === 'Enter' && applyPromo()}
              disabled={promoStatus === 'loading' || promoStatus === 'success'}
            />
            <button
              style={{ padding: '9px 18px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, color: '#F8FAFC', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: (!promoCode.trim() || promoStatus === 'loading' || promoStatus === 'success') ? 0.45 : 1 }}
              onClick={applyPromo}
              disabled={!promoCode.trim() || promoStatus === 'loading' || promoStatus === 'success'}
            >
              {promoStatus === 'loading' ? '...' : 'Apply'}
            </button>
          </div>
          {promoMsg && (
            <div style={{ fontSize: '0.8rem', marginTop: 6, color: promoStatus === 'success' ? '#10B981' : '#F87171' }}>
              {promoStatus === 'success' ? '✓ ' : '✕ '}{promoMsg}
            </div>
          )}
        </div>)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0', color: 'rgba(255,255,255,0.25)', fontSize: '0.75rem' }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
          <span>or pay with PayPal</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
        </div>
        {ppLoading && <div className="gate-loading">Loading payment...</div>}
        {ppError && <div className="gate-error">{ppError}</div>}
        <div id="forge-gate-paypal" />

        <p className="gate-caption">Your free brand brief stays. Payment unlocks everything above Stage 1.</p>
        <p style={{ marginTop: 14, fontSize: '0.7rem', color: '#64748B', textAlign: 'center', lineHeight: 1.6 }}>
          By clicking "Pay Now," you agree to our{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#7C8DB5', textDecoration: 'underline' }}>Terms of Service</a>{" "}and{" "}
          <a href="/acceptable-use" target="_blank" rel="noopener noreferrer" style={{ color: '#7C8DB5', textDecoration: 'underline' }}>Acceptable Use Policy</a>, confirming that your purchase complies with all applicable laws and usage guidelines.
        </p>
        <p style={{ marginTop: 10, fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)', textAlign: 'center', lineHeight: 1.5 }}>
          If you believe your brand profile was incorrectly assigned, contact us at{" "}
          <a href="mailto:hello@forgeintelligence.ai" style={{ color: 'rgba(255,255,255,0.35)' }}>hello@forgeintelligence.ai</a>{" "}
          and we'll verify domain ownership and make it right.
        </p>
      </div>
    </div>
  );
}
