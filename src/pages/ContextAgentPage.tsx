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
  const { currentView, setCurrentView, setIsProcessing, setProcessingStages, setBrandProfile, setAnalysisInput, activeBrand } = useApp();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const onboardUrl = sessionStorage.getItem('forge_onboard_url');
    if (!onboardUrl) return;
    firedRef.current = true;
    sessionStorage.removeItem('forge_onboard_url');

    setCurrentView('active-run');
    setIsProcessing(true);
    setAnalysisInput({ brandUrl: onboardUrl, competitorUrls: [], audienceNotes: '', strategicNotes: '', checkBrainFirst: true, saveToBrain: true });

    const stageTimings = [12500, 15500, 19000, 15500, 12500];
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

    // Domain is the session key — no session ID needed
    fetch('/api/context-hub/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandUrl: onboardUrl,
        competitorUrls: [],
        audienceNotes: '',
        strategicNotes: '',
        checkBrainFirst: true,
        saveToBrain: true,
      }),
    })
      .then(r => r.json())
      .then(d => {
        cancelled = true;
        if (d.success && d.data) {
          setProcessingStages(initialProcessingStages.map(s => ({ ...s, status: 'complete' as const })));
          setBrandProfile(d.data);

          // Store brand in localStorage AND URL param — URL survives mobile Safari localStorage wipes
          const activeBrand = {
            id: d.data.id,
            brandUrl: d.data.brandUrl,
            brandName: d.data.brandName,
            expiresAt: d.data.expiresAt || null,
            isPaid: d.data.isPaid || false,
          };
          try { localStorage.setItem('forge_active_brand', JSON.stringify(activeBrand)); } catch(e) {}
          try { localStorage.setItem('forge_active_brand_id', d.data.id); } catch(e) {}
          // Replace URL with brand ID so mobile users don't lose their scan on refresh
          window.history.replaceState({}, '', `/app/context-hub?brand=${d.data.id}`);
        }
        setIsProcessing(false);
        setCurrentView('brand-profile');
      })
      .catch((err) => {
        cancelled = true;
        setIsProcessing(false);
        setCurrentView('new-analysis');
        // Surface error via custom event so NewAnalysis can show it
        window.dispatchEvent(new CustomEvent('forge:scan-error', {
          detail: { message: err?.message || 'Analysis failed. Please try again.' }
        }));
      });
  }, []);

  // Seed URL from active brand when landing on new-analysis with no pending onboard URL
  // This covers the full-page-reload path (window.location.href navigation)
  useEffect(() => {
    if (currentView !== 'new-analysis') return;
    const onboardUrl = sessionStorage.getItem('forge_onboard_url');
    if (onboardUrl) return; // landing page flow takes precedence
    if (activeBrand?.brandUrl) {
      setAnalysisInput({ brandUrl: activeBrand.brandUrl || '', competitorUrls: [], audienceNotes: '', strategicNotes: '', checkBrainFirst: true, saveToBrain: true });
    }
  }, [currentView, activeBrand?.brandUrl]);

  // URL-based brand recovery — handles mobile Safari localStorage wipes
  // If ?brand=UUID is in the URL and we have no active brand, fetch it from the DB
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const brandId = params.get('brand');
    if (!brandId) return;
    // Already have a brand loaded — no need to recover
    try { const stored = localStorage.getItem('forge_active_brand'); if (stored) return; } catch(e) {}
    // Fetch brand from DB by ID
    fetch(`/api/context-hub/brand/${brandId}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) {
          setBrandProfile(d.data);
          const activeBrand = { id: d.data.id, brandUrl: d.data.brandUrl, brandName: d.data.brandName, expiresAt: d.data.expiresAt || null, isPaid: d.data.isPaid || false };
          try { localStorage.setItem('forge_active_brand', JSON.stringify(activeBrand)); } catch(e) {}
          setCurrentView('brand-profile');
        }
      })
      .catch(() => {});
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

  const viewTitles: Record<string, string> = {
    'new-analysis': 'New Analysis',
    'active-run': 'New Analysis',
    'brand-profile': 'Brand Profile',
    'strategy': 'Strategy Brief',
    'brain-history': 'Brain History',
  };

  return <AppShell pageTitle={viewTitles[currentView] || 'New Analysis'}>{renderView()}</AppShell>;
}

export default ContextAgentPage;
