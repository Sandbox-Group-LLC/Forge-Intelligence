import { useState, useEffect, useRef } from 'react';
import { AppShell } from '../layouts/AppShell';
import './ContentGeneratorPage.css';

const ShieldCheck = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>
  </svg>
);
const FileText = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
  </svg>
);
const Zap = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

interface Brain { id: string; brandName: string; brandUrl: string; }
interface EnrichedBrief { id: string; brandName: string; confidenceScore: number; createdAt: string; }

interface ArticleSection {
  id: string;
  heading: string;
  body: string;
  confidence: number;
  confidenceTier: 'green' | 'yellow' | 'red';
  confidenceReason: string;
  eeatInjections: string[];
  smeHooks: string[];
}

interface GeneratedArticle {
  title: string;
  metaDescription: string;
  estimatedReadTime: string;
  overallConfidence: number;
  sections: ArticleSection[];
  authorBlock: { suggestedByline: string; schemaMarkup: object };
  citationOpportunities: string[];
  brainMatchScore: number;
}

function ContentGeneratorContent() {
  const [brains, setBrains] = useState<Brain[]>([]);
  const [briefs, setBriefs] = useState<EnrichedBrief[]>([]);
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [selectedBriefId, setSelectedBriefId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [article, setArticle] = useState<GeneratedArticle | null>(null);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'article' | 'meta' | 'schema'>('article');
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch('/api/context-hub/brains').then(r => r.json()).then(d => { if (d.success) setBrains(d.data); });
  }, []);

  useEffect(() => {
    if (!selectedBrainId) { setBriefs([]); setSelectedBriefId(''); return; }
    fetch(`/api/authenticity-enricher/briefs?brandProfileId=${selectedBrainId}`)
      .then(r => r.json())
      .then(d => { if (d.success) setBriefs(d.data); });
  }, [selectedBrainId]);

  const runGeneration = () => {
    if (!selectedBrainId) return;
    setIsRunning(true);
    setStreamText('');
    setArticle(null);
    setError('');

    const es = new EventSource(
      `/api/content-generator/generate?brandProfileId=${selectedBrainId}${selectedBriefId ? `&enrichedBriefId=${selectedBriefId}` : ''}`
    );
    streamRef.current = es;

    es.addEventListener('chunk', (e) => {
      setStreamText(prev => prev + e.data);
    });

    es.addEventListener('done', (e) => {
      es.close();
      setIsRunning(false);
      try {
        const parsed = JSON.parse(e.data);
        setArticle(parsed);
        setStreamText('');
      } catch {
        setError('Failed to parse generated article. Raw output preserved.');
        setStreamText(prev => prev || e.data);
      }
    });

    es.addEventListener('error', (e: any) => {
      es.close();
      setIsRunning(false);
      setError(e.data || 'Generation failed. Check server logs.');
    });
  };

  const tierColor = (tier: string) => {
    if (tier === 'green') return '#10B981';
    if (tier === 'yellow') return '#F5B942';
    return '#EF4444';
  };

  const tierLabel = (tier: string) => {
    if (tier === 'green') return '🟢';
    if (tier === 'yellow') return '🟡';
    return '🔴';
  };

  return (
    <div className="geo-content">
      <div className="geo-header">
        <div>
          <div className="geo-eyebrow">Stage 4</div>
          <h1 className="geo-title">Content Generator</h1>
          <p className="geo-description">
            Transforms your Enriched Brief into a Brain-matched, GEO-optimized long-form article with per-section confidence scoring.
          </p>
        </div>
        {article && (
          <div className="geo-score-badge">
            <div className="score-value">{article.overallConfidence}</div>
            <div className="score-label">Confidence</div>
          </div>
        )}
      </div>

      {!isRunning && !article && (
        <div className="geo-input-bar">
          <div className="geo-select-wrap" style={{ flex: 1 }}>
            <select className="geo-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
              <option value="">Select a Brain...</option>
              {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
            </select>
          </div>
          {briefs.length > 0 && (
            <div className="geo-select-wrap" style={{ flex: 1 }}>
              <select className="geo-select" value={selectedBriefId} onChange={e => setSelectedBriefId(e.target.value)}>
                <option value="">Latest Enriched Brief (default)</option>
                {briefs.map(b => <option key={b.id} value={b.id}>{b.brandName} — {new Date(b.createdAt).toLocaleDateString()} (confidence: {b.confidenceScore})</option>)}
              </select>
            </div>
          )}
          <button className="geo-run-btn" onClick={runGeneration} disabled={!selectedBrainId}>
            <FileText size={14} /> Generate Article
          </button>
        </div>
      )}

      {isRunning && (
        <div className="geo-running">
          <div className="cg-stream-header">
            <Zap size={14} />
            <span>Generating — Brain is writing...</span>
          </div>
          <div className="cg-stream-body">
            {streamText || <span className="cg-stream-cursor">▋</span>}
          </div>
        </div>
      )}

      {error && <div className="geo-error">{error}</div>}

      {article && !isRunning && (
        <>
          <div className="cg-meta-bar">
            <span className="cg-meta-item"><FileText size={12} /> {article.estimatedReadTime}</span>
            <span className="cg-meta-item" style={{ color: '#10B981' }}>Brain Match: {article.brainMatchScore}/100</span>
            <span className="cg-meta-item">{article.citationOpportunities?.length || 0} citations needed</span>
            <div className="cg-tabs">
              {(['article', 'meta', 'schema'] as const).map(tab => (
                <button key={tab} className={`cg-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'article' && (
            <div className="cg-article">
              <h2 className="cg-article-title">{article.title}</h2>
              {article.sections?.map(section => (
                <div key={section.id} className="cg-section" style={{ borderLeftColor: tierColor(section.confidenceTier) }}>
                  <div className="cg-section-header">
                    {section.heading && <h3 className="cg-section-heading">{section.heading}</h3>}
                    <div className="cg-confidence-badge" style={{ background: tierColor(section.confidenceTier) + '22', color: tierColor(section.confidenceTier) }}>
                      {tierLabel(section.confidenceTier)} {section.confidence}% — {section.confidenceReason}
                    </div>
                  </div>
                  <p className="cg-section-body">{section.body}</p>
                  {section.eeatInjections?.length > 0 && (
                    <div className="cg-injections">
                      <span className="cg-injection-label">E-E-A-T:</span>
                      {section.eeatInjections.map((inj, i) => <span key={i} className="cg-injection-tag">{inj}</span>)}
                    </div>
                  )}
                  {section.smeHooks?.length > 0 && (
                    <div className="cg-sme-hooks">
                      {section.smeHooks.map((hook, i) => <div key={i} className="cg-sme-hook">💬 {hook}</div>)}
                    </div>
                  )}
                </div>
              ))}
              {article.authorBlock && (
                <div className="cg-author-block">
                  <ShieldCheck size={14} /> {article.authorBlock.suggestedByline}
                </div>
              )}
            </div>
          )}

          {activeTab === 'meta' && (
            <div className="cg-panel">
              <div className="cg-panel-row"><span>Meta Description</span><p>{article.metaDescription}</p></div>
              {article.citationOpportunities?.length > 0 && (
                <div className="cg-panel-row">
                  <span>Citation Opportunities</span>
                  <ul>{article.citationOpportunities.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}
            </div>
          )}

          {activeTab === 'schema' && (
            <div className="cg-panel">
              <pre className="cg-schema-pre">{JSON.stringify(article.authorBlock?.schemaMarkup || {}, null, 2)}</pre>
            </div>
          )}

          <div className="cg-action-bar">
            <button className="geo-run-btn" onClick={() => { setArticle(null); setStreamText(''); }}>
              <FileText size={14} /> Generate Again
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ContentGeneratorPage() {
  return <AppShell><ContentGeneratorContent /></AppShell>;
}
