import { useApp } from '../../context/AppContext';
import './Strategy.css';

// Lucide-style icons
const icons = {
  compass: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
    </svg>
  ),
  download: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" x2="12" y1="15" y2="3"/>
    </svg>
  )
};

export function Strategy() {
  const { brandProfile } = useApp();

  if (!brandProfile) {
    return (
      <div className="strategy empty-state">
        <div className="empty-icon">{icons.compass}</div>
        <h2 className="empty-title">No Strategy Available</h2>
        <p className="empty-description">
          Complete a brand analysis to generate strategic recommendations.
        </p>
      </div>
    );
  }

  const getImpactLabel = (impact: string) => {
    switch (impact) {
      case 'high': return 'High Impact';
      case 'medium': return 'Medium Impact';
      case 'low': return 'Low Impact';
      default: return impact;
    }
  };

  const getEffortLabel = (effort: string) => {
    switch (effort) {
      case 'high': return 'High Effort';
      case 'medium': return 'Medium Effort';
      case 'low': return 'Low Effort';
      default: return effort;
    }
  };

  // Group recommendations by category
  const groupedRecs = brandProfile.strategicRecommendations.reduce((acc, rec) => {
    if (!acc[rec.category]) acc[rec.category] = [];
    acc[rec.category].push(rec);
    return acc;
  }, {} as Record<string, typeof brandProfile.strategicRecommendations>);

  // Derive messaging opportunities from real brand data — competitive gaps + tone attributes
  const messagingOpportunities = [
    ...(brandProfile.competitiveGaps || [])
      .filter(g => g.priority === 'high' && !g.ownedBy)
      .slice(0, 2)
      .map(g => ({
        theme: g.topic,
        description: g.whitespaceOpportunity,
        source: 'Competitive Whitespace'
      })),
    ...(brandProfile.voiceProfile?.toneAttributes || [])
      .sort((a, b) => b.score - a.score)
      .slice(0, 1)
      .map(attr => ({
        theme: `Lead with ${attr.attribute}`,
        description: attr.description,
        source: `Tone Attribute: ${attr.attribute} (${attr.score}/100)`
      }))
  ].slice(0, 3);

  // Content themes from competitive gaps and key phrases
  const contentThemes = [
    ...(brandProfile.competitiveGaps || []).map(g => g.topic),
    ...(brandProfile.voiceProfile?.keyPhrases || []).slice(0, 2)
  ].filter(Boolean).slice(0, 5);

  // Next actions derived from high-impact recommendations
  const nextActions = (brandProfile.strategicRecommendations || [])
    .filter(r => r.impact === 'high')
    .slice(0, 4)
    .map(r => ({ action: r.title, priority: r.impact, description: r.description }));

  return (
    <div className="strategy">
      <div className="strategy-header">
        <div className="header-info">
          <h2 className="view-title">Strategic Recommendations</h2>
          <p className="view-description">
            Actionable insights derived from the {brandProfile.brandName} brand intelligence profile
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#334155', lineHeight: 1, boxSizing: 'border-box', fontFamily: 'inherit', cursor: 'default' }} disabled>
            {brandProfile.strategicRecommendations.length} Recommendations
          </button>
          <button onClick={() => { const blob = new Blob([JSON.stringify(brandProfile, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${brandProfile.brandName || 'strategy'}-brief.json`; a.click(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            {icons.download} Export Brief
          </button>
          <button onClick={() => { window.location.href = '/app/geo-strategist'; }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#4F46E5', color: '#fff', border: '1px solid #4F46E5', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Run GEO Strategy →
          </button>
        </div>
      </div>

      {/* Priority Matrix */}
      <section className="strategy-section">
        <h3 className="section-label">PRIORITY MATRIX</h3>
        <div className="priority-matrix">
          {brandProfile.strategicRecommendations.map((rec) => (
            <div 
              key={rec.id} 
              className={`matrix-card impact-${rec.impact} effort-${rec.effort}`}
            >
              <div className="matrix-header">
                <span className="rec-category">{rec.category}</span>
                <div className="matrix-badges">
                  <span className={`impact-badge ${rec.impact}`}>
                    {getImpactLabel(rec.impact)}
                  </span>
                  <span className={`effort-badge ${rec.effort}`}>
                    {getEffortLabel(rec.effort)}
                  </span>
                </div>
              </div>
              <h4 className="rec-title">{rec.title}</h4>
              <p className="rec-description">{rec.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Messaging Opportunities — derived from competitive gaps + tone */}
      {messagingOpportunities.length > 0 && (
        <section className="strategy-section">
          <h3 className="section-label">MESSAGING OPPORTUNITIES</h3>
          <div className="messaging-grid">
            {messagingOpportunities.map((opp, idx) => (
              <div key={idx} className="messaging-card">
                <div className="messaging-source">{opp.source}</div>
                <h4 className="messaging-theme">{opp.theme}</h4>
                <p className="messaging-description">{opp.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Content Themes — from competitive gaps + key phrases */}
      {contentThemes.length > 0 && (
        <section className="strategy-section">
          <h3 className="section-label">SUGGESTED CONTENT THEMES</h3>
          <div className="content-themes">
            {contentThemes.map((theme, idx) => (
              <div key={idx} className="theme-item">
                <span className="theme-number">{String(idx + 1).padStart(2, '0')}</span>
                <span className="theme-text">{theme}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recommendations by Category */}
      <section className="strategy-section">
        <h3 className="section-label">RECOMMENDATIONS BY CATEGORY</h3>
        <div className="category-groups">
          {Object.entries(groupedRecs).map(([category, recs]) => (
            <div key={category} className="category-group">
              <h4 className="category-title">{category}</h4>
              <div className="category-recs">
                {recs.map((rec) => (
                  <div key={rec.id} className="category-rec-item">
                    <div className="rec-indicator"></div>
                    <div className="rec-content">
                      <span className="rec-item-title">{rec.title}</span>
                      <span className="rec-item-description">{rec.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Next Actions — high-impact recs only */}
      {nextActions.length > 0 && (
        <section className="strategy-section">
          <h3 className="section-label">RECOMMENDED NEXT ACTIONS</h3>
          <div className="actions-list">
            {nextActions.map((action, idx) => (
              <div key={idx} className={`action-item priority-${action.priority}`}>
                <div className="action-number">{idx + 1}</div>
                <div className="action-content">
                  <div className="action-header">
                    <span className="action-name">{action.action}</span>
                    <span className={`action-priority ${action.priority}`}>
                      {action.priority}
                    </span>
                  </div>
                  <p className="action-description">{action.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}


    </div>
  );
}
