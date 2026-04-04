import { useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import { NewAnalysis } from '../components/views/NewAnalysis';
import { ActiveRun } from '../components/views/ActiveRun';
import { BrandProfile } from '../components/views/BrandProfile';
import { Strategy } from '../components/views/Strategy';
import { BrainHistory } from '../components/views/BrainHistory';

function ContextAgentPage() {
  const { currentView, setCurrentView, setAnalysisInput, startAnalysis } = useApp();

  // If arriving from landing page onboard flow, auto-fire analysis for that brand
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const onboardId = params.get('onboard');
    const onboardUrl = sessionStorage.getItem('forge_onboard_url');
    if (onboardId && onboardUrl) {
      // Set the brand URL and kick off the active run immediately
      setAnalysisInput({
        brandUrl: onboardUrl,
        competitorUrls: [],
        audienceNotes: '',
        strategicNotes: '',
        checkBrainFirst: false,
        saveToBrain: true,
        onboardBrandProfileId: onboardId,
      } as any);
      startAnalysis();
      sessionStorage.removeItem('forge_onboard_url');
      window.history.replaceState({}, '', '/app/context-hub');
    }
  }, []);

  const renderView = () => {
    switch (currentView) {
      case 'new-analysis': return <NewAnalysis />;
      case 'active-run': return <ActiveRun />;
      case 'brand-profile': return <BrandProfile />;
      case 'strategy': return <Strategy />;
      case 'brain-history': return <BrainHistory />;
      default: return <NewAnalysis />;
    }
  };

  return <AppShell>{renderView()}</AppShell>;
}

export default ContextAgentPage;
