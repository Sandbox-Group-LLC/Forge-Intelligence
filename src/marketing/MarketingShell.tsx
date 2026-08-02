import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { NavBar } from '../ds/components/navigation/NavBar';
import { Footer } from '../ds/components/navigation/Footer';

const SIGN_IN_URL =
  'https://accounts.forgeintelligence.ai/sign-in?redirect_url=https://forgeintelligence.ai/app/context-hub';

/** Section wrapper matching the design-system marketing rhythm. */
export function Section({
  children,
  size,
  id,
  style,
}: {
  children: React.ReactNode;
  size?: 'sm' | 'lg';
  id?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section id={id} className={'fi-section' + (size ? ' fi-section--' + size : '')} style={style}>
      <div className="fi-container">{children}</div>
    </section>
  );
}

/**
 * The dark marketing chrome shared by / and /product. The `data-forge-ds`
 * attribute scopes the entire design system so its reset and tokens never
 * leak into the light in-app UI. `.fi-canvas` paints the locked navy wash.
 */
export function MarketingShell({
  activeHref,
  children,
}: {
  activeHref?: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const go = (href: string) => {
    if (href.startsWith('/')) navigate(href);
    else window.location.href = href;
  };
  return (
    <div
      className="fi-canvas"
      data-forge-ds=""
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      <NavBar
        activeHref={activeHref}
        onNavigate={go}
        links={[
          { label: 'Product', href: '/product' },
          { label: 'Docs', href: '/docs' },
          { label: 'FAQ', href: '/faq' },
        ]}
        ctaLabel="Analyze my brand free"
        onCta={() => go('/')}
        secondaryLabel="Sign in"
        onSecondary={() => {
          window.location.href = SIGN_IN_URL;
        }}
      />
      <main style={{ flex: 1 }}>{children}</main>
      <Footer
        copyright="© 2026 Forge Intelligence LLC"
        blurb="The intelligence layer behind modern marketing."
        columns={[
          {
            title: 'Product',
            links: [
              { label: 'Product', href: '/product' },
              { label: 'Docs', href: '/docs' },
              { label: 'FAQ', href: '/faq' },
              { label: 'Published by Forge', href: '/articles/forgeintelligence-ai' },
            ],
          },
          {
            title: 'Company',
            links: [{ label: 'Contact', href: 'mailto:hello@forgeintelligence.ai' }],
          },
          {
            title: 'Legal',
            links: [
              { label: 'Privacy Policy', href: '/privacy' },
              { label: 'Terms of Service', href: '/terms' },
              { label: 'Acceptable Use', href: '/acceptable-use' },
              { label: 'DPA', href: '/dpa' },
              { label: 'Sub-processors', href: '/subprocessors' },
            ],
          },
        ]}
        legal={[
          { label: 'Privacy', href: '/privacy' },
          { label: 'Terms', href: '/terms' },
        ]}
      />
    </div>
  );
}
