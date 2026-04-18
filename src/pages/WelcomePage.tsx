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

    // User is already authenticated via Clerk — redirect to the app
    const timer = setTimeout(() => {
      window.location.href = '/app/context-hub';
    }, 3000);
    return () => clearTimeout(timer);
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
      <div style={{ fontSize: '1.1rem', color: '#94a3b8', maxWidth: 480 }}>
        Your account is active. Redirecting you to the platform...
      </div>
    </div>
  );
}
