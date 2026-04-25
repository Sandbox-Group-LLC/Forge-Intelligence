import { ReactNode, useEffect } from 'react';
import { Sidebar } from '../components/Sidebar';
import { TopBar } from '../components/TopBar';
import { useApp } from '../context/AppContext';
import '../layouts/WorkspaceLayout.css';
import { ClerkTokenSync } from '../components/ClerkTokenSync';
import { OnboardingBot } from '../components/OnboardingBot';

interface AppShellProps {
  children: ReactNode;
  pageTitle?: string;
  showSidebar?: boolean;
}

export function AppShell({ children, pageTitle, showSidebar = true }: AppShellProps) {
  const { sidebarCollapsed, setSidebarCollapsed, currentView } = useApp();

  // Auto-collapse drawer when view changes on mobile (after navigation tap)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.innerWidth <= 768 && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);

  // Lock body scroll while mobile drawer is open
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const isMobile = window.innerWidth <= 768;
    if (isMobile && !sidebarCollapsed) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [sidebarCollapsed]);

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {showSidebar && <Sidebar />}
      <div className="app-main">
        <TopBar pageTitle={pageTitle} />
        <ClerkTokenSync />
        <OnboardingBot />
        <main className="app-content">
          <div className="view-container">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
