import { ReactNode } from 'react';
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
  const { sidebarCollapsed } = useApp();

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
