import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import './BrandProfile.css';

// Lucide-style icons
const icons = {
  layers: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  ),
  download: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" x2="12" y1="15" y2="3"/>
    </svg>
  ),
  zap: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  save: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>
  )
};

type TabType = 'voice' | 'personas' | 'signals' | 'gaps';

export function BrandProfile() {
  const { brandProfile } = useApp();
  const [activeTab, setActiveTab] = useState<TabType>('voice');

  if (!brandProfile) {
    return (
      <div className="brand-profile empty-state">
        <div className="empty-icon">{icons.layers}</div>
        <h2 className="empty-title">No Brand Profile Available</h2>
        <p className="empty-description">
          Run a new analysis to generate a brand intelligence profile.
        </p>
      </div>
    );
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleExportJSON = () => {
    const dataStr = JSON.stringify(brandProfile, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${brandProfile.brandName.toLowerCase().replace(/\s+/g, '-')}-profile.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return 'var(--color-success)';
    if (score >= 80) return 'var(--color-accent)';
    if (score >= 70) return 'rgba(59, 130, 246, 0.7)';
    return 'var(--color-warning)';
  };

  return (
    <div className="brand-profile view-shell-centered">
      <div className="profile-header">
        <div className="profile-info">
          <h2 className="profile-brand-name">{brandProfile.brandName}</h2>
          <div className="profile-meta">
            <span className="meta-item">
              <span className="meta-label">Profile ID:</span>
              <span className="meta-value">{brandProfile.id}</span>
            </span>
            <span className="meta-divider">·</span>
            <span className="meta-item">
              <span className="meta-label">Version:</span>
              <span className="meta-value">{brandProfile.version}</span>
            </span>
            <span className="meta-divider">·</span>
            <span className="meta-item">
              <span className="meta-label">Updated:</span>
              <span className="meta-value">{formatDate(brandProfile.updatedAt)}</span>
            </span>
          </div>
        </div>
        <div className="profile-actions">
          <button className="btn-action" onClick={handleExportJSON}>
            <span className="btn-icon">{icons.download}</span>
            Export JSON
          </button>
          <button className="btn-action primary">
            <span className="btn-icon">{icons.save}</span>
            Save Version
          </button>
          <a
            href={`/geo-strategist?profileId=${brandProfile.id}`}
            className="btn-action geo-cta"
          >
            <span className="btn-icon">{icons.zap}</span>
            Run GEO Strategy →
          </a>
        </div>
      </div>

      <div className="profile-tabs">
        <button
          className={`tab-button ${activeTab === 'voice' ? 'active' : ''}`}
          onClick={() => setActiveTab('voice')}
        >
          Voice Profile
        </button>
        <button
          className={`tab-button ${activeTab === 'personas' ? 'active' : ''}`}
          onClick={() => setActiveTab('personas')}
        >
          Brand Personas
        </button>
        <button
          className={`tab-button ${activeTab === 'signals' ? 'active' : ''}`}
          onClick={() => setActiveTab('signals')}
        >
          Signal Summary
        </button>
        <button
          className={`tab-button ${activeTab === 'gaps' ? 'active' : ''}`}
          onClick={() => setActiveTab('gaps')}
        >
          Competitive Whitespace
        </button>
      </div>

      <div className="profile-content">
        {activeTab === 'voice' && (
          <div className="tab-content voice-content">
            <div className="voice-summary-card">
              <h3 className="card-title">Voice Summary</h3>
              <p className="voice-summary-text">{brandProfile.voiceProfile.summary}</p>
            </div>

            <div className="tone-attributes">
              <h3 className="section-label">TONE ATTRIBUTES</h3>
              <div className="attributes-grid">
                {brandProfile.voiceProfile.toneAttributes.map((attr) => (
                  <div key={attr.attribute} className="attribute-card">
                    <div className="attribute-header">
                      <span className="attribute-name">{attr.attribute}</span>
                      <span className="attribute-score" style={{ color: getScoreColor(attr.score) }}>{attr.score}</span>
                    </div>
                    <div className="attribute-bar">
                      <div 
                        className="attribute-fill" 
                        style={{ 
                          width: `${attr.score}%`,
                          background: getScoreColor(attr.score)
                        }}
                      />
                    </div>
                    <p className="attribute-description">{attr.description}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="writing-style-card">
              <h3 className="card-title">Writing Style</h3>
              <p className="writing-style-text">{brandProfile.voiceProfile.writingStyle}</p>
            </div>

            <div className="key-phrases-card">
              <h3 className="card-title">Key Phrases</h3>
              <div className="phrases-list">
                {brandProfile.voiceProfile.keyPhrases.map((phrase) => (
                  <span key={phrase} className="phrase-tag">{phrase}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'personas' && (
          <div className="tab-content personas-content">
            <div className="personas-grid">
              {brandProfile.personas.map((persona) => (
                <div key={persona.id} className="persona-card">
                  <div className="persona-header">
                    <h3 className="persona-name">{persona.name}</h3>
                    <span className="persona-role">{persona.role}</span>
                  </div>
                  
                  <div className="persona-section">
                    <h4 className="persona-section-title">Pain Points</h4>
                    <ul className="persona-list">
                      {persona.painPoints.map((point, idx) => (
                        <li key={idx}>{point}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="persona-section">
                    <h4 className="persona-section-title">Triggers</h4>
                    <ul className="persona-list">
                      {persona.triggers.map((trigger, idx) => (
                        <li key={idx}>{trigger}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="persona-section">
                    <h4 className="persona-section-title">Skepticism</h4>
                    <p className="persona-text">{persona.skepticism}</p>
                  </div>

                  <div className="persona-section">
                    <h4 className="persona-section-title">Motivations</h4>
                    <ul className="persona-list">
                      {persona.motivations.map((motivation, idx) => (
                        <li key={idx}>{motivation}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'signals' && (
          <div className="tab-content signals-content">
            <div className="signals-table">
              <div className="table-header">
                <span className="th-source">Source</span>
                <span className="th-type">Signal Type</span>
                <span className="th-value">Value</span>
                <span className="th-confidence">Confidence</span>
              </div>
              {brandProfile.thirdPartySignals.map((signal, idx) => (
                <div key={idx} className="table-row">
                  <span className="td-source">{signal.source}</span>
                  <span className="td-type">{signal.signalType}</span>
                  <span className={`td-value ${signal.value ? '' : 'null'}`}>
                    {signal.value || 'No data'}
                  </span>
                  <span className="td-confidence">
                    {signal.confidence > 0 ? (
                      <div className="confidence-indicator">
                        <div 
                          className="confidence-fill" 
                          style={{ 
                            width: `${signal.confidence}%`,
                            background: getScoreColor(signal.confidence)
                          }}
                        />
                        <span className="confidence-text">{signal.confidence}%</span>
                      </div>
                    ) : (
                      <span className="no-confidence">—</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <p className="signals-note">
              Third-party signals are gathered from public sources and may vary in accuracy. 
              Last checked: {formatDate(brandProfile.thirdPartySignals[0]?.lastChecked || brandProfile.updatedAt)}
            </p>
          </div>
        )}

        {activeTab === 'gaps' && (
          <div className="tab-content gaps-content">
            <div className="gaps-grid">
              {brandProfile.competitiveGaps.map((gap, idx) => (
                <div key={idx} className={`gap-card priority-${gap.priority}`}>
                  <div className="gap-header">
                    <span className={`priority-badge ${gap.priority}`}>
                      {gap.priority} priority
                    </span>
                  </div>
                  <h3 className="gap-topic">{gap.topic}</h3>
                  <div className="gap-ownership">
                    <span className="ownership-label">Currently owned by:</span>
                    <span className={`ownership-value ${gap.ownedBy ? '' : 'unclaimed'}`}>
                      {gap.ownedBy || 'Unclaimed'}
                    </span>
                  </div>
                  <p className="gap-opportunity">{gap.whitespaceOpportunity}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
