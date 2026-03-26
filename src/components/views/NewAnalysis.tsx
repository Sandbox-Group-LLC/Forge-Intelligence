import { useState } from 'react';
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
  const { analysisInput, setAnalysisInput, startAnalysis } = useApp();
  const [competitorInput, setCompetitorInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleAddCompetitor = () => {
    const val = competitorInput.trim();
    if (val && !analysisInput.competitorUrls.includes(val)) {
      setAnalysisInput({ ...analysisInput, competitorUrls: [...analysisInput.competitorUrls, val] });
      setCompetitorInput('');
    }
  };

  const handleRemoveCompetitor = (url: string) => {
    setAnalysisInput({ ...analysisInput, competitorUrls: analysisInput.competitorUrls.filter(u => u !== url) });
  };

  const canSubmit = analysisInput.brandUrl.trim().length > 0;

  return (
    <div className="new-analysis view-shell-centered">
      <div className="view-header">
        <div className="geo-eyebrow">Stage 1</div>
        <h2 className="view-title">Generate Brand Intelligence</h2>
        <p className="view-description">
          Drop in a URL. Forge discovers competitors, maps your ICP, and builds a full Brand Intelligence Profile — automatically.
        </p>
      </div>

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
                onClick={startAnalysis}
                disabled={!canSubmit}
              >
                <span className="btn-icon">{icons.play}</span>
                Run Analysis
              </button>
            </div>
            <div className="auto-discover-hint">
              <span className="hint-icon">{icons.zap}</span>
              Competitors and ICP are auto-discovered via Perplexity Sonar
            </div>
          </div>
        </div>

        {/* ── Advanced overrides — collapsed by default ── */}
        <div className="form-section advanced-section">
          <button
            type="button"
            className="advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <span>Advanced Overrides</span>
            {icons.chevron(showAdvanced)}
          </button>

          {showAdvanced && (
            <div className="advanced-content">
              <div className="form-group">
                <label className="form-label">Competitor URLs</label>
                <div className="competitor-input-row">
                  <input
                    type="url"
                    className="form-input"
                    placeholder="https://competitor.com"
                    value={competitorInput}
                    onChange={(e) => setCompetitorInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCompetitor(); }}}
                  />
                  <button type="button" className="btn-add" onClick={handleAddCompetitor} disabled={!competitorInput.trim()}>
                    <span className="btn-icon">{icons.plus}</span>Add
                  </button>
                </div>
                {analysisInput.competitorUrls.length > 0 && (
                  <div className="competitor-tags">
                    {analysisInput.competitorUrls.map((url) => (
                      <span key={url} className="competitor-tag">
                        {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                        <button type="button" className="tag-remove" onClick={() => handleRemoveCompetitor(url)}>
                          {icons.x}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <span className="form-hint">Override auto-discovered competitors</span>
              </div>

              <div className="form-group">
                <label className="form-label">Audience / ICP Notes</label>
                <textarea
                  className="form-textarea"
                  placeholder="Override auto-discovered ICP with specific context..."
                  rows={3}
                  value={analysisInput.audienceNotes}
                  onChange={(e) => setAnalysisInput({ ...analysisInput, audienceNotes: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Strategic Notes</label>
                <textarea
                  className="form-textarea"
                  placeholder="Any specific positioning goals or messaging challenges..."
                  rows={3}
                  value={analysisInput.strategicNotes}
                  onChange={(e) => setAnalysisInput({ ...analysisInput, strategicNotes: e.target.value })}
                />
              </div>

              <div className="toggle-group">
                <label className="toggle-row">
                  <div className="toggle-content">
                    <span className="toggle-label">Check Brain first</span>
                    <span className="toggle-hint">Return cached profile if one exists</span>
                  </div>
                  <button
                    type="button"
                    className={`toggle-switch ${analysisInput.checkBrainFirst ? 'active' : ''}`}
                    onClick={() => setAnalysisInput({ ...analysisInput, checkBrainFirst: !analysisInput.checkBrainFirst })}
                    role="switch"
                    aria-checked={analysisInput.checkBrainFirst}
                  ><span className="toggle-knob" /></button>
                </label>
                <label className="toggle-row">
                  <div className="toggle-content">
                    <span className="toggle-label">Save to Brain</span>
                    <span className="toggle-hint">Persist this analysis for future sessions</span>
                  </div>
                  <button
                    type="button"
                    className={`toggle-switch ${analysisInput.saveToBrain ? 'active' : ''}`}
                    onClick={() => setAnalysisInput({ ...analysisInput, saveToBrain: !analysisInput.saveToBrain })}
                    role="switch"
                    aria-checked={analysisInput.saveToBrain}
                  ><span className="toggle-knob" /></button>
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
