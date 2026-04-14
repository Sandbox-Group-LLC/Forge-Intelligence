import { useUser, SignOutButton, SignedIn, SignedOut } from '@clerk/clerk-react';
import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import './TopBar.css';

// Lucide-style icons
const icons = {
  menu: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" x2="20" y1="12" y2="12"/>
      <line x1="4" x2="20" y1="6" y2="6"/>
      <line x1="4" x2="20" y1="18" y2="18"/>
    </svg>
  ),
  zap: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  clock: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  user: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="5"/>
      <path d="M20 21a8 8 0 1 0-16 0"/>
    </svg>
  ),
  chevronDown: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  ),
  shield: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
};

const viewTitles: Record<string, string> = {
  'new-analysis': 'New Analysis',
  'active-run': 'Active Run',
  'brand-profile': 'Brand Profile',
  'strategy': 'Strategy',
  'brain-history': 'Brain History',
  'geo-strategist': 'GEO Strategist',
  'authenticity-enricher': 'Authenticity Enricher',
  'content-generator': 'Content Generator',
};

const pathTitles: Record<string, string> = {
  '/app/geo-strategist':         'GEO Strategist',
  '/app/authenticity-enricher':  'Authenticity Enricher',
  '/app/content-generator':      'Content Generator',
  '/app/campaign-generator':     'Campaign Generator',
  '/app/compliance-gate':        'Compliance Gate',
  '/app/integrations':           'Integrations',
  '/app/publishing-queue':       'Publishing Queue',
  '/app/performance':            'Performance Dashboard',
  '/app/brand-settings':         'Brand Settings',
  '/app/content-library':        'Content Library',
  '/app/content-import':         'Import Article',
  '/app/topic-queue':            'Topic Queue',
  '/app/mc':                  'Mission Control',
  '/app/email-campaign':         'Email Campaign',
  '/app/context-hub':            'New Analysis',
};

export function TopBar({ pageTitle }: { pageTitle?: string }) {
  const { currentView, brandProfile, activeBrand, sidebarCollapsed, setSidebarCollapsed, allBrands, switchBrand } = useApp();
  const { user } = useUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const brandMenuRef = useRef<HTMLDivElement>(null);

  const currentBrand = allBrands?.find(b => b.id === activeBrand?.id) || allBrands?.[0];

  useEffect(() => {
    if (!menuOpen && !brandMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (brandMenuOpen && brandMenuRef.current && !brandMenuRef.current.contains(e.target as Node)) {
        setBrandMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, brandMenuOpen]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button 
          className="mobile-menu-btn"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          aria-label="Toggle menu"
        >
          {icons.menu}
        </button>
        <h1 className="topbar-title">{pageTitle || Object.entries(pathTitles).find(([k]) => window.location.pathname.startsWith(k))?.[1] || viewTitles[currentView] || 'Forge Intelligence'}</h1>
        {activeBrand && (
          <span className="topbar-brand-pill" title={activeBrand.brandUrl}>
            {activeBrand.brandName || activeBrand.brandUrl.replace(/^https?:\/\//, '').replace(/^www\./, '')}
            {brandProfile && currentView === 'brand-profile' && (
              <span style={{ opacity: 0.5, marginLeft: 4, fontWeight: 400 }}>· v{brandProfile.version}</span>
            )}
          </span>
        )}
      </div>

      <div className="topbar-right">
        {/* Super Admin Brand Switcher */}
        {allBrands && allBrands.length > 0 && (
          <div style={{ position: 'relative' }} ref={brandMenuRef}>
            <button
              onClick={() => setBrandMenuOpen(o => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px',
                background: 'rgba(99, 102, 241, 0.15)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                borderRadius: '8px',
                color: '#A5B4FC',
                fontSize: '0.8rem',
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ color: '#818CF8' }}>{icons.shield}</span>
              <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentBrand?.brandName || 'Select Brand'}
              </span>
              {icons.chevronDown}
            </button>
            {brandMenuOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  right: 0,
                  background: '#1a1f2e',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '10px',
                  padding: '8px 0',
                  minWidth: '240px',
                  maxHeight: '320px',
                  overflowY: 'auto',
                  zIndex: 999,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                }}
              >
                <div style={{ padding: '8px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: '0.7rem', fontWeight: 600, color: 'rgba(99, 102, 241, 0.8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {allBrands.length} Brands
                </div>
                {allBrands.map(b => (
                  <button
                    key={b.id}
                    onClick={() => {
                      switchBrand(b.id);
                      setBrandMenuOpen(false);
                      window.location.reload();
                    }}
                    style={{
                      width: '100%',
                      padding: '10px 16px',
                      background: b.id === activeBrand?.id ? 'rgba(99, 102, 241, 0.15)' : 'none',
                      border: 'none',
                      color: b.id === activeBrand?.id ? '#A5B4FC' : 'rgba(255,255,255,0.7)',
                      fontSize: '0.85rem',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.brandName}
                    </span>
                    {b.isPaid && (
                      <span style={{ fontSize: '0.65rem', background: 'rgba(20, 184, 166, 0.2)', color: '#14B8A6', padding: '2px 6px', borderRadius: '4px' }}>
                        PAID
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {brandProfile && activeBrand && (
          <div className={`cache-indicator ${brandProfile.cacheStatus}`} title={`Brain last updated: ${new Date(brandProfile.updatedAt).toLocaleDateString()}`}>
            <span className="cache-icon">
              {brandProfile.cacheStatus === 'fresh' ? icons.zap : icons.clock}
            </span>
            <span className="cache-label">
              {brandProfile.cacheStatus === 'fresh' ? 'Brain Fresh' : 
               brandProfile.cacheStatus === 'cached' ? 'Brain Cached' : 'Brain Stale'}
            </span>
          </div>
        )}
        <div className="user-area" style={{ position: 'relative' }} ref={menuRef}>
          <SignedOut>
            <a href="https://accounts.forgeintelligence.ai/sign-in" style={{ fontSize: '0.875rem', color: '#ffffff', textDecoration: 'none', fontWeight: 600, padding: '8px 20px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, display: 'inline-block' }}>
              Sign In
            </a>
          </SignedOut>
          <SignedIn>
          <button
            className="user-avatar clerk-avatar"
            onClick={() => setMenuOpen(o => !o)}
            title="Account"
          >
            {user?.imageUrl
              ? <img src={user.imageUrl} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
              : <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>
                  {user?.firstName?.[0] || user?.primaryEmailAddress?.emailAddress?.[0]?.toUpperCase() || '?'}
                </span>
            }
          </button>
          {menuOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '8px 0', minWidth: 200, zIndex: 999, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}

            >
              <div style={{ padding: '8px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: '0.8rem', color: 'rgba(255,255,255,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.primaryEmailAddress?.emailAddress || user?.firstName || 'Your account'}
              </div>
              <SignOutButton redirectUrl="/">
                <button style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', color: '#F87171', fontSize: '0.875rem', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}
                  onClick={() => setMenuOpen(false)}
                >
                  Sign out
                </button>
              </SignOutButton>
            </div>
          )}
          </SignedIn>
        </div>
      </div>
    </header>
  );
}
