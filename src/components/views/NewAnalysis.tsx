import { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import './NewAnalysis.css';

const icons = {
  play: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ),
  plus: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14"/><path d="M12 5v14"/>
    </svg>
  ),
  x: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
    </svg>
  ),
  chevron: (open: boolean) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
      <path d="m6 9 6 6 6-6"/>
    </svg>
  ),
  zap: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
};

export function NewAnalysis() {
  const { analysisInput, setAnalysisInput, startAnalysis, activeBrand, isPaid, setCurrentView } = useApp();
  const [scanError, setScanError] = useState('');

  // Listen for scan errors from ContextAgentPage and AppContext
  useEffect(() => {
    const onError = (e: Event) => setScanError((e as CustomEvent).detail?.message || 'Analysis failed. Please try again.');
    const onBlocked = (e: Event) => setScanError((e as CustomEvent).detail?.message || 'This domain already has a Brain. Sign in to access it.');
    window.addEventListener('forge:scan-error', onError);
    window.addEventListener('forge:scan-blocked', onBlocked);
    return () => {
      window.removeEventListener('forge:scan-error', onError);
      window.removeEventListener('forge:scan-blocked', onBlocked);
    };
  }, []);

  const canSubmit = analysisInput.brandUrl.trim().length > 0;

  const daysSinceUpdate = activeBrand?.updatedAt
    ? Math.floor((Date.now() - new Date(activeBrand.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const isStale = isPaid && daysSinceUpdate !== null && daysSinceUpdate > 30;

  const handleRefresh = () => {
    setAnalysisInput({ ...analysisInput, brandUrl: activeBrand?.brandUrl || analysisInput.brandUrl, checkBrainFirst: false });
    setTimeout(() => startAnalysis(), 0);
  };

  return (
    <div className="new-analysis">
      <div className="view-header">
        <div className="geo-eyebrow">Stage 1</div>
        <h2 className="view-title">Generate Brand Intelligence</h2>
        <p className="view-description">
          Drop in a URL. Forge discovers competitors, crawls their sites to see what they actually publish, maps your ICP, and builds a full Brand Intelligence Profile — automatically.
        </p>
      </div>

      {isStale && (
        <div className="staleness-banner">
          <div className="staleness-banner-left">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="staleness-icon">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span>
              Your Brain was last analyzed <strong>{daysSinceUpdate} days ago</strong> — content published since then may not be reflected in generation.
            </span>
          </div>
          <button className="staleness-refresh-btn" onClick={handleRefresh}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M16 8h5V3"/>
            </svg>
            Refresh Brain
          </button>
        </div>
      )}

      {isPaid && activeBrand && !isStale && (
        <div className="staleness-banner" style={{ background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent)' }}>
          <div className="staleness-banner-left">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/>
            </svg>
            <span>Your Brain is ready. Start with your <strong>Strategy Brief</strong> — competitive gaps, personas, and strategic recommendations for your brand.</span>
          </div>
          <div className="staleness-banner-actions" style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => setCurrentView('strategy')} className="staleness-refresh-btn" style={{ borderColor: 'var(--color-accent)', color: 'var(--color-accent)', cursor: 'pointer', background: 'none', border: '1px solid var(--color-accent)' }}>
              View Strategy Brief →
            </button>
            <a href={`/app/geo-strategist?profileId=${activeBrand.id}`} className="staleness-refresh-btn" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
              Skip to GEO Strategy
            </a>
          </div>
        </div>
      )}

      <div className="analysis-form">

        {/* ── Primary input ── */}
        <div className="form-section url-section">
          <div className="form-group">
            <label className="form-label">
              Brand URL <span className="required">*</span>
            </label>
            <div className="url-input-row">
              <input
                type="url"
                className="form-input url-input"
                placeholder="https://your-brand.com"
                value={analysisInput.brandUrl}
                onChange={(e) => setAnalysisInput({ ...analysisInput, brandUrl: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) startAnalysis(); }}
                autoFocus
              />
              <button
                type="button"
                className="btn-primary btn-run"
                onClick={() => startAnalysis()}
                disabled={!canSubmit}
              >
                <span className="btn-icon">{icons.play}</span>
                Run Analysis
              </button>
            </div>
            {scanError && (
              <p style={{ fontSize: '0.8125rem', color: 'var(--color-error, #EF4444)', margin: '6px 0 0', lineHeight: 1.5 }}>
                {scanError}{" "}
                <button onClick={() => setScanError("")} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit', padding: 0, fontFamily: 'inherit' }}>Try again</button>
              </p>
            )}
            <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '8px 0 0', lineHeight: 1.5 }}>
              No website yet?{' '}
              <a
                href="/app/quick-start"
                style={{ color: '#4F46E5', fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 2 }}
              >
                Build a Brand Brain from a Founder Brief instead →
              </a>
            </p>
            <div className="auto-discover-hint">
              <span className="hint-pipeline">
                <span className="hint-step">
                  <span className="hint-icon">{icons.zap}</span>
                  <span><strong>Perplexity Sonar</strong> auto-discovers competitors &amp; maps your ICP</span>
                </span>
                <span className="hint-divider">·</span>
                <span className="hint-step">
                  <span className="hint-icon">{icons.zap}</span>
                  <span><strong>Claude Opus</strong> synthesizes voice, personas, and competitive positioning</span>
                </span>
                <span className="hint-divider">·</span>
                <span className="hint-step">
                  <span className="hint-icon">{icons.zap}</span>
                  <span><strong>G2 &amp; Capterra</strong> reviews mined for power phrases &amp; objection patterns</span>
                </span>
                <span className="hint-divider">·</span>
                <span className="hint-step">
                  <span className="hint-icon">{icons.zap}</span>
                  <span><strong>Claude Opus</strong> synthesizes everything into a full Brand Intelligence Profile</span>
                </span>
              </span>
              <span className="hint-free-badge">Free · No account required</span>
            </div>
          </div>
        </div>

        {/* Check Brain First toggle — single user-facing option. Competitor/audience/strategic
            overrides were removed once Brand Facts + Factual Ground became the course-correction
            path. Save-to-Brain toggle removed (nobody unchecked it; server defaults true). */}
        <div className="form-section">
          <div className="toggle-group">
            <label className="toggle-row">
              <div className="toggle-content">
                <span className="toggle-label">Check Brain first</span>
                <span className="toggle-hint">Return cached profile if one exists. Turn off to force a fresh scan.</span>
              </div>
              <button
                type="button"
                className={`toggle-switch ${analysisInput.checkBrainFirst ? 'active' : ''}`}
                onClick={() => setAnalysisInput({ ...analysisInput, checkBrainFirst: !analysisInput.checkBrainFirst })}
                role="switch"
                aria-checked={analysisInput.checkBrainFirst}
              ><span className="toggle-knob" /></button>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
