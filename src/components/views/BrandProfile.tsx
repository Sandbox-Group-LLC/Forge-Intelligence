import { useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { BuildWithLovableButton } from '../BuildWithLovableButton';
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

type TabType = 'facts' | 'voice' | 'personas' | 'signals' | 'gaps';

// Recognized vendor names get pill-styled inline within the ownership footer
// caption. The list covers the major cloud/SaaS players that show up in
// competitiveGaps.ownedBy strings. Match is case-insensitive, longest-first
// so 'Microsoft Azure' matches before 'Microsoft' or 'Azure' alone.
const KNOWN_VENDORS = [
  'Microsoft Azure', 'Google Cloud', 'Amazon Web Services',
  'Salesforce', 'HubSpot', 'Marketo', 'Adobe',
  'AWS', 'Azure', 'GCP', 'IBM', 'Oracle', 'SAP',
  'ServiceNow', 'Workday', 'Snowflake', 'Databricks',
  'Anthropic', 'OpenAI', 'Cohere', 'Mistral',
  'Stripe', 'Shopify', 'Square', 'PayPal',
  'Notion', 'Linear', 'Asana', 'Monday', 'ClickUp',
].sort((a, b) => b.length - a.length); // longest-first for greedy match

function renderOwnedBy(text: string): React.ReactNode {
  // Split the text on vendor names (case-insensitive), wrap matches in pills,
  // leave non-matches as plain text. Preserves parenthetical context like
  // 'Azure (Azure for Healthcare)' as 'azure-pill (Azure for Healthcare)'.
  const pattern = new RegExp(`\\b(${KNOWN_VENDORS.map(v => v.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})\\b`, 'gi');
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(<span key={key++}>{text.slice(lastIdx, match.index)}</span>);
    }
    parts.push(<span key={key++} className="vendor-pill">{match[0]}</span>);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  }
  return parts.length > 0 ? parts : text;
}

export function BrandProfile() {
  const { brandProfile, setBrandProfile, setCurrentView } = useApp();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>('facts');
  const [reanalyzing, setReanalyzing] = useState(false);

  const handleReanalyze = useCallback(async () => {
    if (!brandProfile?.brandUrl || reanalyzing) return;
    setReanalyzing(true);
    try {
      const token = await getToken();
      const r = await fetch('/api/context-hub/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          brandUrl: brandProfile.brandUrl,
          competitorUrls: [],
          audienceNotes: '',
          strategicNotes: '',
          checkBrainFirst: false,
          saveToBrain: true,
        }),
      });
      const d = await r.json();
      if (d.success && d.data) {
        setBrandProfile(d.data);
      }
    } catch (e) { console.error('Re-analyze failed:', e); }
    setReanalyzing(false);
  }, [brandProfile?.brandUrl, reanalyzing, setBrandProfile]);

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

  const formatDate = (dateString: string | null | undefined) => {
    // Defensive — if for any reason the timestamp is missing or unparseable,
    // fall back to a friendly em-dash instead of showing 'Invalid Date'.
    if (!dateString) return '—';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
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

  // Empty-state guard — if the brand profile has no analysis data (freshly wiped brain, new brand
  // that hasn't been scanned, or data migration in progress), render a CTA instead of crashing on
  // brandProfile.voiceProfile.toneAttributes.map(...) etc. below.
  const hasAnalysisData = brandProfile && brandProfile.voiceProfile && Array.isArray(brandProfile.personas);
  if (!brandProfile || !hasAnalysisData) {
    return (
      <div className="brand-profile" style={{ padding: 48, textAlign: 'center' }}>
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 12, color: 'var(--color-text-primary)' }}>
            {brandProfile?.brandName ? `${brandProfile.brandName}'s Brain is empty` : 'No brand intelligence yet'}
          </h2>
          <p style={{ fontSize: '0.95rem', color: 'var(--color-text-secondary, #64748B)', lineHeight: 1.6, marginBottom: 24 }}>
            {brandProfile?.brandName
              ? `This Brain hasn't been analyzed yet or was recently reset. Run Context Hub to rebuild the intelligence profile.`
              : 'Select a brand from the sidebar or run a new analysis to get started.'}
          </p>
          <button
            onClick={() => setCurrentView('new-analysis')}
            style={{ padding: '10px 20px', background: 'var(--color-accent, #3563FF)', color: '#fff', border: 'none', borderRadius: 8, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Run new analysis
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="brand-profile">
      <div className="profile-header">
        <div className="profile-info">
          <h2 className="profile-brand-name">{brandProfile.brandName}</h2>
          <div className="profile-meta">
            <span className="meta-item">
              <span className="meta-label">URL:</span>
              <a className="meta-value" href={brandProfile.brandUrl} target="_blank" rel="noopener noreferrer" style={{color:'var(--color-accent)',textDecoration:'none'}}>{brandProfile.brandUrl.replace(/^https?:\/\//, '')}</a>
            </span>
            <span className="meta-divider">·</span>
            <span className="meta-item">
              <span className="meta-label">Version:</span>
              <span className="meta-value">{brandProfile.version}</span>
            </span>
            <span className="meta-divider">·</span>
            <span className="meta-item">
              <span className="meta-label">Updated:</span>
              <span className="meta-value">{formatDate(brandProfile.updatedAt || brandProfile.createdAt)}</span>
            </span>
          </div>
        </div>
        <div className="profile-actions-wrap" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="profile-action-btn" onClick={handleReanalyze} disabled={reanalyzing} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            <span className="btn-icon-decorative"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></span>
            {reanalyzing ? 'Re-analyzing...' : 'Re-analyze'}
          </button>
          <button className="profile-action-btn" onClick={handleExportJSON} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            <span className="btn-icon-decorative">{icons.download}</span> Export JSON
          </button>
          <button className="profile-action-btn" onClick={() => setCurrentView('strategy')} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            Strategy Brief →
          </button>
          <button className="profile-action-btn profile-action-btn-primary" onClick={() => { window.location.href = `/app/geo-strategist?profileId=${brandProfile.id}`; }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#4F46E5', color: '#fff', border: '1px solid #4F46E5', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            <span className="btn-icon-decorative">{icons.zap}</span> Run GEO Strategy →
          </button>
        </div>
      </div>

      <BuildWithLovableButton
        brandProfileId={brandProfile.id}
        brandName={brandProfile.brandName}
        disabled={!brandProfile.voiceProfile || !brandProfile.voiceProfile.summary}
      />

      {brandProfile.scraperSuccess === false && (
        <div style={{ padding: '14px 20px', marginBottom: 16, background: '#FFF7ED', border: '1px solid #FDBA74', borderRadius: 10, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#92400E', marginBottom: 4 }}>Limited website access</div>
            <div style={{ fontSize: 12, color: '#B45309', lineHeight: 1.5 }}>
              We couldn't scrape your website content — it may be behind bot protection (Cloudflare, Akamai, etc.). This profile was built from search context only and may be less accurate.
              Use <strong>Re-analyze</strong> to retry, or provide additional context via the <strong>Audience Notes</strong> and <strong>Strategic Notes</strong> fields on the New Analysis page.
            </div>
          </div>
        </div>
      )}

      <div className="profile-tabs">
        <button
          className={`tab-button ${activeTab === 'facts' ? 'active' : ''}`}
          onClick={() => setActiveTab('facts')}
        >
          Brand Facts
        </button>
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
        {activeTab === 'facts' && (
          <div className="tab-content facts-content">
            <div className="facts-intro-banner">
              <div>
                <div className="facts-intro-eyebrow">Double-check what Forge learned</div>
                <div className="facts-intro-text">
                  Anything wrong here?  Correct it in <strong>Factual Ground</strong> — then re-run the analysis. Forge will use your corrections everywhere else: topics, articles, compliance, brand intelligence.
                </div>
              </div>
              <button
                className="facts-intro-btn"
                onClick={() => navigate('/app/brand-settings')}
                title="Edit Factual Ground for this brand"
              >
                Correct these? →
              </button>
            </div>

            <div className="facts-card">
              <h3 className="card-title">What Forge thinks you do</h3>
              <p className="facts-body">
                {brandProfile.businessProfile?.whatTheyDo || <em className="facts-muted">No business summary captured — this brand may have been scanned before this field was added. Run a new analysis to produce one.</em>}
              </p>
            </div>

            <div className="facts-grid">
              <div className="facts-card">
                <h3 className="section-label">MARKET CATEGORY</h3>
                <p className="facts-body-sm">{brandProfile.marketCategory || <em className="facts-muted">—</em>}</p>
              </div>
              <div className="facts-card">
                <h3 className="section-label">TARGET BUYER</h3>
                <p className="facts-body-sm">{brandProfile.businessProfile?.targetBuyer || <em className="facts-muted">—</em>}</p>
              </div>
              <div className="facts-card">
                <h3 className="section-label">GEOGRAPHY</h3>
                <p className="facts-body-sm">{brandProfile.businessProfile?.geography || <em className="facts-muted">—</em>}</p>
              </div>
              <div className="facts-card">
                <h3 className="section-label">COMPANY SCALE</h3>
                <p className="facts-body-sm">{brandProfile.businessProfile?.companyScale || <em className="facts-muted">—</em>}</p>
              </div>
              <div className="facts-card">
                <h3 className="section-label">REVENUE MODEL</h3>
                <p className="facts-body-sm">{brandProfile.businessProfile?.revenueModel || <em className="facts-muted">—</em>}</p>
              </div>
            </div>

            {Array.isArray(brandProfile.businessProfile?.productsOrServices) && brandProfile.businessProfile.productsOrServices.length > 0 && (
              <div className="facts-card">
                <h3 className="card-title">Products & services</h3>
                <ul className="facts-list">
                  {brandProfile.businessProfile.productsOrServices.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="facts-card">
              <h3 className="card-title">Who Forge thinks you compete with</h3>
              {Array.isArray(brandProfile.discoveredCompetitors) && brandProfile.discoveredCompetitors.length > 0 ? (
                <ul className="facts-competitor-list">
                  {brandProfile.discoveredCompetitors.map((c, i) => {
                    const url = typeof c === 'string' ? c : '';
                    const label = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
                    return (
                      <li key={i}>
                        {url.startsWith('http') ? (
                          <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
                        ) : (
                          <span>{label || c}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="facts-muted"><em>No competitors discovered yet. If you know your competitors, add them in Factual Ground.</em></p>
              )}
              <p className="facts-footnote">
                If any of these are wrong, fix them in Factual Ground's Competitors field. Forge uses that list for everything downstream.
              </p>
            </div>
          </div>
        )}

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
              {brandProfile.thirdPartySignals.filter(s => s.value !== null && s.confidence > 0).map((signal, idx) => (
                <div key={idx} className="table-row">
                  <span className="td-source">{signal.source}</span>
                  <span className="td-type">{signal.signalType}</span>
                  <span className={`td-value ${signal.value ? '' : 'null'}`}>
                    {signal.value || 'No data'}
                  </span>
                  <span className="td-confidence">
                    {signal.confidence > 0 ? (
                      <div className="confidence-indicator">
                          <div className="confidence-bar-track">
                            <div
                              className="confidence-fill"
                              style={{
                                width: `${signal.confidence}%`,
                                background: getScoreColor(signal.confidence)
                              }}
                            />
                          </div>
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
                  <p className="gap-opportunity">{gap.whitespaceOpportunity}</p>
                  {gap.ownedBy ? (
                    <div className="gap-ownership-footer">
                      <span className="gap-ownership-caption">Currently held by</span>
                      <span className="gap-ownership-text">{renderOwnedBy(gap.ownedBy)}</span>
                    </div>
                  ) : (
                    <div className="gap-ownership-footer unclaimed">
                      <span className="gap-ownership-caption">Status</span>
                      <span className="gap-ownership-text">Unclaimed whitespace</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
