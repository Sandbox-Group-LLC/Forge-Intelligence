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
  { id: 'geo-strategist', label: 'GEO Strategist', icon: 'zap' }
];

export function Sidebar() {
  const { currentView, setCurrentView, sidebarCollapsed, setSidebarCollapsed, isProcessing, brandProfile } = useApp();

  const getItemStatus = (id: ViewType): 'active' | 'available' | 'disabled' => {
    if (id === currentView) return 'active';
    if (id === 'active-run' && !isProcessing) return 'disabled';
    if ((id === 'brand-profile' || id === 'strategy') && !brandProfile) return 'disabled';
    if (id === 'geo-strategist') return window.location.pathname.startsWith('/geo-strategist') ? 'active' : 'available';
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
          return (
            {item.id === 'geo-strategist' ? (
              <a
                key={item.id}
                href="/geo-strategist"
                className={`nav-item ${status}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-icon">{icons[item.icon]}</span>
                {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
              </a>
            ) : (
              <button
                key={item.id}
                className={`nav-item ${status}`}
                onClick={() => status !== 'disabled' && setCurrentView(item.id)}
                disabled={status === 'disabled'}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-icon">{icons[item.icon]}</span>
                {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
                {item.id === 'active-run' && isProcessing && (
                  <span className="nav-badge pulse"></span>
                )}
              </button>
            )}
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
