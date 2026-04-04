import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import { NewAnalysis } from '../components/views/NewAnalysis';
import { ActiveRun } from '../components/views/ActiveRun';
import { BrandProfile } from '../components/views/BrandProfile';
import { Strategy } from '../components/views/Strategy';
import { BrainHistory } from '../components/views/BrainHistory';
import { initialProcessingStages } from '../data/mockData';
import { ProcessingStage } from '../types';

function ContextAgentPage() {
  const { currentView, setCurrentView, setIsProcessing, setProcessingStages, setBrandProfile, setAnalysisInput } = useApp();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const onboardUrl = sessionStorage.getItem('forge_onboard_url');
    if (!onboardUrl) return;
    firedRef.current = true;
    sessionStorage.removeItem('forge_onboard_url');

    // Switch to active run and reset stages
    setCurrentView('active-run');
    setIsProcessing(true);
    setAnalysisInput({ brandUrl: onboardUrl, competitorUrls: [], audienceNotes: '', strategicNotes: '', checkBrainFirst: false, saveToBrain: true });
    // Drive stage animations while Claude works
    const stageTimings = [2000, 3000, 4000, 3000, 2000];
    let cancelled = false;

    let stages: ProcessingStage[] = initialProcessingStages.map(s => ({ ...s, status: 'pending' as const }));

    const driveStages = async () => {
      for (let i = 0; i < stageTimings.length; i++) {
        if (cancelled) break;
        stages = stages.map((s, idx) =>
          idx === i ? { ...s, status: 'running' as const, startTime: Date.now() } : s
        );
        setProcessingStages([...stages]);
        await new Promise(r => setTimeout(r, stageTimings[i]));
        if (cancelled) break;
        stages = stages.map((s, idx) =>
          idx === i ? { ...s, status: 'complete' as const, endTime: Date.now() } : s
        );
        setProcessingStages([...stages]);
      }
    };

    driveStages();

    // Fire analysis — when done, cancel stage loop and show brand profile
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
        cancelled = true;
        if (d.success && d.data) {
          // Mark all stages complete
          setProcessingStages(initialProcessingStages.map(s => ({ ...s, status: 'complete' as const })));
          setBrandProfile(d.data);
        }
        setIsProcessing(false);
        setCurrentView('brand-profile');
      })
      .catch(() => {
        cancelled = true;
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
