import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import './NewAnalysis.css';

// Lucide-style icons
const icons = {
  plus: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14"/>
      <path d="M12 5v14"/>
    </svg>
  ),
  x: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18"/>
      <path d="m6 6 12 12"/>
    </svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ),
  fileText: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" x2="8" y1="13" y2="13"/>
      <line x1="16" x2="8" y1="17" y2="17"/>
      <line x1="10" x2="8" y1="9" y2="9"/>
    </svg>
  )
};

export function NewAnalysis() {
  const { analysisInput, setAnalysisInput, startAnalysis, loadSampleData } = useApp();
  const [competitorInput, setCompetitorInput] = useState('');

  const handleAddCompetitor = () => {
    if (competitorInput.trim() && !analysisInput.competitorUrls.includes(competitorInput.trim())) {
      setAnalysisInput({
        ...analysisInput,
        competitorUrls: [...analysisInput.competitorUrls, competitorInput.trim()]
      });
      setCompetitorInput('');
    }
  };

  const handleRemoveCompetitor = (url: string) => {
    setAnalysisInput({
      ...analysisInput,
      competitorUrls: analysisInput.competitorUrls.filter(u => u !== url)
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCompetitor();
    }
  };

  const canSubmit = analysisInput.brandUrl.trim().length > 0;

  return (
    <div className="new-analysis view-shell-centered">
      <div className="view-header">
        <h2 className="view-title">Start a New Analysis</h2>
        <p className="view-description">
          Enter your brand details and the Context Agent will generate a comprehensive intelligence profile.
        </p>
      </div>

      <div className="analysis-form">
        <div className="form-section">
          <div className="form-group">
            <label className="form-label">
              Brand URL
              <span className="required">*</span>
            </label>
            <input
              type="url"
              className="form-input"
              placeholder="https://your-brand.com"
              value={analysisInput.brandUrl}
              onChange={(e) => setAnalysisInput({ ...analysisInput, brandUrl: e.target.value })}
            />
            <span className="form-hint">The primary website we'll analyze for brand signals</span>
          </div>

          <div className="form-group">
            <label className="form-label">Competitor URLs</label>
            <div className="competitor-input-row">
              <input
                type="url"
                className="form-input"
                placeholder="https://competitor.com"
                value={competitorInput}
                onChange={(e) => setCompetitorInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                className="btn-add"
                onClick={handleAddCompetitor}
                disabled={!competitorInput.trim()}
              >
                <span className="btn-icon">{icons.plus}</span>
                Add
              </button>
            </div>
            {analysisInput.competitorUrls.length > 0 && (
              <div className="competitor-tags">
                {analysisInput.competitorUrls.map((url) => (
                  <span key={url} className="competitor-tag">
                    {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    <button
                      type="button"
                      className="tag-remove"
                      onClick={() => handleRemoveCompetitor(url)}
                      aria-label={`Remove ${url}`}
                    >
                      {icons.x}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <span className="form-hint">Add competitor sites for comparative analysis</span>
          </div>
        </div>

        <div className="form-section">
          <div className="form-group">
            <label className="form-label">Audience / ICP Notes</label>
            <textarea
              className="form-textarea"
              placeholder="Describe your ideal customer profile, target segments, or audience characteristics..."
              rows={4}
              value={analysisInput.audienceNotes}
              onChange={(e) => setAnalysisInput({ ...analysisInput, audienceNotes: e.target.value })}
            />
            <span className="form-hint">Optional context about who you're trying to reach</span>
          </div>

          <div className="form-group">
            <label className="form-label">Strategic Notes</label>
            <textarea
              className="form-textarea"
              placeholder="Any specific positioning goals, messaging challenges, or strategic context..."
              rows={4}
              value={analysisInput.strategicNotes}
              onChange={(e) => setAnalysisInput({ ...analysisInput, strategicNotes: e.target.value })}
            />
            <span className="form-hint">Optional guidance to focus the analysis</span>
          </div>
        </div>

        <div className="form-section">
          <div className="toggle-group">
            <label className="toggle-row">
              <div className="toggle-content">
                <span className="toggle-label">Check Brain first</span>
                <span className="toggle-hint">Look for existing profile before running fresh analysis</span>
              </div>
              <button
                type="button"
                className={`toggle-switch ${analysisInput.checkBrainFirst ? 'active' : ''}`}
                onClick={() => setAnalysisInput({ ...analysisInput, checkBrainFirst: !analysisInput.checkBrainFirst })}
                role="switch"
                aria-checked={analysisInput.checkBrainFirst}
              >
                <span className="toggle-knob" />
              </button>
            </label>

            <label className="toggle-row">
              <div className="toggle-content">
                <span className="toggle-label">Save results to Brain</span>
                <span className="toggle-hint">Store this analysis for future reference and iteration</span>
              </div>
              <button
                type="button"
                className={`toggle-switch ${analysisInput.saveToBrain ? 'active' : ''}`}
                onClick={() => setAnalysisInput({ ...analysisInput, saveToBrain: !analysisInput.saveToBrain })}
                role="switch"
                aria-checked={analysisInput.saveToBrain}
              >
                <span className="toggle-knob" />
              </button>
            </label>
          </div>
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={loadSampleData}
          >
            <span className="btn-icon">{icons.fileText}</span>
            Load Sample Brand
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={startAnalysis}
            disabled={!canSubmit}
          >
            <span className="btn-icon">{icons.play}</span>
            Run Context Analysis
          </button>
        </div>
      </div>
    </div>
  );
}
