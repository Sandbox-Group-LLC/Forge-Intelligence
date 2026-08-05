import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import GateModal from './GateModal';
import './GateModal.css';
import { ViewType } from '../types';
import './Sidebar.css';

// Lucide-style icon components
const icons = {
  diamond: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>
    </svg>
  ),
  film: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>
    </svg>
  ),
  calendar: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  ),
  plusCircle: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 12h8"/>
      <path d="M12 8v8"/>
    </svg>
  ),
  activity: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  ),
  layers: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  ),
  compass: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
    </svg>
  ),
  bookOpen: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </svg>
  ),
  cpu: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="16" height="16" x="4" y="4" rx="2"/>
      <rect width="6" height="6" x="9" y="9" rx="1"/>
      <path d="M15 2v2"/>
      <path d="M15 20v2"/>
      <path d="M2 15h2"/>
      <path d="M2 9h2"/>
      <path d="M20 15h2"/>
      <path d="M20 9h2"/>
      <path d="M9 2v2"/>
      <path d="M9 20v2"/>
    </svg>
  ),
  brain: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.077-4.56A3 3 0 0 1 3.83 9.85a3 3 0 0 1 .81-4.87A2.5 2.5 0 0 1 9.5 2Z"/>
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.077-4.56A3 3 0 0 0 20.17 9.85a3 3 0 0 0-.81-4.87A2.5 2.5 0 0 0 14.5 2Z"/>
    </svg>
  ),
  chevronLeft: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6"/>
    </svg>
  ),
  chevronRight: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6"/>
    </svg>
  ),
  chevronDown: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6"/>
    </svg>
  ),
  zap: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  shieldCheck: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  ),
  fileText: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  ),
  fileImport: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="18" x2="12" y2="12"/>
      <polyline points="9 15 12 18 15 15"/>
    </svg>
  ),

  plug: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16.5A3.5 3.5 0 0 0 10.5 20H14a3.5 3.5 0 0 0 3.5-3.5V14h-11v2.5Z"/>
      <path d="M17.5 14V10A3.5 3.5 0 0 0 14 6.5h-3.5A3.5 3.5 0 0 0 7 10v4"/>
      <path d="M10 6.5V4"/><path d="M14 6.5V4"/>
    </svg>
  ),
  mail: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
    </svg>
  ),
  sendCloud: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  ),
  barChart2: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
      <line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
  ),
  trendingUp: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  target: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>),
  penLine: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
  ),
  share2: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3"/>
      <circle cx="6" cy="12" r="3"/>
      <circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
};

interface BrainNavItem {
  id: ViewType;
  label: string;
  icon: keyof typeof icons;
}

const brainNavItems: BrainNavItem[] = [
  { id: 'new-analysis', label: 'New Analysis', icon: 'plusCircle' },
  { id: 'active-run', label: 'Active Run', icon: 'activity' },
  { id: 'brand-profile', label: 'Brand Profile', icon: 'layers' },
  { id: 'strategy', label: 'Strategy', icon: 'compass' },
  { id: 'brain-history', label: 'Brain History', icon: 'bookOpen' },
];

interface TopNavItem {
  id: ViewType;
  label: string;
  icon: keyof typeof icons;
  href?: string;
}

// Route map — single source of truth for all nav paths
const NAV_ROUTES: Partial<Record<ViewType, string>> = {
  'geo-strategist':       '/app/geo-strategist',
  'authenticity-enricher':'/app/authenticity-enricher',
  'content-generator':    '/app/content-generator',
  'campaign-generator':   '/app/campaign-generator',
  'social-generator':     '/app/social-generator',
  'video-generator':      '/app/video-generator',
  'ads-generator':        '/app/ads-generator',
  'compliance-gate':      '/app/compliance-gate',
  'strategy-intel':       '/app/strategy-intel',
  'integrations':         '/app/integrations',
  'publishing-queue':     '/app/publishing-queue',
  'performance':          '/app/performance',
  'brand-settings':       '/app/brand-settings',
  'new-analysis':         '/app/context-hub',
  'active-run':           '/app/context-hub',
  'brand-profile':        '/app/context-hub',
  'strategy':             '/app/context-hub',
  'brain-history':        '/app/context-hub',
  'email-campaign':       '/app/email-campaign',
  'quick-copy':           '/app/quick-copy',
  'content-library':      '/app/content-library',
  'content-import':       '/app/content-import',
  'topic-queue':          '/app/topic-queue',
  'admin':                '/app/mc',
};

const publishingNavItems = [
  { id: 'publishing-queue', label: 'Queue',           icon: 'sendCloud',  href: '/app/publishing-queue' },
  { id: 'calendar',         label: 'Calendar',        icon: 'calendar',   href: '/app/calendar' },
  { id: 'content-library',  label: 'Content Library', icon: 'bookOpen',   href: '/app/content-library' },
  { id: 'content-import',   label: 'Import Article',  icon: 'fileImport', href: '/app/content-import' },
  { id: 'topic-queue',      label: 'Topic Queue',     icon: 'fileText',   href: '/app/topic-queue' },
] as const;

const settingsNavItems = [
  { id: 'brand-settings', label: 'Brand Settings', icon: 'settings', href: '/app/brand-settings' },
  { id: 'integrations',   label: 'Integrations',   icon: 'plug',     href: '/app/integrations' },
  { id: 'admin',          label: 'Mission Control', icon: 'cpu',     href: '/app/mc' },
  { id: 'audit-log',      label: 'Audit Log',       icon: 'fileText', href: '/app/audit-log' },
  { id: 'data-requests',  label: 'Data Requests',   icon: 'shieldCheck', href: '/app/data-requests' },
] as const;

const topNavItems: TopNavItem[] = [
  { id: 'geo-strategist',        label: 'GEO Strategist',        icon: 'zap',        href: '/app/geo-strategist' },
  { id: 'strategy-intel',        label: 'Brand Intelligence',    icon: 'compass',    href: '/app/strategy-intel' },
  { id: 'authenticity-enricher', label: 'Authenticity Enricher', icon: 'shieldCheck',href: '/app/authenticity-enricher' },
  { id: 'content-generator',     label: 'Content Generator',     icon: 'fileText',   href: '/app/content-generator' },
  { id: 'campaign-generator',    label: 'Campaign Generator',    icon: 'layers',     href: '/app/campaign-generator' },
  { id: 'social-generator',      label: 'Social Generator',      icon: 'share2',     href: '/app/social-generator' },
  { id: 'video-generator',       label: 'Video Generator',       icon: 'film',       href: '/app/video-generator' },
  { id: 'ads-generator',         label: 'Ads Generator',          icon: 'target',     href: '/app/ads-generator' },
  { id: 'email-campaign',        label: 'Email Campaign',         icon: 'mail',       href: '/app/email-campaign' },
  { id: 'quick-copy',            label: 'Quick Copy',             icon: 'penLine',    href: '/app/quick-copy' },
  { id: 'compliance-gate',       label: 'Compliance Gate',       icon: 'shieldCheck',href: '/app/compliance-gate' },

  { id: 'performance',           label: 'Performance',           icon: 'barChart2',  href: '/app/performance' },
];

export function Sidebar() {
  const { currentView, setCurrentView, setAnalysisInput, analysisInput, sidebarCollapsed, setSidebarCollapsed, isProcessing, brandProfile, isPaid, brandLoading, activeBrand, refetchBrand, isSuperAdmin, historyEntries } = useApp();
  // Brain version: pulled from the active brand's history entry (which already
  // carries version from the brand_profiles row). Falls through to undefined
  // if the brand isn't in the history list yet — footer shows "idle" in that case.
  const activeBrainVersion = historyEntries.find(h => h.id === activeBrand?.id)?.version;
  const [gateFeature, setGateFeature] = useState<string | null>(null);
  const [seededPromoCode, setSeededPromoCode] = useState<string>('');

  // Partner / prospect deep-link support:
  //   ?gate=open    → auto-open GateModal on mount (soft paywall on landing)
  //   ?promo=CODE   → pre-fill promo input so the prospect just clicks Apply
  // Both params are consumed once and stripped from the URL so a refresh
  // doesn't re-pop the modal. ?brand= and other query params are preserved.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wantsGate = params.get('gate') === 'open';
    const promo = params.get('promo') || '';
    if (!wantsGate && !promo) return;
    if (promo) setSeededPromoCode(promo);
    if (wantsGate) setGateFeature('Forge Intelligence');
    params.delete('gate');
    params.delete('promo');
    const qs = params.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState({}, '', url);
  }, []);
  const LOCKED_ROUTES = [
    '/app/geo-strategist', '/app/authenticity-enricher', '/app/content-generator',
    '/app/campaign-generator', '/app/social-generator', '/app/ads-generator', '/app/compliance-gate', '/app/publishing-queue', '/app/calendar',
    '/app/content-library', '/app/content-import', '/app/topic-queue',
    '/app/performance', '/app/integrations', '/app/mc', '/app/email-campaign', '/app/quick-copy',
  ];
  // Never gate while auth is still resolving — brandProfileId would be undefined
  const handleGatedClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string, label: string) => {
    if (!isPaid && !brandLoading && LOCKED_ROUTES.includes(href)) {
      e.preventDefault();
      setGateFeature(label);
    }
  };
  const [brainGroupOpen, setBrainGroupOpen] = useState(() => window.location.pathname.startsWith('/app/context-hub'));
  const [publishingGroupOpen, setPublishingGroupOpen] = useState(() => ['/app/publishing-queue','/app/calendar','/app/content-library','/app/content-import','/app/topic-queue'].some(r => window.location.pathname.startsWith(r)));
  const [settingsGroupOpen, setSettingsGroupOpen] = useState(() => ['/app/brand-settings','/app/integrations','/app/mc'].some(r => window.location.pathname.startsWith(r)));
  // Drawer open/closed derives from sidebarCollapsed (the single source of truth).

  // Auto-collapse on mobile at mount
  useEffect(() => {
    if (window.innerWidth <= 768) {
      setSidebarCollapsed(true);
    }
  }, []);

  // Sync group open state and path with navigation
  useEffect(() => {
    const p = window.location.pathname;
    setPath(p);
    if (['/app/publishing-queue','/app/calendar','/app/content-library','/app/content-import','/app/topic-queue'].some(r => p.startsWith(r))) {
      setPublishingGroupOpen(true);
    }
    if (['/app/brand-settings','/app/integrations','/app/mc'].some(r => p.startsWith(r))) {
      setSettingsGroupOpen(true);
    }
  }, [window.location.pathname]);

  // Track mobile expanded state (collapsed=false on mobile = drawer open)
  const isMobile = () => window.innerWidth <= 768;

  const handleToggle = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };

  const closeMobileDrawer = () => {
    if (isMobile()) {
      setSidebarCollapsed(true);
    }
  };

  const [path, setPath] = useState(window.location.pathname);

  // M3: Update path state on SPA navigation (pushState/popState)
  useEffect(() => {
    const onNav = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onNav);
    // Also patch pushState to fire an event
    const origPush = history.pushState.bind(history);
    history.pushState = (...args) => { origPush(...args); onNav(); };
    return () => {
      window.removeEventListener('popstate', onNav);
      history.pushState = origPush;
    };
  }, []);
  const isBrainViewActive = path.startsWith('/app/context-hub');

  const getBrainItemStatus = (id: ViewType): 'active' | 'available' | 'disabled' => {
    if (id === currentView) return 'active';
    if (id === 'active-run' && !isProcessing) return 'disabled';
    if ((id === 'brand-profile' || id === 'strategy') && !brandProfile) return 'disabled';
    return 'available';
  };

  const getTopItemStatus = (id: ViewType): 'active' | 'available' => {
    const route = NAV_ROUTES[id];
    // Each item is active only if its exact route matches the current path
    // Brain sub-items all share /app/context-hub — handled separately via isBrainViewActive
    if (!route || route === '/app/context-hub') return 'available';
    return path.startsWith(route) ? 'active' : 'available';
  };

  const handleBrainItemClick = (id: ViewType, status: string) => {
    if (status === 'disabled') return;
    // In production (single brand), pre-seed the URL field with the active brand URL
    // so New Analysis always opens ready to re-scan their own brand, not blank/stale
    if (id === 'new-analysis' && activeBrand?.brandUrl) {
      setAnalysisInput({ ...analysisInput, brandUrl: activeBrand.brandUrl });
    }
    const routeMap: Record<string, string> = {
      'new-analysis': '/app/context-hub',
      'active-run': '/app/context-hub?view=active-run',
      'brand-profile': '/app/context-hub?view=brand-profile',
      'strategy': '/app/context-hub?view=strategy',
      'brain-history': '/app/context-hub?view=brain-history',
    };
    const targetPath = routeMap[id] || '/app/context-hub';
    const currentPath = window.location.pathname;
    if (currentPath !== targetPath.split('?')[0]) {
      window.location.href = targetPath;
    } else {
      setCurrentView(id);
    }
  };

  return (
    <>
      {gateFeature && (
        <GateModal
          featureName={gateFeature}
          onClose={() => setGateFeature(null)}
          brandProfileId={activeBrand?.id || (brandProfile as any)?.id || (() => { try { return localStorage.getItem('forge_active_brand_id'); } catch(e) { return null; } })() || new URLSearchParams(window.location.search).get('brand') || undefined}
          onUnlocked={() => { setGateFeature(null); refetchBrand(); }}
          initialPromoCode={seededPromoCode}
        />
      )}
      {/* Mobile backdrop */}
      {!sidebarCollapsed && (
        <div className="sidebar-backdrop" onClick={closeMobileDrawer} aria-hidden="true" />
      )}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}> 
      <div className="sidebar-header">
        <div className="sidebar-brand">
          {!sidebarCollapsed ? (
            <>
              <span className="sidebar-logo-mark">{icons.diamond}</span>
              <span className="sidebar-logo-text">Forge Intelligence</span>
            </>
          ) : (
            <span className="sidebar-logo-mark">{icons.diamond}</span>
          )}
        </div>
        <button
          className="sidebar-toggle"
          onClick={handleToggle}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? icons.chevronRight : icons.chevronLeft}
        </button>
      </div>

      <nav className="sidebar-nav">
        {/* Brain collapsible group */}
        <button
          className={`nav-item nav-group-header ${isBrainViewActive ? 'active' : 'available'}`}
          onClick={() => {
            if (sidebarCollapsed) {
              setSidebarCollapsed(false);
              setBrainGroupOpen(true);
            } else {
              setBrainGroupOpen(!brainGroupOpen);
            }
          }}
          title={sidebarCollapsed ? 'Brain' : undefined}
          aria-expanded={brainGroupOpen}
        >
          <span className="nav-icon">{icons.brain}</span>
          {!sidebarCollapsed && (
            <>
              <span className="nav-label">Brain</span>
              <span className={`nav-group-chevron ${brainGroupOpen ? 'open' : ''}`}> 
                {icons.chevronDown}
              </span>
            </>
          )}
        </button>

        {/* Brain sub-items */}
        {!sidebarCollapsed && brainGroupOpen && (
          <div className="nav-group-children">
            {brainNavItems.map(item => {
              const status = getBrainItemStatus(item.id);
              return (
                <button
                  key={item.id}
                  className={`nav-item nav-child-item ${status}`}
                  onClick={() => handleBrainItemClick(item.id, status)}
                  disabled={status === 'disabled'}
                >
                  <span className="nav-icon">{icons[item.icon]}</span>
                  <span className="nav-label">{item.label}</span>
                  {item.id === 'active-run' && isProcessing && (
                    <span className="nav-badge pulse"></span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Pipeline group label — matches the labeled-group pattern used by
            Publishing and Settings below. Hidden in collapsed mode (no room
            for the label, and the icons + tooltips carry the grouping). */}
        {!sidebarCollapsed && <div className="nav-group-label">Pipeline</div>}

        {/* Top-level nav items — all use href for clean URL-based navigation */}
        {topNavItems.map(item => {
          // Insert Publishing group before Performance
          if (item.id === 'performance') {
            const isPublishingActive = ['/app/publishing-queue','/app/calendar','/app/content-library','/app/content-import','/app/topic-queue'].some(r => path.startsWith(r));
            return (
              <div key="publishing-group">
                {/* Publishing group header */}
                <button
                  className={`nav-item nav-group-header ${isPublishingActive ? 'active' : 'available'}`}
                  onClick={() => {
                    if (!isPaid) { setGateFeature('Publishing'); return; }
                    if (sidebarCollapsed) { setSidebarCollapsed(false); setPublishingGroupOpen(true); }
                    else setPublishingGroupOpen(o => !o);
                  }}
                  title={sidebarCollapsed ? 'Publishing' : undefined}
                >
                  <span className="nav-icon">{icons.sendCloud}</span>
                  {!sidebarCollapsed && (
                    <>
                      <span className="nav-label">Publishing</span>
                      <span className={`nav-group-chevron ${publishingGroupOpen ? 'open' : ''}`}>{icons.chevronDown}</span>
                    </>
                  )}
                </button>
                {/* Publishing children */}
                {!sidebarCollapsed && publishingGroupOpen && (
                  <div className="nav-group-children">
                    {publishingNavItems.map(child => {
                      const childActive = path.startsWith(child.href);
                      return (
                        <a
                          key={child.id}
                          href={child.href}
                          className={`nav-item nav-child-item ${childActive ? 'active' : 'available'}`}
                          onClick={closeMobileDrawer}
                        >
                          <span className="nav-icon">{icons[child.icon as keyof typeof icons]}</span>
                          <span className="nav-label">{child.label}</span>
                        </a>
                      );
                    })}
                  </div>
                )}
                {/* Then render Performance itself */}
                {(() => {
                  const status = getTopItemStatus(item.id as any);
                  return (
                    <a
                      href={item.href}
                      className={`nav-item ${status}${!isPaid && LOCKED_ROUTES.includes(item.href||'') ? ' gated' : ''}`}
                      title={sidebarCollapsed ? item.label : undefined}
                      onClick={(e) => { closeMobileDrawer(); handleGatedClick(e, item.href||'', item.label); }}
                    >
                      <span className="nav-icon">{icons[item.icon as keyof typeof icons]}</span>
                      {!sidebarCollapsed && <span className="nav-label">{item.label}{!isPaid && LOCKED_ROUTES.includes(item.href||'') && <svg style={{marginLeft:'auto',opacity:0.35,flexShrink:0}} width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'><rect x='3' y='11' width='18' height='11' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/></svg>}</span>}
                    </a>
                  );
                })()}
              </div>
            );
          }
          const status = getTopItemStatus(item.id as any);
          return (
            <a
              key={item.id}
              href={item.href}
              className={`nav-item ${status}${!isPaid && LOCKED_ROUTES.includes(item.href||'') ? ' gated' : ''}`}
              title={sidebarCollapsed ? item.label : undefined}
              onClick={(e) => { closeMobileDrawer(); handleGatedClick(e, item.href||'', item.label); }}
            >
              <span className="nav-icon">{icons[item.icon as keyof typeof icons]}</span>
              {!sidebarCollapsed && <span className="nav-label">{item.label}{!isPaid && LOCKED_ROUTES.includes(item.href||'') && <svg style={{marginLeft:'auto',opacity:0.35,flexShrink:0}} width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'><rect x='3' y='11' width='18' height='11' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/></svg>}</span>}
            </a>
          );
        })}
        {/* Settings group */}
        {(() => {
          const isSettingsActive = ['/app/brand-settings','/app/integrations','/app/mc'].some(r => path.startsWith(r));
          return (
            <div>
              <button
                className={`nav-item nav-group-header ${isSettingsActive ? 'active' : 'available'}`}
                onClick={() => {
                  if (sidebarCollapsed) { setSidebarCollapsed(false); setSettingsGroupOpen(true); }
                  else setSettingsGroupOpen(o => !o);
                }}
                title={sidebarCollapsed ? 'Settings' : undefined}
              >
                <span className="nav-icon">{icons.settings}</span>
                {!sidebarCollapsed && (
                  <>
                    <span className="nav-label">Settings</span>
                    <span className={`nav-group-chevron ${settingsGroupOpen ? 'open' : ''}`}>{icons.chevronDown}</span>
                  </>
                )}
              </button>
              {!sidebarCollapsed && settingsGroupOpen && (
                <div className="nav-group-children">
                  {settingsNavItems.filter(c => !['admin', 'audit-log', 'data-requests'].includes(c.id) || isSuperAdmin).map(child => {
                    const childActive = path.startsWith(child.href);
                    return (
                      <a
                        key={child.id}
                        href={child.href}
                        className={`nav-item nav-child-item ${childActive ? 'active' : 'available'}`}
                        onClick={closeMobileDrawer}
                      >
                        <span className="nav-icon">{icons[child.icon as keyof typeof icons]}</span>
                        <span className="nav-label">{child.label}</span>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
      </nav>

      <div className="sidebar-footer">
        {!sidebarCollapsed && (
          // Brain version + sync pulse. Version is bumped by the server on
          // each meaningful brain update (factualGround save, pattern extract,
          // etc.). syncState is "synced" once a brand is loaded — future:
          // surface "syncing" / "stale" if a background job is mid-flight.
          <div className="sidebar-status" title={activeBrand?.brandName || 'No brand loaded'}>
            <span className="status-dot connected" />
            <span className="footer-label">Brain</span>
            <span className="footer-value">
              {activeBrainVersion ? `v${activeBrainVersion} · synced` : 'idle'}
            </span>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}
