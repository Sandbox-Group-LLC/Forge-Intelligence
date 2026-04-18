import { useEffect } from 'react';

export default function WelcomePage() {
  useEffect(() => {
    // Fire Reddit purchase conversion via GTM dataLayer
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ ecommerce: null });
    (window as any).dataLayer.push({
      event: 'purchase',
      ecommerce: {
        value: 99.00,
        currency: 'USD',
        items: [{
          item_id: 'forge-pro-monthly',
          item_name: 'Forge Intelligence Pro',
          item_category: 'SaaS',
          price: 99.00,
          quantity: 1
        }]
      }
    });
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0c10',
      color: '#e2e8f0',
      fontFamily: 'Inter, system-ui, sans-serif',
      textAlign: 'center',
      padding: '2rem'
    }}>
      <div style={{ fontSize: '2.5rem', fontWeight: 700, marginBottom: '0.75rem' }}>
        Welcome to Forge Intelligence
      </div>
      <div style={{ fontSize: '1.1rem', color: '#94a3b8', maxWidth: 480, marginBottom: '2rem' }}>
        Payment received. Create your account to get started.
      </div>
      <a
        href="https://accounts.forgeintelligence.ai/sign-up"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 48,
          padding: '0 32px',
          background: '#3563ff',
          color: '#fff',
          fontSize: '1rem',
          fontWeight: 600,
          borderRadius: 10,
          textDecoration: 'none',
          transition: 'opacity 0.15s'
        }}
      >
        Create Your Account →
      </a>
    </div>
  );
}
