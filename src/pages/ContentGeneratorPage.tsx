import { useState, useEffect, useRef } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
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


// ── Stream progress — shows section titles as they appear, hides raw JSON ────
function StreamProgress({ text }: { text: string }) {
  const headings = Array.from(text.matchAll(/"heading":\s*"([^"]{8,80})"/g))
    .map(m => m[1])
    .filter((h, i, arr) => arr.indexOf(h) === i); // dedupe

  if (!headings.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 0' }}>
        <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite', color: '#3563FF', fontSize: '20px' }}>▋</span>
        <span style={{ color: '#475569', fontSize: '13px' }}>Analyzing Brain context...</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ fontSize: '12px', color: '#475569', marginBottom: '4px' }}>
        Writing {headings.length} section{headings.length !== 1 ? 's' : ''}...
      </div>
      {headings.map((h, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ color: '#14B8A6', fontSize: '12px' }}>✓</span>
          <span style={{ fontSize: '13px', color: '#94A3B8' }}>{h}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite', color: '#3563FF', fontSize: '14px' }}>▋</span>
        <span style={{ fontSize: '13px', color: '#475569' }}>Writing next section...</span>
      </div>
    </div>
  );
}

function ContentGeneratorContent() {
  const [briefs, setBriefs] = useState<EnrichedBrief[]>([]);
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [selectedBriefId, setSelectedBriefId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [article, setArticle] = useState<GeneratedArticle | null>(null);
  const [articleImageUrl, setArticleImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'article' | 'meta' | 'schema'>('article');
  const streamRef = useRef<EventSource | null>(null);
  const [topicPrompt, setTopicPrompt] = useState('');
  const [ideaDrawerOpen, setIdeaDrawerOpen] = useState(false);
  const [ideas, setIdeas] = useState<{id:string;topic:string;note:string|null;status:string;created_at:string}[]>([]);
  const [newIdea, setNewIdea] = useState('');
  const [newIdeaNote, setNewIdeaNote] = useState('');
  const [savingIdea, setSavingIdea] = useState(false);
  const [preflight, setPreflight] = useState<{ status: string; signal?: string; confidence?: string; reframe?: string; reframeRationale?: string; reason?: string }>({ status: 'idle' });

  const { historyEntries, activeBrand, authToken } = useApp();
  const brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));

  // Seed selected brain from active brand context
  useEffect(() => {
    const id = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
    if (id) setSelectedBrainId(id);
  }, []);

  useEffect(() => {
    if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id);
  }, [activeBrand?.id]);

  useEffect(() => {
    if (!selectedBrainId) { setBriefs([]); setSelectedBriefId(''); return; }
    loadIdeas(selectedBrainId);
    fetch(`/api/authenticity-enricher/briefs?brandProfileId=${selectedBrainId}`, { headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {} })
      .then(r => r.json())
      .then(d => { if (d.success) setBriefs(d.data); });

    // Fetch most recent generated article for this brand
    if (!article && authToken) {
      fetch(`/api/compliance/latest/${selectedBrainId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
        .then(r => r.json())
        .then(d => {
          if (d.success && d.articles?.length > 0) {
            const latest = d.articles[0];
            const aj = typeof latest.article_json === 'string' ? JSON.parse(latest.article_json) : latest.article_json;
            if (aj?.title && aj?.sections?.length > 0) {
              setArticle(aj as GeneratedArticle);
              if (latest.hero_image_url) setArticleImageUrl(latest.hero_image_url);
            }
          }
        })
        .catch(() => {});
    }
  }, [selectedBrainId]);

  const checkTopic = async () => {
    if (!selectedBrainId || !topicPrompt.trim()) { setPreflight({ status: 'idle' }); return; }
    setPreflight({ status: 'checking' });
    try {
      const r = await fetch('/api/content/topic-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topic: topicPrompt })
      });
      const d = await r.json();
      if (d.success) setPreflight({ status: 'done', ...d });
      else setPreflight({ status: 'idle' });
    } catch { setPreflight({ status: 'idle' }); }
  };

  const loadIdeas = async (brandId: string) => {
    if (!brandId) return;
    const d = await fetch(`/api/topic-ideas/${brandId}`, { headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {} }).then(r => r.json());
    if (d.success) setIdeas(d.ideas);
  };

  const saveIdea = async () => {
    if (!newIdea.trim() || !selectedBrainId) return;
    setSavingIdea(true);
    try {
      const d = await fetch('/api/topic-ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topic: newIdea.trim(), note: newIdeaNote.trim() || null })
      }).then(r => r.json());
      if (d.success) { setIdeas(prev => [d.idea, ...prev]); setNewIdea(''); setNewIdeaNote(''); }
    } finally { setSavingIdea(false); }
  };

  const deleteIdea = async (id: string) => {
    await fetch(`/api/topic-ideas/${id}`, { method: 'DELETE' });
    setIdeas(prev => prev.filter(i => i.id !== id));
  };

  const useIdea = (idea: { id: string; topic: string }) => {
    setTopicPrompt(idea.topic);
    fetch(`/api/topic-ideas/${idea.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' })
    });
    setIdeas(prev => prev.map(i => i.id === idea.id ? { ...i, status: 'in_progress' } : i));
    setIdeaDrawerOpen(false);
    setTimeout(() => document.querySelector<HTMLElement>('.cg-topic-input')?.focus(), 150);
  };

  const runGeneration = () => {
    if (!selectedBrainId) return;
    setIsRunning(true);
    setStreamText('');
    setArticle(null);
    setArticleImageUrl(null);
    setImageLoading(true);
    setError('');

    const es = new EventSource(
      `/api/content-generator/generate?brandProfileId=${selectedBrainId}${selectedBriefId ? `&enrichedBriefId=${selectedBriefId}` : ''}${topicPrompt.trim() ? `&topicPrompt=${encodeURIComponent(topicPrompt.trim())}` : ''}&token=${authToken}`
    );
    streamRef.current = es;

    es.addEventListener('chunk', (e) => {
      setStreamText(prev => prev + e.data);
    });

    es.addEventListener('done', (e) => {
      setIsRunning(false);
      try {
        const parsed = JSON.parse(e.data);
        setArticle(parsed);
        setStreamText('');
        setImageLoading(true);
      } catch {
        es.close();
        setError('Failed to parse generated article. Raw output preserved.');
        setStreamText(prev => prev || e.data);
      }
    });
    es.addEventListener('image_done', (e) => {
      try { const d = JSON.parse(e.data); setArticleImageUrl(d.image_url); } catch {}
      setImageLoading(false);
      es.close();
    });
    es.addEventListener('image_error', () => {
      setImageLoading(false);
      es.close();
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="geo-input-bar">
            <div className="geo-select-wrap" style={{ flex: 1, minWidth: '220px' }}>
              <select className="geo-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
                <option value="">Select a Brain...</option>
                {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
              </select>
            </div>
            {briefs.length > 0 && (
              <div className="geo-select-wrap" style={{ flex: 1, minWidth: '220px' }}>
                <select className="geo-select" value={selectedBriefId} onChange={e => setSelectedBriefId(e.target.value)}>
                  <option value="">Latest Enriched Brief (default)</option>
                  {briefs.map(b => <option key={b.id} value={b.id}>{b.brandName} — {new Date(b.createdAt).toLocaleDateString()} (confidence: {b.confidenceScore})</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="geo-input-bar">
          <div style={{ flex: 1 }}>
            <input
              className="geo-input cg-topic-input" placeholder="Optional: direct the topic — e.g. 'Why neuroscience matters for event ROI'"
              value={topicPrompt}
              onChange={e => { setTopicPrompt(e.target.value); setPreflight({ status: 'idle' }); }}
              onBlur={checkTopic}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            {preflight.status === 'checking' && (
              <div className="cg-preflight-checking">Brain checking topic alignment...</div>
            )}
            {preflight.status === 'done' && (
              <div className={`cg-preflight cg-preflight-${preflight.signal}`}>
                <div className="cg-preflight-header">
                  <span className="cg-preflight-icon">{preflight.signal === 'strong' ? '✓' : preflight.signal === 'caution' ? '⚠' : '✕'}</span>
                  <span className="cg-preflight-confidence">{preflight.confidence}</span>
                </div>
                <p className="cg-preflight-reason">{preflight.reason}</p>
                {preflight.reframe && (
                  <div className="cg-preflight-reframe">
                    <span className="cg-preflight-reframe-label">Brain suggests instead:</span>
                    <div className="cg-preflight-reframe-card" onClick={() => { setTopicPrompt(preflight.reframe || ''); setPreflight({ status: 'idle' }); }}>
                      <span className="cg-preflight-reframe-topic">{preflight.reframe}</span>
                      <span className="cg-preflight-use-hint">tap to use</span>
                    </div>
                    {preflight.reframeRationale && (
                      <p className="cg-preflight-reframe-rationale">{preflight.reframeRationale}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <button className="geo-run-btn" onClick={runGeneration} disabled={!selectedBrainId}>
            <FileText size={14} /> Generate Article
          </button>
          </div>
        </div>
      )}

      {isRunning && (
        <div className="geo-running">
          <div className="cg-stream-header">
            <Zap size={14} />
            <span>Generating — Brain is writing...</span>
          </div>
          <div className="cg-stream-body">
            <StreamProgress text={streamText} />
          </div>
        </div>
      )}

      {error && <div className="geo-error">{error}</div>}

      {imageLoading && (
        <div className="cg-image-loading-bar">
          <span className="cg-spinner-sm" /> Generating hero image…
        </div>
      )}

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
              {articleImageUrl ? (
                <div className="cg-article-hero">
                  <img src={articleImageUrl} alt={article.title} />
                </div>
              ) : imageLoading ? (
                <div className="cg-article-hero-loading">
                  <span className="cg-spinner-sm" /> Generating hero image…
                </div>
              ) : null}
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

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => { setArticle(null); setStreamText(''); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              <FileText size={14} /> Generate Another
            </button>
            <button onClick={() => window.location.href = '/app/content-library'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#4F46E5', color: '#fff', border: '1px solid #4F46E5', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              View in Content Library
            </button>
            <button onClick={() => window.location.href = '/app/compliance-gate'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#10b981', color: '#fff', border: '1px solid #10b981', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              <ShieldCheck size={14} /> Send to Compliance Gate
            </button>
          </div>
        </>
      )}
      {/* Floating idea capture */}
      <button
        className={`cg-idea-fab${ideaDrawerOpen ? ' open' : ''}`}
        onClick={() => setIdeaDrawerOpen(o => !o)}
        title="Save a topic idea for later"
      >
        {ideaDrawerOpen ? '✕' : '+ Idea'}
      </button>

      {ideaDrawerOpen && (
        <div className="cg-idea-drawer">
          <div className="cg-idea-drawer-header">
            <span className="cg-idea-drawer-title">Topic Ideas</span>
            <span className="cg-idea-drawer-sub">Park it now, generate when ready</span>
          </div>
          <div className="cg-idea-capture">
            <input
              className="cg-idea-input"
              placeholder="What's the topic idea?"
              value={newIdea}
              onChange={e => setNewIdea(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveIdea(); }}
              autoFocus
            />
            <input
              className="cg-idea-note-input"
              placeholder="Optional note..."
              value={newIdeaNote}
              onChange={e => setNewIdeaNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveIdea(); }}
            />
            <button className="cg-idea-save-btn" onClick={saveIdea} disabled={savingIdea || !newIdea.trim() || !selectedBrainId}>
              {savingIdea ? 'Saving...' : 'Save Idea'}
            </button>
            {!selectedBrainId && <p className="cg-idea-warn">Select a Brain first.</p>}
          </div>
          {ideas.length > 0 && (
            <div className="cg-idea-list">
              {ideas.map(idea => (
                <div key={idea.id} className={`cg-idea-item${idea.status === 'in_progress' ? ' in-progress' : ''}`}>
                  <div className="cg-idea-item-top">
                    <span className="cg-idea-topic">{idea.topic}</span>
                    <div className="cg-idea-item-actions">
                      <button className="cg-idea-use-btn" onClick={() => useIdea(idea)}>→ Use</button>
                      <button className="cg-idea-del-btn" onClick={() => deleteIdea(idea.id)}>✕</button>
                    </div>
                  </div>
                  {idea.note && <p className="cg-idea-note-text">{idea.note}</p>}
                  {idea.status === 'in_progress' && <span className="cg-idea-in-progress">In progress</span>}
                </div>
              ))}
            </div>
          )}
          {ideas.length === 0 && selectedBrainId && (
            <p className="cg-idea-empty">No ideas yet — type one above ↑</p>
          )}
        </div>
      )}

    </div>
  );
}

export default function ContentGeneratorPage() {
  return <AppShell><ContentGeneratorContent /></AppShell>;
}
