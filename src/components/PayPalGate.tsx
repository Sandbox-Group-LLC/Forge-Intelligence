import { useEffect, useState } from 'react';

interface PayPalGateProps {
  brandProfileId: string;
  brandName: string;
  onUnlocked: () => void;
}

declare global {
  interface Window { paypal: any; }
}

export default function PayPalGate({ brandProfileId, brandName, onUnlocked }: PayPalGateProps) {
  const [loading, setLoading] = useState(true);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Load PayPal SDK
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${import.meta.env.VITE_PAYPAL_CLIENT_ID || 'AV1QAbjyqG1YTRCWKXzWjZr1Ls7uNLRnk5SzoC-ajEb3rZaq5h58SCUoi9lcZgd9OCvJrM2WchL1om6l'}&currency=USD`;
    script.async = true;
    script.onload = () => {
      setLoading(false);
      renderButtons();
    };
    script.onerror = () => { setLoading(false); setError('PayPal failed to load. Refresh to try again.'); };
    document.body.appendChild(script);
    return () => { document.body.removeChild(script); };
  }, []);

  const renderButtons = () => {
    if (!window.paypal) return;
    window.paypal.Buttons({
      style: { layout: 'vertical', color: 'blue', shape: 'rect', label: 'pay', height: 48 },
      createOrder: (_data: any, actions: any) => {
        return actions.order.create({
          purchase_units: [{
            amount: { value: '99.00', currency_code: 'USD' },
            description: `Forge Intelligence — Brand Intelligence for ${brandName}`,
          }],
        });
      },
      onApprove: async (_data: any, actions: any) => {
        const order = await actions.order.capture();
        const res = await fetch('/api/onboard/paypal-success', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brandProfileId, orderId: order.id }),
        });
        const d = await res.json();
        if (d.success) { setPaid(true); onUnlocked(); }
        else { setError('Payment received but activation failed. Email hello@forgeintelligence.ai'); }
      },
      onError: (err: any) => {
        console.error('[PAYPAL]', err);
        setError('Payment failed. Please try again.');
      },
    }).render('#paypal-button-container');
  };

  if (paid) return null;

  return (
    <div style={gateStyles.overlay}>
      <div style={gateStyles.card}>
        <div style={gateStyles.lockIcon}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3563FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h3 style={gateStyles.title}>Unlock the full intelligence suite</h3>
        <p style={gateStyles.desc}>
          Your brand brief is ready. Unlock GEO Strategy, Content Generation, Publishing, and your permanent Brain for $99 — one time.
        </p>
        <ul style={gateStyles.features}>
          {['GEO Citation Strategy (Stage 2)', 'Authenticity Enrichment (Stage 3)', 'Full Content Generation (Stage 4)', 'Compliance Gate + Publishing (Stages 5–6)', 'Performance Dashboard (Stage 7)', 'Permanent Brand Brain — never expires'].map(f => (
            <li key={f} style={gateStyles.feature}>
              <span style={gateStyles.check}>✓</span> {f}
            </li>
          ))}
        </ul>
        <div style={gateStyles.priceRow}>
          <span style={gateStyles.price}>$99</span>
          <span style={gateStyles.priceNote}>one-time · permanent brain · cancel anytime on upgrades</span>
        </div>
        {loading && <div style={gateStyles.loading}>Loading payment...</div>}
        {error && <div style={gateStyles.error}>{error}</div>}
        <div id="paypal-button-container" style={{ marginTop: 8 }} />
        <p style={gateStyles.caption}>
          Your free brain expires in 24 hours. Payment locks it in permanently.
        </p>
      </div>
    </div>
  );
}

const gateStyles: Record<string, React.CSSProperties> = {
  overlay: {
    background: 'linear-gradient(to bottom, transparent, rgba(11,15,26,0.97) 60px)',
    padding: '80px 0 0',
    marginTop: -40,
  },
  card: {
    background: 'var(--color-bg-card)',
    border: '1px solid var(--color-border)',
    borderTop: '2px solid #3563FF',
    borderRadius: 'var(--radius-lg)',
    padding: '36px 40px',
    maxWidth: 540,
  },
  lockIcon: { marginBottom: 16 },
  title: { fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 10px' },
  desc: { fontSize: '0.9rem', color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: '0 0 20px' },
  features: { listStyle: 'none', padding: 0, margin: '0 0 24px', display: 'flex', flexDirection: 'column', gap: 8 },
  feature: { fontSize: '0.875rem', color: 'var(--color-text-secondary)', display: 'flex', gap: 10 },
  check: { color: '#10B981', fontWeight: 700, flexShrink: 0 },
  priceRow: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 },
  price: { fontSize: '2.5rem', fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.03em' },
  priceNote: { fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.4 },
  loading: { fontSize: '0.875rem', color: 'var(--color-text-muted)', padding: '12px 0' },
  error: { fontSize: '0.875rem', color: '#F87171', padding: '10px 0' },
  caption: { fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 14, textAlign: 'center' as const },
};
