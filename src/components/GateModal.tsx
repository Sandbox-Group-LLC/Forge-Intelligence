import { useEffect, useState } from 'react';

interface GateModalProps {
  featureName: string;
  onClose: () => void;
  brandProfileId?: string;
  onUnlocked?: () => void;
}

declare global { interface Window { paypal: any; } }

const PAYPAL_CLIENT_ID = 'AV1QAbjyqG1YTRCWKXzWjZr1Ls7uNLRnk5SzoC-ajEb3rZaq5h58SCUoi9lcZgd9OCvJrM2WchL1om6l';

export default function GateModal({ featureName, onClose, brandProfileId, onUnlocked }: GateModalProps) {
  const [ppLoading, setPpLoading] = useState(true);
  const [ppError, setPpError] = useState('');
  const [paid, setPaid] = useState(false);

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

  const renderButtons = () => {
    if (!window.paypal) return;
    setTimeout(() => {
      window.paypal.Buttons({
        style: { layout: 'vertical', color: 'blue', shape: 'rect', label: 'pay', height: 44 },
        createOrder: (_: any, actions: any) => actions.order.create({
          purchase_units: [{ amount: { value: '99.00', currency_code: 'USD' }, description: 'Forge Intelligence — Full Suite Unlock' }]
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
          setPaid(true);
          onUnlocked?.();
          // Redirect to Clerk sign-up to tether account to this brain
          setTimeout(() => {
            window.location.href = `https://accounts.forgeintelligence.ai/sign-up?redirect_url=${encodeURIComponent(window.location.origin + '/app/context-hub')}&brand_id=${brandProfileId || ''}`;
          }, 1500);
        },
        onError: () => setPpError('Payment failed. Please try again.'),
      }).render('#forge-gate-paypal');
    }, 100);
  };

  if (paid) return null;

  return (
    <div className="gate-backdrop" onClick={onClose}>
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

        {ppLoading && <div className="gate-loading">Loading payment...</div>}
        {ppError && <div className="gate-error">{ppError}</div>}
        <div id="forge-gate-paypal" />

        <p className="gate-caption">Your free brand brief stays. Payment unlocks everything above Stage 1.</p>
      </div>
    </div>
  );
}
