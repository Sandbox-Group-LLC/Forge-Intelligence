import { useApp } from '../context/AppContext';
import { Sidebar } from '../components/Sidebar';
import { TopBar } from '../components/TopBar';
import { NewAnalysis } from '../components/views/NewAnalysis';
import { ActiveRun } from '../components/views/ActiveRun';
import { BrandProfile } from '../components/views/BrandProfile';
import { Strategy } from '../components/views/Strategy';
import { BrainHistory } from '../components/views/BrainHistory';
import '../layouts/WorkspaceLayout.css';

function ContextAgentPage() {
  const { currentView, sidebarCollapsed } = useApp();

  const renderView = () => {
    switch (currentView) {
      case 'new-analysis':
        return <NewAnalysis />;
      case 'active-run':
        return <ActiveRun />;
      case 'brand-profile':
        return <BrandProfile />;
      case 'strategy':
        return <Strategy />;
      case 'brain-history':
        return <BrainHistory />;
      default:
        return <NewAnalysis />;
    }
  };

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar />
      <div className="app-main">
        <TopBar />
        <main className="app-content">
          <div className="view-container">
            {renderView()}
          </div>
        </main>
      </div>
    </div>
  );
}

export default ContextAgentPage;
