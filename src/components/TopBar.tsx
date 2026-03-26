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
  )
};

const viewTitles: Record<string, string> = {
  'new-analysis': 'New Analysis',
  'active-run': 'Active Run',
  'brand-profile': 'Brand Profile',
  'strategy': 'Strategy',
  'brain-history': 'Brain History',
  'geo-strategist': 'GEO Strategist'
};

export function TopBar() {
  const { currentView, brandProfile, sidebarCollapsed, setSidebarCollapsed } = useApp();

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
        <h1 className="topbar-title">{viewTitles[currentView]}</h1>
        {brandProfile && currentView === 'brand-profile' && (
          <span className="topbar-subtitle">
            {brandProfile.brandName} · v{brandProfile.version}
          </span>
        )}
      </div>

      <div className="topbar-right">
        {brandProfile && (
          <div className={`cache-indicator ${brandProfile.cacheStatus}`}>
            <span className="cache-icon">
              {brandProfile.cacheStatus === 'fresh' ? icons.zap : icons.clock}
            </span>
            <span className="cache-label">
              {brandProfile.cacheStatus === 'fresh' ? 'Fresh' : 
               brandProfile.cacheStatus === 'cached' ? 'Cached' : 'Stale'}
            </span>
          </div>
        )}
        <div className="user-area">
          <span className="user-avatar">{icons.user}</span>
        </div>
      </div>
    </header>
  );
}
