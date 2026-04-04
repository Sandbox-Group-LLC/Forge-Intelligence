import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import { NewAnalysis } from '../components/views/NewAnalysis';
import { ActiveRun } from '../components/views/ActiveRun';
import { BrandProfile } from '../components/views/BrandProfile';
import { Strategy } from '../components/views/Strategy';
import { BrainHistory } from '../components/views/BrainHistory';

function ContextAgentPage() {
  const { currentView, setCurrentView, setIsProcessing, setProcessingStages, setBrandProfile } = useApp();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const onboardUrl = sessionStorage.getItem('forge_onboard_url');
    if (!onboardUrl) return;
    firedRef.current = true;
    sessionStorage.removeItem('forge_onboard_url');

    // Switch to active run immediately so user sees progress
    setCurrentView('active-run');
    setIsProcessing(true);

    // Fire analysis directly — no stale closure risk
    fetch('/api/context-hub/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandUrl: onboardUrl,
        competitorUrls: [],
        audienceNotes: '',
        strategicNotes: '',
        checkBrainFirst: false,
        saveToBrain: true,
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) setBrandProfile(d.data);
        setIsProcessing(false);
        setCurrentView('brand-profile');
      })
      .catch(() => {
        setIsProcessing(false);
      });
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
