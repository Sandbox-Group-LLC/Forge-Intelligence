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
  )
};

interface NavItem {
  id: ViewType;
  label: string;
  icon: keyof typeof icons;
}

const navItems: NavItem[] = [
  { id: 'new-analysis', label: 'New Analysis', icon: 'plusCircle' },
  { id: 'active-run', label: 'Active Run', icon: 'activity' },
  { id: 'brand-profile', label: 'Brand Profile', icon: 'layers' },
  { id: 'strategy', label: 'Strategy', icon: 'compass' },
  { id: 'brain-history', label: 'Brain History', icon: 'bookOpen' },
  { id: 'geo-strategist', label: 'GEO Strategist', icon: 'zap' },
  { id: 'authenticity-enricher', label: 'Authenticity Enricher', icon: 'shieldCheck' },
  { id: 'content-generator', label: 'Content Generator', icon: 'fileText' }
];

export function Sidebar() {
  const { currentView, setCurrentView, sidebarCollapsed, setSidebarCollapsed, isProcessing, brandProfile } = useApp();

  const getItemStatus = (id: ViewType): 'active' | 'available' | 'disabled' => {
    if (id === currentView) return 'active';
    if (id === 'active-run' && !isProcessing) return 'disabled';
    if ((id === 'brand-profile' || id === 'strategy') && !brandProfile) return 'disabled';
    if (id === 'geo-strategist') return window.location.pathname.startsWith('/geo-strategist') ? 'active' : 'available';
    if (id === 'authenticity-enricher') return window.location.pathname.startsWith('/authenticity-enricher') ? 'active' : 'available';
    return 'available';
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
        {navItems.map(item => {
          const status = getItemStatus(item.id);
          if (item.id === 'geo-strategist') {
            return (
              <a
                key={item.id}
                href="/geo-strategist"
                className={`nav-item ${status}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-icon">{icons[item.icon]}</span>
                {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
              </a>
            );
          }
          if (item.id === 'authenticity-enricher') {
            return (
              <a
                key={item.id}
                href="/authenticity-enricher"
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
              onClick={() => {
                if (status === 'disabled') return;
                const routeMap: Record<string, string> = {
                  'new-analysis': '/context-hub',
                  'active-run': '/context-hub?view=active-run',
                  'brand-profile': '/context-hub?view=brand-profile',
                  'strategy': '/context-hub?view=strategy',
                  'brain-history': '/context-hub?view=brain-history',
                  'geo-strategist': '/geo-strategist',
                  'authenticity-enricher': '/authenticity-enricher',
                  'content-generator': '/content-generator',
                };
                const targetPath = routeMap[item.id] || '/context-hub';
                const currentPath = window.location.pathname;
                if (currentPath !== targetPath.split('?')[0]) {
                  window.location.href = targetPath;
                } else {
                  setCurrentView(item.id);
                }
              }}
              disabled={status === 'disabled'}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <span className="nav-icon">{icons[item.icon]}</span>
              {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
              {item.id === 'active-run' && isProcessing && (
                <span className="nav-badge pulse"></span>
              )}
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
