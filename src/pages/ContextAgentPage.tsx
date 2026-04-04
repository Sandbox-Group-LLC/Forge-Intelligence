import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import { NewAnalysis } from '../components/views/NewAnalysis';
import { ActiveRun } from '../components/views/ActiveRun';
import { BrandProfile } from '../components/views/BrandProfile';
import { Strategy } from '../components/views/Strategy';
import { BrainHistory } from '../components/views/BrainHistory';

function ContextAgentPage() {
  const { currentView, setAnalysisInput, startAnalysis } = useApp();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const onboardId = params.get('onboard');
    const onboardUrl = sessionStorage.getItem('forge_onboard_url');
    if (!onboardId || !onboardUrl) return;
    firedRef.current = true;
    window.history.replaceState({}, '', '/app/context-hub');
    sessionStorage.removeItem('forge_onboard_url');
    // setAnalysisInput then call startAnalysis in next tick so state is flushed
    setAnalysisInput({
      brandUrl: onboardUrl,
      competitorUrls: [],
      audienceNotes: '',
      strategicNotes: '',
      checkBrainFirst: false,
      saveToBrain: true,
    });
    setTimeout(() => startAnalysis(), 0);
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
