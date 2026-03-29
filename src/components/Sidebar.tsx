import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { ViewType } from '../types';
import './Sidebar.css';

// Lucide-style icon components
const icons = {
  diamond: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>
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
  plug: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/>
      <path d="M18 8H6a2 2 0 0 0-2 2v3a6 6 0 0 0 12 0v-3a2 2 0 0 0-2-2z"/>
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
  )
};

const BRAIN_VIEWS: ViewType[] = ['new-analysis', 'active-run', 'brand-profile', 'strategy', 'brain-history'];

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

const topNavItems: TopNavItem[] = [
  { id: 'geo-strategist', label: 'GEO Strategist', icon: 'zap', href: '/app/geo-strategist' },
  { id: 'authenticity-enricher', label: 'Authenticity Enricher', icon: 'shieldCheck', href: '/app/authenticity-enricher' },
  { id: 'content-generator', label: 'Content Generator', icon: 'fileText' },
  { id: 'campaign-generator', label: 'Campaign Generator', icon: 'layers' },
  { id: 'compliance-gate', label: 'Compliance Gate', icon: 'shieldCheck' },
  { id: 'integrations', label: 'Integrations', icon: 'plug', href: '/app/integrations' },
  { id: 'publishing-queue', label: 'Publishing Queue', icon: 'sendCloud', href: '/app/publishing-queue' },
  { id: 'performance', label: 'Performance', icon: 'barChart2', href: '/app/performance' },
];

export function Sidebar() {
  const { currentView, setCurrentView, sidebarCollapsed, setSidebarCollapsed, isProcessing, brandProfile } = useApp();
  const [brainGroupOpen, setBrainGroupOpen] = useState(false);

  const isBrainViewActive = BRAIN_VIEWS.includes(currentView);

  const getBrainItemStatus = (id: ViewType): 'active' | 'available' | 'disabled' => {
    if (id === currentView) return 'active';
    if (id === 'active-run' && !isProcessing) return 'disabled';
    if ((id === 'brand-profile' || id === 'strategy') && !brandProfile) return 'disabled';
    return 'available';
  };

  const getTopItemStatus = (id: ViewType): 'active' | 'available' => {
    const path = window.location.pathname;
    if (id === 'geo-strategist') return path.startsWith('/app/geo-strategist') ? 'active' : 'available';
    if (id === 'authenticity-enricher') return path.startsWith('/app/authenticity-enricher') ? 'active' : 'available';
    if (id === 'integrations') return path.startsWith('/app/integrations') ? 'active' : 'available';
    if (id === 'publishing-queue') return path.startsWith('/app/publishing-queue') ? 'active' : 'available';
    if (id === 'performance') return path.startsWith('/app/performance') ? 'active' : 'available';
    if (id === currentView) return 'active';
    return 'available';
  };

  const handleBrainItemClick = (id: ViewType, status: string) => {
    if (status === 'disabled') return;
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

  const handleTopItemClick = (item: TopNavItem, status: string) => {
    if (item.href) {
      window.location.href = item.href;
      return;
    }
    if (status === 'disabled') return;
    const routeMap: Record<string, string> = {
      'content-generator': '/app/content-generator',
      'campaign-generator': '/app/campaign-generator',
      'compliance-gate': '/app/compliance-gate',
    };
    const targetPath = routeMap[item.id] || '/app/context-hub';
    const currentPath = window.location.pathname;
    if (currentPath !== targetPath.split('?')[0]) {
      window.location.href = targetPath;
    } else {
      setCurrentView(item.id);
    }
  };

  return (
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
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
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

        {/* Top-level nav items */}
        {topNavItems.map(item => {
          const status = getTopItemStatus(item.id);
          if (item.href) {
            return (
              <a
                key={item.id}
                href={item.href}
                className={`nav-item ${status}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-icon">{icons[item.icon]}</span>
                {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
              </a>
            );
          }
          return (
            <button
              key={item.id}
              className={`nav-item ${status}`}
              onClick={() => handleTopItemClick(item, status)}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <span className="nav-icon">{icons[item.icon]}</span>
              {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        {!sidebarCollapsed && (
          <div className="sidebar-status">
            <span className="status-icon">{icons.cpu}</span>
            <span className="status-dot connected"></span>
            <span className="status-text">Brain Connected</span>
          </div>
        )}
      </div>
    </aside>
  );
}